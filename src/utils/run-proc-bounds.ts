/**
 * `runProc`'s kill timings, in a module with no imports, so the browser bundle
 * can size a client deadline from them (`src/wiki/plan-card-bounds.ts`).
 */

/** Between the timeout's SIGTERM and its SIGKILL. */
export const RUN_PROC_KILL_GRACE_MS = 2_000;

/** After the SIGKILL, how long the timeout waits for the exit before it gives
 *  up on seeing one (a child stuck in an uninterruptible wait). */
export const RUN_PROC_POST_KILL_WAIT_MS = 1_000;
