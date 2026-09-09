/**
 * Everything a Vimeo capture does BETWEEN the model's answer and the ingest.
 *
 * Shorter than the YouTube tail by TWO steps, and both omissions are deliberate.
 * This vertical runs no `enforceVisualReferences` pass, so the copy parses the
 * summary itself (`keepReferencedFrames` without a `referenced` list); and it
 * runs no `dropFrameReferences` repair afterwards, so a reference the copy could
 * not serve stays in the stored text and the reader gets a broken image rather
 * than a rewritten sentence. A re-run must keep that shape — adding either pass
 * here would silently change what a re-captured Vimeo document may quote.
 *
 * The ingest, `completeJob`, the source draft and the status moves stay in
 * `summarizer.ts`: a re-run writes into a different job. The category is a
 * callback so the live card is told at the same instant it was told inline.
 */

import { getLog } from "../logging.ts";
import { parseSummaryResponse } from "../utils/summary-parser.ts";
import { VIMEO_FRAME_SOURCE, keepReferencedFrames, type CaptureFrame } from "../summaries/frames.ts";

// The CATEGORY stays the vertical's own, not this file's — see the note in
// `src/youtube/finish.ts`. Pinned in `finish.test.ts`.
const log = getLog("vimeo", "summarizer");

export interface FinishVimeoSummaryInput {
  /** The RAW model text, envelope and all. */
  readonly raw: string;
  readonly jobId: string;
  readonly videoId: string;
  readonly frames: readonly CaptureFrame[];
  /** Where quoted frames are kept; default `framesRootDir()`. */
  readonly framesRoot?: string;
  readonly onCategory?: (category: string) => void;
}

export interface FinishedVimeoSummary {
  readonly summary: string;
  readonly category: string;
  /** Seconds copied to the served root. */
  readonly kept: number[];
}

export async function finishVimeoSummary(
  input: FinishVimeoSummaryInput,
): Promise<FinishedVimeoSummary> {
  const { raw, jobId, videoId, frames } = input;
  const { category, summary } = parseSummaryResponse(raw);
  input.onCategory?.(category);

  // The frames the summary QUOTES are copied out of the work dir to the served
  // root before the work dir dies; the rest go with it. Inside its own try: a
  // copy failure must not fail a capture whose text is already on the reader's
  // screen — the reader gets broken images and a log line.
  let kept: number[] = [];
  if (frames.length > 0) {
    try {
      kept = await keepReferencedFrames(summary, VIMEO_FRAME_SOURCE, videoId, frames, input.framesRoot);
    } catch (err) {
      log.error("Vimeo capture {jobId}: keeping quoted frames failed: {error}", {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { summary, category, kept };
}
