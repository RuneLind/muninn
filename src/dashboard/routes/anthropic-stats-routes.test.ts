/**
 * Route-shape test for `GET /api/anthropic/candidates/stats`. The two aggregations are
 * covered against real Postgres in `src/db/summary-candidates.test.ts`; this pins the
 * HTTP contract — the `?days=` clamp reaching the windowed call, and the rule that a
 * failing windowed block degrades to `recent: null` WITHOUT taking the all-time tables
 * down with it (they are three independent views that happen to share one fetch).
 */
import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import { registerAnthropicRoutes } from "./anthropic-routes.ts";
import type { Config } from "../../config.ts";
import type {
  CandidateOutcomeStats,
  CandidateRecentStats,
} from "../../db/summary-candidates.ts";

const CONFIG = { knowledgeApiUrl: "http://kb.test" } as Config;

const ALL_TIME: CandidateOutcomeStats = {
  byKind: [
    {
      source: "x",
      kind: "x-post",
      total: 3,
      summarized: 1,
      dismissedManual: 1,
      dismissedExpired: 1,
      dismissedSwept: 0,
      dismissedUnknown: 0,
      dismissedOther: 0,
      error: 0,
      acceptanceRate: 0.5,
    },
  ],
  byBand: [],
  suggestedFloors: [{ kind: "x-post", suggestedFloor: 0.7 }],
};

function recentFor(days: number): CandidateRecentStats {
  return {
    windowDays: days,
    since: new Date(Date.now() - days * 86_400_000).toISOString(),
    target: 0.5,
    repackaging: { cap: 0.8, since: new Date().toISOString(), floored: true },
    bySource: [],
  };
}

function app(over: {
  outcomeStats?: () => Promise<CandidateOutcomeStats>;
  recentStats?: (days: number) => Promise<CandidateRecentStats>;
}): Hono {
  const a = new Hono();
  registerAnthropicRoutes(a, CONFIG, {
    outcomeStats: over.outcomeStats ?? (async () => ALL_TIME),
    recentStats: over.recentStats ?? (async (d: number) => recentFor(d)),
  });
  return a;
}

describe("GET /api/anthropic/candidates/stats", () => {
  test("serves both halves, and ?days= reaches the windowed call clamped", async () => {
    const asked: number[] = [];
    const a = app({
      recentStats: async (d) => {
        asked.push(d);
        return recentFor(d);
      },
    });
    const res = await a.request("/api/anthropic/candidates/stats?days=900");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(asked).toEqual([90]); // clamped, not passed through
    expect(body.recent.windowDays).toBe(90);
    expect(body.byKind).toHaveLength(1);
    expect(body.suggestedFloors[0].kind).toBe("x-post");
  });

  test("no ?days= ⇒ the default window", async () => {
    const asked: number[] = [];
    const a = app({
      recentStats: async (d) => {
        asked.push(d);
        return recentFor(d);
      },
    });
    await a.request("/api/anthropic/candidates/stats");
    expect(asked).toEqual([7]);
  });

  test("a failing windowed block degrades to recent:null — the all-time tables still 200", async () => {
    // The two used to share one Promise.all, so ANY windowed failure 500'd the whole
    // Calibration tab including three views that had nothing to do with it.
    const a = app({
      recentStats: async () => {
        throw new Error("window aggregation blew up");
      },
    });
    const res = await a.request("/api/anthropic/candidates/stats?days=7");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recent).toBeNull();
    expect(body.byKind).toHaveLength(1);
    expect(body.suggestedFloors).toHaveLength(1);
  });

  test("a failing all-time aggregation is still a 500 — there is nothing left to render", async () => {
    const a = app({
      outcomeStats: async () => {
        throw new Error("nope");
      },
    });
    const res = await a.request("/api/anthropic/candidates/stats");
    expect(res.status).toBe(500);
  });
});
