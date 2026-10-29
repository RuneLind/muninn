import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { __setWikiReadonlyForTest } from "../../wiki/readonly.ts";
import { __resetWorkMapRunsForTest, type WorkMapRunDeps } from "../../wiki/work-map/run.ts";
import type { WorkMapAttempt, WorkMapState } from "../../wiki/work-map/state.ts";
import { fileStateStore } from "../../wiki/work-map/state.ts";
import { writeFileSync } from "node:fs";
import { testTempDirSync } from "../../test/temp-dir.ts";
import path from "node:path";
import { registerWikiWorkMapRoutes, WORK_MAP_REFRESH_COOLDOWN_MS } from "./wiki-work-map.ts";

const NOW = 1_800_000_000_000;

afterEach(() => {
  __setWikiReadonlyForTest();
  __resetWorkMapRunsForTest();
});

function setup(over: Partial<WorkMapRunDeps> = {}, state: WorkMapState | null = null) {
  let modelCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const recorded: WorkMapAttempt[] = [];
  const deps: WorkMapRunDeps = {
    config: { workMapWikis: ["mimir"], workMapModel: "m", schedulerEnabled: true, profile: "default" },
    now: () => NOW,
    registry: () => [{ name: "mimir", root: "/w/mimir", source: "extra" } as never, { name: "other", root: "/w/other", source: "extra" } as never],
    isReadonly: () => false,
    isReadonlyRoot: () => false,
    inputs: {
      urlConfigured: true,
      ledger: async () => {
        await gate;
        return { ok: false, reason: "cold" };
      },
      sessions: async () => ({ memo: null, timedOut: false }),
      rebuildIndex: async () => null,
    },
    readText: async () => null,
    model: async () => {
      modelCalls++;
      return { text: "{}" };
    },
    state: {
      read: async () => state,
      record: async (_w, a) => {
        recorded.push(a);
        return { wiki: "mimir", attempts: recorded };
      },
    },
    ...over,
  };
  const app = new Hono();
  registerWikiWorkMapRoutes(app, {} as Config, () => deps);
  const post = (q: string, json = true) =>
    app.request(`/api/wiki/work-map/refresh?${q}`, { method: "POST", headers: json ? { "content-type": "application/json" } : {}, body: json ? "{}" : "" });
  return { app, post, modelCalls: () => modelCalls, release, recorded };
}

describe("POST /api/wiki/work-map/refresh", () => {
  test("403 with no model call: readonly instance, scheduler off, unlisted wiki, readonly root, nais", async () => {
    const cases: [() => void, Partial<WorkMapRunDeps>, string][] = [
      [() => __setWikiReadonlyForTest(true), {}, "wiki=mimir"],
      [() => {}, { config: { workMapWikis: ["mimir"], workMapModel: "m", schedulerEnabled: false, profile: "default" } }, "wiki=mimir"],
      [() => {}, {}, "wiki=other"],
      [() => {}, { isReadonlyRoot: () => true }, "wiki=mimir"],
      [() => {}, { config: { workMapWikis: ["mimir"], workMapModel: "m", schedulerEnabled: true, profile: "nais" } }, "wiki=mimir"],
    ];
    for (const [arrange, over, q] of cases) {
      arrange();
      const s = setup(over);
      const res = await s.post(q);
      expect(res.status).toBe(403);
      expect(s.modelCalls()).toBe(0);
      expect(s.recorded).toEqual([]);
      __setWikiReadonlyForTest();
    }
  });

  test("415 for a non-JSON POST, 400 without a wiki, 404 for an unknown one", async () => {
    const s = setup();
    expect((await s.post("wiki=mimir", false)).status).toBe(415);
    expect((await s.post("")).status).toBe(400);
    expect((await s.post("wiki=nope")).status).toBe(404);
  });

  test("202 starts a run; a second POST joins it", async () => {
    const s = setup();
    const first = await s.post("wiki=mimir");
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ joined: false, startedAt: NOW });
    const second = await s.post("wiki=mimir");
    expect(await second.json()).toEqual({ joined: true, startedAt: NOW });
    s.release();
  });

  test("429 within 10 minutes of a success unless force=1; the 429 is not an attempt", async () => {
    const recent: WorkMapState = { wiki: "mimir", lastSuccessAt: NOW - 60_000, attempts: [{ at: NOW - 60_000, outcome: "ok" }] };
    const s = setup({}, recent);
    const res = await s.post("wiki=mimir");
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ lastSuccessAt: NOW - 60_000, retryAfterMs: WORK_MAP_REFRESH_COOLDOWN_MS - 60_000 });
    expect(s.recorded).toEqual([]);
    const forced = await s.post("wiki=mimir&force=1");
    expect(forced.status).toBe(202);
    s.release();
  });
});

