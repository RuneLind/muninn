/** The real loop half, in its own process: the registry memo and the answer
 *  config read the environment once, so each case boots a fresh one. */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { commitAt, pushMain, repoWithOrigin, write } from "./test-repo.ts";

const LOOP_DEPS = path.join(import.meta.dir, "loop-deps.ts");
const LOGTAPE = Bun.resolveSync("@logtape/logtape", import.meta.dir);
const LOG = path.join(import.meta.dir, "log.ts");

/** Runs `steps` (a function body over `deps`, `step`, `root`), returning what each `step(...)` saw and the log lines. `model` is more of the run's seams. */
async function drive(steps: string, env: Record<string, string>, tmp: string, model = "") {
  const driver = path.join(tmp, "driver.ts");
  writeFileSync(driver, `
import { configure } from ${JSON.stringify(LOGTAPE)};
import { realTriageLoopDeps } from ${JSON.stringify(LOOP_DEPS)};
import { appendLogLines, readLog } from ${JSON.stringify(LOG)};
import { renameSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
const lines: string[] = [];
await configure({ sinks: { mem: (r) => void lines.push(r.level + " " + r.message.join("")) }, loggers: [{ category: "muninn", lowestLevel: "info", sinks: ["mem"] }, { category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] }] });
const config = { decisionTriageRepoRoots: process.env.TEST_REPO_ROOTS ?? "/r", workMapModel: "m" };
const logs = ${JSON.stringify(path.join(tmp, "logs"))};
const answerAll = (prompt: string, only?: number) => JSON.stringify({ verdicts: [...prompt.matchAll(/"card": "(c\\d+)"/g)].slice(0, only).map((m) => ({ card: m[1], verdict: "DEFAULT", costOfDelay: "low", reversible: true, onlyOwnerHas: null, why: "w", evidence: [], restsOnPrs: [] })) });
let calls = 0;
const seams = { answers: async () => [], floor: async () => ({ labelled: 0, added: 0, addedPages: 0, met: false }) };
const deps = realTriageLoopDeps(config as never, logs, { ...seams, ${model} })!;
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
    expect(seen[0]).toEqual({ outcome: "partial" });
    expect((seen[1] as unknown as { attempts: { outcome: string }[] }).attempts[0]!.outcome).toBe("ok");
  });

  test("a record after a run that finished is about no run: a fresh id and zeros, never the finished run's", async () => {
    const { tmp, env } = withCards(1);
    await drive(`
await deps.run("a", new AbortController().signal);
await deps.recordFailed("a", "later");
`, env, tmp, `call: async (req) => ({ text: answerAll(req.prompt) })`);
    const runs = logOf(tmp).filter((l) => l.type === "run");
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ outcome: "failed", cards: 0, usage: { calls: 0 }, reason: "later" });
    expect(runs[1]!.runId).not.toBe(runs[0]!.runId);
  });

  test("a record consumes the progress, so a second one is no second partial", async () => {
    const { tmp, env } = withCards(30);
    const { seen } = await drive(`${BOUND}
seen.push(await deps.recordFailed("a", "again"));
`, env, tmp, HANG_SECOND);
    expect(seen[2]).toBe("failed");
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
