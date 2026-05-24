import { chatState } from "./state.ts";
import { listStaleHandoffs } from "../db/dev-runs.ts";
import { broadcastDevRun } from "./dev-run-broadcast.ts";
import { getLog } from "../logging.ts";

const log = getLog("chat", "stale-sweep");

/** How often the background sweep checks for stale handoffs. The threshold itself
 *  (`STALE_HANDOFF_THRESHOLD_MS`, 6h) lives in dev-runs.ts; the sweep just nudges
 *  open chat tabs so a parked run surfaces its re-send affordance without waiting
 *  for the next reply. 10 min is far below the 6h threshold — no point polling
 *  faster than runs can go stale. */
export const STALE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface StaleSweepDeps {
  list?: typeof listStaleHandoffs;
  /** Broadcast one run's current state. Defaults to the real chat-state push. */
  broadcast?: (runId: string) => Promise<unknown>;
}

/**
 * One sweep tick: find every stale handoff, then broadcast each affected run
 * ONCE (a run with two stale handoffs still gets a single push). Returns the run
 * ids it broadcast — handy for tests. Best-effort: a per-run broadcast failure is
 * swallowed (broadcastDevRun already logs) so one bad run can't abort the sweep.
 */
export async function sweepStaleHandoffs(deps: StaleSweepDeps = {}): Promise<string[]> {
  const list = deps.list ?? listStaleHandoffs;
  const broadcast = deps.broadcast ?? ((runId: string) => broadcastDevRun(chatState, { runId }));
  const stale = await list();
  const runIds = [...new Set(stale.map((s) => s.run.id))];
  for (const runId of runIds) {
    try {
      await broadcast(runId);
    } catch {
      // broadcastDevRun is already best-effort; ignore so the sweep finishes.
    }
  }
  if (runIds.length > 0) {
    log.info("Stale-handoff sweep broadcast {n} run(s)", { n: runIds.length });
  }
  return runIds;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic stale-handoff sweep (idempotent). Unref'd so it never keeps
 *  the process alive on its own. */
export function startStaleHandoffSweep(intervalMs: number = STALE_SWEEP_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    sweepStaleHandoffs().catch((err) => {
      log.warn("Stale-handoff sweep failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopStaleHandoffSweep(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