describe("POST cooldown after a failed run", () => {
  test("429 within 10 minutes of a post-model failure unless force=1; not an attempt", async () => {
    const failed: WorkMapState = { wiki: "mimir", attempts: [{ at: NOW - 120_000, outcome: "failed", error: "zod" }] };
    const s = setup({}, failed);
    const res = await s.post("wiki=mimir");
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ lastFailedAt: NOW - 120_000, retryAfterMs: WORK_MAP_REFRESH_COOLDOWN_MS - 120_000 });
    expect(s.recorded).toEqual([]);
    expect(s.modelCalls()).toBe(0);
    expect((await s.post("wiki=mimir&force=1")).status).toBe(202);
    s.release();
  });

  test("a recent failure behind a newer refusal still cools down", async () => {
    const state: WorkMapState = {
      wiki: "mimir",
      attempts: [
        { at: NOW - 30_000, outcome: "refused", error: "cold" },
        { at: NOW - 120_000, outcome: "failed", error: "zod" },
      ],
    };
    const s = setup({}, state);
    const res = await s.post("wiki=mimir");
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ lastFailedAt: NOW - 120_000 });
    expect(s.modelCalls()).toBe(0);
  });

  test("a failure older than 10 minutes, or a refusal, does not cool down", async () => {
    const cases: WorkMapState[] = [
      { wiki: "mimir", attempts: [{ at: NOW - WORK_MAP_REFRESH_COOLDOWN_MS - 1, outcome: "failed", error: "zod" }] },
      { wiki: "mimir", attempts: [{ at: NOW - 60_000, outcome: "refused", error: "cold" }] },
    ];
    for (const state of cases) {
      const s = setup({}, state);
      expect((await s.post("wiki=mimir")).status).toBe(202);
      s.release();
      __resetWorkMapRunsForTest();
    }
  });
});

describe("POST cooldown with an unwritable state dir", () => {
  test("a success the store could not write still answers 429", async () => {
    const blocker = path.join(testTempDirSync("work-map-state-"), "file");
    writeFileSync(blocker, "x");
    const store = fileStateStore(path.join(blocker, "sub"));
    await expect(store.record("mimir", { at: NOW - 60_000, outcome: "ok" })).rejects.toThrow();
    const s = setup({ state: store });
    const res = await s.post("wiki=mimir");
    expect(res.status).toBe(429);
    expect(s.modelCalls()).toBe(0);
  });
});

describe("GET /api/wiki/work-map", () => {
  test("reads the map and, where organizable, the last attempt", async () => {
    const map = {
      version: 1,
      wiki: "mimir",
      runAtMs: NOW,
      model: "m",
      coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 0, threads: 0, logEntries: 0, digestChars: 0, warnings: [] },
      summary: "s",
      needsYou: [],
      themes: [],
      efforts: [],
      loose: [],
    };
    const state: WorkMapState = { wiki: "mimir", lastSuccessAt: NOW - 5, attempts: [{ at: NOW, outcome: "refused", error: "cold" }] };
    const s = setup({ readText: async (p) => (p === "/w/mimir/.work-map.json" ? JSON.stringify(map) : null) }, state);
    const body = await (await s.app.request("/api/wiki/work-map?wiki=mimir")).json();
    expect(body).toEqual({ wiki: "mimir", map, organizable: true, lastAttempt: { at: NOW, outcome: "refused", error: "cold" }, lastSuccessAt: NOW - 5 });
  });

  test("an unorganizable wiki says why and carries no state; a bad file is mapError", async () => {
    const s = setup({ readText: async () => "not json" });
    const body = await (await s.app.request("/api/wiki/work-map?wiki=other")).json();
    expect(body.map).toBeNull();
    expect(body.mapError).toContain("could not be read");
    expect(body.organizable).toBe(false);
    expect(body.organizableReason).toContain("WORK_MAP_WIKIS");
    expect(body.lastAttempt).toBeUndefined();
  });
});
