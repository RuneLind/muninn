import { test, expect, describe } from "bun:test";
import type { AgentRun } from "../observability/agent-status.ts";
import type { ScheduledTask, Watcher } from "../types.ts";
import type { RecentExtractorRow, RecentTraceRow } from "../db/agent-activity.ts";
import type { RecentAgentRunRow } from "../db/agent-activity.ts";
import {
  assembleAgentsOverview,
  type AgentsOverview,
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
    lastSuccessAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function traceRow(over: Partial<RecentTraceRow> = {}): RecentTraceRow {
  return { traceId: `tr-${Math.random()}`, name: "telegram_message", status: "ok", botName: "jarvis", startedAt: 1000, durationMs: 500, model: null, costUsd: null, inputTokens: null, outputTokens: null, ...over };
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
    getRecentAgentRuns: over.getRecentAgentRuns ?? (async () => []),
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

// ── recent cost column (trace + ring carry it; extractor/unknown → undefined) ──

describe("assembleAgentsOverview recent cost", () => {
  test("chat + watcher trace rows carry costUsd; a null cost is omitted (→ dash)", async () => {
    const o = await assembleAgentsOverview(deps({
      getRecentTraces: async () => [
        traceRow({ name: "telegram_message", startedAt: 1000, costUsd: 0.0234 }),
        traceRow({ name: "watcher:email", startedAt: 2000, costUsd: 0.05 }),
        traceRow({ name: "web_message", startedAt: 3000, costUsd: null }),
      ],
    }), NOW);
    const chat = o.recent.find((r) => r.kind === "chat" && r.costUsd === 0.0234);
    expect(chat).toBeDefined();
    const watcher = o.recent.find((r) => r.kind === "watcher");
    expect(watcher!.costUsd).toBe(0.05);
    // A null cost must not leak an undefined `costUsd` key onto the entry.
    const noCost = o.recent.find((r) => r.kind === "chat" && r.model === undefined && r.costUsd === undefined);
    expect(noCost).toBeDefined();
    expect("costUsd" in noCost!).toBe(false);
  });

  test("an explicit 0 (subscription connector) is preserved, distinct from unknown", async () => {
    const o = await assembleAgentsOverview(deps({
      getRecentTraces: async () => [traceRow({ name: "telegram_message", startedAt: 1000, costUsd: 0 })],
    }), NOW);
    const chat = o.recent.find((r) => r.kind === "chat")!;
    expect(chat.costUsd).toBe(0);
    expect("costUsd" in chat).toBe(true);
  });

  test("a ring row reports how its run ended; a producer that reports nothing reads as ok", async () => {
    const o = await assembleAgentsOverview(deps({
      getCompletedRing: () => [
        run({ kind: "capture", name: "failed", status: "error" }),
        run({ kind: "digest", name: "fine", status: "ok" }),
        run({ kind: "gardener_drain", name: "silent" }),
      ],
    }), NOW);
    const status = (name: string) => o.recent.find((r) => r.name === name)!.status;
    expect(status("failed")).toBe("error");
    expect(status("fine")).toBe("ok");
    expect(status("silent")).toBe("ok");
  });

  test("ring rows (research/task/digest) carry costUsd; drain with no meta omits it", async () => {
    const o = await assembleAgentsOverview(deps({
      getCompletedRing: () => [
        run({ kind: "research", name: "Ask", completedAt: 9000, startedAt: 8500, costUsd: 0.012 }),
        run({ kind: "scheduled_task", name: "Briefing", completedAt: 10000, startedAt: 9000, costUsd: 0 }),
        run({ kind: "gardener_drain", name: "Drain", completedAt: 8000, startedAt: 7000 }), // no costUsd
      ],
    }), NOW);
    const research = o.recent.find((r) => r.kind === "research")!;
    expect(research.costUsd).toBe(0.012);
    const task = o.recent.find((r) => r.kind === "scheduled_task")!;
    expect(task.costUsd).toBe(0); // explicit 0 preserved
    const drain = o.recent.find((r) => r.kind === "gardener_drain")!;
    expect("costUsd" in drain).toBe(false); // unknown → dash
  });

  test("extractor rows never carry a cost (haiku_usage has no cost column)", async () => {
    const o = await assembleAgentsOverview(deps({
      getRecentExtractors: async () => [extractorRow({ source: "goals", createdAt: 7000 })],
    }), NOW);
    const e = o.recent.find((r) => r.kind === "extractor")!;
    expect("costUsd" in e).toBe(false);
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
    expect(o.estimates["research\u0000Q"]).toBe(300); // median 200/400
    expect(typeof o.processStartedAt).toBe("number");
  });

  test("a degraded watcher_durations source doesn't throw — estimates just omit watchers", async () => {
    const live = run({ requestId: "w1", kind: "watcher", name: "email", completed: false, completedAt: undefined, startedAt: NOW });
    const o = await assembleAgentsOverview(deps({
      getRunning: () => [live],
      getWatcherDurations: async () => { throw new Error("traces down"); },
    }), NOW);
    expect(o.errors!.some((e) => e.includes("watcher_durations"))).toBe(true);
    expect(o.estimates["watcher\u0000email"]).toBeUndefined();
  });
});

// ── a ring kind's run across its two sources ──────────────────────────────────

function agentRunRow(over: Partial<RecentAgentRunRow> = {}): RecentAgentRunRow {
  return {
    traceId: "tr-1",
    kind: "capture",
    name: "YouTube: a talk",
    status: "ok",
    botName: "jarvis",
    startedAt: 5000,
    durationMs: 700,
    model: "claude-sonnet-5",
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.5,
    ...over,
  };
}

describe("assembleAgentsOverview recent, ring kinds", () => {
  const named = (o: AgentsOverview, name: string) => o.recent.filter((r) => r.name === name);

  test("after a restart the stamped span alone rebuilds the row", async () => {
    const o = await assembleAgentsOverview(deps({ getRecentAgentRuns: async () => [agentRunRow()] }), NOW);
    expect(o.recent).toEqual([
      {
        kind: "capture",
        bot: "jarvis",
        name: "YouTube: a talk",
        finishedAt: 5700,
        durationMs: 700,
        status: "ok",
        traceId: "tr-1",
        model: "claude-sonnet-5",
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.5,
      },
    ]);
  });

  test("an explicit $0 survives, and an unknown cost stays absent", async () => {
    const o = await assembleAgentsOverview(deps({
      getRecentAgentRuns: async () => [
        agentRunRow({ traceId: "a", name: "free", costUsd: 0 }),
        agentRunRow({ traceId: "b", name: "unknown", costUsd: null, model: null, inputTokens: null, outputTokens: null, durationMs: null }),
      ],
    }), NOW);
    expect(named(o, "free")[0]!.costUsd).toBe(0);
    const unknown = named(o, "unknown")[0]!;
    expect(unknown).not.toHaveProperty("costUsd");
    expect(unknown).not.toHaveProperty("model");
    expect(unknown).not.toHaveProperty("inputTokens");
    expect(unknown).not.toHaveProperty("durationMs");
    expect(unknown.finishedAt).toBe(5000);
  });

  test("a run in both sources is listed once, as the ring row", async () => {
    const o = await assembleAgentsOverview(deps({
      getCompletedRing: () => [run({ kind: "capture", name: "YouTube: a talk", traceId: "tr-1", model: "live-corrected", completedAt: 9000 })],
      getRecentAgentRuns: async () => [agentRunRow()],
    }), NOW);
    expect(named(o, "YouTube: a talk")).toHaveLength(1);
    expect(named(o, "YouTube: a talk")[0]).toMatchObject({ model: "live-corrected", finishedAt: 9000 });
  });

  test("a name the span stored cleaned still matches its ring row", async () => {
    const o = await assembleAgentsOverview(deps({
      getCompletedRing: () => [run({ kind: "capture", name: "YouTube: a\ud83d\u0000", traceId: "tr-1" })],
      getRecentAgentRuns: async () => [agentRunRow({ name: "YouTube: a\ufffd" })],
    }), NOW);
    expect(o.recent).toHaveLength(1);
  });

  test("tasks sharing their tick's trace stay separate runs, and a failed one is not swallowed", async () => {
    // A failed task clears its run, so it is only in the durable source.
    const o = await assembleAgentsOverview(deps({
      getCompletedRing: () => [run({ kind: "scheduled_task", name: "Task A", traceId: "tick" })],
      getRecentAgentRuns: async () => [
        agentRunRow({ kind: "scheduled_task", traceId: "tick", name: "Task A" }),
        agentRunRow({ kind: "scheduled_task", traceId: "tick", name: "Task B", status: "error" }),
      ],
    }), NOW);
    expect(named(o, "Task A")).toHaveLength(1);
    expect(named(o, "Task B")).toHaveLength(1);
    expect(named(o, "Task B")[0]!.status).toBe("error");
  });

  test("after a restart, tasks sharing a trace are still two rows", async () => {
    const o = await assembleAgentsOverview(deps({
      getRecentAgentRuns: async () => [
        agentRunRow({ kind: "scheduled_task", traceId: "tick", name: "Task A" }),
        agentRunRow({ kind: "scheduled_task", traceId: "tick", name: "Task B" }),
      ],
    }), NOW);
    expect(o.recent.map((r) => r.name).sort()).toEqual(["Task A", "Task B"]);
  });

  test("a span that ended in error turns the ring row red", async () => {
    // A goal completes its ring row, then a last DB write throws.
    const o = await assembleAgentsOverview(deps({
      getCompletedRing: () => [run({ kind: "scheduled_task", name: "Goal", traceId: "g" })],
      getRecentAgentRuns: async () => [agentRunRow({ kind: "scheduled_task", traceId: "g", name: "Goal", status: "error" })],
    }), NOW);
    expect(named(o, "Goal")).toHaveLength(1);
    expect(named(o, "Goal")[0]!.status).toBe("error");
  });

  test("a ring row that says error stays error over a span that says ok", async () => {
    // A capture's root finishes before an ingest that can still fail.
    const o = await assembleAgentsOverview(deps({
      getCompletedRing: () => [run({ kind: "capture", name: "YouTube: a talk", traceId: "tr-1", status: "error" })],
      getRecentAgentRuns: async () => [agentRunRow()],
    }), NOW);
    expect(named(o, "YouTube: a talk")[0]!.status).toBe("error");
  });

  test("a stamped span whose run is still live is left out, and a different run is not", async () => {
    const o = await assembleAgentsOverview(deps({
      getRunning: () => [run({ kind: "capture", name: "YouTube: a talk", completed: false, liveTraceId: "tr-1" })],
      getRecentAgentRuns: async () => [
        agentRunRow(),
        agentRunRow({ traceId: "tr-1", name: "same trace, another run" }),
        agentRunRow({ traceId: "tr-2", name: "YouTube: a talk" }),
      ],
    }), NOW);
    expect(o.recent.map((r) => r.traceId + "/" + r.name).sort()).toEqual([
      "tr-1/same trace, another run",
      "tr-2/YouTube: a talk",
    ]);
  });

  test("a ring row with no trace leaves a like-named span alone", async () => {
    const o = await assembleAgentsOverview(deps({
      getCompletedRing: () => [run({ kind: "capture", name: "YouTube: a talk" })],
      getRecentAgentRuns: async () => [agentRunRow()],
    }), NOW);
    expect(named(o, "YouTube: a talk")).toHaveLength(2);
  });

  test("a ring row sharing a trace with a watcher row does not touch it", async () => {
    // A consolidation draft's ring row names its tick's trace.
    const o = await assembleAgentsOverview(deps({
      getCompletedRing: () => [run({ kind: "capture", name: "Synthesis page: x", traceId: "tick" })],
      getRecentTraces: async () => [traceRow({ name: "watcher:consolidation-gardener", traceId: "tick" })],
    }), NOW);
    expect(o.recent.map((r) => r.name).sort()).toEqual(["Synthesis page: x", "consolidation-gardener"]);
  });

  test("a degraded span source costs its rows, not the ring's or the page", async () => {
    const o = await assembleAgentsOverview(deps({
      getCompletedRing: () => [run({ kind: "capture", name: "from the ring", traceId: "x" })],
      getRecentAgentRuns: async () => { throw new Error("db down"); },
    }), NOW);
    expect(o.errors).toEqual(["agent_runs: db down"]);
    expect(named(o, "from the ring")).toHaveLength(1);
  });
});
