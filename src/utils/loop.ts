/**
 * One background loop: a first run after a delay, then one per interval, with
 * the single-flight, the stop and the last-run state owned here instead of
 * hand-rolled per loop (architecture review 2026-11, F41).
 *
 * A handle is single-use: `stop()` is final, and a restart creates a new handle.
 * A run stopped while in flight is told through its `AbortSignal` and stays
 * stopped whatever happens to later handles. A handle created with `after`
 * starts no run while that older handle's run (or its own `after`'s) is still
 * in flight, so a restart never overlaps a stopped run that has not settled.
 */
import type { Logger } from "@logtape/logtape";

/** The four timer functions, injectable so a test drives ticks without sleeping. */
export interface LoopTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: LoopTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** The latest run. Epoch ms; `finishedAt` and `ok` are null while it is in flight. */
export interface LoopRunState {
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  /** The thrown error's message when `ok` is false. */
  error: string | null;
}

export interface LoopState {
  name: string;
  started: boolean;
  stopped: boolean;
  /** This handle's own run is in flight. */
  running: boolean;
  lastRun: LoopRunState | null;
}

export interface LoopOptions {
  /** Names the loop in the failure line, e.g. "Retention cleanup". */
  name: string;
  intervalMs: number;
  /** Delay before the first run; defaults to `intervalMs`. The interval starts
   *  at `start()`, beside it, not after the first run. */
  firstDelayMs?: number;
  /** One run. Its rejection (or synchronous throw) is caught, logged at error and
   *  recorded; `signal` aborts when the handle is stopped. */
  run: (signal: AbortSignal) => Promise<unknown>;
  log: Logger;
  /** Called for a tick skipped because a run is still in flight. */
  onSkip?: () => void;
  /** An older (stopped) handle of the same loop: no run starts while its run is in flight. */
  after?: LoopHandle | null;
  timers?: LoopTimers;
  now?: () => number;
}

export interface LoopHandle {
  /** Arm the timers. A no-op once started or stopped. */
  start(): void;
  /** Final: clears the timers, aborts a run in flight, and resolves once that
   *  run (and any `after` run) has settled. Never rejects. */
  stop(): Promise<void>;
  state(): LoopState;
  /** A run of this handle or of its `after` chain is in flight. */
  busy(): boolean;
  /** Resolves when no run of this handle or its `after` chain is in flight. */
  settled(): Promise<void>;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createLoop(opts: LoopOptions): LoopHandle {
  const timers = opts.timers ?? realTimers;
  const now = opts.now ?? Date.now;
  const controller = new AbortController();
  let after = opts.after ?? null;
  let first: unknown = null;
  let interval: unknown = null;
  let started = false;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let lastRun: LoopRunState | null = null;

  const afterBusy = () => {
    if (after && !after.busy()) after = null; // settled for good: drop the reference
    return after !== null;
  };

  // `now`, `log` and `onSkip` are the caller's: a throw from one must not escape a
  // timer callback, leave `inFlight` set, or reject `stop()`. A throwing clock
  // falls back to Date.now().
  const clock = () => {
    try {
      return now();
    } catch {
      return Date.now();
    }
  };

  const tick = () => {
    if (stopped) return;
    if (inFlight || afterBusy()) {
      try {
        opts.onSkip?.();
      } catch {
        // the skip hook's failure is not the loop's
      }
      return;
    }
    const record: LoopRunState = { startedAt: clock(), finishedAt: null, ok: null, error: null };
    lastRun = record;
    // The async wrapper turns a synchronous throw in `run` into a rejection.
    inFlight = (async () => opts.run(controller.signal))()
      .then(
        () => {
          record.ok = true;
        },
        (err) => {
          record.ok = false;
          record.error = errText(err);
          try {
            opts.log.error("{loop} failed: {error}", { loop: opts.name, error: record.error });
          } catch {
            // a broken sink: the failure is still recorded in `lastRun`
          }
        },
      )
      .finally(() => {
        record.finishedAt = clock();
        inFlight = null;
      });
  };

  const unref = (h: unknown) => (h as { unref?: () => void } | null)?.unref?.();

  const handle: LoopHandle = {
    start() {
      if (started || stopped) return;
      started = true;
      first = timers.setTimeout(tick, opts.firstDelayMs ?? opts.intervalMs);
      interval = timers.setInterval(tick, opts.intervalMs);
      unref(first);
      unref(interval);
    },
    stop() {
      if (!stopped) {
        stopped = true;
        if (first !== null) timers.clearTimeout(first);
        if (interval !== null) timers.clearInterval(interval);
        first = interval = null;
        controller.abort();
      }
      return handle.settled();
    },
    state: () => ({ name: opts.name, started, stopped, running: inFlight !== null, lastRun: lastRun && { ...lastRun } }),
    busy: () => inFlight !== null || afterBusy(),
    async settled() {
      await Promise.all([inFlight, after?.settled()]);
    },
  };
  return handle;
}

/** Wait for `p` at most `ms`; true when it settled in time. */
export async function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => (timeout = setTimeout(() => r(false), ms))),
  ]);
  clearTimeout(timeout);
  return settled;
}
