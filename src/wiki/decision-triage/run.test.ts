/** One pass through injected seams and a real temp log: scope, the `ANSWERED`
 *  branch, partial runs, refusals, and a line per card in every outcome. */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "../../config.ts";
import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { sha256 } from "../../gardener/util.ts";
import { silentTracer } from "../../test/one-shot-drive.ts";
import { testTempDirSync } from "../../test/temp-dir.ts";
import type { WikiIndex, WikiPageMeta } from "../store.ts";
import { WORK_MAP_SPAWN_ARGS, WORK_MAP_TIMEOUT_MS } from "../work-map/run.ts";
import { appendLogLines, nightlyLogPath, parseLog, readLog } from "./log.ts";
import { TRIAGE_SYSTEM_PROMPT } from "./prompt.ts";
import { decisionTriageBotConfig, parseVerdicts, realDecisionTriageModel, runDecisionTriage, type TriageModel, type TriageProgress, type TriageRunDeps } from "./run.ts";
import { commitAt, pushMain, repoWithOrigin, write } from "./test-repo.ts";
import { realGit } from "./git.ts";
import { DECISION_TRIAGE_PROMPT_VERSION, type LogLine } from "./schema.ts";

const card = (id: string, extra = "") => `<Question id="${id}" choices="A|B">\nSkal vi ${id}?${extra}\n\n**Recommendation: A.** Fordi.\n</Question>\n`;
const page = (body: string, fm = "") => `---\ntitle: T\nrepos: [code]\n${fm}---\n# T\n\n${body}\n`;
const hashOf = (id: string, extra = "") => sha256(`Skal vi ${id}?${extra}\n**Recommendation: A.** Fordi.\n\nchoices: A|B`);

let dirs: { root: string; codeRoots: string; log: string };
beforeEach(() => {
  const root = testTempDirSync(path.join(tmpdir(), "triage-run-"));
  const codeRoots = path.join(root, "src");
  const code = path.join(codeRoots, "code");
  repoWithOrigin(code, path.join(root, "bare"), "code");
  write(code, "a.txt", "x\n");
  commitAt(code, "2026-10-01T10:00:00Z", "first");
  pushMain(code);
  dirs = { root: path.join(root, "wiki"), codeRoots, log: path.join(root, "log.jsonl") };
});

function indexOf(pages: Record<string, { text: string; meta?: Partial<WikiPageMeta> }>): { index: WikiIndex; files: Map<string, string> } {
  const files = new Map<string, string>();
  const metas = Object.entries(pages).map(([relPath, p]) => {
    files.set(`${dirs.root}/${relPath}`, p.text);
    return { relPath, ...p.meta } as WikiPageMeta;
  });
  const index = { root: dirs.root, pages: metas, backlinks: new Map(), resolveRelPath: () => undefined } as unknown as WikiIndex;
  return { index, files };
}

const answerVerdicts = (prompt: string, verdict = "DEFAULT") => {
  const ids = [...prompt.matchAll(/"card": "(c\d+)"/g)].map((m) => m[1]!);
  return JSON.stringify({ verdicts: ids.map((c) => ({ card: c, verdict, costOfDelay: "low", reversible: true, onlyOwnerHas: null, why: "fordi", evidence: ["D1"], restsOnPrs: [] })) });
};

function deps(pages: Parameters<typeof indexOf>[0], over: Partial<TriageRunDeps> & { model?: string } = {}): TriageRunDeps {
  const { index, files } = indexOf(pages);
  return {
    entry: { name: "w", root: dirs.root, source: "extra" },
    now: () => Date.parse("2026-11-01T05:00:00Z"),
    repoRoots: dirs.codeRoots,
    model: "m",
    call: async (req) => ({ text: answerVerdicts(req.prompt), costUsd: 0.5, inputTokens: 10, outputTokens: 5, durationMs: 100 }),
    git: realGit,
    loadIndex: async () => index,
    readFile: async (abs) => files.get(abs) ?? null,
    answers: async () => [],
    owner: "Eier (X123456)",
    groups: new Map(),
    append: (lines) => appendLogLines(dirs.log, lines),
    ...over,
  };
}

