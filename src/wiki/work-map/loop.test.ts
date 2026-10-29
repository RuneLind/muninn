import { afterEach, describe, expect, test } from "bun:test";
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
