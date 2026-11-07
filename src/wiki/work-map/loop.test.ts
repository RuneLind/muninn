import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { triagePassHeld, tryHoldTriagePass, type TriageLoopDeps } from "../decision-triage/loop-deps.ts";
import type { WorkMapRunResult } from "./run.ts";
import type { WorkMapState } from "./state.ts";
import {
  startWorkMapLoop,
  stopWorkMapLoop,
  todaysHourMs,
  WORK_MAP_FRESH_MS,
  WORK_MAP_TICK_MS,
  WORK_MAP_WAKE_RETRY_MS,
  workMapDue,
  type WorkMapLoopDeps,
} from "./loop.ts";

const HOUR = 3_600_000;
const MIN = 60_000;
/** 2026-10-20 07:00 Europe/Oslo (CEST, UTC+2) — past the default 05:00. */
const MORNING = Date.parse("2026-10-20T05:00:00Z");

afterEach(() => stopWorkMapLoop(10));
/** Settles every `stuck` pass a test left running, so its hold on the shared single-flight ends with the test. */
const stuckSettlers: (() => void)[] = [];
afterEach(async () => {
  for (const settle of stuckSettlers.splice(0)) settle();
  await Bun.sleep(1);
});

describe("the decision triage's due check", () => {
  function triageHarness(opts: { workMap?: WorkMapRunResult["outcome"][]; triage?: ("ok" | "partial" | "refused" | "failed")[]; state?: () => WorkMapState | null; wikis?: string[]; start?: number } = {}) {
    const base = harness({ ...(opts.workMap ? { outcomes: opts.workMap } : {}), ...(opts.start !== undefined ? { start: opts.start } : {}) });
    const runs: { wiki: string; at: number }[] = [];
    const checks: string[] = [];
    const outcomes = [...(opts.triage ?? [])];
    const triage: TriageLoopDeps = {
      wikis: async (covered) => opts.wikis ?? [...covered],
      beforeCheck: async (wiki) => void checks.push(wiki),
      readState: async () => opts.state?.() ?? null,
      run: async (wiki) => {
        runs.push({ wiki, at: base.deps.now() });
        return { outcome: outcomes.shift() ?? "ok" };
      },
      recordFailed: async () => {},
    };
    return { ...base, deps: { ...base.deps, triage }, triageRuns: runs, checks };
  }
  const config = { schedulerEnabled: true, workMapWikis: ["mimir"], workMapHour: 5, profile: "default" as const };

  test("a failed work map does not cost the night", async () => {
    const h = triageHarness({ workMap: ["failed"] });
    startWorkMapLoop(config, { deps: h.deps });
    await h.advance(WORK_MAP_TICK_MS);
    expect(h.runs).toHaveLength(1);
    expect(h.triageRuns.map((r) => r.wiki)).toEqual(["mimir"]);
    expect(h.checks).toEqual(["mimir"]);
  });

  test("its own state decides: done within 20 h, twice failed since the hour, or before the hour", async () => {
    const fresh = triageHarness({ state: () => ({ wiki: "mimir", lastSuccessAt: MORNING - HOUR, attempts: [] }) });
    startWorkMapLoop(config, { deps: fresh.deps });
    await fresh.advance(WORK_MAP_TICK_MS);
    expect(fresh.runs).toHaveLength(1);
    expect(fresh.triageRuns).toHaveLength(0);
    await stopWorkMapLoop(10);

    const failing = triageHarness({ state: () => ({ wiki: "mimir", attempts: [{ at: MORNING - MIN, outcome: "failed" }, { at: MORNING - 2 * MIN, outcome: "failed" }] }) });
    startWorkMapLoop(config, { deps: failing.deps });
    await failing.advance(WORK_MAP_TICK_MS);
    expect(failing.triageRuns).toHaveLength(0);
  });

  test("a wiki outside its scope gets no check; a throw costs the work map nothing", async () => {
    const out = triageHarness({ wikis: [] });
    startWorkMapLoop(config, { deps: out.deps });
    await out.advance(WORK_MAP_TICK_MS);
    expect(out.runs).toHaveLength(1);
    expect(out.triageRuns).toHaveLength(0);
    await stopWorkMapLoop(10);

    const thrower = triageHarness();
    thrower.deps.triage!.readState = async () => {
      throw new Error("boom");
    };
    startWorkMapLoop(config, { deps: thrower.deps });
    await thrower.advance(WORK_MAP_TICK_MS);
    expect(thrower.runs).toHaveLength(1);
  });

  test("a refused run retries at the next check", async () => {
    const h = triageHarness({ triage: ["refused", "ok"] });
    startWorkMapLoop(config, { deps: h.deps });
    await h.advance(WORK_MAP_TICK_MS);
    expect(h.triageRuns).toHaveLength(1);
    await h.advance(HOUR + WORK_MAP_TICK_MS);
    expect(h.triageRuns).toHaveLength(2);
  });

  test("no deps, no triage", async () => {
    const h = harness();
    startWorkMapLoop(config, { deps: h.deps });
    await h.advance(WORK_MAP_TICK_MS);
    expect(h.runs).toHaveLength(1);
  });

  describe("beside the work map's check, not inside it", () => {
    /** A triage whose run never returns; `signals` holds what each run was handed. */
    function stuck(h: ReturnType<typeof triageHarness>) {
      const signals: AbortSignal[] = [];
      const failed: { wiki: string; at: number; error: string }[] = [];
      h.deps.triage!.run = (wiki, signal) => {
        h.triageRuns.push({ wiki, at: h.deps.now() });
        signals.push(signal);
        return new Promise((r) => void stuckSettlers.push(() => r({ outcome: "aborted" })));
      };
      h.deps.triage!.recordFailed = async (wiki, error) => void failed.push({ wiki, at: h.deps.now(), error });
      /** Let every stuck pass return, as an aborted one eventually does. */
      const settle = async () => {
        for (const s of stuckSettlers.splice(0)) s();
        await Bun.sleep(1);
      };
      return { signals, failed, settle };
    }

    test("a triage that never returns leaves the work map on schedule", async () => {
      const h = triageHarness();
      stuck(h);
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      expect(h.runs).toHaveLength(1);
      await h.advance(HOUR);
      expect(h.runs).toHaveLength(2);
      // Its guard holds: no second run on top of the one still going.
      expect(h.triageRuns).toHaveLength(1);
      await h.advance(HOUR);
      expect(h.runs).toHaveLength(3);
    });

    test("a triage that never returns leaves the work map's wake retries on time", async () => {
      const h = triageHarness({ workMap: Array(10).fill("refused") });
      stuck(h);
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      await h.jump(30 * MIN);
      const wakeAt = h.now();
      await h.advance(20 * MIN);
      expect(h.runs.slice(2).map((r) => Math.round((r.at - wakeAt) / MIN))).toEqual([5, 10, 15]);
    });

    test("a stalled work map does not hold the triage", async () => {
      const h = triageHarness();
      h.deps.run = () => new Promise(() => {});
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      expect(h.triageRuns).toHaveLength(1);
      await h.advance(HOUR);
      expect(h.triageRuns).toHaveLength(2);
    });

    test("a triage refusal after a wake arms no work-map retry", async () => {
      const h = triageHarness({ triage: Array(10).fill("refused") });
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      await h.jump(2 * HOUR);
      expect(h.runs).toHaveLength(2);
      await h.advance(30 * MIN);
      expect(h.runs).toHaveLength(2);
    });

    test("a work-map refusal after a wake re-runs no triage, and a triage gets no wake check of its own", async () => {
      const h = triageHarness({ workMap: Array(10).fill("refused"), triage: Array(10).fill("refused") });
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      expect(h.triageRuns).toHaveLength(1);
      await h.jump(20 * MIN);
      await h.advance(20 * MIN);
      expect(h.runs.length).toBeGreaterThanOrEqual(5);
      expect(h.triageRuns).toHaveLength(1);
      // Hourly from its own last check, whatever the work map did since.
      await h.advance(21 * MIN);
      expect(h.triageRuns).toHaveLength(2);
    });

    test("a refused day is one run per hour past the hour, however often the machine wakes", async () => {
      const h = triageHarness({ start: Date.parse("2026-10-19T22:00:00Z"), triage: Array(100).fill("refused") }); // 00:00 Oslo
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      for (let i = 0; i < 72; i++) await h.jump(20 * MIN);
      expect(h.triageRuns.length).toBeGreaterThanOrEqual(18);
      expect(h.triageRuns.length).toBeLessThanOrEqual(19);
    });

    test("Run now holding the pass skips the loop's check, which runs on the next tick after the release", async () => {
      const h = triageHarness();
      const click = tryHoldTriagePass()!;
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      expect(h.runs).toHaveLength(1);
      expect(h.triageRuns).toHaveLength(0);
      click();
      await h.advance(WORK_MAP_TICK_MS);
      expect(h.triageRuns).toHaveLength(1);
    });

    test("the loop's check holds the pass Run now shares, until it ends", async () => {
      const h = triageHarness();
      let finish!: () => void;
      h.deps.triage!.run = (wiki) => {
        h.triageRuns.push({ wiki, at: h.deps.now() });
        return new Promise((r) => (finish = () => r({ outcome: "ok" })));
      };
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      expect(h.triageRuns).toHaveLength(1);
      expect(triagePassHeld()).toBe(true);
      expect(tryHoldTriagePass()).toBeNull();
      finish();
      await Bun.sleep(1);
      expect(triagePassHeld()).toBe(false);
    });

    test("a pass that ignores its bound keeps the hold: no second pass, from a click or the loop, until it settles", async () => {
      const h = triageHarness();
      const { signals, settle } = stuck(h);
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      await h.advance(4 * HOUR);
      expect(signals[0]!.aborted).toBe(true);
      expect(h.triageRuns).toHaveLength(1);
      expect(triagePassHeld()).toBe(true);
      expect(tryHoldTriagePass()).toBeNull();
      await settle();
      expect(triagePassHeld()).toBe(false);
      await h.advance(HOUR);
      expect(h.triageRuns).toHaveLength(2);
    });

    test("the stop aborts a pass that never returns and keeps the hold until it settles", async () => {
      const h = triageHarness();
      const { signals, failed, settle } = stuck(h);
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      await stopWorkMapLoop(10);
      expect(signals[0]!.aborted).toBe(true);
      expect(triagePassHeld()).toBe(true);
      await settle();
      expect(triagePassHeld()).toBe(false);
      // A stop is no failure: nothing recorded.
      expect(failed).toEqual([]);
    });

    test("the pass's bound: 2 h, then its signal aborts; a pass that returns aborted is recorded failed once, when it returns", async () => {
      const h = triageHarness();
      const { signals, failed, settle } = stuck(h);
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      await h.advance(2 * HOUR - MIN);
      expect(signals[0]!.aborted).toBe(false);
      expect(h.triageRuns).toHaveLength(1);
      await h.advance(2 * MIN);
      expect(signals[0]!.aborted).toBe(true);
      // The pass may still be writing: nothing is recorded until it returns.
      expect(failed).toEqual([]);
      await h.advance(HOUR);
      expect(failed).toEqual([]);
      expect(h.triageRuns).toHaveLength(1);
      await settle();
      expect(failed.map((f) => f.wiki)).toEqual(["mimir"]);
      expect(failed[0]!.error).toContain("timed out");
      await h.advance(HOUR);
      expect(h.triageRuns).toHaveLength(2);
      expect(failed).toHaveLength(1);
    });

    test("a pass that ignores its bound and then finishes on its own: one run line for its run, and the state is its own", async () => {
      const h = triageHarness();
      /** The log and state as the real half writes them: the pass's own line at its end, or `recordFailed`'s. */
      const lines: { runId: string; outcome: string }[] = [];
      let state = null as string | null;
      let finish!: () => void;
      h.deps.triage!.run = (wiki) => {
        h.triageRuns.push({ wiki, at: h.deps.now() });
        return new Promise((r) => (finish = () => {
          lines.push({ runId: "r1", outcome: "ok" });
          state = "ok";
          r({ outcome: "ok", cards: 2 });
        }));
      };
      h.deps.triage!.recordFailed = async () => {
        lines.push({ runId: "r1", outcome: "failed" });
        state = "failed";
        return "failed";
      };
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      await h.advance(2 * HOUR + MIN);
      finish();
      await Bun.sleep(1);
      expect(lines).toEqual([{ runId: "r1", outcome: "ok" }]);
      expect(state).toBe("ok");
    });

    test("a pass that ends on its own records nothing and leaves no bound armed", async () => {
      const h = triageHarness();
      const failed: string[] = [];
      h.deps.triage!.recordFailed = async (wiki) => void failed.push(wiki);
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      expect(h.triageRuns).toHaveLength(1);
      await h.advance(90 * MIN);
      await h.advance(3 * HOUR);
      expect(failed).toEqual([]);
      expect(h.timers).toHaveLength(1);
    });

    test("shutdown aborts a triage that never returns, gives up after the wait and leaves no timer", async () => {
      const h = triageHarness();
      const { signals, failed } = stuck(h);
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      await stopWorkMapLoop(10);
      expect(signals[0]!.aborted).toBe(true);
      expect(h.timers).toHaveLength(0);
      await h.advance(3 * HOUR);
      expect(failed).toEqual([]);
      expect(h.runs).toHaveLength(1);
      expect(h.triageRuns).toHaveLength(1);
    });

    test("the stop path awaits a triage that is finishing", async () => {
      const h = triageHarness();
      let finished = false;
      h.deps.triage!.run = (_wiki, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            setTimeout(() => {
              finished = true;
              resolve({ outcome: "aborted" });
            }, 30);
          });
        });
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      await stopWorkMapLoop(2_000);
      expect(finished).toBe(true);
    });
  });

  describe("a pass past its bound that still holds the guard says so", () => {
    let records: LogRecord[];
    beforeEach(async () => {
      records = [];
      await configure({
        sinks: { mem: (r) => void records.push(r) },
        loggers: [{ category: "muninn", lowestLevel: "info", sinks: ["mem"] }, { category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] }],
      });
    });
    afterEach(() => reset());
    const wedged = () => records.filter((r) => r.level === "warning" && r.message.join("").includes("still holds the guard")).map((r) => r.message.join(""));

    test("a click's hold, however long, says nothing", async () => {
      const h = triageHarness();
      const click = tryHoldTriagePass()!;
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(5 * HOUR);
      click();
      expect(h.triageRuns).toHaveLength(0);
      expect(wedged()).toEqual([]);
    });

    test("the loop's own pass past its bound: one warning an hour, naming the wiki", async () => {
      const h = triageHarness();
      h.deps.triage!.run = (wiki) => {
        h.triageRuns.push({ wiki, at: h.deps.now() });
        return new Promise((r) => void stuckSettlers.push(() => r({ outcome: "aborted" })));
      };
      startWorkMapLoop(config, { deps: h.deps });
      await h.advance(WORK_MAP_TICK_MS);
      await h.advance(2 * HOUR - MIN);
      expect(wedged()).toEqual([]);
      await h.advance(2 * HOUR + 30 * MIN);
      expect(wedged()).toHaveLength(3);
      expect(wedged()[0]).toContain("a pass on mimir has run since");
    });
  });

  describe("the variable set with the loop off says so", () => {
    let records: LogRecord[];
    beforeEach(async () => {
      records = [];
      await configure({
        sinks: { mem: (r) => void records.push(r) },
        loggers: [{ category: "muninn", lowestLevel: "info", sinks: ["mem"] }, { category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] }],
      });
    });
    afterEach(() => reset());
    const said = () => records.map((r) => r.message.join("")).filter((m) => m.includes("Decision triage"));

    test("no WORK_MAP_WIKIS, the scheduler off, nais, a readonly instance, no wiki left: one line each", () => {
      const { deps } = harness();
      const on = { ...config, decisionTriageRepoRoots: "/r" };
      for (const off of [
        () => startWorkMapLoop({ ...on, workMapWikis: [] }, { deps }),
        () => startWorkMapLoop({ ...on, schedulerEnabled: false }, { deps }),
        () => startWorkMapLoop({ ...on, profile: "nais" }, { deps }),
        () => startWorkMapLoop(on, { deps: { ...deps, isReadonly: () => true } }),
        () => startWorkMapLoop({ ...on, workMapWikis: ["ro"] }, { deps }),
      ]) {
        records.length = 0;
        expect(off()).toEqual([]);
        expect(said()).toHaveLength(1);
      }
    });

    test("the variable unset: nothing about the triage", () => {
      const { deps } = harness();
      expect(startWorkMapLoop({ ...config, workMapWikis: [] }, { deps })).toEqual([]);
      expect(said()).toEqual([]);
    });
  });
});

