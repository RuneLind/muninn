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

function fakeTimers() {
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  let id = 0;
  const unrefed: number[] = [];
  const handle = (n: number) => ({ n, unref: () => unrefed.push(n) });
  const timers: LoopTimers = {
    setTimeout: (fn, _ms) => (timeouts.set(++id, fn), handle(id)),
    clearTimeout: (h) => timeouts.delete((h as { n: number }).n),
    setInterval: (fn, _ms) => (intervals.set(++id, fn), handle(id)),
    clearInterval: (h) => intervals.delete((h as { n: number }).n),
  };
  return {
    timers,
    unrefed,
    /** Fire the first-run timeout (once, like a real one). */
    fireFirst() {
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
});
