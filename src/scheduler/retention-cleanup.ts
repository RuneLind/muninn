import type { Config } from "../config.ts";
import { cleanupOldTraces } from "../db/traces.ts";
import { cleanupOldSnapshots } from "../db/prompt-snapshots.ts";
import { cleanupThreadCitations } from "../db/research-citations.ts";
import { harvestSearchSignals } from "../db/search-signals.ts";
import { BatchedDeleteError } from "../db/batched-delete.ts";
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
/** How long shutdown waits for a run in flight before closing the pool anyway
 *  (`closeDb`'s timeout then terminates a statement still blocked). It overlaps
 *  shutdown's waits for ticks and extractions, which return at once when nothing
 *  is pending (always so for ticks on a pod with no Telegram bot), so it can add
 *  up to 5 s to shutdown. */
export const RETENTION_CLEANUP_STOP_WAIT_MS = 5_000;

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
/** Rows the committed batches of a failed batched delete removed. */
const deletedBefore = (err: unknown) => (err instanceof BatchedDeleteError ? err.deleted : 0);

/** One cleanup pass. Never rejects: each failure is logged. `shouldStop` (shutdown)
 *  skips the steps not yet started and ends a delete between its batches. */
export async function runRetentionCleanup(
  config: RetentionCleanupConfig,
  deps: RetentionCleanupDeps = realDeps,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  const deleteOpts = { ...BOUND, shouldStop };
  // Harvest BEFORE the trace delete: the search quality attrs live only in trace
  // JSONB. Own try-block, so a harvest failure never blocks the deletes.
  try {
    const harvested = await deps.harvestSearchSignals(BOUND);
    if (harvested > 0) log.info("Harvested {count} search signals", { count: harvested });
  } catch (err) {
    log.error("Search-signal harvest failed: {error}", { error: errText(err) });
  }
  if (shouldStop()) return;
  try {
    const deleted = await deps.cleanupOldTraces(config.tracingRetentionDays, deleteOpts);
    if (deleted > 0) log.info("Cleaned up {count} old traces", { count: deleted });
  } catch (err) {
    log.error("Trace cleanup failed after {count} rows: {error}", { count: deletedBefore(err), error: errText(err) });
  }
  if (shouldStop()) return;
  try {
    const deletedSnapshots = await deps.cleanupOldSnapshots({
      chatDays: config.promptSnapshotsRetentionDays,
      captureDays: config.promptSnapshotsCaptureRetentionDays,
    }, deleteOpts);
    if (deletedSnapshots > 0) log.info("Cleaned up {count} old prompt snapshots", { count: deletedSnapshots });
  } catch (err) {
    log.error("Prompt snapshot cleanup failed after {count} rows: {error}", { count: deletedBefore(err), error: errText(err) });
  }
  if (shouldStop()) return;
  try {
    // The chat half of `research_citations`, same window as the traces.
    const deletedCitations = await deps.cleanupThreadCitations(config.tracingRetentionDays, deleteOpts);
    if (deletedCitations > 0) log.info("Cleaned up {count} old thread citations", { count: deletedCitations });
  } catch (err) {
    log.error("Thread citation cleanup failed after {count} rows: {error}", { count: deletedBefore(err), error: errText(err) });
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
/** The current start's stop flag, read between steps and between delete
 *  batches. One object per start, so a later start cannot un-stop a run the
 *  previous stop flagged and could not wait out. */
let current: { stopping: boolean } = { stopping: false };

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
  const run = (current = { stopping: false });
  const tick = () => {
    if (running) {
      // Each statement is bounded in Postgres, so a run still here an hour on is
      // stuck outside it (a half-open TCP connection, say): this line is the signal.
      log.warn("Retention cleanup skipped: the previous run is still in flight");
      return;
    }
    running = runRetentionCleanup(config, opts.deps, () => run.stopping).finally(() => {
      running = null;
    });
  };
  first = setTimeout(tick, opts.firstDelayMs ?? RETENTION_CLEANUP_FIRST_DELAY_MS);
  timer = setInterval(tick, opts.intervalMs ?? RETENTION_CLEANUP_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return true;
}

/** Stop the timers and flag a run in flight to stop at its next batch, then wait
 *  (bounded) for it, so shutdown closes the pool after it rather than under it. */
export async function stopRetentionCleanup(waitMs = RETENTION_CLEANUP_STOP_WAIT_MS): Promise<void> {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = timer = null;
  current.stopping = true;
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
