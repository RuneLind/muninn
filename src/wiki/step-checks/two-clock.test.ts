/**
 * The two-clock rule (`two-clock.ts`) and the three timers that use it: the
 * local `ProbeCache` (a settled answer's TTL, and the drop of an entry that
 * never settles), the peer client's (machine, kind, value) cache and its
 * per-machine down window. Every timeline runs on two injected clocks, no real
 * waits and no network: the wall clock may step back, step forward or jump
 * over a sleep, the monotonic clock only stands still or advances.
 */
import { describe, expect, test } from "bun:test";
import type { CheckProbe } from "../../format/check-tag.ts";
import { PROBE_TTL_MS, ProbeCache } from "./answer.ts";
import { createPeerAnswerer, PEER_DOWN_WINDOW_MS } from "./peer.ts";
import type { ProbeResult, ProbeState } from "./probes.ts";
import { stampSource, within, type Stamp } from "./two-clock.ts";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;
const M0 = 50_000;

describe("within: live only while the age is in [0, limit) on both clocks", () => {
  const s = (wall: number, mono: number): Stamp => ({ wall, mono });
  const at = s(1_000, 100);
  const L = 30_000;
  const ROWS: [string, Stamp, number, Stamp, boolean][] = [
    ["the same instant", at, L, at, true],
    ["both 1 ms old", at, L, s(1_001, 101), true],
    ["both limit − 1 ms old", at, L, s(1_000 + L - 1, 100 + L - 1), true],
    ["both exactly the limit old", at, L, s(1_000 + L, 100 + L), false],
    ["wall at the limit, mono 1 ms short", at, L, s(1_000 + L, 100 + L - 1), false],
    ["mono at the limit, wall 1 ms short", at, L, s(1_000 + L - 1, 100 + L), false],
    ["wall past the limit (sleep), mono 0", at, L, s(1_000 + HOUR, 100), false],
    ["wall 10 s ahead (step forward), mono 0", at, L, s(11_000, 100), true],
    ["wall step forward runs out first", at, L, s(1_000 + L, 100 + L - 10_000), false],
    ["wall 1 ms behind the stamp (step back)", at, L, s(999, 105), false],
    ["wall 1 h behind the stamp", at, L, s(1_000 - HOUR, 105), false],
    ["wall back at the stamp, mono past the limit", at, L, s(1_000 + 10, 100 + HOUR), false],
    ["mono 1 ms behind the stamp", at, L, s(1_005, 99), false],
    ["limit 0: nothing is live, not even the same instant", at, 0, at, false],
    ["negative limit", at, -5, at, false],
    ["infinite limit", at, Infinity, s(2_000, 200), false],
    ["NaN limit", at, NaN, at, false],
    ["now.wall NaN", at, L, s(NaN, 101), false],
    ["now.mono NaN", at, L, s(1_001, NaN), false],
    ["stamp.wall NaN", s(NaN, 100), L, s(1_001, 101), false],
    ["stamp.mono NaN", s(1_000, NaN), L, s(1_001, 101), false],
    ["now.wall Infinity", at, L, s(Infinity, 101), false],
    ["now.mono −Infinity", at, L, s(1_001, -Infinity), false],
    ["stamp.wall −Infinity", s(-Infinity, 100), L, s(1_001, 101), false],
    ["stamp.mono Infinity", s(1_000, Infinity), L, s(1_001, 101), false],
    ["both stamp and now Infinity (NaN age)", s(Infinity, Infinity), L, s(Infinity, Infinity), false],
  ];
  for (const [name, stamp, limit, now, live] of ROWS) test(`${name} → ${live ? "live" : "expired"}`, () => expect(within(stamp, limit, now)).toBe(live));
});

