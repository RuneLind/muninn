/**
 * The loop helper's contract, driven with fake timers and a fake clock: no
 * sleeps. Ticks are fired by hand, runs are held on gates the test releases.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { configure, getLogger, reset, type LogRecord } from "@logtape/logtape";
import { createLoop, settleWithin, type LoopTimers } from "./loop.ts";

afterEach(async () => {
  await reset();
});

const log = getLogger(["muninn", "test", "loop"]);

/** Delay-blind fake timers: each `fire*()` calls the armed callbacks by hand. */
function fakeTimers() {
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  let id = 0;
  let timeoutArmed = false;
  const unrefed: number[] = [];
  const handle = (n: number) => ({ n, unref: () => unrefed.push(n) });
  const timers: LoopTimers = {
    setTimeout: (fn, _ms) => ((timeoutArmed = true), timeouts.set(++id, fn), handle(id)),
    clearTimeout: (h) => timeouts.delete((h as { n: number }).n),
    setInterval: (fn, _ms) => (intervals.set(++id, fn), handle(id)),
    clearInterval: (h) => intervals.delete((h as { n: number }).n),
  };
  return {
    timers,
    unrefed,
    /** Fire the first-run trigger: the first-delay timeout (once, like a real
     *  one), or, for a loop that armed none (no `firstDelayMs`), the first
     *  interval tick. */
    fireFirst() {
      if (!timeoutArmed) {
        for (const fn of intervals.values()) fn();
        return;
      }
      for (const [k, fn] of timeouts) {
        timeouts.delete(k);
        fn();
      }
    },
    fireInterval() {
      for (const fn of intervals.values()) fn();
    },
    armed: () => timeouts.size + intervals.size,
  };
}

function gated() {
  let release!: () => void;
  let fail!: (e: unknown) => void;
  const gate = new Promise<void>((r, j) => ((release = r), (fail = j)));
  return { gate, release, fail };
}

/** Let pending microtasks (a run's settle handlers) drain. */
const flush = () => new Promise<void>((r) => setImmediate(r));

/**
 * Delay-aware fake timers on a fake clock. `advanceTo(t)` fires every timer due
 * by `t` in due order (ties in arming order, as a real event loop does), and
 * drains microtasks between two callbacks, as real timers do.
 */
function clockTimers() {
  let clock = 0;
  let seq = 0;
  const pending = new Map<number, { due: number; every: number | null; fn: () => void }>();
  const timers: LoopTimers = {
    setTimeout: (fn, ms) => (pending.set(++seq, { due: clock + ms, every: null, fn }), seq),
    clearTimeout: (h) => void pending.delete(h as number),
    setInterval: (fn, ms) => (pending.set(++seq, { due: clock + ms, every: ms, fn }), seq),
    clearInterval: (h) => void pending.delete(h as number),
  };
  return {
    timers,
    armed: () => pending.size,
    async advanceTo(t: number) {
      for (;;) {
        let next: [number, { due: number; every: number | null; fn: () => void }] | null = null;
        for (const e of pending) if (e[1].due <= t && (!next || e[1].due < next[1].due)) next = e;
        if (!next) break;
        const [id, timer] = next;
        clock = timer.due;
        if (timer.every === null) pending.delete(id);
        else timer.due += timer.every;
        timer.fn();
        await flush();
      }
      clock = t;
    },
  };
}

async function capture(): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (r: LogRecord) => records.push(r) },
    loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
    reset: true,
  });
  return records;
}

