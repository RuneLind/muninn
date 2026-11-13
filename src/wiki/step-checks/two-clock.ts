/**
 * How long a step-check answer lives, on two clocks at once (mimir plan
 * muninn-wiki-owner-step-checks): the wall clock (`Date.now`), which counts
 * sleep but can step back or forward, and the monotonic clock
 * (`performance.now`), which never steps and is assumed to stop while the
 * machine sleeps (not measured; if it counts sleep the rule is only stricter).
 * An answer is live only while its age is inside the limit on BOTH readings.
 * What the two readings cannot see: a sleep followed by a wall step back to
 * within the limit of the stamp. That one sequence can outlive the limit.
 */

/** One instant, read from both clocks. */
export interface Stamp {
  wall: number;
  mono: number;
}

/** A single clock drives both halves (the cheap test case); an object names them apart. */
export type Clocks = (() => number) | { wall?: () => number; mono?: () => number };

/**
 * A stamp reader over `clocks`. No clock: `Date.now` and `performance.now`.
 * One function, or an object naming only `wall`: that clock drives both
 * halves. An object naming only `mono`: the wall half is `Date.now`.
 */
export function stampSource(clocks?: Clocks): () => Stamp {
  const c = typeof clocks === "function" ? { wall: clocks, mono: clocks } : (clocks ?? {});
  const wall = c.wall ?? Date.now;
  const mono = c.mono ?? c.wall ?? (() => performance.now());
  return () => ({ wall: wall(), mono: mono() });
}

/**
 * True only when `stamp` is `[0, limitMs)` old on both clocks at `now`. A
 * negative age (the wall clock stepped back), an age at or past the limit on
 * either clock (sleep runs the wall age out; a wall step forward runs it out
 * early) and any non-finite number (a NaN or infinite difference fails every
 * comparison; an infinite limit is refused here) all answer false.
 */
export function within(stamp: Stamp, limitMs: number, now: Stamp): boolean {
  const wall = now.wall - stamp.wall;
  const mono = now.mono - stamp.mono;
  return Number.isFinite(limitMs) && wall >= 0 && wall < limitMs && mono >= 0 && mono < limitMs;
}
