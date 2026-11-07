/**
 * `GET /api/wiki/decision-triage/status` and `/overview` over a temp triage dir
 * and temp wiki roots: the inbox's scope (404 outside it), a missing log and
 * state as an empty answer, a seeded log counted, and the pass's covered and
 * skipped wikis with the loop's own reasons. No DB, no git.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { testTempDirSync } from "../../test/temp-dir.ts";
import type { WikiRegistryEntry } from "../../wiki/registry.ts";
import { appendLogLines, nightlyLogPath, triageStateStore } from "../../wiki/decision-triage/log.ts";
import type { CardLine, RunLine } from "../../wiki/decision-triage/schema.ts";
import { registerWikiDecisionTriageStatusRoutes, type TriageOverviewBody, type TriageStatusBody, type TriageStatusDeps } from "./wiki-decision-triage-status.ts";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 7, 9);

function fixture(over: Partial<ReturnType<TriageStatusDeps["config"]>> = {}) {
  const tmp = testTempDirSync(path.join(tmpdir(), "triage-status-"));
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
  const dir = path.join(tmp, "triage");
  const config = {
    schedulerEnabled: true, workMapWikis: ["mimir", "jarvis", "ro", "ghost"], workMapHour: 5, workMapModel: "m",
    profile: "default" as const, decisionTriageRepoRoots: "/r", ...over,
  };
  const deps: TriageStatusDeps = {
    config: () => config,
    dir,
    now: () => NOW,
    registry: () => registry,
    isReadonly: () => false,
    isReadonlyRoot: (r) => r === registry[2]!.root,
    answerWikis: () => new Set(["mimir", "ro"]),
  };
  const app = new Hono();
  registerWikiDecisionTriageStatusRoutes(app, () => deps);
  return { app, dir, registry };
}

const run = (at: number, over: Partial<RunLine> = {}): RunLine => ({
  type: "run", runId: `r${at}`, at, wiki: "mimir", model: "none", promptVersion: "off", usage: { calls: 0 },
  repoRoots: "/r", repos: [], cards: 0, floor: null, outcome: "ok", ...over,
});
const card = (r: RunLine, id: string, over: Partial<CardLine> = {}): CardLine => ({
  type: "card", runId: r.runId, at: r.at, wiki: "mimir", promptVersion: "off", relPath: "plans/p.mdx", id, questionHash: "h",
  recommendation: null, verdict: "NO_VERDICT", ...over,
});

describe("GET /api/wiki/decision-triage/status", () => {
  test("400 without a wiki; 404 outside the inbox's scope", async () => {
    const { app } = fixture();
    expect((await app.request("/api/wiki/decision-triage/status")).status).toBe(400);
    for (const w of ["jarvis", "ro", "ghost", "nope"]) expect((await app.request(`/api/wiki/decision-triage/status?wiki=${w}`)).status).toBe(404);
  });

  test("no log and no state: a well-formed empty answer", async () => {
    const { app } = fixture();
    const res = await app.request("/api/wiki/decision-triage/status?wiki=MIMIR");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TriageStatusBody;
    expect(body).toMatchObject({ wiki: "mimir", lastRun: null, nights: [], reposNotFound: [], broken: 0, pass: { on: true, why: null } });
    expect(body.nextDueAt).toBe(NOW);
  });

  test("a seeded log and state: the last run, its night and the next due time", async () => {
    const { app, dir } = fixture();
    const r = run(NOW - 3 * H, { cards: 2, repos: [{ repo: "gone", found: false, reason: "no such folder under the roots" }] });
    await appendLogLines(nightlyLogPath("mimir", dir), [card(r, "O1", { codeFacts: true }), card(r, "O2", { verdict: "ANSWERED" }), r]);
    await triageStateStore(dir).record("mimir", { at: r.at, outcome: "ok" });
    const body = (await (await app.request("/api/wiki/decision-triage/status?wiki=mimir")).json()) as TriageStatusBody;
    expect(body.lastRun).toMatchObject({ at: r.at, cards: 2, codeFacts: 1, model: "none" });
    expect(body.nights).toEqual([{ night: "2026-11-07", outcome: "ok", reason: null, cards: 2, codeFacts: 1, answered: 1, reposNotFound: ["gone"] }]);
    expect(body.reposNotFound).toEqual([{ repo: "gone", reason: "no such folder under the roots" }]);
    // 06:00 Oslo + 20 h falls before tomorrow's 05:00, so tomorrow's hour.
    expect(body.nextDueAt).toBe(Date.UTC(2026, 10, 8, 4));
  });

  test("a torn log line is counted, not a 500", async () => {
    const { app, dir } = fixture();
    mkdirSync(dir, { recursive: true });
    writeFileSync(nightlyLogPath("mimir", dir), '{"type":"ru');
    const body = (await (await app.request("/api/wiki/decision-triage/status?wiki=mimir")).json()) as TriageStatusBody;
    expect(body).toMatchObject({ lastRun: null, broken: 1 });
  });

  test("the pass off says why", async () => {
    const { app } = fixture({ decisionTriageRepoRoots: null });
    const body = (await (await app.request("/api/wiki/decision-triage/status?wiki=mimir")).json()) as TriageStatusBody;
    expect(body.pass).toEqual({ on: false, why: "DECISION_TRIAGE_REPO_ROOTS is not set", modelOff: true });
  });
});

describe("GET /api/wiki/decision-triage/overview", () => {
  test("covered and skipped with the loop's and the scope's reasons, and each covered wiki's last run", async () => {
    const { app, dir } = fixture();
    const r = run(NOW - H, { cards: 1 });
    await appendLogLines(nightlyLogPath("mimir", dir), [r]);
    const body = (await (await app.request("/api/wiki/decision-triage/overview")).json()) as TriageOverviewBody;
    expect(body.pass).toMatchObject({ on: true, why: null, modelOff: true, model: "m", hour: 5, covered: ["mimir"] });
    expect(body.pass.skipped).toEqual([
      { wiki: "ro", reason: "a readonly root (WIKI_READONLY_ROOTS)" },
      { wiki: "ghost", reason: "not a registered wiki" },
      { wiki: "jarvis", reason: "not in WIKI_ANSWER_WIKIS" },
    ]);
    expect(body.wikis).toEqual([{ wiki: "mimir", lastRun: expect.objectContaining({ at: r.at }), reposNotFound: [], nextDueAt: expect.any(Number) }]);
  });

  test("a run line with no repos is counted broken: status and overview still answer 200 for every wiki", async () => {
    const { app, dir } = fixture();
    mkdirSync(dir, { recursive: true });
    writeFileSync(nightlyLogPath("mimir", dir), `${JSON.stringify({ type: "run", runId: "bad", at: NOW - H })}\n${JSON.stringify(run(NOW - 2 * H, { cards: 1 }))}\n`);
    const status = await app.request("/api/wiki/decision-triage/status?wiki=mimir");
    expect(status.status).toBe(200);
    expect((await status.json()) as TriageStatusBody).toMatchObject({ broken: 1, lastRun: { at: NOW - 2 * H } });
    const overview = await app.request("/api/wiki/decision-triage/overview");
    expect(overview.status).toBe(200);
    expect(((await overview.json()) as TriageOverviewBody).wikis.map((w) => w.wiki)).toEqual(["mimir"]);
  });

  test("the loop off: off with its reason, nothing covered", async () => {
    const cases: [Parameters<typeof fixture>[0], string][] = [
      [{ workMapWikis: [] }, "WORK_MAP_WIKIS is not set"],
      [{ profile: "nais" }, "the profile is nais"],
      [{ schedulerEnabled: false }, "SCHEDULER_ENABLED is off"],
    ];
    for (const [over, why] of cases) {
      const { app } = fixture(over);
      const body = (await (await app.request("/api/wiki/decision-triage/overview")).json()) as TriageOverviewBody;
      expect(body.pass).toMatchObject({ on: false, why, covered: [], skipped: [] });
      expect(body.wikis).toEqual([]);
    }
  });
});