/** A fake clock and timer queue: `advance` moves time and fires due timers. */
function harness(opts: { outcomes?: WorkMapRunResult["outcome"][]; state?: () => WorkMapState | null; start?: number } = {}) {
  let now = opts.start ?? MORNING;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 0;
  const runs: { wiki: string; at: number }[] = [];
  const outcomes = [...(opts.outcomes ?? [])];
  const deps: WorkMapLoopDeps = {
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, id: ++nextId };
      timers.push(t);
      return t.id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    readState: async () => opts.state?.() ?? null,
    run: async (wiki) => {
      runs.push({ wiki, at: now });
      const outcome = outcomes.shift() ?? "ok";
      return outcome === "ok"
        ? ({ outcome, map: {} as never, written: true } as WorkMapRunResult)
        : outcome === "aborted"
          ? { outcome }
          : { outcome, reason: "x" };
    },
    registry: () => [{ name: "mimir", root: "/w/mimir", source: "extra" } as never, { name: "ro", root: "/w/ro", source: "extra" } as never],
    isReadonly: () => false,
    isReadonlyRoot: (root) => root === "/w/ro",
  };
  /** Advance in tick-sized steps (a sleep is one big jump: `jump`). */
  const advance = async (ms: number) => {
    const until = now + ms;
    while (true) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > until) break;
      timers.shift();
      now = t.at;
      t.fn();
      await Bun.sleep(0);
      await Bun.sleep(0);
    }
    now = until;
  };
  /** The machine slept: the clock jumps, the pending timer fires late. */
  const jump = async (ms: number) => {
    now += ms;
    timers.sort((a, b) => a.at - b.at);
    const t = timers.shift();
    t?.fn();
    await Bun.sleep(0);
    await Bun.sleep(0);
  };
  return { deps, runs, advance, jump, timers, now: () => now };
}

