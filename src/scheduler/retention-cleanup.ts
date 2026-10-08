import type { Config } from "../config.ts";
import { cleanupOldTraces } from "../db/traces.ts";
import { cleanupOldSnapshots } from "../db/prompt-snapshots.ts";
import { cleanupThreadCitations } from "../db/research-citations.ts";
import { harvestSearchSignals } from "../db/search-signals.ts";
import { getLog } from "../logging.ts";

const log = getLog("scheduler", "retention");

export const RETENTION_CLEANUP_INTERVAL_MS = 3_600_000;
/** The first run comes this long after boot, so a pod that restarts more often
 *  than hourly still cleans. */
export const RETENTION_CLEANUP_FIRST_DELAY_MS = 60_000;
/** Postgres `statement_timeout` for each cleanup statement, lock waits included:
 *  a statement blocked on a lock throws and frees its pooled connection. */
export const RETENTION_CLEANUP_STATEMENT_TIMEOUT_MS = 5 * 60_000;
const BOUND = { statementTimeoutMs: RETENTION_CLEANUP_STATEMENT_TIMEOUT_MS };
/** How long shutdown waits for a run in flight before closing the pool anyway. */
export const RETENTION_CLEANUP_STOP_WAIT_MS = 10_000;

export type RetentionCleanupConfig = Pick<
  Config,
  "schedulerEnabled" | "tracingRetentionDays" | "promptSnapshotsRetentionDays" | "promptSnapshotsCaptureRetentionDays"
>;

export interface RetentionCleanupDeps {
  harvestSearchSignals: typeof harvestSearchSignals;
  cleanupOldTraces: typeof cleanupOldTraces;
  cleanupOldSnapshots: typeof cleanupOldSnapshots;
  cleanupThreadCitations: typeof cleanupThreadCitations;
}

const realDeps: RetentionCleanupDeps = { harvestSearchSignals, cleanupOldTraces, cleanupOldSnapshots, cleanupThreadCitations };

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One cleanup pass. Never rejects: each failure is logged. */
export async function runRetentionCleanup(
  config: RetentionCleanupConfig,
  deps: RetentionCleanupDeps = realDeps,
): Promise<void> {
  // Harvest BEFORE the trace delete: the search quality attrs live only in trace
  // JSONB. Own try-block, so a harvest failure never blocks the deletes.
  try {
    const harvested = await deps.harvestSearchSignals(BOUND);
    if (harvested > 0) log.info("Harvested {count} search signals", { count: harvested });
  } catch (err) {
    log.error("Search-signal harvest failed: {error}", { error: errText(err) });
  }
  try {
    const deleted = await deps.cleanupOldTraces(config.tracingRetentionDays, BOUND);
    if (deleted > 0) log.info("Cleaned up {count} old traces", { count: deleted });
  } catch (err) {
    log.error("Trace cleanup failed: {error}", { error: errText(err) });
  }
  try {
    const deletedSnapshots = await deps.cleanupOldSnapshots({
      chatDays: config.promptSnapshotsRetentionDays,
      captureDays: config.promptSnapshotsCaptureRetentionDays,
    }, BOUND);
    if (deletedSnapshots > 0) log.info("Cleaned up {count} old prompt snapshots", { count: deletedSnapshots });
  } catch (err) {
    log.error("Prompt snapshot cleanup failed: {error}", { error: errText(err) });
  }
  try {
    // The chat half of `research_citations`, same window as the traces.
    const deletedCitations = await deps.cleanupThreadCitations(config.tracingRetentionDays, BOUND);
    if (deletedCitations > 0) log.info("Cleaned up {count} old thread citations", { count: deletedCitations });
  } catch (err) {
    log.error("Thread citation cleanup failed: {error}", { error: errText(err) });
  }
}

export function retentionCleanupBootLine(config: RetentionCleanupConfig): string {
  return (
    `Retention cleanup on (hourly): traces and thread citations ${config.tracingRetentionDays} day(s), ` +
    `chat prompt snapshots ${config.promptSnapshotsRetentionDays}, capture snapshots ${config.promptSnapshotsCaptureRetentionDays}`
  );
}

let first: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
/** The run in flight, if any: a tick that finds one skips, and stop waits for it. */
let running: Promise<unknown> | null = null;

/** Start the hourly cleanup (idempotent). Process-wide and on every profile:
 *  the per-bot scheduler tick runs only for a bot with a Telegram token, which
 *  a nais pod does not have. Off with SCHEDULER_ENABLED=false, which the e2e
 *  shared server sets so its seed trace survives. `opts` is for tests. */
export function startRetentionCleanup(
  config: RetentionCleanupConfig,
  opts: { deps?: RetentionCleanupDeps; firstDelayMs?: number; intervalMs?: number } = {},
): boolean {
  if (first || timer) return true;
  if (!config.schedulerEnabled) return false;
  const tick = () => {
    if (running) {
      // Each statement is bounded in Postgres, so a run still here an hour on is
      // stuck outside it (a half-open TCP connection, say): this line is the signal.
      log.warn("Retention cleanup skipped: the previous run is still in flight");
      return;
    }
    running = runRetentionCleanup(config, opts.deps).finally(() => {
      running = null;
    });
  };
  first = setTimeout(tick, opts.firstDelayMs ?? RETENTION_CLEANUP_FIRST_DELAY_MS);
  timer = setInterval(tick, opts.intervalMs ?? RETENTION_CLEANUP_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return true;
}

/** Stop the timers, then wait (bounded) for a run in flight, so shutdown can
 *  close the pool after it rather than under it. */
export async function stopRetentionCleanup(waitMs = RETENTION_CLEANUP_STOP_WAIT_MS): Promise<void> {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = timer = null;
  const inFlight = running;
  if (!inFlight) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    inFlight.then(() => false),
    new Promise<boolean>((r) => (timeout = setTimeout(() => r(true), waitMs))),
  ]);
  clearTimeout(timeout);
  if (timedOut) log.warn("Shutdown: timed out waiting for the retention cleanup");
}