describe("stampSource", () => {
  test("one function drives both halves", () => {
    let t = 7;
    const src = stampSource(() => t);
    expect(src()).toEqual({ wall: 7, mono: 7 });
    t = 9;
    expect(src()).toEqual({ wall: 9, mono: 9 });
  });
  test("an object names the halves apart; wall alone drives both", () => {
    expect(stampSource({ wall: () => 1, mono: () => 2 })()).toEqual({ wall: 1, mono: 2 });
    expect(stampSource({ wall: () => 3 })()).toEqual({ wall: 3, mono: 3 });
  });
  test("no clock: Date.now and performance.now", () => {
    const before = { wall: Date.now(), mono: performance.now() };
    const got = stampSource()();
    expect(got.wall).toBeGreaterThanOrEqual(before.wall);
    expect(got.wall - before.wall).toBeLessThan(1_000);
    expect(got.mono).toBeGreaterThanOrEqual(before.mono);
    expect(got.mono - before.mono).toBeLessThan(1_000);
  });
});

/**
 * One timer seen from outside: `start` makes the timed thing (an `ok`, an
 * unsettled run, an open window) at the current instant; `read` asks again
 * and says whether the timer was still live (no new run, no request) and
 * checks the answer that came back.
 */
interface Timer {
  limit: number;
  clock: { w: number; m: number };
  start(): Promise<void>;
  read(): Promise<boolean>;
}

const PROBE: CheckProbe = { kind: "env", value: "HAVE" };

/** The local cache's TTL after an `ok` settles. */
function localSettled(): Timer {
  const clock = { w: T0, m: M0 };
  const cache = new ProbeCache({ wall: () => clock.w, mono: () => clock.m }, PROBE_TTL_MS);
  let world: ProbeState = "ok";
  let runs = 0;
  const ask = () => cache.get(PROBE, async () => (runs++, { state: world, why: world }));
  return {
    limit: PROBE_TTL_MS,
    clock,
    async start() {
      world = "ok";
      expect((await ask()).state).toBe("ok");
    },
    async read() {
      world = "not-yet";
      const before = runs;
      const got = await ask();
      const live = runs === before;
      expect(got.state).toBe(live ? "ok" : "not-yet");
      return live;
    },
  };
}

/** The local cache's drop of an entry that never settles; `startsLater` stamps it at its `started()` call instead. */
function localUnsettled(startsLater: boolean): Timer {
  const clock = { w: T0, m: M0 };
  const cache = new ProbeCache({ wall: () => clock.w, mono: () => clock.m }, PROBE_TTL_MS);
  let runs = 0;
  const ask = () => {
    let started!: () => void;
    void cache.get(
      PROBE,
      (s) => {
        runs++;
        started = s;
        return new Promise<ProbeResult>(() => {});
      },
      { startsLater },
    );
    return started;
  };
  return {
    limit: PROBE_TTL_MS,
    clock,
    async start() {
      const started = ask();
      if (startsLater) started();
      expect(runs).toBe(1);
    },
    async read() {
      const before = runs;
      const started = ask();
      if (runs !== before && startsLater) started();
      return runs === before;
    },
  };
}

const peerReply = (asked: string[], state: ProbeState) =>
  new Response(JSON.stringify({ v: 1, machine: "beta", results: asked.map((s) => ({ kind: s.split(":")[0], value: s.slice(s.indexOf(":") + 1), state })) }), { status: 200, headers: { "content-type": "application/json" } });

function peerClient() {
  const clock = { w: T0, m: M0 };
  const world = { up: true, state: "ok" as ProbeState };
  let calls = 0;
  const answer = createPeerAnswerer({
    peers: new Map([["beta", "https://beta.test"]]),
    wall: () => clock.w,
    mono: () => clock.m,
    fetch: async (input) => {
      calls++;
      if (!world.up) throw Object.assign(new Error("Unable to connect."), { code: "ConnectionRefused" });
      return peerReply(new URL(input).searchParams.getAll("p"), world.state);
    },
  });
  return { clock, world, answer, calls: () => calls };
}

/** The peer client's cache TTL after an `ok` reply. */
function peerCache(): Timer {
  const { clock, world, answer, calls } = peerClient();
  return {
    limit: PROBE_TTL_MS,
    clock,
    async start() {
      world.state = "ok";
      expect((await answer("beta", [PROBE]))[0]!.state).toBe("ok");
    },
    async read() {
      world.state = "not-yet";
      const before = calls();
      const [got] = await answer("beta", [PROBE]);
      const live = calls() === before;
      expect(got!.state).toBe(live ? "ok" : "not-yet");
      return live;
    },
  };
}

