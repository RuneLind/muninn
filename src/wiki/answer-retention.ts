import type { WikiAnswerRetention } from "../config.ts";
import {
  sweepWikiAnswerRetention,
  type WikiAnswerRetentionCounts,
  type WikiAnswerRetentionWindows,
} from "../db/wiki-answers.ts";
import { getLog } from "../logging.ts";

const log = getLog("wiki", "answer-retention");

export const ANSWER_RETENTION_INTERVAL_MS = 3_600_000;
/** The first sweep runs this long after boot, so a pod that restarts more often
 *  than hourly still sweeps. */
export const ANSWER_RETENTION_FIRST_DELAY_MS = 60_000;
/** How long shutdown waits for a sweep in flight before closing the pool anyway. */
export const ANSWER_RETENTION_STOP_WAIT_MS = 10_000;

/** One sweep, with the one line D17 allows: counts per rule plus failures,
 *  nothing else. A warning when any answer failed, else info. */
export async function runAnswerRetentionSweep(
  windows: WikiAnswerRetentionWindows,
  sweep: typeof sweepWikiAnswerRetention = sweepWikiAnswerRetention,
  shouldStop?: () => boolean,
): Promise<WikiAnswerRetentionCounts> {
  const counts = await sweep(windows, Date.now(), { shouldStop });
  const { exported, unexported, redacted, failed } = counts;
  const props = { exported, unexported, redacted, failed };
  const message =
    "Answer retention deleted {exported} exported, {unexported} unexported, {redacted} redacted answer(s); {failed} failed";
  if (failed > 0) {
    // The first failure's class and code, once per sweep: never its message.
    const first = counts.firstFailure;
    log.warn(`${message} (first: {errorClass} {code})`, {
      ...props,
      errorClass: first?.errorClass ?? "unknown",
      code: first?.code ?? "no code",
    });
  } else if (exported + unexported + redacted > 0) log.info(message, props);
  return counts;
}

const ruleText = (days: number | null, set: (n: number) => string, rule: string) => (days == null ? `${rule} rule off` : set(days));

/** The boot lines, for `src/index.ts` to log once logging is up: one info line
 *  when the sweep runs, one warning per variable refused at 0 (config is loaded
 *  before logging, so the refusal cannot be logged where it is made). */
export function answerRetentionBootLines(r: WikiAnswerRetention): { info: string | null; warnings: string[] } {
  const warnings = r.refused.map(
    ({ name, value }) => `${name} is ${value}, which would delete every answer on the next sweep — refused, the rule is off`,
  );
  if (r.exportedDays == null && r.unexportedDays == null) return { info: null, warnings };
  const info =
    "Answer retention sweep on (hourly): " +
    [
      ruleText(r.exportedDays, (n) => `exported answers deleted ${n} day(s) after export`, "exported"),
      ruleText(r.unexportedDays, (n) => `unexported answers deleted ${n} day(s) after their latest version`, "unexported"),
      "redacted answers deleted at the next sweep",
    ].join("; ");
  return { info, warnings };
}

let first: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
/** The sweep in flight, if any: a tick that finds one skips, and stop waits for it. */
let running: Promise<unknown> | null = null;
/** Set by stop: the sweep in flight ends at its next answer. */
let stopping = false;

/** Start the hourly sweep (idempotent). Starts nothing when both windows are
 *  unset — the laptop default, so the owner's own answers stay. Its own timer,
 *  not the scheduler tick: that tick runs only for a bot with a Telegram token,
 *  which a nais pod does not have. `opts` is for tests. */
export function startAnswerRetentionSweep(
  windows: WikiAnswerRetentionWindows,
  opts: { sweep?: typeof sweepWikiAnswerRetention; firstDelayMs?: number; intervalMs?: number } = {},
): boolean {
  if (first || timer) return true;
  if (windows.exportedDays == null && windows.unexportedDays == null) return false;
  stopping = false;
  const tick = () => {
    // One sweep at a time: a sweep slower than the interval must not overlap itself.
    if (running) return;
    running = runAnswerRetentionSweep(windows, opts.sweep, () => stopping)
      .catch((err) => {
        log.warn("Answer retention sweep failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        running = null;
      });
  };
  first = setTimeout(tick, opts.firstDelayMs ?? ANSWER_RETENTION_FIRST_DELAY_MS);
  timer = setInterval(tick, opts.intervalMs ?? ANSWER_RETENTION_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return true;
}

/** Stop the timers, then wait (bounded) for a sweep in flight, so shutdown can
 *  close the pool after it rather than under it. */
export async function stopAnswerRetentionSweep(waitMs = ANSWER_RETENTION_STOP_WAIT_MS): Promise<void> {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = timer = null;
  stopping = true;
  const inFlight = running;
  if (!inFlight) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    inFlight.then(() => false),
    new Promise<boolean>((r) => (timeout = setTimeout(() => r(true), waitMs))),
  ]);
  clearTimeout(timeout);
  if (timedOut) log.warn("Shutdown: timed out waiting for the answer retention sweep");
}