const config = { schedulerEnabled: true, workMapWikis: ["mimir"], workMapHour: 5, profile: "default" as const };

describe("gates", () => {
  test("off when WORK_MAP_WIKIS is unset, under nais, with the scheduler off, on a readonly instance", () => {
    const { deps, timers } = harness();
    expect(startWorkMapLoop({ ...config, workMapWikis: [] }, { deps })).toEqual([]);
    expect(startWorkMapLoop({ ...config, profile: "nais" }, { deps })).toEqual([]);
    expect(startWorkMapLoop({ ...config, schedulerEnabled: false }, { deps })).toEqual([]);
    expect(startWorkMapLoop(config, { deps: { ...deps, isReadonly: () => true } })).toEqual([]);
    expect(timers).toHaveLength(0);
  });
  test("a readonly root and an unregistered name are skipped; nothing left means off", () => {
    const { deps } = harness();
    expect(startWorkMapLoop({ ...config, workMapWikis: ["ro", "nope"] }, { deps })).toEqual([]);
    expect(startWorkMapLoop({ ...config, workMapWikis: ["ro", "MIMIR"] }, { deps })).toEqual(["mimir"]);
  });
});

describe("workMapDue", () => {
  test("not before the day's hour; not within 20 h of a success", () => {
    const before = Date.parse("2026-10-20T02:30:00Z"); // 04:30 Oslo
    expect(workMapDue(null, before, 5).due).toBe(false);
    expect(workMapDue(null, MORNING, 5).due).toBe(true);
    expect(workMapDue({ wiki: "m", lastSuccessAt: MORNING - 19 * HOUR, attempts: [] }, MORNING, 5).due).toBe(false);
    expect(workMapDue({ wiki: "m", lastSuccessAt: MORNING - WORK_MAP_FRESH_MS - 1, attempts: [] }, MORNING, 5).due).toBe(true);
  });
  test("refusals never block; two failures after the model call since the hour wait for tomorrow", () => {
    const at = (h: number) => MORNING - 2 * HOUR + h * HOUR;
    const refused = { wiki: "m", attempts: [1, 2, 3].map((i) => ({ at: at(i), outcome: "refused" as const })) };
    expect(workMapDue(refused, MORNING + 2 * HOUR, 5).due).toBe(true);
    const once = { wiki: "m", attempts: [{ at: MORNING + HOUR, outcome: "failed" as const }] };
    expect(workMapDue(once, MORNING + 2 * HOUR, 5).due).toBe(true);
    const twice = { wiki: "m", attempts: [{ at: MORNING + 2 * HOUR, outcome: "failed" as const }, { at: MORNING + HOUR, outcome: "failed" as const }] };
    expect(workMapDue(twice, MORNING + 3 * HOUR, 5).due).toBe(false);
    // Yesterday's failures do not count against today.
    expect(workMapDue(twice, MORNING + 24 * HOUR, 5).due).toBe(true);
  });
  test("todaysHourMs is the Oslo hour boundary", () => {
    expect(todaysHourMs(MORNING + 30 * MIN, 5)).toBe(Date.parse("2026-10-20T03:00:00Z"));
    expect(todaysHourMs(Date.parse("2026-10-20T01:00:00Z"), 5)).toBeNull();
  });
  // 2026-10-25: Oslo falls back 03:00 CEST -> 02:00 CET (01:00Z); 02:00 happens twice.
  // 2026-03-29: Oslo springs forward 02:00 CET -> 03:00 CEST (01:00Z); 02:00 never happens.
  test.each([
    ["fall-back, hour 2: the first 02:00", "2026-10-25T01:30:00Z", 2, "2026-10-25T00:00:00Z"],
    ["fall-back, hour 2: during the first 02:00", "2026-10-25T00:10:00Z", 2, "2026-10-25T00:00:00Z"],
    ["fall-back, hour 1", "2026-10-25T02:30:00Z", 1, "2026-10-24T23:00:00Z"],
    ["fall-back, default hour 5", "2026-10-25T04:30:00Z", 5, "2026-10-25T04:00:00Z"],
    ["spring-forward, hour 2: when the clock reaches 03:00", "2026-03-29T02:00:00Z", 2, "2026-03-29T01:00:00Z"],
    ["spring-forward, default hour 5", "2026-03-29T03:30:00Z", 5, "2026-03-29T03:00:00Z"],
    ["winter, hour 0: Oslo midnight, not the evening before", "2026-01-15T10:00:00Z", 0, "2026-01-14T23:00:00Z"],
    ["summer, hour 0", "2026-07-15T10:00:00Z", 0, "2026-07-14T22:00:00Z"],
  ])("todaysHourMs across DST: %s", (_name, now, hour, want) => {
    expect(todaysHourMs(Date.parse(now), hour)).toBe(Date.parse(want));
  });
  test.each([
    ["2026-10-24T23:59:00Z", 2, null],
    ["2026-03-29T00:59:59Z", 2, null],
    ["2026-10-25T03:59:00Z", 5, null],
    ["2026-03-29T02:59:00Z", 5, null],
  ])("todaysHourMs across DST: %s is before hour %d", (now, hour) => {
    expect(todaysHourMs(Date.parse(now), hour as number)).toBeNull();
  });
  test("fall-back day, hour 2: two failures in the first 02:00 hour still block in the second", () => {
    const state = {
      wiki: "m",
      attempts: [
        { at: Date.parse("2026-10-25T00:40:00Z"), outcome: "failed" as const },
        { at: Date.parse("2026-10-25T00:10:00Z"), outcome: "failed" as const },
      ],
    };
    expect(workMapDue(state, Date.parse("2026-10-25T01:30:00Z"), 2).due).toBe(false);
  });
});

