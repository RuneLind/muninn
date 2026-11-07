/**
 * `POST /api/wiki/decision-triage/run`: every refusal and the single-flight it
 * shares with the loop, over a stub loop half; then one real model-off pass in its
 * own process (the registry memo and the answer config read the environment once),
 * writing its run line and state into a temp triage dir. No DB.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { tryHoldTriagePass, type TriageLoopDeps, type TriagePassOutcome } from "../../wiki/decision-triage/loop-deps.ts";
import { __setWikiReadonlyForTest } from "../../wiki/readonly.ts";
import type { WikiRegistryEntry } from "../../wiki/registry.ts";
import { registerWikiDecisionTriageRunRoute, type TriageRunBody, type TriageRunDeps } from "./wiki-decision-triage-run.ts";

afterEach(() => __setWikiReadonlyForTest(undefined));

function fixture(over: Partial<TriageRunDeps> = {}, configOver: Partial<ReturnType<TriageRunDeps["config"]>> = {}) {
  const tmp = testTempDirSync(path.join(tmpdir(), "triage-run-"));
  const root = (name: string) => {
    const r = path.join(tmp, name);
    mkdirSync(r);
    return r;
  };
  const registry: WikiRegistryEntry[] = [
    { name: "mimir", root: root("mimir"), source: "extra" },
    { name: "jarvis", root: root("jarvis"), source: "extra" },
    { name: "ro", root: root("ro"), source: "extra" },
  ];
  const config = {
    schedulerEnabled: true, workMapWikis: ["mimir", "jarvis", "ro"], workMapHour: 5, workMapModel: "m",
    profile: "default" as const, decisionTriageRepoRoots: "/r", ...configOver,
  };
  const runs: string[] = [];
  let next: () => Promise<TriagePassOutcome> = async () => ({ outcome: "ok", cards: 3 });
  const loop: TriageLoopDeps = {
    wikis: async (covered) => [...covered],
    beforeCheck: async () => {},
    readState: async () => null,
    run: async (wiki) => {
      runs.push(wiki);
      return next();
    },
    recordFailed: async () => "failed",
  };
  const deps: TriageRunDeps = {
    config: () => config,
    dir: path.join(tmp, "triage"),
    now: Date.now,
    registry: () => registry,
    isReadonly: () => false,
    isReadonlyRoot: (r) => r === registry[2]!.root,
    answerWikis: () => new Set(["mimir", "ro"]),
    loop: () => loop,
    modelOff: () => true,
    hold: tryHoldTriagePass,
    ...over,
  };
  const app = new Hono();
  registerWikiDecisionTriageRunRoute(app, () => deps);
  const post = (q = "?wiki=mimir", headers: Record<string, string> = { "content-type": "application/json" }) =>
    app.request(`/api/wiki/decision-triage/run${q}`, { method: "POST", headers, body: "{}" });
  return { post, runs, setNext: (fn: typeof next) => (next = fn) };
}

describe("POST /api/wiki/decision-triage/run", () => {
  test("a pass: the outcome and card count, through the loop's half", async () => {
    const { post, runs } = fixture();
    const res = await post("?wiki=MIMIR");
    expect(res.status).toBe(200);
    expect((await res.json()) as TriageRunBody).toEqual({ wiki: "mimir", outcome: "ok", cards: 3 });
    expect(runs).toEqual(["mimir"]);
  });

  test("400 without a wiki; 404 outside the status line's scope; 415 for a non-JSON POST", async () => {
    const { post, runs } = fixture();
    expect((await post("")).status).toBe(400);
    for (const w of ["jarvis", "ghost"]) expect((await post(`?wiki=${w}`)).status).toBe(404);
    expect((await post("?wiki=mimir", { "content-type": "text/plain" })).status).toBe(415);
    expect(runs).toEqual([]);
  });

  test("403 on a readonly instance and on a readonly root, before anything runs", async () => {
    const { post, runs } = fixture();
    const root = await post("?wiki=ro");
    expect(root.status).toBe(403);
    expect(await root.json()).toMatchObject({ readonly: true });
    __setWikiReadonlyForTest(true);
    const instance = await post();
    expect(instance.status).toBe(403);
    expect(await instance.json()).toMatchObject({ readonly: true });
    expect(runs).toEqual([]);
  });

  test("409 while the model call is on (D3), and while the pass is off", async () => {
    const on = fixture({ modelOff: () => false });
    const res = await on.post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ modelOn: true });
    const off = fixture({}, { decisionTriageRepoRoots: null });
    const res2 = await off.post();
    expect(res2.status).toBe(409);
    expect(await res2.json()).toMatchObject({ off: true, error: "the pass is off: DECISION_TRIAGE_REPO_ROOTS is not set" });
    const noLoop = fixture({ loop: () => null });
    expect((await noLoop.post()).status).toBe(409);
    expect([...on.runs, ...off.runs, ...noLoop.runs]).toEqual([]);
  });

  test("the single-flight: 409 while the loop holds it, and the loop's hold fails while a click runs", async () => {
    const { post, runs, setNext } = fixture();
    const loopHold = tryHoldTriagePass()!;
    const busy = await post();
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ busy: true });
    expect(runs).toEqual([]);
    loopHold();

    let finish!: (v: TriagePassOutcome) => void;
    setNext(() => new Promise((r) => (finish = r)));
    const first = post();
    for (let i = 0; i < 100 && runs.length === 0; i++) await Bun.sleep(1);
    expect(runs).toEqual(["mimir"]);
    expect(tryHoldTriagePass()).toBeNull();
    expect((await post()).status).toBe(409);
    finish({ outcome: "partial", cards: 2, reason: "the model call is off (D19)" });
    expect(await (await first).json()).toEqual({ wiki: "mimir", outcome: "partial", cards: 2, reason: "the model call is off (D19)" });
    const after = tryHoldTriagePass();
    expect(after).not.toBeNull();
    after!();
  });

  test("a pass that throws: 500 JSON, and the single-flight is let go", async () => {
    const { post, setNext } = fixture();
    setNext(async () => {
      throw new Error("boom");
    });
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "the triage pass failed" });
    const hold = tryHoldTriagePass();
    expect(hold).not.toBeNull();
    hold!();
  });
});

describe("a real model-off pass", () => {
  test("writes the night's run line and state into the triage dir, and answers with them", async () => {
    const tmp = testTempDirSync(path.join(tmpdir(), "triage-run-real-"));
    const wiki = path.join(tmp, "a");
    mkdirSync(path.join(wiki, "plans"), { recursive: true });
    mkdirSync(path.join(tmp, "no-bots"));
    writeFileSync(path.join(wiki, "plans", "p.mdx"), `---\ntitle: T\n---\n# T\n\n<Question id="O1" choices="A|B">\nSkal vi?\n\n**Recommendation: A.** Fordi.\n</Question>\n`);
    const logs = path.join(tmp, "triage");
    const driver = path.join(tmp, "driver.ts");
    const imp = (rel: string) => JSON.stringify(path.join(import.meta.dir, rel));
    writeFileSync(driver, `
import { Hono } from "hono";
import { realTriageLoopDeps } from ${imp("../../wiki/decision-triage/loop-deps.ts")};
import { agentStatus } from ${imp("../../observability/agent-status.ts")};
import { realTriageRunDeps, registerWikiDecisionTriageRunRoute } from ${imp("./wiki-decision-triage-run.ts")};
const config = { schedulerEnabled: true, workMapWikis: ["a"], workMapHour: 0, workMapModel: "m", profile: "default", decisionTriageRepoRoots: ${JSON.stringify(path.join(tmp, "src"))}, wikiAnswers: { wikis: new Set(["a"]), owner: null, groups: {} } };
const finishes: unknown[] = [];
const loop = realTriageLoopDeps(config as never, ${JSON.stringify(logs)}, { answers: async () => [], floor: async () => ({ labelled: 0, added: 0, addedPages: 0, met: false }) }, () => ({ traceId: "t-1", finish: (status: string, attrs: unknown) => void finishes.push({ status, attrs }) }));
const app = new Hono();
registerWikiDecisionTriageRunRoute(app, () => ({ ...realTriageRunDeps(config as never), dir: ${JSON.stringify(logs)}, loop: () => loop }));
const res = await app.request("/api/wiki/decision-triage/run?wiki=a", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const ring = agentStatus.getRecentCompleted().map((r) => ({ kind: r.kind, name: r.name, status: r.status, traceId: r.traceId, botName: r.botName }));
console.log(JSON.stringify({ status: res.status, body: await res.json(), finishes, ring }));
process.exit(0);
`);
    const proc = Bun.spawn([process.execPath, "--no-env-file", driver], {
      cwd: tmp,
      env: { PATH: process.env.PATH ?? "", HOME: tmp, MUNINN_BOTS_DIR: path.join(tmp, "no-bots"), DATABASE_URL: "postgresql://x@127.0.0.1:1/x_test", WIKI_EXTRA: `a=${wiki}`, WIKI_ANSWER_WIKIS: "a" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    if (!out.trim()) throw new Error(`driver printed nothing: ${err}`);
    const got = JSON.parse(out.trim().split("\n").pop()!) as { status: number; body: TriageRunBody; finishes: { status: string; attrs: Record<string, unknown> }[]; ring: Record<string, unknown>[] };
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ wiki: "a", outcome: "ok", cards: 1, reason: "the model call is off (D19)" });
    const lines = readFileSync(path.join(logs, "a.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.type)).toEqual(["card", "run"]);
    expect(lines[1]).toMatchObject({ wiki: "a", model: "none", promptVersion: "off", cards: 1, outcome: "ok" });
    const state = JSON.parse(readFileSync(path.join(logs, "state", "a.json"), "utf8")) as { lastSuccessAt?: number };
    expect(state.lastSuccessAt).toBeGreaterThan(Date.now() - 60_000);
    expect(got.finishes).toEqual([{ status: "ok", attrs: expect.objectContaining({ agentKind: "decision_triage", agentName: "Decision triage: a", outcome: "ok", cards: 1 }) }]);
    expect(got.ring).toEqual([{ kind: "decision_triage", name: "Decision triage: a", status: "ok", traceId: "t-1", botName: "decision-triage" }]);
  }, 30_000);
});
