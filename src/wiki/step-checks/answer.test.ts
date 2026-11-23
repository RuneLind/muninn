/**
 * A page's checks answered: which steps carry one, machines, the cache and
 * its single flight, and the whole answer's bound. Probes are faked through
 * `ProbeDeps`; the page walk is the real one.
 */
import { describe, expect, test } from "bun:test";
import { sha256 } from "../../utils/date-hash.ts";
import { listYouSteps } from "../../format/step-done.ts";
import type { GitRun } from "../decision-triage/git.ts";
import { ANOTHER_CHECK, answerStepChecks, checkedSteps, ProbeCache, type AnswerDeps } from "./answer.ts";
import type { ProbeDeps } from "./probes.ts";
import { checkComponents } from "../lint-components.ts";

const page = (...items: string[]) => ["---", "title: T", "---", "", "<NextMoves>", "", '<Lane kind="you">', "", ...items, "", "</Lane>", "", "</NextMoves>", ""].join("\n");

const noGit: GitRun = async () => {
  throw new Error("git must not run");
};

function probes(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    git: noGit,
    roots: null,
    readEnvFile: async () => ({ bytes: new TextEncoder().encode("HAVE=1\n") }),
    processHasEnv: () => true,
    appliedMigrations: async () => new Set(["086"]),
    ...over,
  };
}

const deps = (over: Partial<AnswerDeps> = {}, p: Partial<ProbeDeps> = {}): AnswerDeps => ({ probes: probes(p), machine: null, cache: new ProbeCache(), ...over });

describe("checkedSteps", () => {
  test("only open list steps whose first line ends in a valid tag; keys and rows are Done's", () => {
    const text = page('1. One <Check env="HAVE" />', "2. Two, no tag", '3. Three <Check env="HAVE" /> then text', '4. Four\n   <Check env="HAVE" />', '5. Five <Check migration="086" />');
    const keys = listYouSteps(text)!.map((s) => s.key);
    expect(checkedSteps(text)).toEqual({
      laneRows: [5],
      steps: [
        { key: keys[0]!, lane: 0, row: 0, probes: [{ kind: "env", value: "HAVE" }], on: null, problems: [] },
        { key: keys[4]!, lane: 0, row: 4, probes: [{ kind: "migration", value: "086" }], on: null, problems: [] },
      ],
    });
  });
  test("a task-list row, a done row and a tag outside a you lane are no checks", () => {
    expect(checkedSteps(page('- [ ] Task <Check env="HAVE" />', '- [x] Done <Check env="HAVE" />'))!.steps).toEqual([]);
    expect(checkedSteps('---\ntitle: T\n---\n\n1. Loose <Check env="HAVE" />\n')).toEqual({ laneRows: [], steps: [] });
  });
});