describe("createLoop", () => {
  test("first run on the first-delay timer, then on the interval; timers are unref'd", async () => {
    const t = fakeTimers();
    let runs = 0;
    const loop = createLoop({ name: "L", intervalMs: 1000, firstDelayMs: 10, log, timers: t.timers, run: async () => void runs++ });
    loop.start();
    loop.start(); // idempotent
    expect(t.armed()).toBe(2);
    expect(t.unrefed.length).toBe(2);
    t.fireFirst();
    await flush();
    t.fireInterval();
    await flush();
    expect(runs).toBe(2);
    await loop.stop();
  });

  test("single-flight: a tick while a run is in flight starts no second run, and calls onSkip", async () => {
    const t = fakeTimers();
    const g = gated();
    let runs = 0;
    let skips = 0;
    const loop = createLoop({
      name: "L",
      intervalMs: 1000,
      log,
      timers: t.timers,
      onSkip: () => skips++,
      run: async () => {
        runs++;
        await g.gate;
      },
    });
    loop.start();
    t.fireFirst();
    t.fireInterval();
    t.fireInterval();
    await flush();
    expect(runs).toBe(1);
    expect(skips).toBe(2);
    g.release();
    await flush();
    t.fireInterval();
    await flush();
    expect(runs).toBe(2);
    await loop.stop();
  });

  test("stop aborts the run in flight, clears the timers, and resolves only when the run has settled", async () => {
    const t = fakeTimers();
    const g = gated();
    let signal: AbortSignal | undefined;
    const loop = createLoop({
      name: "L",
      intervalMs: 1000,
      log,
      timers: t.timers,
      run: async (s) => {
        signal = s;
        await g.gate;
      },
    });
    loop.start();
    t.fireFirst();
    expect(signal?.aborted).toBe(false);
    let stopped = false;
    const stop = loop.stop().then(() => (stopped = true));
    expect(signal?.aborted).toBe(true);
    expect(t.armed()).toBe(0);
    await flush();
    expect(stopped).toBe(false);
    expect(loop.state().running).toBe(true);
    g.release();
    await stop;
    expect(stopped).toBe(true);
    expect(loop.state().running).toBe(false);
  });

  test("stop is final: no tick after it starts a run, and start does not re-arm", async () => {
    const t = fakeTimers();
    let runs = 0;
    const loop = createLoop({ name: "L", intervalMs: 1000, log, timers: t.timers, run: async () => void runs++ });
    loop.start();
    await loop.stop();
    loop.start();
    expect(t.armed()).toBe(0);
    t.fireInterval();
    t.fireFirst();
    await flush();
    expect(runs).toBe(0);
    expect(loop.state().stopped).toBe(true);
  });

  test("a tick already queued when stop clears the timers starts no run", async () => {
    let tick: (() => void) | undefined;
    const timers: LoopTimers = {
      setTimeout: () => null,
      clearTimeout: () => {},
      setInterval: (fn) => ((tick = fn), null),
      clearInterval: () => {},
    };
    let runs = 0;
    const loop = createLoop({ name: "L", intervalMs: 1000, log, timers, run: async () => void runs++ });
    loop.start();
    await loop.stop();
    tick!();
    await flush();
    expect(runs).toBe(0);
  });

  test("a fresh handle created after a stop never revives the stopped run, and runs nothing while it is in flight", async () => {
    const t1 = fakeTimers();
    const g = gated();
    let signal: AbortSignal | undefined;
    const old = createLoop({
      name: "L",
      intervalMs: 1000,
      log,
      timers: t1.timers,
      run: async (s) => {
        signal = s;
        await g.gate;
      },
    });
    old.start();
    t1.fireFirst();
    void old.stop(); // not awaited: the run is still at its gate
    const t2 = fakeTimers();
    let fresh = 0;
    let skips = 0;
    const next = createLoop({ name: "L", intervalMs: 1000, log, timers: t2.timers, after: old, onSkip: () => skips++, run: async () => void fresh++ });
    next.start();
    expect(signal?.aborted).toBe(true);
    t2.fireFirst();
    await flush();
    expect(fresh).toBe(0);
    expect(skips).toBe(1);
    expect(next.busy()).toBe(true);
    let nextStopped = false;
    const nextStop = next.stop().then(() => (nextStopped = true));
    await flush();
    expect(nextStopped, "stopping the new handle still waits for the old run").toBe(false);
    g.release();
    await nextStop;
    expect(signal?.aborted).toBe(true);
  });

  test("once the older run settles, the new handle runs", async () => {
    const t1 = fakeTimers();
    const g = gated();
    const old = createLoop({ name: "L", intervalMs: 1000, log, timers: t1.timers, run: () => g.gate });
    old.start();
    t1.fireFirst();
    void old.stop();
    const t2 = fakeTimers();
    let fresh = 0;
    const next = createLoop({ name: "L", intervalMs: 1000, log, timers: t2.timers, after: old, run: async () => void fresh++ });
    next.start();
    g.release();
    await flush();
    t2.fireFirst();
    await flush();
    expect(fresh).toBe(1);
    await next.stop();
  });

  test("a run that rejects is logged at error with the loop name, recorded, and the loop keeps ticking", async () => {
    const records = await capture();
    const t = fakeTimers();
    let calls = 0;
    let ms = 1_000;
    const loop = createLoop({
      name: "Retention cleanup",
      intervalMs: 1000,
      log,
      timers: t.timers,
      now: () => (ms += 5),
      run: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
      },
    });
    loop.start();
    t.fireFirst();
    await flush();
    const errors = records.filter((r) => r.level === "error");
    expect(errors.length).toBe(1);
    expect(errors[0]!.properties).toEqual({ loop: "Retention cleanup", error: "boom" });
    expect(loop.state().lastRun).toEqual({ startedAt: 1_005, finishedAt: 1_010, ok: false, error: "boom" });
    t.fireInterval();
    await flush();
    expect(calls).toBe(2);
    expect(loop.state().lastRun).toEqual({ startedAt: 1_015, finishedAt: 1_020, ok: true, error: null });
    await loop.stop();
  });

  test("a run that throws synchronously is caught the same way", async () => {
    const records = await capture();
    const t = fakeTimers();
    const loop = createLoop({
      name: "L",
      intervalMs: 1000,
      log,
      timers: t.timers,
      run: () => {
        throw new Error("sync");
      },
    });
    loop.start();
    t.fireFirst();
    await flush();
    expect(records.filter((r) => r.level === "error").length).toBe(1);
    expect(loop.state().lastRun?.error).toBe("sync");
    expect(loop.state().running).toBe(false);
    await loop.stop();
  });

  test("state: nothing before a run; in flight with no finish; epoch-ms timestamps", async () => {
    const t = fakeTimers();
    const g = gated();
    const loop = createLoop({ name: "L", intervalMs: 1000, log, timers: t.timers, run: () => g.gate });
    expect(loop.state()).toEqual({ name: "L", started: false, stopped: false, running: false, lastRun: null });
    loop.start();
    const before = Date.now();
    t.fireFirst();
    const s = loop.state();
    expect(s.running).toBe(true);
    expect(s.lastRun?.finishedAt).toBeNull();
    expect(s.lastRun?.ok).toBeNull();
    expect(s.lastRun!.startedAt).toBeGreaterThanOrEqual(before);
    g.release();
    await flush();
    expect(loop.state().lastRun?.ok).toBe(true);
    expect(loop.state().lastRun!.finishedAt).toBeGreaterThanOrEqual(s.lastRun!.startedAt);
    await loop.stop();
  });
});