const answer = (id: string, over: Partial<WikiAnswerVersion> = {}): WikiAnswerVersion => ({
  answerId: `ans-${id}`,
  version: 1,
  wiki: "w",
  relPath: "plans/p.mdx",
  questionId: id,
  author: { userId: null, oid: null, navIdent: null, name: "Eier" },
  choice: "A",
  body: "",
  questionHash: hashOf(id),
  createdAt: Date.parse("2026-10-30T10:00:00Z"),
  exportedAt: null,
  redactedAt: null,
  ...over,
});

describe("which cards", () => {
  test("open cards with an id, on pages in scope, a line each", async () => {
    const seen: string[] = [];
    const res = await runDecisionTriage(
      deps(
        {
          "plans/p.mdx": { text: page(`${card("O1")}\n${card("O2")}\n<DecisionLog>\n- **O1** — Åpent.\n- **O2** — Lukket 01.11.2026 (D1).\n- **D1** — Valgt. E, 01.11.2026.\n</DecisionLog>`) },
          "plans/culled.mdx": { text: page(card("O3")), meta: { culled: true } },
          "plans/gone.mdx": { text: page(card("O4")), meta: { plan_status: "superseded" as never } },
          "plans/dropped.mdx": { text: page(card("O5")), meta: { plan_status: "abandoned" as never } },
          "plans/shipped.mdx": { text: page(card("O6")), meta: { plan_status: "shipped" as never } },
          "plans/dup.mdx": { text: page(`${card("O7")}\n${card("O7")}\n${card("O8")}`) },
          "plans/noid.mdx": { text: page('<Question choices="A|B">\nHva?\n</Question>') },
          "notes/plain.md": { text: "ingen kort\n" },
        },
        { call: async (req) => {
          seen.push(...(JSON.parse(req.prompt.slice(req.prompt.indexOf("{"))) as { cards: { id: string }[] }).cards.map((c) => c.id));
          return { text: answerVerdicts(req.prompt) };
        } },
      ),
    );
    expect(res.outcome).toBe("ok");
    expect(seen.sort()).toEqual(["O1", "O6", "O8"]);
    const { cards, runs } = await readLog(dirs.log);
    expect(cards.map((c) => c.id).sort()).toEqual(["O1", "O6", "O8"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ type: "run", wiki: "w", cards: 3, outcome: "ok", model: "m" });
    expect(runs[0]!.usage).toMatchObject({ calls: 1 });
    expect(runs[0]!.repos[0]).toMatchObject({ repo: "code", found: true, fetch: "ok" });
    expect(cards.every((c) => c.runId === runs[0]!.runId && c.recommendation === "A" && c.questionHash.length === 64)).toBe(true);
  });
});

describe("answered cards", () => {
  test("a live choice on unchanged wording takes no model call; the others reach it as facts", async () => {
    const prompts: string[] = [];
    await runDecisionTriage(
      deps(
        { "plans/p.mdx": { text: page(["O1", "O2", "O3", "O4", "O5"].map((id) => card(id)).join("\n")) } },
        {
          answers: async () => [
            answer("O1"),
            answer("O2", { choice: "not-sure" }),
            answer("O3", { choice: null, body: "bare tekst" }),
            answer("O4", { questionHash: "changed" }),
            answer("O5", { redactedAt: 1, choice: null, body: "" }),
          ],
          call: async (req) => {
            prompts.push(req.prompt);
            return { text: answerVerdicts(req.prompt) };
          },
        },
      ),
    );
    const { cards } = await readLog(dirs.log);
    const of = (id: string) => cards.find((c) => c.id === id)!;
    expect(of("O1").verdict).toBe("ANSWERED");
    expect(of("O1").recommendation).toBe("A");
    expect(["O2", "O3", "O4", "O5"].map((id) => of(id).verdict)).toEqual(["DEFAULT", "DEFAULT", "DEFAULT", "DEFAULT"]);
    const facts = JSON.parse(prompts[0]!.slice(prompts[0]!.indexOf("{"))) as { cards: { id: string; answers: { choice: string | null; body: string; questionChanged: boolean }[] }[] };
    const asked = (id: string) => facts.cards.find((c) => c.id === id)!.answers;
    expect(facts.cards.map((c) => c.id)).not.toContain("O1");
    expect(asked("O2")[0]!.choice).toBe("not-sure");
    expect(asked("O3")[0]!.body).toBe("bare tekst");
    expect(asked("O4")[0]!.questionChanged).toBe(true);
    expect(asked("O5")).toEqual([]);
  });

  test("a night where every card is answered is ok, with no call", async () => {
    let calls = 0;
    const res = await runDecisionTriage(deps({ "plans/p.mdx": { text: page(card("O1")) } }, { answers: async () => [answer("O1")], call: async () => (calls++, { text: "{}" }) }));
    expect(res.outcome).toBe("ok");
    expect(calls).toBe(0);
  });
});

