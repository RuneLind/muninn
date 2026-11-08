/** The real loop half, in its own process: the registry memo and the answer
 *  config read the environment once, so each case boots a fresh one. */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { DECISION_TRIAGE_PROMPT_VERSION, MODEL_OFF_MODEL, MODEL_OFF_VERSION } from "./schema.ts";
import { commitAt, pushMain, repoWithOrigin, write } from "./test-repo.ts";

const LOOP_DEPS = path.join(import.meta.dir, "loop-deps.ts");
const LOGTAPE = Bun.resolveSync("@logtape/logtape", import.meta.dir);
const LOG = path.join(import.meta.dir, "log.ts");
const AGENT_STATUS = path.join(import.meta.dir, "..", "..", "observability", "agent-status.ts");
const LOOP = path.join(import.meta.dir, "..", "work-map", "loop.ts");
const REGISTRY = path.join(import.meta.dir, "..", "registry-memo.ts");

/** Runs `steps` (a function body over `deps`, `step`, `root`), returning what each `step(...)` saw and the log lines. `model` is more of the run's seams. */
async function drive(steps: string, env: Record<string, string>, tmp: string, model = "") {
  const driver = path.join(tmp, "driver.ts");
  writeFileSync(driver, `
import { configure } from ${JSON.stringify(LOGTAPE)};
import { realTriageLoopDeps, triagePassHeld } from ${JSON.stringify(LOOP_DEPS)};
import { startWorkMapLoop, stopWorkMapLoop, TRIAGE_PASS_BOUND_MS } from ${JSON.stringify(LOOP)};
import { getWikiRegistry } from ${JSON.stringify(REGISTRY)};
import { agentStatus } from ${JSON.stringify(AGENT_STATUS)};
import { appendLogLines, readLog } from ${JSON.stringify(LOG)};
import { renameSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
const lines: string[] = [];
await configure({ sinks: { mem: (r) => void lines.push(r.level + " " + r.message.join("")) }, loggers: [{ category: "muninn", lowestLevel: "info", sinks: ["mem"] }, { category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] }] });
const config = { decisionTriageRepoRoots: process.env.TEST_REPO_ROOTS ?? "/r", workMapModel: "m" };
const logs = ${JSON.stringify(path.join(tmp, "logs"))};
const answerAll = (prompt: string, only?: number) => JSON.stringify({ verdicts: [...prompt.matchAll(/"card": "(c\\d+)"/g)].slice(0, only).map((m) => ({ card: m[1], verdict: "DEFAULT", costOfDelay: "low", reversible: true, onlyOwnerHas: null, why: "w", evidence: [], restsOnPrs: [] })) });
let calls = 0;
const seams = { answers: async () => [], floor: async () => ({ labelled: 0, added: 0, addedPages: 0, met: false }) };
const finishes: { status: string; attrs: Record<string, unknown> }[] = [];
const tracer = () => ({ traceId: "t-" + (finishes.length + 1), finish: (status: string, attrs: Record<string, unknown> = {}) => void finishes.push({ status, attrs }) });
/** Every \`/agents\` run the pass opened, live or completed. */
const agentRuns = () => agentStatus.getAll().map((r) => ({ kind: r.kind, name: r.name, completed: !!r.completed, status: r.status ?? null, traceId: r.traceId ?? null }));
/** A seam that stops at \`pass()\` until \`open()\`; \`reached\` resolves when it gets there. */
const gate = () => {
  let open!: () => void;
  let hit!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const reached = new Promise<void>((r) => (hit = r));
  return { open, reached, pass: async () => { hit(); await opened; } };
};
const g1 = gate();
let appends = 0;
const deps = realTriageLoopDeps(config as never, logs, { ...seams, ${model} }, tracer)!;
/** The work map's loop on fake timers with \`triage\` as its triage half; the work map itself is never due. */
let fakeNow = Date.parse("2026-10-20T05:00:00Z");
const timers: { at: number; fn: () => void; id: number }[] = [];
let timerId = 0;
const advance = async (ms: number) => {
  const end = fakeNow + ms;
  while (true) {
    timers.sort((x, y) => x.at - y.at);
    const t = timers[0];
    if (!t || t.at > end) break;
    timers.shift();
    fakeNow = t.at;
    t.fn();
    await Bun.sleep(0);
    await Bun.sleep(0);
  }
  fakeNow = end;
};
const loop = (triage: typeof deps, names: string[]) => startWorkMapLoop({ schedulerEnabled: true, workMapWikis: names, workMapHour: 5, profile: "default" }, { deps: {
  now: () => fakeNow,
  setTimer: (fn, ms) => { const t = { at: fakeNow + ms, fn, id: ++timerId }; timers.push(t); return t.id; },
  clearTimer: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
  readState: async (wiki) => ({ wiki, lastSuccessAt: fakeNow, attempts: [] }),
  run: async () => ({ outcome: "refused", reason: "x" }),
  registry: () => names.map((name) => ({ name, root: "/w/" + name, source: "extra" }) as never),
  isReadonly: () => false,
  isReadonlyRoot: () => false,
  triage,
} });
const until = async (ok: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 2000; i++) {
    if (await ok()) return;
    await Bun.sleep(5);
  }
  throw new Error("never: " + what);
};
const runsOf = async (wiki: string) => (await readLog(logs + "/" + wiki + ".jsonl")).runs;
/** Until the log holds n card lines. */
const logged = async (n: number) => {
  for (let i = 0; i < 2000; i++) {
    if ((await readLog(logs + "/a.jsonl")).cards.length >= n) return;
    await Bun.sleep(5);
  }
  throw new Error("the log never reached " + n);
};
const seen: unknown[] = [];
${steps}
console.log(JSON.stringify({ seen, lines }));
process.exit(0);
`);
  const proc = Bun.spawn([process.execPath, "--no-env-file", driver], {
    cwd: tmp,
    env: { PATH: process.env.PATH ?? "", HOME: tmp, MUNINN_BOTS_DIR: path.join(tmp, "no-bots"), DATABASE_URL: "postgresql://x@127.0.0.1:1/x_test", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (!out.trim()) throw new Error(`driver printed nothing: ${err}`);
  return JSON.parse(out.trim().split("\n").pop()!) as { seen: unknown[]; lines: string[] };
}

function wikis() {
  const tmp = testTempDirSync(path.join(tmpdir(), "triage-loop-deps-"));
  mkdirSync(path.join(tmp, "no-bots"));
  const a = path.join(tmp, "a");
  const b = path.join(tmp, "b");
  mkdirSync(a);
  mkdirSync(b);
  return { tmp, a, b, env: { WIKI_EXTRA: `a=${a},b=${b}`, WIKI_ANSWER_WIKIS: "a,b" } };
}

describe("the scope is read at each check", () => {
  test("a reader file broken at boot takes the wiki out only until it is whole again", async () => {
    const { tmp, a, env } = wikis();
    writeFileSync(path.join(a, ".wiki-reader.json"), "{ half a rebase");
    const { seen } = await drive(`
seen.push(await deps.wikis(["a", "b"]));
writeFileSync(${JSON.stringify(path.join(a, ".wiki-reader.json"))}, "{}");
seen.push(await deps.wikis(["a", "b"]));
`, env, tmp);
    expect(seen).toEqual([["b"], ["a", "b"]]);
  });

  test("a wiki turning unreadable at a later check drops out then, and a later call's names count", async () => {
    const { tmp, a, env } = wikis();
    const { seen } = await drive(`
seen.push(await deps.wikis(["a"]));
mkdirSync(${JSON.stringify(path.join(a, ".wiki-reader.json"))});
seen.push(await deps.wikis(["a", "b"]));
`, env, tmp);
    expect(seen).toEqual([["a"], ["b"]]);
  });

  test("an unreadable reader file is no `work` wiki: dropped with its reason, one line over two checks", async () => {
    const { tmp, a, env } = wikis();
    mkdirSync(path.join(a, ".wiki-reader.json"));
    const { seen, lines } = await drive(`
seen.push(await deps.wikis(["a", "b"]));
seen.push(await deps.wikis(["a", "b"]));
`, env, tmp);
    expect(seen).toEqual([["b"], ["b"]]);
    const dropped = lines.filter((l) => l.includes("Decision triage skips"));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toStartWith("warning ");
    expect(dropped[0]).toContain(".wiki-reader.json exists but could not be read");
    expect(dropped[0]).toContain("skips a:");
  });

  test("a wiki that came back and drops again gets its line again", async () => {
    const { tmp, a, env } = wikis();
    const reader = JSON.stringify(path.join(a, ".wiki-reader.json"));
    writeFileSync(path.join(a, ".wiki-reader.json"), "{ nope");
    const { lines } = await drive(`
await deps.wikis(["a"]);
writeFileSync(${reader}, "{}");
await deps.wikis(["a"]);
writeFileSync(${reader}, "{ nope");
await deps.wikis(["a"]);
`, env, tmp);
    expect(lines.filter((l) => l.includes("Decision triage skips a:"))).toHaveLength(2);
  });

  test("one line naming what it covers, once per start, not per check", async () => {
    const { tmp, env } = wikis();
    const { lines } = await drive(`
await deps.wikis(["a", "b"]);
await deps.wikis(["a", "b"]);
await deps.wikis(["a", "b"]);
`, env, tmp);
    const covers = lines.filter((l) => l.includes("Decision triage covers"));
    expect(covers).toHaveLength(1);
    expect(covers[0]).toEndWith("covers a, b");
  });

  test("the variable set and nothing covered warns, with each wiki's reason", async () => {
    const { tmp, env } = wikis();
    const { seen, lines } = await drive(`seen.push(await deps.wikis(["c"]));`, { ...env, WIKI_ANSWER_WIKIS: "a" }, tmp);
    expect(seen).toEqual([[]]);
    expect(lines.some((l) => l.startsWith("warning ") && l.includes("covers nothing"))).toBe(true);
    expect(lines.some((l) => l.includes("Decision triage skips c:"))).toBe(true);
  });

  test("a wiki dropped for a fault still gets the two-nights warning", async () => {
    const { tmp, a, env } = wikis();
    mkdirSync(path.join(a, ".wiki-reader.json"));
    const logDir = path.join(tmp, "logs");
    mkdirSync(logDir);
    const line = { type: "run", runId: "r", at: Date.now() - 4 * 86_400_000, wiki: "a", model: "m", promptVersion: "p", usage: { calls: 0 }, repoRoots: null, repos: [], cards: 0, floor: null, outcome: "ok" };
    writeFileSync(path.join(logDir, "a.jsonl"), `${JSON.stringify(line)}\n`);
    const { lines } = await drive(`await deps.wikis(["a", "b"]);`, env, tmp);
    expect(lines.some((l) => l.includes("a has") && l.includes("nights with no run line"))).toBe(true);
    rmSync(logDir, { recursive: true });
  });

  test("a failed record: the state counts it and the night has its run line", async () => {
    const { tmp, env } = wikis();
    const { seen } = await drive(`
await deps.recordFailed("a", "the pass timed out");
seen.push(await deps.readState("a"));
`, env, tmp);
    expect((seen[0] as unknown as { attempts: { outcome: string; error: string }[] }).attempts[0]).toMatchObject({ outcome: "failed", error: "the pass timed out" });
    const run = JSON.parse(readFileSync(path.join(tmp, "logs", "a.jsonl"), "utf8").trim()) as Record<string, unknown>;
    expect(run).toMatchObject({ type: "run", wiki: "a", outcome: "failed", reason: "the pass timed out", cards: 0 });
  });
});

describe("a run cut short says what it did", () => {
  const card = (n: number) => `<Question id="O${n}" choices="A|B">\nSkal vi ${n}?\n\n**Recommendation: A.** Fordi.\n</Question>\n`;
  function withCards(n: number) {
    const w = wikis();
    mkdirSync(path.join(w.a, "plans"));
    writeFileSync(path.join(w.a, "plans", "p.mdx"), `---\ntitle: T\n---\n# T\n\n${Array.from({ length: n }, (_, i) => card(i + 1)).join("\n")}\n`);
    return w;
  }
  const logOf = (tmp: string) => readFileSync(path.join(tmp, "logs", "a.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  /** The first batch lands at $0.5 and the second never returns. */
  const HANG_SECOND = `call: async (req) => { if (++calls === 2) return new Promise(() => {}); return { text: answerAll(req.prompt), costUsd: 0.5, inputTokens: 10, outputTokens: 5, durationMs: 100 }; }`;
  /** As loop.ts's expiry does it: the abort, then the record in the same tick. */
  const BOUND = `
const ac = new AbortController();
void deps.run("a", ac.signal);
await logged(25);
await Bun.sleep(20);
ac.abort();
seen.push(await deps.recordFailed("a", "the pass timed out after 7 ms"));
seen.push(await deps.readState("a"));
`;

  test("one batch lands, the second hangs, the bound fires: partial, the run's id, the real counts, and the state does not retry", async () => {
    const { tmp, a, env } = withCards(30);
    const code = path.join(tmp, "src", "code");
    repoWithOrigin(code, path.join(tmp, "bare"), "code");
    write(code, "a.txt", "x\n");
    commitAt(code, "2026-10-01T10:00:00Z", "first");
    pushMain(code);
    const pageFile = path.join(a, "plans", "p.mdx");
    writeFileSync(pageFile, readFileSync(pageFile, "utf8").replace("title: T", "title: T\nrepos: [code]"));
    const { seen } = await drive(BOUND, { ...env, TEST_REPO_ROOTS: path.join(tmp, "src") }, tmp, HANG_SECOND);
    const lines = logOf(tmp);
    const cards = lines.filter((l) => l.type === "card");
    const runs = lines.filter((l) => l.type === "run");
    expect(cards).toHaveLength(25);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      outcome: "partial",
      repos: [{ repo: "code", found: true }],
      cards: 25,
      usage: { calls: 1, costUsd: 0.5, inputTokens: 10, outputTokens: 5, durationMs: 100 },
      reason: "the pass timed out after 7 ms; 25 verdict(s) in 25 card line(s) logged of 30 open card(s), 1 call(s) answered",
    });
    expect(cards.every((c) => c.runId === runs[0]!.runId && c.at === runs[0]!.at)).toBe(true);
    expect(seen[0]).toBe("partial");
    const state = seen[1] as unknown as { lastSuccessAt?: number; attempts: { outcome: string; error: string }[] };
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toMatchObject({ outcome: "ok", error: runs[0]!.reason as string });
    expect(state.lastSuccessAt).toBeNumber();
  });

  test("the first batch hangs: failed, and the line still carries the run's id and open count", async () => {
    const { tmp, env } = withCards(3);
    const { seen } = await drive(`
const ac = new AbortController();
void deps.run("a", ac.signal);
await Bun.sleep(300);
ac.abort();
seen.push(await deps.recordFailed("a", "the pass timed out after 7 ms"));
seen.push(await deps.readState("a"));
`, env, tmp, `call: () => new Promise(() => {})`);
    const lines = logOf(tmp);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "failed", cards: 0, usage: { calls: 0 }, reason: "the pass timed out after 7 ms; 0 verdict(s) in 0 card line(s) logged of 3 open card(s), 0 call(s) answered" });
    expect(seen[0]).toBe("failed");
    expect((seen[1] as unknown as { attempts: { outcome: string }[] }).attempts[0]!.outcome).toBe("failed");
  });

  test("the bound fires before the cards are read: failed, the run's id kept, and the reason claims no counts", async () => {
    const { tmp, env } = withCards(3);
    await drive(`
const ac = new AbortController();
void deps.run("a", ac.signal);
await Bun.sleep(300);
ac.abort();
await deps.recordFailed("a", "the pass timed out after 7 ms");
`, env, tmp, `answers: () => new Promise(() => {})`);
    const lines = logOf(tmp);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "failed", cards: 0, usage: { calls: 0 }, reason: "the pass timed out after 7 ms" });
  });

  test("a throw after a batch landed: the same line, and the run reads partial", async () => {
    const { tmp, env } = withCards(30);
    const { seen } = await drive(`
seen.push(await deps.run("a", new AbortController().signal));
seen.push(await deps.readState("a"));
`, env, tmp, `call: async (req) => ({ text: answerAll(req.prompt), costUsd: 0.5 }), append: async (l) => { if (l.some((x) => x.type === "card") && ++calls === 2) throw new Error("disk full"); await appendLogLines(logs + "/a.jsonl", l); }`);
    const lines = logOf(tmp);
    const runs = lines.filter((l) => l.type === "run");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "partial", cards: 25, usage: { calls: 2, costUsd: 1 } });
    expect(String(runs[0]!.reason)).toStartWith("disk full; 25 verdict(s)");
    expect(lines.filter((l) => l.type === "card").every((c) => c.runId === runs[0]!.runId)).toBe(true);
    expect(seen[0]).toEqual({ outcome: "partial", cards: 25 });
    expect((seen[1] as unknown as { attempts: { outcome: string }[] }).attempts[0]!.outcome).toBe("ok");
  });

  test("with the model call off (no call seam), a thrown night and a bare record carry the off version and no model", async () => {
    const { tmp, env } = withCards(3);
    await drive(`
await deps.run("a", new AbortController().signal);
await deps.recordFailed("a", "later");
`, env, tmp, `append: async (l) => { if (l.some((x) => x.type === "card")) throw new Error("disk full"); await appendLogLines(logs + "/a.jsonl", l); }`);
    const runs = logOf(tmp).filter((l) => l.type === "run");
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ outcome: "failed", promptVersion: MODEL_OFF_VERSION, model: MODEL_OFF_MODEL });
    expect(String(runs[0]!.reason)).toStartWith("disk full");
    expect(runs[1]).toMatchObject({ outcome: "failed", promptVersion: MODEL_OFF_VERSION, model: MODEL_OFF_MODEL, reason: "later" });
  });

  test("a record after a run that finished is about no run: a fresh id and zeros, never the finished run's", async () => {
    const { tmp, env } = withCards(1);
    await drive(`
await deps.run("a", new AbortController().signal);
await deps.recordFailed("a", "later");
`, env, tmp, `call: async (req) => ({ text: answerAll(req.prompt) })`);
    const runs = logOf(tmp).filter((l) => l.type === "run");
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ outcome: "failed", cards: 0, usage: { calls: 0 }, reason: "later", promptVersion: DECISION_TRIAGE_PROMPT_VERSION, model: "m" });
    expect(runs[1]!.runId).not.toBe(runs[0]!.runId);
  });

  test("a second record of the same run writes no second line or state record, and answers the first's outcome", async () => {
    const { tmp, env } = withCards(30);
    const { seen } = await drive(`${BOUND}
seen.push(await deps.recordFailed("a", "again"));
seen.push(await deps.readState("a"));
`, env, tmp, HANG_SECOND);
    expect(seen[2]).toBe("partial");
    expect(logOf(tmp).filter((l) => l.type === "run")).toHaveLength(1);
    expect((seen[3] as unknown as { attempts: unknown[] }).attempts).toHaveLength(1);
  });

  /** Every way a pass ends, through the real `run`: one run line and one state
   *  record per run, and the `/agents` row's status agrees with the line. */
  describe("one run line per run, however the pass ends", () => {
    type Row = { name: string; completed: boolean; status: string | null };
    type State = { attempts: { outcome: string }[] } | null;
    const rows = (v: unknown) => v as Row[];
    const attempts = (v: unknown) => (v as State)?.attempts.length ?? 0;
    const runLines = (tmp: string, wiki = "a") => {
      try {
        return readFileSync(path.join(tmp, "logs", `${wiki}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.type === "run");
      } catch {
        return [];
      }
    };
    const SETTLED = `seen.push(await deps.readState("a"), agentRuns());`;
    /** The first batch lands; the second call waits at the gate. */
    const SECOND_WAITS = `call: async (req) => { if (++calls === 2) await g1.pass(); return { text: answerAll(req.prompt), costUsd: 0.5 }; }`;

    test("a: ok, and partial: one line, one state record, the row ok", async () => {
      for (const [only, outcome] of [[undefined, "ok"], [1, "partial"]] as const) {
        const { tmp, env } = withCards(3);
        const { seen } = await drive(`seen.push(await deps.run("a", new AbortController().signal));\n${SETTLED}`, env, tmp, `call: async (req) => ({ text: answerAll(req.prompt, ${only}) })`);
        expect(runLines(tmp).map((r) => r.outcome)).toEqual([outcome]);
        expect(seen[0]).toMatchObject({ outcome });
        expect(attempts(seen[1])).toBe(1);
        expect(rows(seen[2])).toEqual([expect.objectContaining({ completed: true, status: "ok" })]);
      }
    });

    test("b: the bound fires while the pass writes its run line, and the pass returns normally: one line, one state record", async () => {
      const { tmp, env } = withCards(3);
      const { seen } = await drive(`
const ac = new AbortController();
const p = deps.run("a", ac.signal);
await g1.reached;
ac.abort();
// As the loop's bound does: not awaited; it waits for the pass's write in flight.
const bound = deps.recordFailed("a", "the pass timed out after 7 ms");
g1.open();
seen.push((await bound) ?? null);
seen.push(await p);
${SETTLED}`, env, tmp, `call: async (req) => ({ text: answerAll(req.prompt) }), append: async (l) => { if (l.some((x) => x.type === "run")) await g1.pass(); await appendLogLines(logs + "/a.jsonl", l); }`);
      const runs = runLines(tmp);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ outcome: "ok", cards: 3 });
      expect(seen[0]).toBeNull();
      expect(seen[1]).toMatchObject({ outcome: "ok", cards: 3 });
      expect(attempts(seen[2])).toBe(1);
      expect(rows(seen[3])).toEqual([expect.objectContaining({ completed: true, status: "ok" })]);
    });

    test("c: the bound fires, then the pass throws: the bound's one line, and the row agrees with it", async () => {
      const { tmp, env } = withCards(30);
      const { seen } = await drive(`
const ac = new AbortController();
const p = deps.run("a", ac.signal);
await g1.reached;
ac.abort();
seen.push(await deps.recordFailed("a", "the pass timed out after 7 ms"));
g1.open();
seen.push(await p);
${SETTLED}`, env, tmp, `call: async (req) => ({ text: answerAll(req.prompt), costUsd: 0.5 }), append: async (l) => { if (l.some((x) => x.type === "card") && ++appends === 2) { await g1.pass(); throw new Error("disk full"); } await appendLogLines(logs + "/a.jsonl", l); }`);
      const runs = runLines(tmp);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ outcome: "partial", cards: 25 });
      expect(String(runs[0]!.reason)).toStartWith("the pass timed out after 7 ms");
      expect(seen[0]).toBe("partial");
      expect(seen[1]).toEqual({ outcome: "partial", cards: 25 });
      expect(attempts(seen[2])).toBe(1);
      expect(rows(seen[3])).toEqual([expect.objectContaining({ completed: true, status: "ok" })]);
    });

    test("d: a throw with no abort: one line through the failure record, the row agrees", async () => {
      const { tmp, env } = withCards(30);
      const { seen } = await drive(`seen.push(await deps.run("a", new AbortController().signal));\n${SETTLED}`, env, tmp, `call: async (req) => ({ text: answerAll(req.prompt), costUsd: 0.5 }), append: async (l) => { if (l.some((x) => x.type === "card") && ++appends === 2) throw new Error("disk full"); await appendLogLines(logs + "/a.jsonl", l); }`);
      expect(runLines(tmp).map((r) => r.outcome)).toEqual(["partial"]);
      expect(seen[0]).toEqual({ outcome: "partial", cards: 25 });
      expect(attempts(seen[1])).toBe(1);
      expect(rows(seen[2])).toEqual([expect.objectContaining({ completed: true, status: "ok" })]);
    });

    test("d: the pass's own run line fails to write: the failure record still writes the one line", async () => {
      const { tmp, env } = withCards(3);
      const { seen } = await drive(`seen.push(await deps.run("a", new AbortController().signal));\n${SETTLED}`, env, tmp, `call: async (req) => ({ text: answerAll(req.prompt) }), append: async (l) => { if (l.some((x) => x.type === "run")) throw new Error("disk full"); await appendLogLines(logs + "/a.jsonl", l); }`);
      expect(runLines(tmp)).toEqual([expect.objectContaining({ outcome: "partial", cards: 3 })]);
      expect(String(runLines(tmp)[0]!.reason)).toStartWith("disk full");
      expect(seen[0]).toEqual({ outcome: "partial", cards: 3 });
      expect(attempts(seen[1])).toBe(1);
      expect(rows(seen[2])).toEqual([expect.objectContaining({ completed: true, status: "ok" })]);
    });

    test("b2: the bound fires after the pass's run line landed, while it still records its state: no second line or state record", async () => {
      const { tmp, env } = withCards(3);
      const { seen } = await drive(`
const ac = new AbortController();
let bound: Promise<unknown> | null = null;
const p = deps.run("a", ac.signal);
seen.push(await p);
seen.push((await bound) ?? null);
${SETTLED}`, env, tmp, `call: async (req) => ({ text: answerAll(req.prompt) }), append: async (l) => { await appendLogLines(logs + "/a.jsonl", l); if (l.some((x) => x.type === "run")) setImmediate(() => { ac.abort(); bound = deps.recordFailed("a", "the pass timed out after 7 ms"); }); }`);
      expect(runLines(tmp).map((r) => r.outcome)).toEqual(["ok"]);
      expect(seen[0]).toMatchObject({ outcome: "ok", cards: 3 });
      expect(seen[1]).toBeNull();
      expect(attempts(seen[2])).toBe(1);
      expect(rows(seen[3])).toEqual([expect.objectContaining({ completed: true, status: "ok" })]);
    });

    test("Run now's shape: an aborted pass writes no line, and a record after it carries the run's id and counts", async () => {
      const { tmp, env } = withCards(30);
      const { seen } = await drive(`
const ac = new AbortController();
const p = deps.run("a", ac.signal);
await g1.reached;
ac.abort();
g1.open();
seen.push(await p);
seen.push(await deps.recordFailed("a", "the pass timed out after 7 ms"));
`, env, tmp, SECOND_WAITS);
      const lines = logOf(tmp);
      const runs = lines.filter((l) => l.type === "run");
      expect(seen[0]).toEqual({ outcome: "aborted" });
      expect(seen[1]).toBe("partial");
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ outcome: "partial", cards: 25 });
      expect(lines.filter((l) => l.type === "card").every((c) => c.runId === runs[0]!.runId)).toBe(true);
    });

    test("the pass's run line fails to write while the bound fires: the bound waits for it, then writes the one line", async () => {
      const { tmp, env } = withCards(3);
      const { seen } = await drive(`
const ac = new AbortController();
const p = deps.run("a", ac.signal);
await g1.reached;
ac.abort();
const bound = deps.recordFailed("a", "the pass timed out after 7 ms");
g1.open();
seen.push(await p);
seen.push((await bound) ?? null);
seen.push(await deps.readState("a"));
`, env, tmp, `call: async (req) => ({ text: answerAll(req.prompt) }), append: async (l) => { if (l.some((x) => x.type === "run")) { await g1.pass(); throw new Error("disk full"); } await appendLogLines(logs + "/a.jsonl", l); }`);
      const lines = logOf(tmp);
      const runs = lines.filter((l) => l.type === "run");
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ outcome: "partial", cards: 3 });
      expect(String(runs[0]!.reason)).toStartWith("the pass timed out after 7 ms");
      expect(lines.filter((l) => l.type === "card").every((c) => c.runId === runs[0]!.runId)).toBe(true);
      expect(seen[1]).toBe("partial");
      expect(attempts(seen[2])).toBe(1);
    });

    test("a slot left by Run now's record is not read by a later pass that refuses before it starts", async () => {
      const { tmp, env } = withCards(30);
      const { seen } = await drive(`
const ac = new AbortController();
const p = deps.run("a", ac.signal);
await g1.reached;
ac.abort();
g1.open();
await p;
seen.push(await deps.recordFailed("a", "the pass timed out after 7 ms"));
// The wiki leaves the registry: the next pass refuses before it has any progress.
const reg = getWikiRegistry();
reg.splice(reg.findIndex((e) => e.name === "a"), 1);
seen.push(await deps.run("a", new AbortController().signal));
seen.push(await deps.recordFailed("a", "later"));
`, env, tmp, SECOND_WAITS);
      const runs = logOf(tmp).filter((l) => l.type === "run");
      expect(seen[0]).toBe("partial");
      expect(seen[1]).toMatchObject({ outcome: "refused" });
      expect(seen[2]).toBe("failed");
      expect(runs).toHaveLength(2);
      expect(runs[1]).toMatchObject({ outcome: "failed", cards: 0, reason: "later" });
      expect(runs[1]!.runId).not.toBe(runs[0]!.runId);
    });

    test("the bound's record fails to write: its claim is released, and the pass reports its own end, not the record's", async () => {
      const { tmp, env } = withCards(30);
      // The run line's file is a folder: the record's append throws; the pass's cards go elsewhere.
      mkdirSync(path.join(tmp, "logs", "a.jsonl"), { recursive: true });
      const { seen } = await drive(`
const ac = new AbortController();
const p = deps.run("a", ac.signal);
await g1.reached;
ac.abort();
seen.push(await deps.recordFailed("a", "the pass timed out after 7 ms").then(() => "recorded", () => "threw"));
g1.open();
seen.push(await p);
seen.push(agentRuns());
`, env, tmp, `${SECOND_WAITS}, append: (l) => appendLogLines(logs + "/cards.jsonl", l)`);
      expect(seen[0]).toBe("threw");
      expect(seen[1]).toEqual({ outcome: "aborted" });
      expect(rows(seen[2])).toEqual([expect.objectContaining({ completed: true, status: "error" })]);
    });

    test("e: the loop stops mid-pass: no run line, no state, the row an error", async () => {
      const { tmp, env } = withCards(30);
      const { seen } = await drive(`
loop(deps, ["a"]);
await advance(60_000);
await g1.reached;
const stopping = stopWorkMapLoop(5_000);
g1.open();
await stopping;
await until(() => agentRuns().every((r) => r.completed), "the row closes");
${SETTLED}`, env, tmp, SECOND_WAITS);
      expect(runLines(tmp)).toEqual([]);
      expect(attempts(seen[0])).toBe(0);
      expect(rows(seen[1])).toEqual([expect.objectContaining({ completed: true, status: "error" })]);
    });

    test("f: the loop stops after the bound fired: still the bound's one line, and the row agrees", async () => {
      const { tmp, env } = withCards(30);
      const { seen } = await drive(`
loop(deps, ["a"]);
await advance(60_000);
await g1.reached;
await advance(TRIAGE_PASS_BOUND_MS);
await until(async () => (await runsOf("a")).length === 1, "the bound's line");
const stopping = stopWorkMapLoop(5_000);
g1.open();
await stopping;
await until(() => agentRuns().every((r) => r.completed), "the row closes");
${SETTLED}`, env, tmp, SECOND_WAITS);
      const runs = runLines(tmp);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ outcome: "partial", cards: 25 });
      expect(String(runs[0]!.reason)).toStartWith("the pass timed out after");
      expect(attempts(seen[0])).toBe(1);
      expect(rows(seen[1])).toEqual([expect.objectContaining({ completed: true, status: "ok" })]);
    });

    test("g: the bound fires between wikis: no line and no pass for the next wiki, no timeout on the one that finished", async () => {
      const { tmp, b, env } = withCards(1);
      mkdirSync(path.join(b, "plans"));
      writeFileSync(path.join(b, "plans", "p.mdx"), `---\ntitle: T\n---\n# T\n\n${card(1)}`);
      const { seen } = await drive(`
const triage = { ...deps, beforeCheck: async (wiki: string, nowMs: number) => { if (wiki === "b") await g1.pass(); return deps.beforeCheck(wiki, nowMs); } };
loop(triage, ["a", "b"]);
await advance(60_000);
await g1.reached;
await advance(TRIAGE_PASS_BOUND_MS);
g1.open();
await until(() => !triagePassHeld(), "the check ends");
seen.push(agentRuns().map((r) => r.name));
`, env, tmp, `call: async (req) => ({ text: answerAll(req.prompt) })`);
      expect(runLines(tmp).map((r) => r.outcome)).toEqual(["ok"]);
      expect(runLines(tmp, "b")).toEqual([]);
      expect(seen[0]).toEqual(["Decision triage: a"]);
    });

    test("h: a pass that does not settle: the bound's line at the bound, nothing more when it settles, the row agrees", async () => {
      const { tmp, env } = withCards(30);
      const { seen } = await drive(`
loop(deps, ["a"]);
await advance(60_000);
await g1.reached;
await advance(TRIAGE_PASS_BOUND_MS);
await until(async () => (await runsOf("a")).length === 1, "the bound's line");
seen.push(agentRuns().map((r) => r.completed));
g1.open();
await until(() => !triagePassHeld(), "the pass settles");
${SETTLED}`, env, tmp, SECOND_WAITS);
      expect(runLines(tmp).map((r) => r.outcome)).toEqual(["partial"]);
      expect(seen[0]).toEqual([false]);
      expect(attempts(seen[1])).toBe(1);
      expect(rows(seen[2])).toEqual([expect.objectContaining({ completed: true, status: "ok" })]);
    });
  });
});