/** The peer client's down window after a failed request; while the peer is back and would say `ok`, a live window still answers unknown. */
function peerWindow(): Timer {
  const { clock, world, answer, calls } = peerClient();
  return {
    limit: PEER_DOWN_WINDOW_MS,
    clock,
    async start() {
      world.up = false;
      expect((await answer("beta", [PROBE]))[0]!.state).toBe("unknown");
      expect(calls()).toBe(1);
    },
    async read() {
      world.up = true;
      world.state = "ok";
      const before = calls();
      const [got] = await answer("beta", [PROBE]);
      const live = calls() === before;
      if (live) {
        expect(got!.state).toBe("unknown");
        expect(got!.why).toContain("a moment ago");
      } else expect(got!.state).toBe("ok");
      return live;
    },
  };
}

/** A clock position relative to (T0, M0), in ms; `read` is the expected liveness of a read there. */
type Step = { w: number; m: number; read?: boolean };
interface Row {
  name: string;
  /** Where the timer starts, relative to (T0, M0); NaN/Infinity allowed. */
  startAt?: { w: number; m: number };
  steps: (limit: number) => Step[];
  only?: "window";
}

const ROWS: Row[] = [
  {
    name: "1. wall back 1 h right after it starts, nothing read, both advance until the wall is 10 s past the start: expired",
    steps: () => [
      { w: -HOUR, m: 1 },
      { w: 10_000, m: HOUR + 10_001, read: false },
    ],
  },
  { name: "2a. wall back 5 s, mono on: a read while the wall age is negative is expired", steps: () => [{ w: -5_000, m: 1_000, read: false }] },
  {
    name: "2b. wall back 5 s, mono on, nothing read until the wall age is positive: live until the mono age reaches the limit, never beyond",
    steps: (L) => [
      { w: -5_000, m: 0 },
      { w: 5_000, m: 10_000, read: true },
      { w: L - 5_001, m: L - 1, read: true },
      { w: L - 5_000, m: L, read: false },
    ],
  },
  { name: "3. sleep: wall 1 h forward, mono still: expired", steps: () => [{ w: HOUR, m: 0, read: false }] },
  {
    name: "4. wall 10 s forward: live, and expired once the wall age reaches the limit (mono 10 s short of it)",
    steps: (L) => [
      { w: 10_000, m: 0, read: true },
      { w: L - 1, m: L - 10_001, read: true },
      { w: L, m: L - 10_000, read: false },
    ],
  },
  {
    name: "5. forward only: live at age 0 and at limit − 1 ms, expired at exactly the limit",
    steps: (L) => [
      { w: 0, m: 0, read: true },
      { w: L - 1, m: L - 1, read: true },
      { w: L, m: L, read: false },
    ],
  },
  { name: "5b. mono at the limit, wall 1 ms short: expired", steps: (L) => [{ w: L - 1, m: L, read: false }] },
  { name: "5c. wall at the limit, mono 1 ms short: expired", steps: (L) => [{ w: L, m: L - 1, read: false }] },
  { name: "5d. a mono reading behind the start (an injected clock): expired", steps: () => [{ w: 1_000, m: -1, read: false }] },
  { name: "6a. started at a NaN wall: expired at the next read", startAt: { w: NaN, m: 0 }, steps: () => [{ w: 1, m: 1, read: false }] },
  { name: "6b. started at an infinite mono: expired at the next read", startAt: { w: 0, m: Infinity }, steps: () => [{ w: 1, m: 1, read: false }] },
  { name: "6c. read at a NaN mono: expired", steps: () => [{ w: 1, m: NaN, read: false }] },
  { name: "6d. read at an infinite wall: expired", steps: () => [{ w: Infinity, m: 1, read: false }] },
  {
    name: "7. window: wall back 5 s with no asks, wall returns to open + 5 s while mono has run 20 s: not down",
    only: "window",
    steps: () => [
      { w: -5_000, m: 1 },
      { w: 5_000, m: 20_000, read: false },
    ],
  },
];