describe("partial and failed nights", () => {
  const many = () => ({ "plans/p.mdx": { text: page(Array.from({ length: 30 }, (_, i) => card(`O${i + 1}`)).join("\n")) } });

  test("a batch that fails makes the night partial and keeps what landed, with a line for every card", async () => {
    let call = 0;
    const res = await runDecisionTriage(
      deps(many(), {
        call: async (req) => {
          if (++call === 2) throw new Error("timed out");
          return { text: answerVerdicts(req.prompt) };
        },
      }),
    );
    expect(res.outcome).toBe("partial");
    expect(call).toBe(2);
    const { cards, runs } = await readLog(dirs.log);
    expect(cards).toHaveLength(30);
    expect(cards.filter((c) => c.verdict === "DEFAULT")).toHaveLength(25);
    expect(cards.filter((c) => c.verdict === "NO_VERDICT").every((c) => c.reason === "the batch failed")).toBe(true);
    expect(runs[0]!.outcome).toBe("partial");
  });

  test("only a night with no verdicts is failed", async () => {
    const res = await runDecisionTriage(deps(many(), { call: async () => ({ text: "not json" }) }));
    expect(res.outcome).toBe("failed");
    const { cards } = await readLog(dirs.log);
    expect(cards).toHaveLength(30);
    expect(cards.every((c) => c.verdict === "NO_VERDICT")).toBe(true);
  });

  test("a card missing from the answer, or malformed, logs NO_VERDICT and the night is partial, counting both", async () => {
    const res = await runDecisionTriage(
      deps({ "plans/p.mdx": { text: page(`${card("O1")}\n${card("O2")}\n${card("O3")}`) } }, {
        call: async () => ({ text: JSON.stringify({ verdicts: [{ card: "c1", verdict: "ASK_OWNER", costOfDelay: "high", reversible: false, onlyOwnerHas: "smak", why: "fordi", evidence: [], restsOnPrs: ["repo#1"] }, { card: "c2", verdict: "MAYBE" }] }) }),
      }),
    );
    expect(res.outcome).toBe("partial");
    const { cards, runs } = await readLog(dirs.log);
    expect(runs[0]).toMatchObject({ outcome: "partial", reason: "1 malformed verdict(s), 1 card(s) missing from the answer" });
    expect(cards.map((c) => c.verdict)).toEqual(["ASK_OWNER", "NO_VERDICT", "NO_VERDICT"]);
    expect(cards[0]).toMatchObject({ onlyOwnerHas: "smak", restsOnPrs: ["repo#1"], costOfDelay: "high", reversible: false });
    expect(cards[1]!.reason).toBe("a malformed verdict");
    expect(cards[2]!.reason).toBe("missing from the answer");
  });

  test("only a malformed verdict beside one that landed is partial too", async () => {
    const res = await runDecisionTriage(
      deps({ "plans/p.mdx": { text: page(`${card("O1")}\n${card("O2")}`) } }, {
        call: async () => ({ text: JSON.stringify({ verdicts: [{ card: "c1", verdict: "DEFAULT", costOfDelay: "low", reversible: true, onlyOwnerHas: null, why: "fordi", evidence: [], restsOnPrs: [] }, { card: "c2", verdict: "MAYBE" }] }) }),
      }),
    );
    expect(res.outcome).toBe("partial");
    expect((await readLog(dirs.log)).runs[0]!.reason).toBe("1 malformed verdict(s)");
  });

  test("the model answering 1 of 25 cards is partial, and the reason counts the other 24", async () => {
    const pages = { "plans/p.mdx": { text: page(Array.from({ length: 25 }, (_, i) => card(`O${i + 1}`)).join("\n")) } };
    const res = await runDecisionTriage(deps(pages, { call: async () => ({ text: answerVerdicts('"card": "c1"') }) }));
    expect(res.outcome).toBe("partial");
    expect((await readLog(dirs.log)).runs[0]!.reason).toBe("24 card(s) missing from the answer");
  });

  test("a card over the limit beside verdicts stays ok, and the run line still counts it", async () => {
    const pages = { "plans/p.mdx": { text: page(`${card("O1")}\n${card("BIG", " " + "x".repeat(130_000))}`) } };
    const res = await runDecisionTriage(deps(pages));
    expect(res.outcome).toBe("ok");
    const { runs } = await readLog(dirs.log);
    expect(runs[0]).toMatchObject({ outcome: "ok", reason: "1 card(s) over the call's size limit" });
  });

  test("a clean night has no reason", async () => {
    const res = await runDecisionTriage(deps({ "plans/p.mdx": { text: page(card("O1")) } }));
    expect(res.outcome).toBe("ok");
    expect((await readLog(dirs.log)).runs[0]!.reason).toBeUndefined();
  });

  test("the progress is live: run id, calls, usage, cards and verdicts as each batch lands, repos before any call", async () => {
    const seen: TriageProgress[] = [];
    const snapshots: unknown[] = [];
    await runDecisionTriage(deps(many(), {
      track: (p) => void seen.push(p),
      call: async (req) => {
        const p = seen[0]!;
        snapshots.push({ calls: p.usage.calls, cost: p.usage.costUsd, logged: p.cardsLogged, verdicts: p.verdicts, open: p.open, repos: p.repos.map((r) => r.repo) });
        return { text: answerVerdicts(req.prompt), costUsd: 0.5 };
      },
    }));
    expect(seen).toHaveLength(1);
    expect(snapshots).toEqual([
      { calls: 0, cost: undefined, logged: 0, verdicts: 0, open: 30, repos: ["code"] },
      { calls: 1, cost: 0.5, logged: 25, verdicts: 25, open: 30, repos: ["code"] },
    ]);
    const { cards, runs } = await readLog(dirs.log);
    expect(seen[0]!.runId).toBe(runs[0]!.runId);
    expect(cards.every((c) => c.runId === seen[0]!.runId && c.at === seen[0]!.at)).toBe(true);
  });

  test("a card line counts as logged only once it is written, and only a model verdict counts as a verdict", async () => {
    let progress: TriageProgress | undefined;
    const res = runDecisionTriage(deps({ "plans/p.mdx": { text: page(`${card("O1")}\n${card("O2")}`) } }, {
      answers: async () => [answer("O1")],
      track: (p) => void (progress = p),
      append: async (lines) => {
        if (lines.some((l) => l.type === "card" && l.verdict === "DEFAULT")) throw new Error("disk full");
        await appendLogLines(dirs.log, lines);
      },
    }));
    await expect(res).rejects.toThrow("disk full");
    expect(progress).toMatchObject({ cardsLogged: 1, verdicts: 0, open: 2 });
  });

  /** Facts for a card naming `a.txt` throw; the rest gather. */
  const factsThrow = (over: Partial<TriageRunDeps> = {}): Partial<TriageRunDeps> => ({
    git: async (cwd, args, opts) => {
      if (args[0] === "grep" && args.includes("a.txt")) throw new Error("grep broke");
      return realGit(cwd, args, opts);
    },
    ...over,
  });
  const NAMES_A = " `a.txt`";

  test("every card stopped in the gather: failed, no call, and the reason says so", async () => {
    let calls = 0;
    const res = await runDecisionTriage(
      deps({ "plans/p.mdx": { text: page(`${card("O1", NAMES_A)}\n${card("O2", NAMES_A)}`) } }, factsThrow({ call: async () => (calls++, { text: "{}" }) })),
    );
    expect(res.outcome).toBe("failed");
    expect(calls).toBe(0);
    const { runs, cards } = await readLog(dirs.log);
    expect(cards.map((c) => c.verdict)).toEqual(["NO_VERDICT", "NO_VERDICT"]);
    expect(runs[0]).toMatchObject({ outcome: "failed", reason: "2 card(s) with no facts" });
  });

  test("a gather failure on one card with another judged: partial, and the reason names it", async () => {
    const res = await runDecisionTriage(deps({ "plans/p.mdx": { text: page(`${card("O1", NAMES_A)}\n${card("O2")}`) } }, factsThrow()));
    expect(res.outcome).toBe("partial");
    const { runs } = await readLog(dirs.log);
    expect(runs[0]).toMatchObject({ outcome: "partial", reason: "1 card(s) with no facts" });
  });

  test("the memory guard stopping every card is a failed night too", async () => {
    const spy = spyOn(process, "memoryUsage").mockReturnValue({ rss: 4 * 1024 ** 3 } as never);
    try {
      const res = await runDecisionTriage(deps({ "plans/p.mdx": { text: page(card("O1")) } }));
      expect(res.outcome).toBe("failed");
    } finally {
      spy.mockRestore();
    }
    const { runs, cards } = await readLog(dirs.log);
    expect(cards[0]!.reason).toBe("the memory guard stopped the gather");
    expect(runs[0]!.reason).toBe("1 card(s) with no facts");
  });

  test("an answer with no verdicts: failed, for that reason and no other", async () => {
    const res = await runDecisionTriage(deps({ "plans/p.mdx": { text: page(card("O1")) } }, { call: async () => ({ text: '{"verdicts":[]}' }) }));
    expect(res.outcome).toBe("failed");
    const { runs, cards } = await readLog(dirs.log);
    expect(runs[0]!.reason).toBe("1 card(s) missing from the answer");
    expect(cards[0]!.reason).toBe("missing from the answer");
  });

  test("only malformed verdicts: failed, and the reason says malformed", async () => {
    const res = await runDecisionTriage(deps({ "plans/p.mdx": { text: page(card("O1")) } }, { call: async () => ({ text: '{"verdicts":[{"card":"c1","verdict":"MAYBE"}]}' }) }));
    expect(res.outcome).toBe("failed");
    const { runs, cards } = await readLog(dirs.log);
    expect(runs[0]!.reason).toBe("1 malformed verdict(s)");
    expect(cards[0]!.reason).toBe("a malformed verdict");
  });

  test("every card over the limit: failed with no call, and the reason is not 0 of 0", async () => {
    let calls = 0;
    const huge = "x".repeat(130_000);
    const res = await runDecisionTriage(deps({ "plans/p.mdx": { text: page(card("O1", huge)) } }, { call: async () => (calls++, { text: "{}" }) }));
    expect(res.outcome).toBe("failed");
    expect(calls).toBe(0);
    const { runs } = await readLog(dirs.log);
    expect(runs[0]!.reason).toBe("1 card(s) over the call's size limit");
  });

  test("a failed batch's reason still counts batches, and an all-failed night is failed", async () => {
    const res = await runDecisionTriage(deps({ "plans/p.mdx": { text: page(card("O1")) } }, { call: async () => ({ text: "not json" }) }));
    expect(res.outcome).toBe("failed");
    const { runs } = await readLog(dirs.log);
    expect(runs[0]!.reason).toBe("1 of 1 batch(es) failed");
  });

  test("a card over the call's limit logs NO_VERDICT, and the rest still run", async () => {
    const huge = "x".repeat(130_000);
    const res = await runDecisionTriage(deps({ "plans/p.mdx": { text: page(`${card("O1", huge)}\n${card("O2")}`) } }));
    expect(res.outcome).toBe("ok");
    const { cards } = await readLog(dirs.log);
    expect(cards.find((c) => c.id === "O1")).toMatchObject({ verdict: "NO_VERDICT", reason: "over the call's size limit" });
    expect(cards.find((c) => c.id === "O2")!.verdict).toBe("DEFAULT");
  });
});