describe("answerStepChecks", () => {
  test("a page with no check answers no steps and runs nothing", async () => {
    let ran = 0;
    const text = page("1. Plain step.");
    const a = await answerStepChecks(text, deps({}, { readEnvFile: async () => (ran++, { bytes: new Uint8Array() }), appliedMigrations: async () => (ran++, new Set<string>()) }));
    expect(a).toEqual({ hash: sha256(text), machine: null, laneRows: [1], steps: [] });
    expect(ran).toBe(0);
  });

  test("a step is ok only when every probe is; any not-yet wins", async () => {
    const text = page('1. A <Check env="HAVE" migration="086" />', '2. B <Check env="HAVE" migration="087" />', '3. C <Check env="MISSING" checkout="muninn" />');
    const a = await answerStepChecks(text, deps());
    expect(a.steps.map((s) => s.state)).toEqual(["ok", "not-yet", "not-yet"]);
    expect(a.steps[0]!.machines).toEqual([
      {
        name: null,
        state: "ok",
        why: "all 2 facts hold",
        probes: [
          { kind: "env", value: "HAVE", state: "ok", why: "HAVE is set in .env and in the running process" },
          { kind: "migration", value: "086", state: "ok", why: "migration 086 is applied on this machine's database" },
        ],
      },
    ]);
  });

  test("restart, and pushed with no repo roots, are never ok, whatever else holds, and run no git", async () => {
    const text = page('1. A <Check env="HAVE" restart="3010" />', '2. B <Check migration="086" pushed="muninn" />', '3. C <Check pushed="muninn" restart="3010" />');
    const a = await answerStepChecks(text, deps());
    expect(a.steps.map((s) => s.state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(a.steps[0]!.machines[0]!.probes.map((p) => [p.kind, p.state, p.why])).toEqual([
      ["env", "ok", "HAVE is set in .env and in the running process"],
      ["restart", "unknown", "muninn cannot prove this yet"],
    ]);
    expect(a.steps[1]!.machines[0]!.probes[1]).toEqual({ kind: "pushed", value: "muninn", state: "unknown", why: "DECISION_TRIAGE_REPO_ROOTS is not set, so muninn cannot be found" });
  });

  test("a check whose tag dropped an attribute is never ok", async () => {
    const a = await answerStepChecks(page('1. A <Check env="HAVE" migration="86" />', '2. B <Check bogus="1" />'), deps());
    expect(a.steps.map((s) => [s.state, s.machines[0]!.state])).toEqual([
      ["unknown", "unknown"],
      ["unknown", "unknown"],
    ]);
    expect(a.steps[0]!.problems[0]).toContain("migration");
    expect(a.steps[1]!.machines[0]!.why).toBe("the check names no usable probe");
  });

  describe("machines", () => {
    const text = page('1. A <Check env="HAVE" on="laptop,mini" />', '2. B <Check env="HAVE" on="laptop" />', '3. C <Check env="HAVE" />');
    test("no `on`: this machine, by its name", async () => {
      const a = await answerStepChecks(text, deps({ machine: "laptop" }));
      expect(a.machine).toBe("laptop");
      expect(a.steps[2]!.machines.map((m) => [m.name, m.state])).toEqual([["laptop", "ok"]]);
    });
    test("`on` with this machine's name: answered here", async () => {
      const a = await answerStepChecks(text, deps({ machine: "laptop" }));
      expect(a.steps[1]!.machines.map((m) => [m.name, m.state])).toEqual([["laptop", "ok"]]);
      expect(a.steps[1]!.state).toBe("ok");
    });
    test("`on` with two names: the other is unknown with no peer, so the step is unknown", async () => {
      const a = await answerStepChecks(text, deps({ machine: "laptop" }));
      expect(a.steps[0]!.machines.map((m) => [m.name, m.state, m.why])).toEqual([
        ["laptop", "ok", "all 1 fact holds"],
        ["mini", "unknown", "no peer configured for mini"],
      ]);
      expect(a.steps[0]!.state).toBe("unknown");
    });
    test("a peer answerer is given the probes and its answer counts", async () => {
      const seen: unknown[] = [];
      const a = await answerStepChecks(text, deps({ machine: "laptop", peer: async (m, ps) => (seen.push([m, ps]), ps.map(() => ({ state: "ok" as const, why: "peer ok" }))) }));
      expect(seen).toEqual([["mini", [{ kind: "env", value: "HAVE" }]]]);
      expect(a.steps[0]!.state).toBe("ok");
    });
    test("a peer that throws is unknown", async () => {
      const a = await answerStepChecks(text, deps({ machine: "laptop", peer: async () => Promise.reject(new Error("x")) }));
      expect(a.steps[0]!.machines[1]!.state).toBe("unknown");
    });
    test("MUNINN_MACHINE unset: every named machine is unknown; an `on`-less check is answered here", async () => {
      const a = await answerStepChecks(text, deps({ machine: null }));
      expect(a.steps[0]!.machines.map((m) => [m.name, m.state, m.why])).toEqual([
        ["laptop", "unknown", "this muninn has no MUNINN_MACHINE"],
        ["mini", "unknown", "this muninn has no MUNINN_MACHINE"],
      ]);
      expect(a.steps[1]!.state).toBe("unknown");
      expect(a.steps[2]!.machines.map((m) => [m.name, m.state])).toEqual([[null, "ok"]]);
    });
  });

  test("identical probes share one run in flight and are reused inside the TTL, then run again", async () => {
    let now = 0;
    let runs = 0;
    const cache = new ProbeCache(() => now, 30_000);
    const p = { appliedMigrations: async () => (runs++, await Bun.sleep(5), new Set(["086"])) };
    const text = page('1. A <Check migration="086" />', '2. B <Check migration="086" />');
    await Promise.all([answerStepChecks(text, deps({ cache }, p)), answerStepChecks(text, deps({ cache }, p))]);
    expect(runs).toBe(1);
    now = 29_999;
    await answerStepChecks(text, deps({ cache }, p));
    expect(runs).toBe(1);
    now = 30_005;
    await answerStepChecks(text, deps({ cache }, p));
    expect(runs).toBe(2);
  });

  test("a probe still running at the answer's bound answers unknown, timed out", async () => {
    const t0 = Date.now();
    const a = await answerStepChecks(page('1. A <Check migration="086" env="HAVE" />'), deps({ boundMs: 50 }, { appliedMigrations: () => new Promise(() => {}) }));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(a.steps[0]!.machines[0]!.probes.map((p) => [p.kind, p.state, p.why])).toEqual([
      ["env", "ok", "HAVE is set in .env and in the running process"],
      ["migration", "unknown", "timed out"],
    ]);
    expect(a.steps[0]!.state).toBe("unknown");
  });
});

describe("a tag lint reports is never ok", () => {
  // Every surviving probe answers ok on this machine.
  const reachesAnswer = [
    ["duplicate env", '<Check env="MISSING" env="HAVE" on="laptop" />'],
    ["duplicate on", '<Check env="HAVE" on="mini" on="laptop" />'],
    ["wrong-case ON", '<Check env="HAVE" ON="mini" />'],
    ["unknown envs", '<Check envs="MISSING" env="HAVE" />'],
  ] as const;
  // Placement refuses these runs, so the step has no trailing tag at all.
  const noTrailingTag = [
    ["single-quoted value", `<Check env="HAVE" on='mini' />`],
    ["unquoted value", '<Check env="HAVE" on=mini />'],
    ["stray text", '<Check env="HAVE" please on="laptop" />'],
  ] as const;
  const controls = ['<Check env="HAVE" on="laptop" />', '<Check env="HAVE" migration="086" />', '<Check env="HAVE" />'];

  test.each(reachesAnswer)("%s: lint reports component-attr, and the answer holds one unknown step with problems", async (_n, tag) => {
    const text = page(`1. **Do it.** ${tag}`);
    expect(checkComponents("plans/x.mdx", text).map((f) => f.check)).toContain("component-attr");
    const steps = checkedSteps(text)!.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.problems).not.toEqual([]);
    const a = await answerStepChecks(text, deps({ machine: "laptop" }));
    expect(a.steps).toHaveLength(1);
    expect(a.steps[0]!.state).toBe("unknown");
    expect(a.steps[0]!.problems).not.toEqual([]);
  });

  test.each(noTrailingTag)("%s: lint reports check-placement, and the answer holds no step", async (_n, tag) => {
    const text = page(`1. **Do it.** ${tag}`);
    expect(checkComponents("plans/x.mdx", text).map((f) => f.check)).toContain("check-placement");
    expect(checkedSteps(text)!.steps).toEqual([]);
    expect((await answerStepChecks(text, deps({ machine: "laptop" }))).steps).toEqual([]);
  });

  test("a step's problem lines come in order: the run's grammar, then the attributes, then another tag", async () => {
    const text = page('1. **Do.** <Check env="HAVE" migration="86" bogus="1" on="laptop" />', '   <Check env="MISSING" />');
    const want = ['bogus="1" is not a Check attribute; it is not read', 'migration="86" is not a schema_migrations version, zero-padded to at least 3 digits (086); the probe is dropped', ANOTHER_CHECK];
    expect(checkedSteps(text)!.steps.map((s) => s.problems)).toEqual([want]);
    const a = await answerStepChecks(text, deps({ machine: "laptop" }));
    expect(a.steps.map((s) => [s.state, s.problems])).toEqual([["unknown", want]]);
  });

  test("well-formed controls keep no problems and read ok", async () => {
    const text = page(...controls.map((t, i) => `${i + 1}. **Do it.** ${t}`));
    expect(checkComponents("plans/x.mdx", text)).toEqual([]);
    expect(checkedSteps(text)!.steps.map((s) => s.problems)).toEqual([[], [], []]);
    expect((await answerStepChecks(text, deps({ machine: "laptop" }))).steps.map((s) => s.state)).toEqual(["ok", "ok", "ok"]);
  });

  test("a not-yet probe still wins over the problem's unknown", async () => {
    const a = await answerStepChecks(page('1. A <Check env="HAVE" env="MISSING" />'), deps({ machine: "laptop" }));
    expect(a.steps[0]!.state).toBe("not-yet");
  });
});

describe("a step holding another Check tag is never ok", () => {
  // The step's item runs from its first line to the next top-level item of
  // its lane, or to the lane's end: its first line, continuation lines and
  // nested content. Any `<Check` there that lint reports (`check-placement`)
  // keeps the step from `ok`, wherever it sits. The trailing tag is ok alone.
  const T = '<Check env="HAVE" on="laptop" />';
  const other = '<Check env="MISSING" />';
  const where = [
    ["a second tag before the trailing one", [`1. **Do it.** <Check migration="086" on="laptop" /> ${T}`]],
    ["an earlier tag mid-sentence", [`1. **Do.** ${other} then ${T}`]],
    ["a tag inside the bold label", [`1. **Do it ${other}.** ${T}`]],
    ["a tag at the very start of the text", [`1. ${other} **Do.** ${T}`]],
    ["a continuation line", [`1. **Do.** ${T}`, `   ${other}`]],
    ["a continuation line's middle", [`1. **Do.** ${T}`, `   and then ${other} too`]],
    ["a nested list item", [`1. **Do.** ${T}`, `   - nested ${other}`]],
    ["a nested list's continuation", [`1. **Do.** ${T}`, "   - nested", `     ${other}`]],
    ["a paragraph after a blank line", [`1. **Do.** ${T}`, "", `   ${other}`]],
    ["a single-quoted tag on a continuation", [`1. **Do.** ${T}`, `   <Check env='MISSING' />`]],
    ["a paired tag on a continuation", [`1. **Do.** ${T}`, `   <Check env="MISSING">x</Check>`]],
    ["a tag wrapped over two lines", [`1. **Do.** ${T}`, '   <Check env="MISSING"', '   on="laptop" />']],
    ["a lane paragraph after the last step", [`1. **Do.** ${T}`, "", other]],
  ] as const;

  test.each(where)("%s: lint reports it, and the step is not ok", async (_n, items) => {
    const text = page(...items);
    expect(checkComponents("plans/x.mdx", text).map((f) => f.check)).toContain("check-placement");
    const steps = checkedSteps(text)!.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.problems).toContain(ANOTHER_CHECK);
    expect((await answerStepChecks(text, deps({ machine: "laptop" }))).steps.map((s) => s.state)).toEqual(["unknown"]);
  });

  // A lane written on one line closes on the step's own line, which bounds
  // nothing: the item runs to the page's end, so the earlier tag still counts.
  const oneLineLane = `<Lane kind="you">1. **Do.** ${other} <Check env="HAVE" /></Lane>`;
  const singleLine = [
    ["a lane on one line", ["---", "title: T", "---", "", "<NextMoves>", "", oneLineLane, "", "</NextMoves>", ""].join("\n")],
    ["NextMoves and its lane on one line", ["---", "title: T", "---", "", `<NextMoves>${oneLineLane}</NextMoves>`, ""].join("\n")],
  ] as const;

  test.each(singleLine)("%s: lint reports the earlier tag, and the step is not ok", async (_n, text) => {
    expect(checkComponents("plans/x.mdx", text).map((f) => f.check)).toContain("check-placement");
    const steps = checkedSteps(text)!.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.problems).toContain(ANOTHER_CHECK);
    expect((await answerStepChecks(text, deps({ machine: "laptop" }))).steps.map((s) => s.state)).toEqual(["unknown"]);
  });

  const exempt = [
    ["a code span on the first line", [`1. **Do \`<Check env="MISSING" />\`.** ${T}`]],
    ["a code span on a continuation", [`1. **Do.** ${T}`, '   see `<Check env="MISSING" />`']],
    ["a fence under the item", [`1. **Do.** ${T}`, "", "   ```", `   ${other}`, "   ```"]],
    ["the longer name Checklist", [`1. **Do.** ${T}`, "   a <Checklist> mention"]],
  ] as const;

  test.each(exempt)("%s: lint is silent, and the step reads ok", async (_n, items) => {
    const text = page(...items);
    expect(checkComponents("plans/x.mdx", text).filter((f) => f.check === "check-placement")).toEqual([]);
    expect(checkedSteps(text)!.steps.map((s) => s.problems)).toEqual([[]]);
    expect((await answerStepChecks(text, deps({ machine: "laptop" }))).steps.map((s) => s.state)).toEqual(["ok"]);
  });

  test.each([
    ["the next step", page(`1. **Do.** ${T}`, `2. **Then.** ${other} here`, `3. **Last.** ${T}`), 2],
    ["past the lane", page(`1. **Do.** ${T}`) + `\n${other}\n`, 1],
    ["another lane", page(`1. **Do.** ${T}`).replace("</NextMoves>", `<Lane kind="you">\n\n${other}\n\n1. **B.** ${T}\n\n</Lane>\n\n</NextMoves>`), 2],
  ] as const)("a tag in %s is not this step's", (_n, text, n) => {
    expect(checkComponents("plans/x.mdx", text).map((f) => f.check)).toContain("check-placement");
    expect(checkedSteps(text)!.steps.map((s) => s.problems)).toEqual(Array.from({ length: n }, () => []));
  });
});