describe("a night's one warning", () => {
  const warnings = (lines: string[]) => lines.filter((l) => l.startsWith("warning ") && l.includes("Decision triage for a"));
  function oneCard(n: number, big = false) {
    const w = wikis();
    mkdirSync(path.join(w.a, "plans"));
    const body = Array.from({ length: n }, (_, i) => `<Question id="O${i}" choices="A|B">\nSkal vi ${i}?\n\n**Recommendation: A.** Fordi.\n</Question>\n`).join("\n");
    const huge = big ? `<Question id="BIG" choices="A|B">\nSkal vi ${"x".repeat(130_000)}?\n\n**Recommendation: A.** Fordi.\n</Question>\n` : "";
    writeFileSync(path.join(w.a, "plans", "p.mdx"), `---\ntitle: T\n---\n# T\n\n${body}\n${huge}`);
    return w;
  }
  const RUN = `seen.push(await deps.run("a", new AbortController().signal));`;

  test("a clean night warns nothing and has no reason", async () => {
    const { tmp, env } = oneCard(2);
    const { lines } = await drive(RUN, env, tmp, `call: async (req) => ({ text: answerAll(req.prompt) })`);
    expect(warnings(lines)).toEqual([]);
    const run = readFileSync(path.join(tmp, "logs", "a.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.type === "run")!;
    expect(run).toMatchObject({ outcome: "ok" });
    expect(run.reason).toBeUndefined();
  });

  test("the model dropping a card warns once, with the count", async () => {
    const { tmp, env } = oneCard(3);
    const { lines } = await drive(RUN, env, tmp, `call: async (req) => ({ text: answerAll(req.prompt, 1) })`);
    expect(warnings(lines)).toEqual(["warning Decision triage for a: partial: 2 card(s) missing from the answer"]);
  });

  test("an oversized card beside verdicts stays ok, and warns once with the count", async () => {
    const { tmp, env } = oneCard(1, true);
    const { seen, lines } = await drive(RUN, env, tmp, `call: async (req) => ({ text: answerAll(req.prompt) })`);
    expect(seen[0]).toMatchObject({ outcome: "ok" });
    expect(warnings(lines)).toEqual(["warning Decision triage for a: ok: 1 card(s) over the call's size limit"]);
  });
});

describe("every pass is one /agents run and one stamped span", () => {
  const RUN = `
const p = deps.run("a", new AbortController().signal);
seen.push(agentRuns());
try { seen.push(await p); } catch (err) { seen.push({ threw: (err as Error).message.length > 0 }); }
seen.push(agentRuns(), finishes);
`;
  const page = (a: string, body: string) => {
    mkdirSync(path.join(a, "plans"));
    writeFileSync(path.join(a, "plans", "p.mdx"), `---\ntitle: T\n---\n# T\n\n<Question id="O1" choices="A|B">\n${body}\n</Question>\n`);
  };

  test("a pass opens a decision_triage run and closes it ok with the card count", async () => {
    const w = wikis();
    page(w.a, "Skal vi?\n\n**Recommendation: A.** Fordi.");
    const { seen } = await drive(RUN, w.env, w.tmp);
    expect(seen[0]).toEqual([{ kind: "decision_triage", name: "Decision triage: a", completed: false, status: null, traceId: null }]);
    expect(seen[1]).toMatchObject({ outcome: "ok", cards: 1 });
    expect(seen[2]).toEqual([{ kind: "decision_triage", name: "Decision triage: a", completed: true, status: "ok", traceId: "t-1" }]);
    expect(seen[3]).toEqual([{ status: "ok", attrs: expect.objectContaining({ agentKind: "decision_triage", agentName: "Decision triage: a", wiki: "a", outcome: "ok", cards: 1 }) }]);
  });

  test("a refused pass closes as an error", async () => {
    const w = wikis();
    const { seen } = await drive(RUN, w.env, w.tmp);
    expect(seen[1]).toMatchObject({ outcome: "refused", reason: "the wiki has no pages" });
    expect(seen[2]).toEqual([expect.objectContaining({ completed: true, status: "error" })]);
    expect(seen[3]).toEqual([{ status: "error", attrs: expect.objectContaining({ agentKind: "decision_triage", outcome: "refused" }) }]);
  });

  test("a pass that throws closes as an error and rethrows", async () => {
    const w = wikis();
    page(w.a, "Skal vi?");
    // A file where the log folder goes: the run line and the failure record both throw.
    writeFileSync(path.join(w.tmp, "logs"), "not a folder");
    const { seen } = await drive(RUN, w.env, w.tmp);
    expect(seen[1]).toEqual({ threw: true });
    expect(seen[2]).toEqual([expect.objectContaining({ kind: "decision_triage", completed: true, status: "error" })]);
    expect(seen[3]).toEqual([{ status: "error", attrs: expect.objectContaining({ agentKind: "decision_triage", agentName: "Decision triage: a", outcome: "failed" }) }]);
  });
});