describe("refusals", () => {
  test("no repo resolving: a refused line with reason no-repo, no model call, no card lines", async () => {
    let calls = 0;
    const res = await runDecisionTriage(deps({ "plans/p.mdx": { text: page(card("O1")) } }, { repoRoots: "/nonexistent/roots", call: async () => (calls++, { text: "{}" }) }));
    expect(res.outcome).toBe("refused");
    expect(calls).toBe(0);
    const { runs, cards } = await readLog(dirs.log);
    expect(cards).toEqual([]);
    expect(runs[0]).toMatchObject({ outcome: "refused", reason: "no-repo" });
    expect(runs[0]!.repos[0]).toMatchObject({ repo: "code", found: false });
  });

  test("an index that cannot be read refuses; a floor that throws is written, not fatal", async () => {
    const res = await runDecisionTriage(deps({}, { loadIndex: async () => null }));
    expect(res).toMatchObject({ outcome: "refused", reason: "the wiki index could not be read" });
    const threw = await runDecisionTriage(deps({ "n.md": { text: "x" } }, { answers: async () => { throw new Error("db down"); } }));
    expect(threw).toMatchObject({ outcome: "refused", reason: "the cards could not be read: db down" });
    const ok = await runDecisionTriage(deps({ "notes/plain.md": { text: "ingen kort\n" } }, { floor: async () => { throw new Error("db down"); } }));
    expect(ok.outcome).toBe("ok");
    const { runs } = await readLog(dirs.log);
    expect(runs[2]!.floor).toMatchObject({ met: false, error: "db down" });
  });

  test("the floor is told this run's own start, and every card line carries the prompt's version", async () => {
    const seen: number[] = [];
    await runDecisionTriage(deps({ "notes/plain.md": { text: 'x\n\n<Question id="O1" choices="A|B">\nSkal vi?\n</Question>\n' } }, { now: () => 777, floor: async (startedAt) => { seen.push(startedAt); return { labelled: 0, added: 0, addedPages: 0, met: false }; } }));
    expect(seen).toEqual([777]);
    const { cards } = await readLog(dirs.log);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.promptVersion === DECISION_TRIAGE_PROMPT_VERSION)).toBe(true);
  });

  test("a wiki with no pages refuses; a wiki whose pages cannot be read refuses; neither makes a call", async () => {
    let calls = 0;
    const call: TriageModel = async () => (calls++, { text: "{}" });
    const empty = await runDecisionTriage(deps({}, { call }));
    expect(empty).toMatchObject({ outcome: "refused", reason: "the wiki has no pages" });
    const onlyHtml = await runDecisionTriage(deps({ "a.html": { text: "<p/>" } }, { call }));
    expect(onlyHtml).toMatchObject({ outcome: "refused", reason: "the wiki has no pages" });
    const unreadable = await runDecisionTriage(deps({ "plans/p.mdx": { text: page(card("O1")) } }, { call, readFile: async () => null }));
    expect(unreadable).toMatchObject({ outcome: "refused", reason: "none of its 1 page(s) could be read" });
    expect(calls).toBe(0);
    const { runs } = await readLog(dirs.log);
    expect(runs.map((r) => r.outcome)).toEqual(["refused", "refused", "refused"]);
  });

  test("a real wiki with no open cards is ok, with 0 cards; so is one with only culled pages", async () => {
    const plain = await runDecisionTriage(deps({ "notes/plain.md": { text: "ingen kort\n" } }));
    expect(plain.outcome).toBe("ok");
    const culled = await runDecisionTriage(deps({ "notes/c.md": { text: page(card("O1")), meta: { culled: true } } }));
    expect(culled.outcome).toBe("ok");
    const { runs } = await readLog(dirs.log);
    expect(runs.map((r) => r.cards)).toEqual([0, 0]);
  });

  test("a throw while resolving repos refuses, with a run line, no call and no card line", async () => {
    let calls = 0;
    const res = await runDecisionTriage(
      deps({ "plans/p.mdx": { text: page(card("O1")) } }, { git: async () => { throw new Error("spawn broke"); }, call: async () => (calls++, { text: "{}" }) }),
    );
    expect(res).toMatchObject({ outcome: "refused", reason: "the repos could not be resolved: spawn broke" });
    expect(calls).toBe(0);
    const { runs, cards } = await readLog(dirs.log);
    expect(cards).toEqual([]);
    expect(runs[0]).toMatchObject({ outcome: "refused" });
    expect(runs[0]!.repos[0]).toMatchObject({ repo: "code", found: false });
  });

  test("a stop on the refuse path is aborted: no line", async () => {
    const stopThen = (ac: AbortController) => async () => {
      ac.abort();
      return null;
    };
    const ac = new AbortController();
    expect(await runDecisionTriage(deps({}, { signal: ac.signal, loadIndex: stopThen(ac) }))).toEqual({ outcome: "aborted" });
    const ac2 = new AbortController();
    const threw = await runDecisionTriage(deps({ "n.md": { text: "x" } }, { signal: ac2.signal, answers: async () => { ac2.abort(); throw new Error("db closed"); } }));
    expect(threw).toEqual({ outcome: "aborted" });
    const { runs } = await readLog(dirs.log);
    expect(runs).toEqual([]);
  });

  test("a stop during the floor, or in a night with no call to check it, writes no run line", async () => {
    const ac = new AbortController();
    const res = await runDecisionTriage(deps({ "n.md": { text: "x" } }, { signal: ac.signal, floor: async () => {
      ac.abort();
      return { labelled: 0, added: 0, addedPages: 0, met: false };
    } }));
    expect(res).toEqual({ outcome: "aborted" });
    const ac2 = new AbortController();
    const held = await runDecisionTriage(deps({ "plans/p.mdx": { text: page(card("O1", " `a.txt`")) } }, { signal: ac2.signal, git: async (cwd, args, opts) => {
      if (args[0] === "grep") {
        ac2.abort();
        throw new Error("stopped");
      }
      return realGit(cwd, args, opts);
    } }));
    expect(held).toEqual({ outcome: "aborted" });
    const { runs, cards } = await readLog(dirs.log);
    expect(runs).toEqual([]);
    expect(cards).toEqual([]);
  });

  test("a stop mid-run writes no further line", async () => {
    const ac = new AbortController();
    const res = await runDecisionTriage(deps({ "plans/p.mdx": { text: page(card("O1")) } }, { signal: ac.signal, call: async (req) => (ac.abort(), { text: answerVerdicts(req.prompt) }) }));
    expect(res.outcome).toBe("aborted");
    const { runs, cards } = await readLog(dirs.log);
    expect(runs).toEqual([]);
    expect(cards).toEqual([]);
  });
});

