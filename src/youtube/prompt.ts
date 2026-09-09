/**
 * The two prompts a YouTube capture sends, as pure builders.
 *
 * They were sub-expressions of `summarizeVideo` — the system prompt composed
 * inline after the transcript fetch, the user prompt an expression inside the
 * `runCaptureOneShot` call — so the only way to see either was to run a capture.
 * Three things now need them without one: the re-run (PR 3), which must send the
 * SAME prompt the first capture did; `/summaries/prompts`, which shows what a
 * combination receives; and the tests, which can pin "the run uses the builder"
 * instead of re-typing the composition.
 *
 * Its own module rather than `summarizer.ts` for the reason `src/vimeo/limits.ts`
 * exists: the summarizer's import graph is yt-dlp, ffmpeg and the wiki queue, and
 * a dashboard view must not pull that in to render a prompt. Nothing here does
 * IO.
 */

import { VALID_CATEGORIES } from "../utils/summary-parser.ts";
import {
  joinPromptPieces,
  optionalPiece,
  summarySystemPromptPieces,
  windowedTranscriptRider,
  type PromptPiece,
} from "../summaries/prompt-pieces.ts";
import type { CapturePreset } from "../summaries/presets.ts";
import {
  YOUTUBE_FRAME_SOURCE,
  framesPromptSection,
  type CaptureFrame,
} from "../summaries/frames.ts";
import { visualDetailPolicy, type VisualDetail } from "../summaries/visual-detail.ts";

export const SUMMARIZE_INTRO =
  "You are a video content analyst. Summarize the following YouTube video transcript.";

/**
 * The rider added when huginn ANSWERED with a windowed transcript. The sentence
 * is the seam's, shared with the Vimeo prompt (which says "talk"): a slide can
 * only be placed beside its passage if the model knows the headings are
 * positions.
 */
export const WINDOWED_TRANSCRIPT_RIDER = `\n\n${windowedTranscriptRider("video")}`;

export interface YouTubeSystemPromptInput {
  /**
   * Whether huginn ANSWERED with a windowed transcript — its own answer, never
   * the frames decision (a pre-#129 huginn ignores `?timestamps=1`).
   */
  readonly windowed: boolean;
  readonly title: string;
  /** Built from the validated video id (`youtubeWatchUrl`), never a caller's url. */
  readonly videoUrl: string;
}

/**
 * The system prompt's pieces, in order: the shared scaffold around the KIND's
 * structure bullets, the windowed rider where the transcript carries windows,
 * and the video's own context lines.
 */
export function youTubeSystemPromptPieces(
  preset: CapturePreset,
  input: YouTubeSystemPromptInput,
): PromptPiece[] {
  return [
    ...summarySystemPromptPieces(SUMMARIZE_INTRO, VALID_CATEGORIES, preset.instruction),
    ...optionalPiece(input.windowed, {
      id: "rider-windowed",
      label: "Windowed transcript rider",
      text: WINDOWED_TRANSCRIPT_RIDER,
    }),
    {
      id: "context",
      label: "Video context",
      text: `\n\nVideo title: ${input.title}\nVideo URL: ${input.videoUrl}`,
    },
  ];
}

/** The system prompt one YouTube capture sends. */
export function buildYouTubeSystemPrompt(
  preset: CapturePreset,
  input: YouTubeSystemPromptInput,
): string {
  return joinPromptPieces(youTubeSystemPromptPieces(preset, input));
}

export interface YouTubeUserPromptInput {
  readonly videoId: string;
  readonly frames: readonly CaptureFrame[];
  readonly visualDetail: VisualDetail;
  /**
   * Does this frame list have a CADENCE the prompt may state? Absent ⇒ yes,
   * which is every capture: the frames came off one sampler, evenly spaced.
   *
   * The capture RE-RUN passes `false`. Its list is whatever the previous
   * summary happened to quote, so the median gap between two survivors is not a
   * sampling interval — see `framesPromptSection`.
   */
  readonly cadence?: boolean;
}

/**
 * The user prompt: the transcript, then the frame list and this policy's rules.
 *
 * With no frames it is the transcript alone — byte-identical to the prompt that
 * shipped before slides existed. The POLICY is built only where frames came out,
 * deliberately: building it needs an ADDRESS (`frameQuoteTemplate`), and
 * `framesPromptSection`'s contract is that a frames-off capture never asks the
 * id gate anything.
 *
 * The `detailed` must-quote rule names "the note above", so it is stated only
 * where a frame actually carries one — the dense scan's selection pass and
 * nothing else.
 */
export function buildYouTubeUserPrompt(transcript: string, input: YouTubeUserPromptInput): string {
  const { videoId, frames, visualDetail } = input;
  return (
    transcript +
    (frames.length > 0
      ? framesPromptSection(
          YOUTUBE_FRAME_SOURCE,
          videoId,
          frames,
          visualDetailPolicy(
            visualDetail,
            YOUTUBE_FRAME_SOURCE,
            videoId,
            frames.some((f) => (f.note ?? "") !== ""),
          ),
          input.cadence === false ? { cadence: false } : undefined,
        )
      : "")
  );
}
