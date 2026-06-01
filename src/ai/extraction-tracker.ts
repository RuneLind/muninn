import { getLog } from "../logging.ts";

const log = getLog("ai", "extraction-tracker");

/** Read a positive-integer env knob, falling back on anything invalid (0, negative, NaN). */
function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Bounded concurrency for fire-and-forget Haiku extraction (memory / goal /
// schedule). Without a cap, a burst of messages fans out unchecked — 10 messages
// → 30 extraction spawns — which saturates the Postgres pool (max 5) and can
// exhaust memory / file descriptors (each CLI Haiku call is its own subprocess)
// before any backpressure kicks in. Defaults are conservative and pool-friendly;
// override via env for high-throughput deployments.
const MAX_CONCURRENT = positiveIntEnv("EXTRACTION_MAX_CONCURRENT", 4);
// Hard cap on the wait queue so a sustained flood sheds load instead of growing
// unbounded. A dropped extraction only loses a background memory/goal/schedule
// detection — never a user-facing reply — so shedding is the safe failure mode.
const MAX_QUEUE = positiveIntEnv("EXTRACTION_MAX_QUEUE", 200);

// `pending` is the single source of truth for the in-flight count — its size
// gates new starts, so no separate counter can drift out of sync with it.
const queue: Array<() => void> = [];
const pending = new Set<Promise<void>>();

/**
 * Run a fire-and-forget extraction task under a concurrency cap, tracking it so
 * {@link waitForPendingExtractions} can drain in-flight work on shutdown.
 *
 * The task is expected to handle its own errors; any rejection that still
 * escapes (including a *synchronous* throw before the task's first `await`) is
 * caught and logged here, so it can never become an unhandled rejection that
 * takes down the process. Returns immediately — never blocks the caller.
 */
export function runTrackedExtraction(task: () => Promise<void>): void {
  if (pending.size >= MAX_CONCURRENT) {
    if (queue.length >= MAX_QUEUE) {
      log.warn("Extraction queue full ({max}) — dropping extraction under load", { max: MAX_QUEUE });
      return;
    }
    queue.push(() => start(task));
    return;
  }
  start(task);
}

function start(task: () => Promise<void>): void {
  // `Promise.resolve().then(task)` defers the task to a microtask and turns a
  // synchronous throw into a rejection, so the `.catch` below always catches it.
  const p: Promise<void> = Promise.resolve()
    .then(task)
    .catch((err) => {
      log.error("Tracked extraction failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      pending.delete(p);
      const next = queue.shift();
      if (next) next();
    });
  pending.add(p);
}

/**
 * Block until all tracked extractions (in-flight + queued) settle, or the
 * timeout elapses. Called during graceful shutdown so background memory/goal/
 * schedule writes complete before the DB pool closes. Mirrors
 * `waitForPendingTicks` in the scheduler runner.
 */
export async function waitForPendingExtractions(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pending.size === 0 && queue.length === 0) return;
    await Bun.sleep(100);
  }
  if (pending.size > 0 || queue.length > 0) {
    log.warn("Shutdown: timed out with {active} active + {queued} queued extractions", {
      active: pending.size,
      queued: queue.length,
    });
  }
}

/** Diagnostic snapshot of the tracker — used by tests. */
export function extractionTrackerStats(): { active: number; queued: number } {
  return { active: pending.size, queued: queue.length };
}