describe("createLoop: first-run timing on a fake clock", () => {
  test("without firstDelayMs, an instant run executes once at the first boundary, not twice", async () => {
    const c = clockTimers();
    let runs = 0;
    let skips = 0;
    const loop = createLoop({ name: "L", intervalMs: 1000, log, timers: c.timers, onSkip: () => skips++, run: async () => void runs++ });
    loop.start();
    const armedAtStart = c.armed();
    await c.advanceTo(999);
    expect(runs).toBe(0);
    await c.advanceTo(1000);
    expect({ runs, skips }).toEqual({ runs: 1, skips: 0 });
    await c.advanceTo(2000);
    expect({ runs, skips }).toEqual({ runs: 2, skips: 0 });
    expect(armedAtStart, "only the interval is armed").toBe(1);
    await loop.stop();
  });

  test("without firstDelayMs, a run still in flight at the first boundary draws no skip there", async () => {
    const c = clockTimers();
    const g = gated();
    let runs = 0;
    let skips = 0;
    const loop = createLoop({
      name: "L",
      intervalMs: 1000,
      log,
      timers: c.timers,
      onSkip: () => skips++,
      run: async () => {
        runs++;
        await g.gate;
      },
    });
    loop.start();
    await c.advanceTo(1000);
    expect({ runs, skips }).toEqual({ runs: 1, skips: 0 });
    g.release();
    await loop.stop();
  });

  test("with firstDelayMs, both timers are armed at start and the interval does not wait for the first run", async () => {
    const c = clockTimers();
    const startedAt: number[] = [];
    let ms = 0;
    const loop = createLoop({
      name: "L",
      intervalMs: 1000,
      firstDelayMs: 10,
      log,
      timers: c.timers,
      now: () => ms,
      run: async () => void startedAt.push(ms),
    });
    loop.start();
    expect(c.armed()).toBe(2);
    ms = 10;
    await c.advanceTo(10);
    ms = 1000;
    await c.advanceTo(1000);
    expect(startedAt).toEqual([10, 1000]);
    await loop.stop();
  });
});

