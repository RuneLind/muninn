import type { Api } from "grammy";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import {
  getGoalsNeedingReminder,
  getGoalsNeedingCheckin,
} from "../db/goals.ts";
import { getTasksDueNow } from "../db/scheduled-tasks.ts";
import { runWatchers, getDueWatchers } from "../watchers/runner.ts";
import { Tracer } from "../tracing/index.ts";
import { cleanupOldTraces } from "../db/traces.ts";
import { cleanupOldSnapshots } from "../db/prompt-snapshots.ts";
import { harvestSearchSignals } from "../db/search-signals.ts";
import { runScheduledTasksFromList } from "./task-executor.ts";
import { runGoalRemindersFromList, runGoalCheckinsFromList } from "./goal-runner.ts";
import { getBotDefaultUser } from "../db/chat-preferences.ts";
import { isProfileStale } from "../db/interest-profiles.ts";
import { refreshInterestProfile } from "../profile/generator.ts";
import { getLog } from "../logging.ts";

const log = getLog("scheduler");

const intervals = new Map<string, ReturnType<typeof setInterval>>();
const tickRunning = new Map<string, boolean>();
/** Bots with an interest-profile refresh in flight — guards against a slow Haiku
 *  refresh being re-dispatched by ticks that fire before it writes its row. */
const profileRefreshInFlight = new Set<string>();
let lastCleanupAt = 0;
const TICK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max per tick

// Store scheduler contexts so the dashboard can trigger manual runs
const schedulerContexts = new Map<string, { api: Api; config: Config; botConfig: BotConfig }>();

export function getSchedulerContext(botName: string) {
  return schedulerContexts.get(botName);
}