describe("the log", () => {
  const cardLine = (id: string): LogLine => ({ type: "card", runId: "r", at: 1, wiki: "w", promptVersion: "p", relPath: "p", id, questionHash: "h", recommendation: null, verdict: "DEFAULT" });

  test("append-only, and a line with no end starts the next append on a fresh line", async () => {
    await appendLogLines(dirs.log, [cardLine("O1")]);
    await Bun.write(dirs.log, `${await Bun.file(dirs.log).text()}{"type":"card","runId":"r","at`);
    await appendLogLines(dirs.log, [cardLine("O2")]);
    const parsed = parseLog(await Bun.file(dirs.log).text());
    expect(parsed.cards.map((c) => c.id)).toEqual(["O1", "O2"]);
    expect(parsed.broken).toBe(1);
  });

  test("a card line with no run line reads as a card, and a missing log as empty", async () => {
    expect(await readLog(`${dirs.log}.none`)).toEqual({ runs: [], cards: [], broken: 0 });
    expect(parseLog(JSON.stringify(cardLine("O1")))).toMatchObject({ runs: [], broken: 0 });
    expect(nightlyLogPath("Some-Wiki", "/d")).toBe("/d/some-wiki.jsonl");
  });
});

test("parseVerdicts throws on no JSON and on another shape, so the batch counts as failed", () => {
  expect(() => parseVerdicts("nope")).toThrow();
  expect(() => parseVerdicts('{"other":1}')).toThrow();
});

