import { test, expect } from "bun:test";
import {
  assembleAttention,
  isWatcherStale,
  type AttentionDeps,
} from "./home-attention.ts";
import type { Watcher } from "../types.ts";
import type { RecentTraceRow } from "../db/agent-activity.ts";

const NOW = Date.parse("2026-07-21T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

function watcher(over: Partial<Watcher> = {}): Watcher {
  return {
    id: "w1",
    userId: "u1",
    botName: "jarvis",
    name: "Email",
    type: "email",
    config: {},
    intervalMs: HOUR,
    enabled: true,
    lastRunAt: NOW - 10 * 60_000, // 10m ago (fresh)
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function trace(over: Partial<RecentTraceRow> = {}): RecentTraceRow {
  return {
    traceId: "t1",
    name: "telegram_message",
    status: "ok",
    botName: "jarvis",
    startedAt: NOW - HOUR,
    durationMs: 1000,
    model: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    ...over,
  };
}

function deps(over: Partial<AttentionDeps> = {}): AttentionDeps {
  return {
    getWatchers: async () => [],
    getDraftCounts: async () => [],
    getRecentTraces: async () => [],
    ...over,
  };
}

// ── isWatcherStale ────────────────────────────────────────────────────────────

test("pure-interval watcher: fresh is not stale", () => {
  expect(isWatcherStale(watcher({ lastRunAt: NOW - HOUR }), NOW)).toBe(false);
});

test("pure-interval watcher: past 2×interval is stale", () => {
  // 1h interval, last ran 3h ago → 3h > 2h → stale.
  expect(isWatcherStale(watcher({ intervalMs: HOUR, lastRunAt: NOW - 3 * HOUR }), NOW)).toBe(true);
});

test("disabled watcher is never stale", () => {
  expect(isWatcherStale(watcher({ enabled: false, lastRunAt: NOW - 10 * DAY }), NOW)).toBe(false);
});

test("never-run watcher is not flagged (no baseline)", () => {
  expect(isWatcherStale(watcher({ lastRunAt: null }), NOW)).toBe(false);
});

test("hour-gated short-interval watcher is NOT stale from the interval floor", () => {
  // The real X Daily Digest: 5min interval but config.hour=12; last ran 56m ago.
  // Naive lastRunAt+2×5min would flag it — the day-floor rule must not.
  const w = watcher({ intervalMs: 5 * 60_000, config: { hour: 12 }, lastRunAt: NOW - 56 * 60_000 });
  expect(isWatcherStale(w, NOW)).toBe(false);
});

test("hour-gated watcher IS stale when overdue by >2 days", () => {
  const w = watcher({ intervalMs: 5 * 60_000, config: { hour: 12 }, lastRunAt: NOW - 3 * DAY });
  expect(isWatcherStale(w, NOW)).toBe(true);
});

// ── assembleAttention ─────────────────────────────────────────────────────────

test("assembles stale-watcher, drafts, and failed-run items with correct actions", async () => {
  const overview = await assembleAttention(
    deps({
      getWatchers: async () => [
        watcher({ name: "Email", intervalMs: HOUR, lastRunAt: NOW - 26 * HOUR }),
        watcher({ name: "Fresh", lastRunAt: NOW - 5 * 60_000 }),
      ],
      getDraftCounts: async () => [
        { bot: "jarvis", count: 2 },
        { bot: "melosys", count: 0 },
      ],
      getRecentTraces: async () => [
        trace({ traceId: "abc", name: "watcher:email", status: "error", startedAt: NOW - 2 * HOUR }),
        trace({ status: "ok" }), // healthy — excluded
      ],
    }),
    NOW,
  );

  const kinds = overview.items.map((i) => i.kind);
  expect(kinds).toContain("stale_watcher");
  expect(kinds).toContain("gardener_drafts");
  expect(kinds).toContain("failed_run");

  const stale = overview.items.find((i) => i.kind === "stale_watcher")!;
  expect(stale.tone).toBe("warning");
  expect(stale.text).toContain("Email");
  expect(stale.text).toContain("26h");
  expect(stale.actionHref).toBe("/#schedules-watchers");

  const drafts = overview.items.find((i) => i.kind === "gardener_drafts")!;
  expect(drafts.tone).toBe("info");
  expect(drafts.text).toContain("2 drafts");
  expect(drafts.actionHref).toBe("/wiki/gardener");

  const failed = overview.items.find((i) => i.kind === "failed_run")!;
  expect(failed.tone).toBe("error");
  expect(failed.actionHref).toBe("/traces#abc");
  expect(failed.text).toContain("Watcher email");

  // Errors → first (severity order).
  expect(overview.items[0]!.tone).toBe("error");
  expect(overview.errors).toBeUndefined();
});

test("single draft is singular; multi-bot drafts name the bot", async () => {
  const one = await assembleAttention(deps({ getDraftCounts: async () => [{ bot: "jarvis", count: 1 }] }), NOW);
  expect(one.items[0]!.text).toContain("1 draft ");

  const multi = await assembleAttention(
    deps({ getDraftCounts: async () => [{ bot: "jarvis", count: 2 }, { bot: "capra", count: 3 }] }),
    NOW,
  );
  expect(multi.items.map((i) => i.text).join("|")).toContain("jarvis gardener");
  expect(multi.items.map((i) => i.text).join("|")).toContain("capra gardener");
});

test("old failed runs outside the 24h window are excluded", async () => {
  const overview = await assembleAttention(
    deps({
      getRecentTraces: async () => [
        trace({ status: "error", startedAt: NOW - 30 * HOUR }), // too old
      ],
    }),
    NOW,
  );
  expect(overview.items).toHaveLength(0);
});

test("never 5xx — a degraded source lands in errors[] and others still assemble", async () => {
  const overview = await assembleAttention(
    deps({
      getWatchers: async () => {
        throw new Error("db down");
      },
      getDraftCounts: async () => [{ bot: "jarvis", count: 1 }],
    }),
    NOW,
  );
  expect(overview.errors).toBeDefined();
  expect(overview.errors!.join()).toContain("watchers");
  // The healthy draft source still produced its item.
  expect(overview.items.some((i) => i.kind === "gardener_drafts")).toBe(true);
});

test("no attention needed → empty items, no errors", async () => {
  const overview = await assembleAttention(deps(), NOW);
  expect(overview.items).toHaveLength(0);
  expect(overview.errors).toBeUndefined();
  expect(overview.generatedAt).toBe(NOW);
});