describe("the loop", () => {
  test("the first tick after boot checks; then hourly, not every tick", async () => {
    const h = harness({ outcomes: ["refused", "refused", "refused"] });
    startWorkMapLoop(config, { deps: h.deps });
    expect(h.runs).toHaveLength(0);
    await h.advance(WORK_MAP_TICK_MS);
    expect(h.runs).toHaveLength(1);
    await h.advance(30 * MIN);
    expect(h.runs).toHaveLength(1);
    await h.advance(31 * MIN);
    expect(h.runs).toHaveLength(2);
  });

  test("catch-up: a boot before the hour runs nothing until the hour passes", async () => {
    const h = harness({ start: Date.parse("2026-10-20T02:00:00Z"), outcomes: ["ok"] }); // 04:00 Oslo
    startWorkMapLoop(config, { deps: h.deps });
    await h.advance(WORK_MAP_TICK_MS);
    expect(h.runs).toHaveLength(0);
    await h.advance(HOUR);
    expect(h.runs).toHaveLength(1);
  });

  test("a wake is detected from the tick gap and checks at once", async () => {
    const h = harness({ outcomes: ["refused", "ok"] });
    startWorkMapLoop(config, { deps: h.deps });
    await h.advance(WORK_MAP_TICK_MS);
    expect(h.runs).toHaveLength(1);
    await h.advance(10 * MIN);
    // Slept 20 minutes: under an hour since the check, but the gap says wake.
    await h.jump(20 * MIN);
    expect(h.runs).toHaveLength(2);
  });

  test("a refusal right after a wake retries every 5 minutes, three times, then hourly", async () => {
    const h = harness({ outcomes: Array(10).fill("refused") });
    startWorkMapLoop(config, { deps: h.deps });
    await h.advance(WORK_MAP_TICK_MS);
    expect(h.runs).toHaveLength(1);
    await h.jump(3 * HOUR);
    const wakeAt = h.now();
    expect(h.runs).toHaveLength(2);
    await h.advance(20 * MIN);
    const retries = h.runs.slice(2).map((r) => Math.round((r.at - wakeAt) / MIN));
    expect(retries).toEqual([1, 2, 3].map((n) => (n * WORK_MAP_WAKE_RETRY_MS) / MIN));
    // Then hourly from the last retry (+15 min): nothing until +75.
    await h.advance(50 * MIN);
    expect(h.runs).toHaveLength(5);
    await h.advance(6 * MIN);
    expect(h.runs).toHaveLength(6);
  });

  test("a wake during an in-flight check is not lost: a refused check then starts the wake retries", async () => {
    const h = harness({ outcomes: Array(10).fill("refused") });
    let release: ((r: WorkMapRunResult) => void) | null = null;
    const run = h.deps.run;
    let calls = 0;
    startWorkMapLoop(config, {
      deps: {
        ...h.deps,
        run: (w, s) => (++calls === 1 ? new Promise((r) => (release = r)) : run(w, s)),
      },
    });
    await h.advance(WORK_MAP_TICK_MS);
    expect(calls).toBe(1);
    await h.jump(3 * HOUR);
    expect(calls).toBe(1);
    release!({ outcome: "refused", reason: "x" });
    await Bun.sleep(0);
    const releasedAt = h.now();
    await h.advance(20 * MIN);
    // The remembered wake checks on the next tick, then retries three times.
    expect(h.runs.map((r) => Math.round((r.at - releasedAt) / MIN))).toEqual([1, 6, 11, 16]);
  });

  test("the stop hook: no tick schedules or runs after it, and the run gets an aborted signal", async () => {
    let signal: AbortSignal | undefined;
    const h = harness();
    const run = h.deps.run;
    startWorkMapLoop(config, {
      deps: {
        ...h.deps,
        run: (w, s) => {
          signal = s;
          return run(w, s);
        },
      },
    });
    await h.advance(WORK_MAP_TICK_MS);
    expect(h.runs).toHaveLength(1);
    await stopWorkMapLoop(10);
    expect(signal?.aborted).toBe(true);
    expect(h.timers).toHaveLength(0);
    await h.advance(3 * HOUR);
    expect(h.runs).toHaveLength(1);
  });
});
