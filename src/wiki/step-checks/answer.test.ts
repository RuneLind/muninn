/**
 * A page's checks answered: which steps carry one, machines, the cache and
 * its single flight, and the whole answer's bound. Probes are faked through
 * `ProbeDeps`; the page walk is the real one.
 */
import { describe, expect, test } from "bun:test";
import { sha256 } from "../../utils/date-hash.ts";
import { listYouSteps } from "../../format/step-done.ts";
import type { GitRun } from "../decision-triage/git.ts";
import { answerStepChecks, checkedSteps, ProbeCache, type AnswerDeps } from "./answer.ts";
import type { ProbeDeps } from "./probes.ts";

const page = (...items: string[]) => ["---", "title: T", "---", "", "<NextMoves>", "", '<Lane kind="you">', "", ...items, "", "</Lane>", "", "</NextMoves>", ""].join("\n");

const noGit: GitRun = async () => {
  throw new Error("git must not run");
};

function probes(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    git: noGit,
    roots: null,
    readEnvFile: async () => ({ text: "HAVE=1\n" }),
    processHasEnv: () => true,
    hasMigration: async (v) => v === "086",
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
    const a = await answerStepChecks(text, deps({}, { readEnvFile: async () => (ran++, { text: "" }), hasMigration: async () => (ran++, true) }));
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

  test("a step naming restart or pushed is never ok, whatever else holds, and runs no git", async () => {
    const text = page('1. A <Check env="HAVE" restart="3010" />', '2. B <Check migration="086" pushed="muninn" />', '3. C <Check pushed="muninn" restart="3010" />');
    const a = await answerStepChecks(text, deps());
    expect(a.steps.map((s) => s.state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(a.steps[0]!.machines[0]!.probes.map((p) => [p.kind, p.state, p.why])).toEqual([
      ["env", "ok", "HAVE is set in .env and in the running process"],
      ["restart", "unknown", "muninn cannot prove this yet"],
    ]);
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
    const p = { hasMigration: async (v: string) => (runs++, await Bun.sleep(5), v === "086") };
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
    const a = await answerStepChecks(page('1. A <Check migration="086" env="HAVE" />'), deps({ boundMs: 50 }, { hasMigration: () => new Promise(() => {}) }));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(a.steps[0]!.machines[0]!.probes.map((p) => [p.kind, p.state, p.why])).toEqual([
      ["env", "ok", "HAVE is set in .env and in the running process"],
      ["migration", "unknown", "timed out"],
    ]);
    expect(a.steps[0]!.state).toBe("unknown");
  });
});