describe("createLoop: stop and the predecessor chain", () => {
  test("a second stop() while a run is in flight also waits for that run", async () => {
    const t = fakeTimers();
    const g = gated();
    const loop = createLoop({ name: "L", intervalMs: 1000, firstDelayMs: 10, log, timers: t.timers, run: () => g.gate });
    loop.start();
    t.fireFirst();
    const done = { first: false, second: false };
    const first = loop.stop().then(() => (done.first = true));
    const second = loop.stop().then(() => (done.second = true));
    for (let i = 0; i < 3; i++) await flush();
    expect(done, "neither stop resolves before the run settles").toEqual({ first: false, second: false });
    g.release();
    await Promise.all([first, second]);
    expect(done).toEqual({ first: true, second: true });
  });

  test("the predecessor chain is followed past one level: a run in flight two handles back still holds the newest", async () => {
    const g = gated();
    const tA = fakeTimers();
    const a = createLoop({ name: "L", intervalMs: 1000, log, timers: tA.timers, run: () => g.gate });
    a.start();
    tA.fireFirst();
    void a.stop(); // A's run stays at its gate
    // B never runs: started and stopped while A's run is in flight. Nothing here
    // calls B.busy() or ticks B, so B still holds its reference to A.
    const b = createLoop({ name: "L", intervalMs: 1000, log, timers: fakeTimers().timers, after: a, run: async () => {} });
    b.start();
    void b.stop();
    const tC = fakeTimers();
    let runs = 0;
    let skips = 0;
    const c = createLoop({ name: "L", intervalMs: 1000, log, timers: tC.timers, after: b, onSkip: () => skips++, run: async () => void runs++ });
    c.start();
    tC.fireFirst();
    await flush();
    expect({ runs, skips }, "C must skip while A's run is in flight").toEqual({ runs: 0, skips: 1 });
    expect(c.busy()).toBe(true);
    g.release();
    await a.settled();
    await flush();
    tC.fireInterval();
    await flush();
    expect({ runs, skips }, "once A's run has settled, C runs").toEqual({ runs: 1, skips: 1 });
    await c.stop();
  });

  /**
   * A chain of stopped handles, none ever ticked, only the newest kept. Each
   * older handle must become collectable once it has settled. Observed through
   * `WeakRef` after `Bun.gc(true)`, polled with a bound: a reachable handle
   * keeps its `deref()` for every poll, so a leak fails deterministically; a
   * collected one can only be observed as collected, so the green is real.
   */
  test("a stopped handle that never ticked releases its settled predecessors", async () => {
    const build = () => {
      const refs: WeakRef<object>[] = [];
      let prev: ReturnType<typeof createLoop> | null = null;
      for (let i = 0; i < 3; i++) {
        const h = createLoop({ name: "L", intervalMs: 1000, firstDelayMs: 10, log, timers: fakeTimers().timers, after: prev, run: async () => {} });
        h.start();
        void h.stop();
        if (prev) refs.push(new WeakRef(prev));
        prev = h;
      }
      return { newest: prev!, refs };
    };
    const { newest, refs } = build();
    // No busy() call before the check: busy() drops a settled `after` itself,
    // which would hide the leak this test is about.
    await newest.settled();
    let alive = refs.length;
    for (let i = 0; i < 50 && alive > 0; i++) {
      await flush();
      Bun.gc(true);
      alive = refs.filter((r) => r.deref() !== undefined).length;
    }
    expect(alive, "older handles still reachable from the newest").toBe(0);
    expect(newest.state().stopped).toBe(true);
  });
});

