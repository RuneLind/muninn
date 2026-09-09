/**
 * Everything a SHORT-VIDEO capture does BETWEEN the model's answer and the
 * ingest — TikTok and X video, one tail.
 *
 * Two steps, and the second is the one a re-run would forget: the envelope
 * parse, and the cheap check that a frames-ON summary mentions any visual
 * content at all. When it does not, the frame Reads likely degraded silently (a
 * permissions or `--add-dir` regression) and the whole visual-summary value was
 * lost with no other signal — so the warn is the only place that failure is
 * visible.
 *
 * **The warn is a SPEC flag, not a constant.** `src/tiktok/finish.ts` carried
 * it and `src/x-article/video-finish.ts` deliberately did not, and merging the
 * two tails must not hand the X vertical a warn it never had — that difference
 * is `visualWarning` on the spec, and a re-run inherits whichever its vertical
 * declares. The LOG CATEGORY is a spec field for the same kind of reason: the
 * JSONL sink is queried by category, and a merge that moved every TikTok record
 * to `muninn.video.*` would break a saved query.
 *
 * Neither vertical runs a frames seam (`keepReferencedFrames`, the enforcement
 * pass): their keyframes are read by the model and never quoted by address, so
 * there is nothing to copy out or hold the text to.
 */

import { getLog } from "../logging.ts";
import { parseSummaryResponse } from "../utils/summary-parser.ts";

/**
 * Cheap heuristic: did a frames-on summary actually mention any visual content?
 * If not, the frame Reads likely silently degraded (permissions / --add-dir
 * regression) and we lost the whole visual-summary value — surface a warning.
 */
export function mentionsVisualContent(summary: string): boolean {
  return /\b(frame|image|visual|screen|on-screen|diagram|slide|chart|shown|display|graphic|caption|text overlay)\b/i.test(
    summary,
  );
}

/** What the tail needs to know about the vertical it is finishing. */
export interface ShortVideoFinishSpec {
  /** The vertical as a log line names it: "TikTok", "X video". */
  readonly noun: string;
  /** The logger category the warn is recorded under, e.g. `["tiktok", "summarizer"]`. */
  readonly logCategory: readonly [string, string];
  /** Whether this vertical warns when a frames-on summary mentions nothing visual. */
  readonly visualWarning: boolean;
}

export interface FinishShortVideoSummaryInput {
  /** The RAW model text, envelope and all. */
  readonly raw: string;
  readonly jobId: string;
  /** The video id the warn names. */
  readonly videoId: string;
  /** How many keyframes the model was shown — 0 means there is nothing to warn about. */
  readonly frameCount: number;
  readonly onCategory?: (category: string) => void;
}

export interface FinishedShortVideoSummary {
  readonly summary: string;
  readonly category: string;
}

export function finishShortVideoSummary(
  spec: ShortVideoFinishSpec,
  input: FinishShortVideoSummaryInput,
): FinishedShortVideoSummary {
  const { category, summary } = parseSummaryResponse(input.raw);
  input.onCategory?.(category);

  if (spec.visualWarning && input.frameCount > 0 && !mentionsVisualContent(summary)) {
    // The CATEGORY stays the VERTICAL's own, not this file's — the JSONL sink is
    // queried by category and moving this code must not move the records a
    // saved query already selects. Pinned in `short-video-finish.test.ts`.
    getLog(spec.logCategory[0], spec.logCategory[1]).warn(
      `Frames-on ${spec.noun} summary for job {jobId} mentions no visual content — frame Reads may have degraded`,
      { jobId: input.jobId, videoId: input.videoId },
    );
  }

  return { summary, category };
}