const TIMERS: [string, () => Timer, boolean][] = [
  ["local cache TTL (ProbeCache, settled ok)", localSettled, false],
  ["local cache unsettled drop (ProbeCache, run never settles)", () => localUnsettled(false), false],
  ["local cache unsettled drop, started later (ProbeCache, startsLater)", () => localUnsettled(true), false],
  ["peer cache TTL", peerCache, false],
  ["peer down window", peerWindow, true],
];

for (const [timerName, make, isWindow] of TIMERS) {
  describe(`two-clock timeline: ${timerName}`, () => {
    for (const row of ROWS) {
      if (row.only === "window" && !isWindow) continue;
      test(row.name, async () => {
        const t = make();
        t.clock.w = T0 + (row.startAt?.w ?? 0);
        t.clock.m = M0 + (row.startAt?.m ?? 0);
        await t.start();
        const seen: (boolean | undefined)[] = [];
        const want: (boolean | undefined)[] = [];
        for (const step of row.steps(t.limit)) {
          t.clock.w = T0 + step.w;
          t.clock.m = M0 + step.m;
          if (step.read === undefined) continue;
          want.push(step.read);
          seen.push(await t.read());
        }
        expect(seen).toEqual(want);
      });
    }
  });
}

describe("peer cache: an entry that is not live is gone, never kept for a later read", () => {
  const Q: CheckProbe = { kind: "env", value: "OTHER" };
  /** A client whose request for Q waits until `failQ` is called and then fails; every other probe answers `ok`. */
  function heldClient() {
    const clock = { w: T0, m: M0 };
    let failQ!: () => void;
    let calls = 0;
    const answer = createPeerAnswerer({
      peers: new Map([["beta", "https://beta.test"]]),
      wall: () => clock.w,
      mono: () => clock.m,
      fetch: async (input) => {
        calls++;
        const asked = new URL(input).searchParams.getAll("p");
        if (asked.includes("env:OTHER")) {
          await new Promise<void>((r) => (failQ = r));
          throw Object.assign(new Error("Unable to connect."), { code: "ConnectionRefused" });
        }
        return peerReply(asked, "ok");
      },
    });
    return { clock, answer, failQ: () => failQ(), calls: () => calls };
  }

  test("a hit read while not live is deleted: once its age is inside the TTL again it is still a miss (here the window answers)", async () => {
    const { clock, answer, failQ, calls } = heldClient();
    expect((await answer("beta", [PROBE]))[0]!.state).toBe("ok");
    // Q's request starts while PROBE is live (its miss prunes nothing), then fails after the wall stepped back 3 s.
    clock.w = T0 + 1_000;
    clock.m = M0 + 1_000;
    const q = answer("beta", [Q]);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls()).toBe(2);
    clock.w = T0 - 2_000;
    clock.m = M0 + 2_000;
    failQ();
    expect((await q)[0]!.state).toBe("unknown");
    // PROBE read at wall age −1 s: not live, deleted; the window (open 1 s on both clocks) answers.
    clock.w = T0 - 1_000;
    clock.m = M0 + 3_000;
    expect((await answer("beta", [PROBE]))[0]!.why).toContain("a moment ago");
    // PROBE would be 1 s wall / 5 s mono old: inside the TTL, but it was deleted, so the window answers again.
    clock.w = T0 + 1_000;
    clock.m = M0 + 5_000;
    const [got] = await answer("beta", [PROBE]);
    expect(got!.state).toBe("unknown");
    expect(got!.why).toContain("a moment ago");
    expect(calls()).toBe(2);
  });

  test("a miss prunes by the same rule: an entry not live at a NaN mono reading is gone when the clock reads normally again", async () => {
    const { clock, world, answer, calls } = peerClient();
    expect((await answer("beta", [PROBE]))[0]!.state).toBe("ok");
    clock.w = T0 + 1;
    clock.m = NaN;
    expect((await answer("beta", [Q]))[0]!.state).toBe("ok");
    world.state = "not-yet";
    clock.w = T0 + 2;
    clock.m = M0 + 2;
    expect((await answer("beta", [PROBE]))[0]!.state).toBe("not-yet");
    expect(calls()).toBe(3);
  });
});
