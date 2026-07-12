import { test, expect, describe } from "bun:test";
import type { AgentRun } from "../observability/agent-status.ts";
import type { ScheduledTask, Watcher } from "../types.ts";
import type { RecentExtractorRow, RecentTraceRow } from "../db/agent-activity.ts";
import {
  assembleAgentsOverview,
  computeWatcherNextRun,
  _internalsForTest,
  type AgentsOverviewDeps,
} from "./agents-overview.ts";

const { osloWallParts } = _internalsForTest();

// ── Factories ─────────────────────────────────────────────────────────────────

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: `t-${Math.random()}`,
    userId: "u1",
    botName: "jarvis",
    title: "Morning briefing",
    taskType: "briefing",
    prompt: null,
    scheduleHour: 8,
    scheduleMinute: 0,
    scheduleDays: null,
    scheduleIntervalMs: null,
    timezone: "Europe/Oslo",
    platform: "telegram",
    enabled: true,
    lastRunAt: null,
    nextRunAt: Date.now() + 3_600_000,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function watcher(over: Partial<Watcher> = {}): Watcher {
  return {
    id: `w-${Math.random()}`,
    userId: "u1",
    botName: "jarvis",
    name: "Email Watcher",
    type: "email",
    config: {},
    intervalMs: 3_600_000,
    enabled: true,
    lastRunAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function traceRow(over: Partial<RecentTraceRow> = {}): RecentTraceRow {
  return { traceId: `tr-${Math.random()}`, name: "telegram_message", status: "ok", botName: "jarvis", startedAt: 1000, durationMs: 500, model: null, inputTokens: null, outputTokens: null, ...over };
}

function extractorRow(over: Partial<RecentExtractorRow> = {}): RecentExtractorRow {
  return { source: "memory", model: "claude-haiku", botName: "jarvis", inputTokens: 10, outputTokens: 4, createdAt: 2000, ...over };
}

function run(over: Partial<AgentRun> = {}): AgentRun {
  return {
    requestId: `req-${Math.random()}`,
    botName: "jarvis",
    phase: "idle",
    startedAt: 1000,
    completedAt: 1500,
    completed: true,
    tools: [],
    kind: "chat",
    ...over,
  };
}

function deps(over: Partial<AgentsOverviewDeps> = {}): AgentsOverviewDeps {
  return {
    getRunning: over.getRunning ?? (() => []),
    getCompletedRing: over.getCompletedRing ?? (() => []),
    getScheduledTasks: over.getScheduledTasks ?? (async () => []),
    getWatchers: over.getWatchers ?? (async () => []),
    getRecentTraces: over.getRecentTraces ?? (async () => []),
    getRecentExtractors: over.getRecentExtractors ?? (async () => []),
    getWatcherDurations: over.getWatcherDurations ?? (async () => []),
  };
}

// Fixed winter (no-DST-transition) instant so slot arithmetic is deterministic.
// 2026-01-15 08:00 Europe/Oslo = 07:00 UTC.
const NOW = Date.UTC(2026, 0, 15, 7, 0, 0);

// ── computeWatcherNextRun (isScheduledTimeDue mirror) ─────────────────────────

describe("computeWatcherNextRun", () => {
  test("force_next_run → queued for next tick (now)", () => {
    const r = computeWatcherNextRun(watcher({ forceNextRun: true }), NOW);
    expect(r.nextRunAt).toBe(NOW);
    expect(r.label).toBe("queued for next tick");
  });

  test("time-of-day, not run today, slot still ahead → today's slot", () => {
    // config.hour 10 (Oslo). now is 08:00 Oslo → slot at 10:00 today, in future.
    const r = computeWatcherNextRun(watcher({ config: { hour: 10, minute: 0 }, lastRunAt: null }), NOW);
    expect(r.nextRunAt).toBeGreaterThan(NOW);
    const p = osloWallParts(r.nextRunAt);
    expect(p.hour).toBe(10);
    expect(p.minute).toBe(0);
    expect(p.day).toBe(15); // still today (Oslo)
    expect(r.label).toBeUndefined();
  });

  test("time-of-day, already ran today → tomorrow's slot", () => {
    const ranToday = Date.UTC(2026, 0, 15, 9, 0, 0); // 10:00 Oslo, same day
    const noon = Date.UTC(2026, 0, 15, 11, 0, 0); // 12:00 Oslo (past the slot)
    const r = computeWatcherNextRun(watcher({ config: { hour: 10, minute: 0 }, lastRunAt: ranToday }), noon);
    const p = osloWallParts(r.nextRunAt);
    expect(p.hour).toBe(10);
    expect(p.day).toBe(16); // tomorrow (Oslo)
  });

  test("time-of-day, slot passed today but not yet run → due now", () => {
    const noon = Date.UTC(2026, 0, 15, 11, 0, 0); // 12:00 Oslo, slot 10:00 passed
    const r = computeWatcherNextRun(watcher({ config: { hour: 10, minute: 0 }, lastRunAt: null }), noon);
    expect(r.label).toBe("due now");
    expect(r.nextRunAt).toBeLessThanOrEqual(noon);
  });

  test("no time-of-day → last_run_at + interval", () => {
    const last = NOW - 1_000_000;
    const r = computeWatcherNextRun(watcher({ config: {}, lastRunAt: last, intervalMs: 3_600_000 }), NOW);
    expect(r.nextRunAt).toBe(last + 3_600_000);
  });

  test("no time-of-day, never run → due now", () => {
    const r = computeWatcherNextRun(watcher({ config: {}, lastRunAt: null }), NOW);
    expect(r.label).toBe("due now");
    expect(r.nextRunAt).toBe(NOW);
  });

  test("weekly interval + hour gate: ran Sunday 10:00, asked Monday → ~next Sunday 10:00, NOT due now", () => {
    // Seeded wiki-gardener shape: 7d interval AND config.hour 10. The interval
    // gate must dominate — it should read next Sunday, not "due now" every day.
    const ranSun = Date.UTC(2026, 0, 11, 9, 0, 0); // Sun 2026-01-11 10:00 Oslo
    const mon = Date.UTC(2026, 0, 12, 13, 0, 0);   // Mon 2026-01-12 14:00 Oslo
    const r = computeWatcherNextRun(
      watcher({ config: { hour: 10, minute: 0 }, lastRunAt: ranSun, intervalMs: 7 * 86_400_000 }),
      mon,
    );
    expect(r.label).toBeUndefined();
    expect(r.nextRunAt).toBeGreaterThan(mon);
    const p = osloWallParts(r.nextRunAt);
    expect(p.hour).toBe(10);
    expect(p.minute).toBe(0);
    expect(p.year).toBe(2026);
    expect(p.month).toBe(1);
    expect(p.day).toBe(18); // Sun 2026-01-18 (a full week after the last run)
  });

  test("sub-day interval + hour gate: ran today 10:00, interval 1h, asked 14:00 → tomorrow 10:00", () => {
    const ranToday = Date.UTC(2026, 0, 15, 9, 0, 0); // 10:00 Oslo today
    const afternoon = Date.UTC(2026, 0, 15, 13, 0, 0); // 14:00 Oslo today
    const r = computeWatcherNextRun(
      watcher({ config: { hour: 10, minute: 0 }, lastRunAt: ranToday, intervalMs: 3_600_000 }),
      afternoon,
    );
    // Interval gate cleared long ago, but the hour gate blocks a second run the
    // same day → next slot is tomorrow 10:00, not today.
    expect(r.label).toBeUndefined();
    const p = osloWallParts(r.nextRunAt);
    expect(p.hour).toBe(10);
    expect(p.day).toBe(16);
  });

  test("interval floor lands past the slot on an eligible day → fires at the floor", () => {
    // Last run Mon 12:00, interval 2d → floor Wed 12:00 (past the 10:00 slot,
    // Wed differs from Mon) so both gates hold at the floor → fires Wed 12:00.
    const ranMon = Date.UTC(2026, 0, 12, 11, 0, 0); // Mon 12:00 Oslo
    const askedTue = Date.UTC(2026, 0, 13, 8, 0, 0); // Tue 09:00 Oslo
    const r = computeWatcherNextRun(
      watcher({ config: { hour: 10, minute: 0 }, lastRunAt: ranMon, intervalMs: 2 * 86_400_000 }),
      askedTue,
    );
    expect(r.label).toBeUndefined();
    const p = osloWallParts(r.nextRunAt);
    expect(p.day).toBe(14); // Wed
    expect(p.hour).toBe(12); // the interval floor, past the 10:00 slot
    expect(r.nextRunAt).toBe(ranMon + 2 * 86_400_000);
  });
});

// ── upNext assembly ───────────────────────────────────────────────────────────

describe("assembleAgentsOverview upNext", () => {
  test("includes enabled scheduled tasks with a next_run_at; excludes disabled/null", async () => {
    const o = await assembleAgentsOverview(deps({
      getScheduledTasks: async () => [
        task({ title: "Enabled", nextRunAt: NOW + 60_000 }),
        task({ title: "Disabled", enabled: false }),
        task({ title: "NoNext", nextRunAt: null }),
      ],
    }), NOW);
    const names = o.upNext.filter((u) => u.kind === "scheduled_task").map((u) => u.name);
    expect(names).toEqual(["Enabled"]);
  });

  test("merges + sorts tasks and watchers by nextRunAt ascending", async () => {
    const o = await assembleAgentsOverview(deps({
      getScheduledTasks: async () => [task({ title: "Task", nextRunAt: NOW + 120_000 })],
      getWatchers: async () => [watcher({ name: "W", config: {}, lastRunAt: NOW - 3_600_000 + 30_000, intervalMs: 3_600_000 })],
    }), NOW);
    // Watcher fires at NOW+30_000 (< task NOW+120_000) → comes first.
    expect(o.upNext.map((u) => u.name)).toEqual(["W", "Task"]);
  });

  test("wiki-gardener watcher carries a /wiki/gardener sourcePage", async () => {
    const o = await assembleAgentsOverview(deps({
      getWatchers: async () => [watcher({ name: "Gardener", type: "wiki-gardener", config: { hour: 10 } })],
    }), NOW);
    const g = o.upNext.find((u) => u.name === "Gardener")!;
    expect(g.sourcePage).toBe("/wiki/gardener");
  });

  test("excludes disabled watchers", async () => {
    const o = await assembleAgentsOverview(deps({
      getWatchers: async () => [watcher({ name: "Off", enabled: false })],
    }), NOW);
    expect(o.upNext.find((u) => u.name === "Off")).toBeUndefined();
  });
});

// ── recent per-kind source-of-truth policy ────────────────────────────────────

describe("assembleAgentsOverview recent", () => {
  test("unions traces + extractors + ring, filters ring to no-durable-source kinds", async () => {
    const o = await assembleAgentsOverview(deps({
      getRecentTraces: async () => [
        traceRow({ name: "telegram_message", startedAt: 5000, durationMs: 100 }),
        traceRow({ name: "watcher:email", startedAt: 6000, durationMs: 200 }),
      ],
      getRecentExtractors: async () => [extractorRow({ source: "goals", createdAt: 7000 })],
      getCompletedRing: () => [
        run({ kind: "gardener_drain", name: "Drain", completedAt: 8000, startedAt: 7000 }),
        run({ kind: "research", name: "Ask", completedAt: 9000, startedAt: 8500 }),
        run({ kind: "scheduled_task", name: "Briefing", completedAt: 10000, startedAt: 9000 }),
        // These must be EXCLUDED from the ring source (durable elsewhere):
        run({ kind: "chat", name: "ChatRing", completedAt: 11000 }),
        run({ kind: "watcher", name: "WatcherRing", completedAt: 12000 }),
        run({ kind: "extractor", name: "ExtractorRing", completedAt: 13000 }),
      ],
    }), NOW);

    const byKind = o.recent.reduce<Record<string, number>>((acc, r) => { acc[r.kind] = (acc[r.kind] ?? 0) + 1; return acc; }, {});
    expect(byKind.chat).toBe(1);       // only the trace chat, not the ring chat
    expect(byKind.watcher).toBe(1);    // only the trace watcher
    expect(byKind.extractor).toBe(1);  // only the haiku_usage extractor
    expect(byKind.gardener_drain).toBe(1);
    expect(byKind.research).toBe(1);
    expect(byKind.scheduled_task).toBe(1);
    // Ring chat/watcher/extractor names never appear.
    const names = o.recent.map((r) => r.name);
    expect(names).not.toContain("ChatRing");
    expect(names).not.toContain("WatcherRing");
    expect(names).not.toContain("ExtractorRing");
  });

  test("strips the watcher: prefix and maps chat/extractor fields", async () => {
    const o = await assembleAgentsOverview(deps({
      getRecentTraces: async () => [
        traceRow({ name: "watcher:email", traceId: "wt1", status: "ok", startedAt: 1000, durationMs: 300, model: "claude-haiku-4-5", inputTokens: 227000, outputTokens: 480 }),
      ],
      getRecentExtractors: async () => [extractorRow({ source: "schedule", model: "claude-haiku-4-5", inputTokens: 20, outputTokens: 8, createdAt: 2000 })],
    }), NOW);
    const w = o.recent.find((r) => r.kind === "watcher")!;
    expect(w.name).toBe("email");
    expect(w.traceId).toBe("wt1");
    expect(w.durationMs).toBe(300);
    // Watcher span token totals thread through to Recent (childless-span lookup).
    expect(w.inputTokens).toBe(227000);
    expect(w.outputTokens).toBe(480);

    const e = o.recent.find((r) => r.kind === "extractor")!;
    expect(e.name).toBe("Extractor: schedule");
    expect(e.model).toBe("claude-haiku-4-5");
    expect(e.inputTokens).toBe(20);
  });

  test("chat trace row surfaces its joined model; a null model is omitted", async () => {
    const o = await assembleAgentsOverview(deps({
      getRecentTraces: async () => [
        traceRow({ name: "telegram_message", startedAt: 1000, durationMs: 100, model: "claude-sonnet-5" }),
        traceRow({ name: "web_message", startedAt: 2000, durationMs: 100, model: null }),
      ],
    }), NOW);
    const chats = o.recent.filter((r) => r.kind === "chat");
    const withModel = chats.find((r) => r.model === "claude-sonnet-5");
    expect(withModel).toBeDefined();
    // A null model must not leak an undefined `model` key onto the entry.
    const noModel = chats.find((r) => r.model === undefined);
    expect(noModel).toBeDefined();
    expect("model" in noModel!).toBe(false);
  });

  test("sorts recent newest-first by finishedAt", async () => {
    const o = await assembleAgentsOverview(deps({
      getRecentTraces: async () => [
        traceRow({ name: "telegram_message", startedAt: 1000, durationMs: 0 }),   // finish 1000
        traceRow({ name: "web_message", startedAt: 9000, durationMs: 0 }),        // finish 9000
      ],
      getRecentExtractors: async () => [extractorRow({ createdAt: 5000 })],
    }), NOW);
    const finishes = o.recent.map((r) => r.finishedAt);
    expect(finishes).toEqual([...finishes].sort((a, b) => b - a));
    expect(finishes[0]).toBe(9000);
  });
});

// ── running + degrade ─────────────────────────────────────────────────────────

describe("assembleAgentsOverview running + degrade", () => {
  test("passes through the running set", async () => {
    const live = [run({ requestId: "live1", completed: false, completedAt: undefined, kind: "chat" })];
    const o = await assembleAgentsOverview(deps({ getRunning: () => live }), NOW);
    expect(o.running.map((r) => r.requestId)).toEqual(["live1"]);
  });

  test("a rejecting source lands in errors[] without throwing", async () => {
    const o = await assembleAgentsOverview(deps({
      getRecentTraces: async () => { throw new Error("db down"); },
    }), NOW);
    expect(o.errors).toBeDefined();
    expect(o.errors!.some((e) => e.includes("traces") && e.includes("db down"))).toBe(true);
    expect(o.recent).toEqual([]); // degraded, not thrown
  });

  test("builds per-identity estimates for live runs + carries processStartedAt", async () => {
    const live = run({ requestId: "l1", kind: "research", name: "Q", completed: false, completedAt: undefined, startedAt: NOW });
    const o = await assembleAgentsOverview(deps({
      getRunning: () => [live],
      getCompletedRing: () => [
        run({ kind: "research", name: "Q", startedAt: 0, completedAt: 200 }),
        run({ kind: "research", name: "Q", startedAt: 0, completedAt: 400 }),
      ],
    }), NOW);
    expect(o.estimates["research Q"]).toBe(300); // median 200/400
    expect(typeof o.processStartedAt).toBe("number");
  });

  test("a degraded watcher_durations source doesn't throw — estimates just omit watchers", async () => {
    const live = run({ requestId: "w1", kind: "watcher", name: "email", completed: false, completedAt: undefined, startedAt: NOW });
    const o = await assembleAgentsOverview(deps({
      getRunning: () => [live],
      getWatcherDurations: async () => { throw new Error("traces down"); },
    }), NOW);
    expect(o.errors!.some((e) => e.includes("watcher_durations"))).toBe(true);
    expect(o.estimates["watcher email"]).toBeUndefined();
  });
});