/**
 * The caller's own callbacks (`now`, `log`, `onSkip`) throwing. Each case asserts
 * the handle is not wedged (the next tick runs), `stop()` resolves, and nothing
 * escapes: the fake timers call the tick synchronously, so a throw that would be
 * an uncaught exception in a real timer callback is a throw from `fire*()` here.
 * An unhandled rejection is caught by bun's test runner itself, which fails the
 * test whatever process listeners exist (it does not dispatch to them); the
 * counters are kept for a runtime that does.
 */
describe("createLoop: a throwing caller callback", () => {
  const escapes = () => {
    const seen = { uncaught: 0, unhandled: 0 };
    const onUncaught = () => void seen.uncaught++;
    const onUnhandled = () => void seen.unhandled++;
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);
    return {
      seen,
      /** Wait long enough for a late rejection to surface, then detach. */
      async done() {
        for (let i = 0; i < 5; i++) await flush();
        await new Promise((r) => setTimeout(r, 20));
        process.off("uncaughtException", onUncaught);
        process.off("unhandledRejection", onUnhandled);
      },
    };
  };

  /** "resolved", "rejected", or "pending" after a bounded wait. */
  const outcome = async (p: Promise<unknown>) =>
    Promise.race([
      p.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((r) => setTimeout(() => r("pending"), 50)),
    ]);

  const throwingLog = () => {
    const l = Object.create(log) as typeof log;
    l.error = (() => {
      throw new Error("sink down");
    }) as typeof log.error;
    return l;
  };

  test("now() throwing when a tick starts: no throw from the tick, the next tick runs, stop resolves", async () => {
    const e = escapes();
    const t = fakeTimers();
    let calls = 0;
    let runs = 0;
    const loop = createLoop({
      name: "L",
      intervalMs: 1000,
      log,
      timers: t.timers,
      now: () => {
        if (++calls === 1) throw new Error("clock");
        return calls;
      },
      run: async () => void runs++,
    });
    loop.start();
    expect(() => t.fireFirst()).not.toThrow();
    await flush();
    t.fireInterval();
    await flush();
    expect(runs).toBeGreaterThanOrEqual(1);
    expect(loop.state().running).toBe(false);
    expect(await outcome(loop.stop())).toBe("resolved");
    await e.done();
    expect(e.seen).toEqual({ uncaught: 0, unhandled: 0 });
  });

  test("now() throwing when a failed run finishes: the run is recorded as failed, not wedged, stop resolves", async () => {
    const e = escapes();
    const t = fakeTimers();
    const g = gated();
    let calls = 0;
    let runs = 0;
    const loop = createLoop({
      name: "L",
      intervalMs: 1000,
      log,
      timers: t.timers,
      now: () => {
        if (++calls === 2) throw new Error("clock");
        return calls;
      },
      run: async () => {
        if (++runs === 1) await g.gate;
      },
    });
    loop.start();
    t.fireFirst();
    g.fail(new Error("boom"));
    await flush();
    expect(loop.state().running).toBe(false);
    expect(loop.busy()).toBe(false);
    expect(loop.state().lastRun?.ok).toBe(false);
    expect(loop.state().lastRun?.error).toBe("boom");
    t.fireInterval();
    await flush();
    expect(runs).toBe(2);
    expect(await outcome(loop.stop())).toBe("resolved");
    await e.done();
    expect(e.seen).toEqual({ uncaught: 0, unhandled: 0 });
  });

  test("now() throwing when a run finishes while stop() waits: stop resolves", async () => {
    const e = escapes();
    const t = fakeTimers();
    const g = gated();
    let calls = 0;
    const loop = createLoop({
      name: "L",
      intervalMs: 1000,
      log,
      timers: t.timers,
      now: () => {
        if (++calls === 2) throw new Error("clock");
        return calls;
      },
      run: () => g.gate,
    });
    loop.start();
    t.fireFirst();
    const stop = loop.stop();
    g.release();
    expect(await outcome(stop)).toBe("resolved");
    expect(await outcome(loop.settled())).toBe("resolved");
    expect(loop.state().running).toBe(false);
    await e.done();
    expect(e.seen).toEqual({ uncaught: 0, unhandled: 0 });
  });

  test("log.error throwing for a failed run: recorded as failed, not wedged, a waiting stop resolves", async () => {
    const e = escapes();
    const t = fakeTimers();
    const g = gated();
    let runs = 0;
    const loop = createLoop({
      name: "L",
      intervalMs: 1000,
      log: throwingLog(),
      timers: t.timers,
      run: async () => {
        if (++runs === 1) await g.gate;
      },
    });
    loop.start();
    t.fireFirst();
    g.fail(new Error("boom"));
    await flush();
    expect(loop.state().running).toBe(false);
    expect(loop.state().lastRun?.ok).toBe(false);
    expect(loop.state().lastRun?.error).toBe("boom");
    expect(loop.state().lastRun?.finishedAt).not.toBeNull();
    t.fireInterval();
    await flush();
    expect(runs).toBe(2);
    expect(await outcome(loop.stop())).toBe("resolved");
    await e.done();
    expect(e.seen).toEqual({ uncaught: 0, unhandled: 0 });
  });

  test("log.error throwing while stop() waits on the failing run: stop resolves", async () => {
    const e = escapes();
    const t = fakeTimers();
    const g = gated();
    const loop = createLoop({ name: "L", intervalMs: 1000, log: throwingLog(), timers: t.timers, run: () => g.gate });
    loop.start();
    t.fireFirst();
    const stop = loop.stop();
    g.fail(new Error("boom"));
    expect(await outcome(stop)).toBe("resolved");
    expect(loop.state().lastRun?.ok).toBe(false);
    await e.done();
    expect(e.seen).toEqual({ uncaught: 0, unhandled: 0 });
  });

  test("onSkip throwing: no throw from the skipped tick, the next tick runs, stop resolves", async () => {
    const e = escapes();
    const t = fakeTimers();
    const g = gated();
    let runs = 0;
    const loop = createLoop({
      name: "L",
      intervalMs: 1000,
      log,
      timers: t.timers,
      onSkip: () => {
        throw new Error("skip hook");
      },
      run: async () => {
        if (++runs === 1) await g.gate;
      },
    });
    loop.start();
    t.fireFirst();
    expect(() => t.fireInterval()).not.toThrow();
    g.release();
    await flush();
    t.fireInterval();
    await flush();
    expect(runs).toBe(2);
    expect(await outcome(loop.stop())).toBe("resolved");
    await e.done();
    expect(e.seen).toEqual({ uncaught: 0, unhandled: 0 });
  });
});

describe("settleWithin", () => {
  test("true when the promise settles in time (a rejection included), false after the bound", async () => {
    expect(await settleWithin(Promise.resolve(), 50)).toBe(true);
    expect(await settleWithin(Promise.reject(new Error("x")), 50)).toBe(true);
    expect(await settleWithin(new Promise(() => {}), 5)).toBe(false);
  });

  test("a promise that settles first clears the bound's timer", async () => {
    // Spies on the globals settleWithin calls, restored in `finally`.
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const armed: unknown[] = [];
    const cleared: unknown[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const h = realSet(fn, ms);
      armed.push(h);
      return h;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((h: Parameters<typeof clearTimeout>[0]) => {
      cleared.push(h);
      realClear(h);
    }) as typeof clearTimeout;
    try {
      expect(await settleWithin(Promise.resolve(), 60_000)).toBe(true);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
    expect(armed.length).toBe(1);
    expect(cleared).toContain(armed[0]);
    realClear(armed[0] as ReturnType<typeof setTimeout>); // leave no live 60 s timer behind under a mutant
  });
});
