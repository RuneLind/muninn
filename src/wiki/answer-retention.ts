import type { WikiAnswerRetention } from "../config.ts";
import { sweepWikiAnswerRetention, type WikiAnswerRetentionCounts } from "../db/wiki-answers.ts";
import { getLog } from "../logging.ts";

const log = getLog("wiki", "answer-retention");

export const ANSWER_RETENTION_INTERVAL_MS = 3_600_000;
/** The first sweep runs this long after boot, so a pod that restarts more often
 *  than hourly still sweeps. */
export const ANSWER_RETENTION_FIRST_DELAY_MS = 60_000;

/** One sweep, with the one info line D17 allows: counts per rule, nothing else. */
export async function runAnswerRetentionSweep(
  windows: WikiAnswerRetention,
  sweep: typeof sweepWikiAnswerRetention = sweepWikiAnswerRetention,
): Promise<WikiAnswerRetentionCounts> {
  const counts = await sweep(windows);
  if (counts.exported + counts.unexported + counts.redacted > 0) {
    log.info("Answer retention deleted {exported} exported, {unexported} unexported, {redacted} redacted answer(s)", {
      ...counts,
    });
  }
  return counts;
}

let first: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Start the hourly sweep (idempotent). Starts nothing when both windows are
 *  unset — the laptop default, so the owner's own answers stay. Its own timer,
 *  not the scheduler tick: that tick runs only for a bot with a Telegram token,
 *  which a nais pod does not have. */
export function startAnswerRetentionSweep(windows: WikiAnswerRetention): boolean {
  if (first || timer) return true;
  if (windows.exportedDays == null && windows.unexportedDays == null) return false;
  const tick = () =>
    void runAnswerRetentionSweep(windows).catch((err) => {
      log.warn("Answer retention sweep failed: {error}", { error: err instanceof Error ? err.message : String(err) });
    });
  first = setTimeout(tick, ANSWER_RETENTION_FIRST_DELAY_MS);
  timer = setInterval(tick, ANSWER_RETENTION_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return true;
}

export function stopAnswerRetentionSweep(): void {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = timer = null;
}
