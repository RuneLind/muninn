/**
 * Everything a TikTok capture does BETWEEN the model's answer and the ingest.
 *
 * Two steps, and the second is the one a re-run would forget: the envelope parse,
 * and the cheap check that a frames-ON summary mentions any visual content at
 * all. When it does not, the frame Reads likely degraded silently (a permissions
 * or `--add-dir` regression) and the whole visual-summary value was lost with no
 * other signal — so the warn is the only place that failure is visible.
 *
 * This vertical runs no frames seam (`keepReferencedFrames`, the enforcement
 * pass): its keyframes are read by the model and never quoted by address, so
 * there is nothing to copy out or hold the text to.
 */

import { getLog } from "../logging.ts";
import { parseSummaryResponse } from "../utils/summary-parser.ts";

// The CATEGORY stays the vertical's own, not this file's — see the note in
// `src/youtube/finish.ts`. Pinned in `finish.test.ts`.
const log = getLog("tiktok", "summarizer");

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

export interface FinishTikTokSummaryInput {
  /** The RAW model text, envelope and all. */
  readonly raw: string;
  readonly jobId: string;
  /** The video id the warn names. */
  readonly videoId: string;
  /** How many keyframes the model was shown — 0 means there is nothing to warn about. */
  readonly frameCount: number;
  readonly onCategory?: (category: string) => void;
}

export interface FinishedTikTokSummary {
  readonly summary: string;
  readonly category: string;
}

export function finishTikTokSummary(input: FinishTikTokSummaryInput): FinishedTikTokSummary {
  const { category, summary } = parseSummaryResponse(input.raw);
  input.onCategory?.(category);

  if (input.frameCount > 0 && !mentionsVisualContent(summary)) {
    log.warn("Frames-on TikTok summary for job {jobId} mentions no visual content — frame Reads may have degraded", {
      jobId: input.jobId,
      videoId: input.videoId,
    });
  }

  return { summary, category };
}