test("the prompt tells the model page text is data, and names the five verdicts", () => {
  for (const word of ["untrusted", "SETTLED", "VOID", "DEFAULT", "ASK_OWNER", "ASK_OTHER"]) expect(TRIAGE_SYSTEM_PROMPT).toContain(word);
});

describe("the spawned argv pins the tool surface to none", () => {
  const config = { claudeModel: "claude-sonnet-4-5", claudeTimeoutMs: 30_000, tracingEnabled: false, tracingCaptureToolOutputs: false } as unknown as Config;
  let saved: { cwd?: string; mtt?: string };
  beforeEach(() => {
    saved = { cwd: process.env.MUNINN_AGENT_CWD, mtt: process.env.MAX_THINKING_TOKENS };
    process.env.MUNINN_AGENT_CWD = testTempDirSync(path.join(tmpdir(), "triage-agent-"));
    process.env.MAX_THINKING_TOKENS = "31999";
  });
  afterEach(() => {
    if (saved.cwd === undefined) delete process.env.MUNINN_AGENT_CWD;
    else process.env.MUNINN_AGENT_CWD = saved.cwd;
    if (saved.mtt === undefined) delete process.env.MAX_THINKING_TOKENS;
    else process.env.MAX_THINKING_TOKENS = saved.mtt;
  });

  test("no tools, no MCP, no settings, no thinking budget, the prompt after --", async () => {
    const out = JSON.stringify({ type: "result", result: '{"verdicts":[]}', total_cost_usd: 0.1, duration_ms: 10, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
    const spy = spyOn(Bun, "spawn").mockReturnValue({ pid: 1, stdout: new Response(`${out}\n`).body!, stderr: new Response("").body!, exited: Promise.resolve(0), kill: () => {} } as never);
    try {
      const call: TriageModel = realDecisionTriageModel(config, { tracer: silentTracer() });
      const reply = await call({ wiki: "w", prompt: "the facts", systemPrompt: "the system", model: "claude-opus-5-5" });
      const [argv, opts] = spy.mock.calls[0] as unknown as [string[], { env: Record<string, string | undefined>; cwd: string }];
      expect(argv[argv.indexOf("--tools") + 1]).toBe("");
      expect(argv).toContain("--strict-mcp-config");
      expect(argv.join("\u0000")).toContain(WORK_MAP_SPAWN_ARGS.join("\u0000"));
      expect(argv).not.toContain("--effort");
      expect(opts.env.MAX_THINKING_TOKENS).toBeUndefined();
      expect(argv.slice(-2)).toEqual(["--", "the facts"]);
      expect(opts.cwd).toBe(path.join(process.env.MUNINN_AGENT_CWD!, ".fenced"));
      expect(reply.costUsd).toBe(0.1);
    } finally {
      spy.mockRestore();
    }
  });

  test("the BotConfig is its own, named for the triage", () => {
    expect(decisionTriageBotConfig({ model: "m", dir: "/d" })).toEqual({
      name: "decision-triage",
      dir: "/d",
      persona: "",
      telegramAllowedUserIds: [],
      slackAllowedUserIds: [],
      connector: "claude-cli",
      model: "m",
      toolSurface: "none",
      timeoutMs: WORK_MAP_TIMEOUT_MS,
      spawnArgs: [...WORK_MAP_SPAWN_ARGS],
      spawnEnvOmit: ["MAX_THINKING_TOKENS"],
    });
  });
});