export function startScheduler(api: Api, config: Config, botConfig: BotConfig): void {
  schedulerContexts.set(botConfig.name, { api, config, botConfig });

  if (!config.schedulerEnabled) {
    log.info("Scheduler disabled", { botName: botConfig.name });
    return;
  }

  const intervalMs = config.schedulerIntervalMs;
  const tag = botConfig.name;
  log.info("Unified scheduler started (interval: {interval}s)", { botName: tag, interval: intervalMs / 1000 });

  const id = setInterval(() => {
    if (tickRunning.get(tag)) {
      log.warn("Scheduler tick skipped — previous tick still running", { botName: tag });
      return;
    }
    tickRunning.set(tag, true);

    let timeoutId: ReturnType<typeof setTimeout>;
    const tickWithTimeout = Promise.race([
      runSchedulerTick(api, config, botConfig),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Scheduler tick timed out after ${TICK_TIMEOUT_MS}ms`)), TICK_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timeoutId));

    tickWithTimeout
      .catch((err) => {
        log.error("Scheduler tick failed: {error}", { botName: tag, error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        tickRunning.set(tag, false);
      });
  }, intervalMs);

  intervals.set(tag, id);
}

export function stopScheduler(): void {
  for (const [tag, id] of intervals) {
    clearInterval(id);
    log.info("Scheduler stopped", { botName: tag });
  }
  intervals.clear();
}

export async function waitForPendingTicks(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const anyRunning = [...tickRunning.values()].some(Boolean);
    if (!anyRunning) return;
    await Bun.sleep(200);
  }
  const running = [...tickRunning.entries()].filter(([, v]) => v).map(([k]) => k);
  if (running.length > 0) {
    log.warn("Shutdown: timed out waiting for scheduler ticks: {bots}", { bots: running.join(", ") });
  }
}

async function runSchedulerTick(api: Api, config: Config, botConfig: BotConfig): Promise<void> {
  const botName = botConfig.name;

  // Check if there's anything to do before creating a trace. Watchers are the
  // most failure-prone component, so fold due-watcher presence into hasWork too —
  // a watcher-only tick still gets a trace (its primary debug surface). The
  // resolved list is handed to runWatchers below to avoid a second DB round-trip.
  const dueTasks = await getTasksDueNow(botName);
  const goalReminders = await getGoalsNeedingReminder(24, botName);
  const staleGoals = await getGoalsNeedingCheckin(3, botName);
  const dueWatchers = await getDueWatchers(botName);
  const hasWork =
    dueTasks.length > 0 || goalReminders.length > 0 || staleGoals.length > 0 || dueWatchers.length > 0;

  // Only create a trace if something will actually run
  let t: Tracer | undefined;
  if (hasWork) {
    t = new Tracer("scheduler_tick", { botName, platform: "scheduler" });
  }

  try {
    // 1. Run due scheduled tasks
    if (dueTasks.length > 0) {
      t?.start("scheduled_tasks");
      await runScheduledTasksFromList(api, config, botConfig, dueTasks);
      t?.end("scheduled_tasks", { count: dueTasks.length });
    }

    // 2. Goal deadline reminders (24h ahead)
    if (goalReminders.length > 0) {
      t?.start("goal_reminders");
      await runGoalRemindersFromList(api, config, botConfig, goalReminders);
      t?.end("goal_reminders", { count: goalReminders.length });
    }

    // 3. Goal check-ins (stale goals, max 1 per tick)
    if (staleGoals.length > 0) {
      t?.start("goal_checkins");
      await runGoalCheckinsFromList(api, config, botConfig, staleGoals);
      t?.end("goal_checkins", { count: Math.min(staleGoals.length, 1) });
    }

    // 4. Watchers (email, calendar, etc.) — reuse the already-resolved due list
    await runWatchers(api, botConfig, t?.context, dueWatchers);

    // 5. Interest-profile refresh (fire-and-forget). Keeps the profile that
    //    personalizes the watcher gate prompts in sync with the user's goals +
    //    memories. Gated by a "stale > 7 days" DB predicate so it only spends a
    //    Haiku call about weekly, not every tick.
    await maybeRefreshInterestProfile(botConfig);

    t?.finish("ok");
  } catch (err) {
    t?.error(err instanceof Error ? err : String(err));
    throw err;
  }

  // 6. Retention cleanup — once per hour
  const now = Date.now();
  if (now - lastCleanupAt > 3_600_000) {
    lastCleanupAt = now;
    // Harvest durable retrieval signals BEFORE the trace delete — the search
    // quality attrs live only in trace JSONB, so this must run ahead of
    // cleanupOldTraces or the signal is erased unharvested. Own try-block:
    // a harvest failure must never block the retention cleanup behind it.
    try {
      const harvested = await harvestSearchSignals();
      if (harvested > 0) {
        log.info("Harvested {count} search signals", { botName, count: harvested });
      }
    } catch (err) {
      log.error("Search-signal harvest failed: {error}", { botName, error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const deleted = await cleanupOldTraces(config.tracingRetentionDays);
      if (deleted > 0) {
        log.info("Cleaned up {count} old traces", { botName, count: deleted });
      }
      const deletedSnapshots = await cleanupOldSnapshots(config.promptSnapshotsRetentionDays);
      if (deletedSnapshots > 0) {
        log.info("Cleaned up {count} old prompt snapshots", { botName, count: deletedSnapshots });
      }
    } catch (err) {
      log.error("Trace cleanup failed: {error}", { botName, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * If the bot has a default user whose interest profile is stale (missing or > 7
 * days old), dispatch a fire-and-forget refresh. The staleness check is awaited
 * (cheap PK lookup); the refresh itself runs detached so a slow Haiku call never
 * blocks the tick. In-flight guard prevents a slow refresh from being re-queued
 * by the next tick before it writes its row. Best-effort throughout — a failure
 * here must never disrupt the scheduler tick.
 */
async function maybeRefreshInterestProfile(botConfig: BotConfig): Promise<void> {
  const botName = botConfig.name;
  if (profileRefreshInFlight.has(botName)) return;
  try {
    const userId = await getBotDefaultUser(botName);
    if (!userId) return; // no primary user → nothing to personalize against
    if (!(await isProfileStale(userId, botName, 7))) return;

    profileRefreshInFlight.add(botName);
    // Detached: matches how the async extractors are dispatched. The generator
    // swallows its own errors; this .finally only clears the in-flight guard.
    void refreshInterestProfile(userId, botName, {
      connector: botConfig.connector,
      haikuBackend: botConfig.haikuBackend,
    }).finally(() => profileRefreshInFlight.delete(botName));
  } catch (err) {
    log.error("Interest-profile refresh dispatch failed: {error}", {
      botName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
