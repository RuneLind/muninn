import type { WikiAnswerRetention } from "../config.ts";
import {
  sweepWikiAnswerRetention,
  type WikiAnswerRetentionCounts,
  type WikiAnswerRetentionWindows,
} from "../db/wiki-answers.ts";
import { getLog } from "../logging.ts";
import { createLoop, settleWithin, type LoopHandle, type LoopState } from "../utils/loop.ts";

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

/** The current handle; a stopped one stays here so the next start runs after it. */
let loop: LoopHandle | null = null;

/** Start the hourly sweep (idempotent). Starts nothing when both windows are
 *  unset — the laptop default, so the owner's own answers stay. Its own timer,
 *  not the scheduler tick: that tick runs only for a bot with a Telegram token,
 *  which a nais pod does not have. One sweep at a time, across a restart too, and
 *  a restart never un-stops a sweep still in flight (`createLoop`). `opts` is for tests. */
export function startAnswerRetentionSweep(
  windows: WikiAnswerRetentionWindows,
  opts: { sweep?: typeof sweepWikiAnswerRetention; firstDelayMs?: number; intervalMs?: number } = {},
): boolean {
  if (loop && !loop.state().stopped) return true;
  if (windows.exportedDays == null && windows.unexportedDays == null) return false;
  loop = createLoop({
    name: "Answer retention sweep",
    intervalMs: opts.intervalMs ?? ANSWER_RETENTION_INTERVAL_MS,
    firstDelayMs: opts.firstDelayMs ?? ANSWER_RETENTION_FIRST_DELAY_MS,
    log,
    after: loop,
    run: (signal) => runAnswerRetentionSweep(windows, opts.sweep, () => signal.aborted),
  });
  loop.start();
  return true;
}

/** The current handle's state (last run, in flight, stopped); null before the first start. */
export const answerRetentionSweepState = (): LoopState | null => loop?.state() ?? null;

/** Stop the timers and end a sweep in flight at its next answer, then wait
 *  (bounded) for it, so shutdown can close the pool after it rather than under it. */
export async function stopAnswerRetentionSweep(waitMs = ANSWER_RETENTION_STOP_WAIT_MS): Promise<void> {
  if (!loop) return;
  if (!(await settleWithin(loop.stop(), waitMs))) log.warn("Shutdown: timed out waiting for the answer retention sweep");
}
