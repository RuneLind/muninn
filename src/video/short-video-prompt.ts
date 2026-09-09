/**
 * The two prompts a SHORT-VIDEO capture sends — TikTok and X video, one builder.
 *
 * `src/tiktok/prompt.ts` and `src/x-article/video-prompt.ts` were measured
 * copy-paste twins: the same four pieces, differing in the platform noun in the
 * intro sentence and in one clause about what that platform's frames typically
 * carry. Both are gone; those two differences are {@link ShortVideoPromptSpec}.
 *
 * **The envelope is the SHARED one now** (`summarySystemPromptPieces`), where it
 * used to be hand-rolled here. That is not a prompt change: the frame-reading
 * rules go into the envelope's `before` slot and the no-commentary rule into its
 * `after` slot, and the slots NUMBER what they hold — so the composed prompt is
 * still `1.` read the frames, `2.` note visual-only, `3.` CATEGORY, `4.` SUMMARY,
 * `5.` structure, `6.` no commentary, byte for byte. What the shared envelope
 * buys is the KIND: `structure` is the preset's instruction, so these two
 * verticals get the `standard` / `deep` / `talk-notes` picker every other
 * capture has.
 *
 * The no-commentary line is its own piece because it is load-bearing: without it
 * the model narrates ("let me look at frame 3…") between Read calls and that
 * chatter leaks into the streamed shelf card. The summarizer reads each frame
 * image before it writes the CATEGORY/SUMMARY — a multi-turn agentic session.
 *
 * PURE, and deliberately importing `../video/media.ts` for its `Keyframe` TYPE
 * only: `/summaries/prompts` composes these strings inside a server-rendered
 * page, and a value edge to the media engine would put yt-dlp's spawner in that
 * page's graph. `../summaries/presets.ts` is a value import and is IO-free.
 */

import { VALID_CATEGORIES } from "../utils/summary-parser.ts";
import {
  joinPromptPieces,
  summarySystemPromptPieces,
  type EnvelopeInstruction,
  type PromptPiece,
} from "../summaries/prompt-pieces.ts";
import type { CapturePreset } from "../summaries/presets.ts";
import type { Keyframe } from "./media.ts";

/**
 * The two words that differ between the platforms' prompts, and nothing else.
 *
 * Kept apart from the RUN spec (`ShortVideoSpec`, in each vertical's own
 * summarizer) so the prompts page can build a cell without importing a job
 * store or the media engine.
 */
export interface ShortVideoPromptSpec {
  /** The trace/source id — `tiktok` or `x-video`. */
  readonly id: string;
  /** The platform as the intro sentence names it: "TikTok", "X/Twitter". */
  readonly platform: string;
  /** What this platform's frames typically carry — the tail of instruction 1. */
  readonly frameClause: string;
}

export const TIKTOK_PROMPT_SPEC: ShortVideoPromptSpec = {
  id: "tiktok",
  platform: "TikTok",
  frameClause:
    "TikToks often carry most of their information on screen — capture diagrams, code, on-screen text, and visual demos.",
};

export const X_VIDEO_PROMPT_SPEC: ShortVideoPromptSpec = {
  id: "x-video",
  platform: "X/Twitter",
  frameClause:
    "X videos often carry key information on screen — capture slides, charts, code, captions, and visual demos.",
};

/** Format a timestamp (seconds) as `M:SS` for the frame list. */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/** Build the `t=M:SS <path>` frame list block for the user prompt. */
export function frameListBlock(frames: readonly Keyframe[]): string {
  return frames.map((f) => `t=${formatTimestamp(f.tSeconds)} ${f.path}`).join("\n");
}

export interface ShortVideoSystemPromptInput {
  /** The summary KIND — its instruction is the envelope's structure step. */
  readonly preset: CapturePreset;
  readonly title: string;
  readonly url: string;
  readonly author: string;
}

/**
 * The instruction the frame-reading session opens with — the `before` slot's
 * first entry, and the reason these two verticals could not use the shared
 * envelope before it had slots. It must be step 1: everything after it depends
 * on the images already being in the context.
 */
function readFramesInstruction(spec: ShortVideoPromptSpec): EnvelopeInstruction {
  return {
    id: "read-frames",
    label: "Frame-reading rule",
    text:
      `Read ALL the frame images listed below (with the Read tool) FIRST, batching many Read tool calls ` +
      `into one turn (parallel tool calls) — do NOT read one frame per message. ${spec.frameClause}`,
  };
}

const VISUAL_ONLY_INSTRUCTION: EnvelopeInstruction = {
  id: "visual-only",
  label: "Visual-only rule",
  text: "Note explicitly when key information is visual-only (not spoken).",
};

/**
 * The LAST instruction, and the one whose POSITION matters as much as its
 * presence: it is the rule the model applies to everything above it, so it is
 * numbered after the structure step rather than folded into the frame-reading
 * one. Without it the model narrates its Reads and the chatter streams into the
 * shelf card ahead of the summary.
 */
const NO_COMMENTARY_INSTRUCTION: EnvelopeInstruction = {
  id: "no-commentary",
  label: "No-commentary rule",
  text:
    "CRITICAL: produce NO commentary — your only text output is the final CATEGORY/SUMMARY response. " +
    "Do not narrate the frames as you read them.",
};

/** The system prompt's pieces — the spans `/summaries/prompts` tints by. */
export function shortVideoSystemPromptPieces(
  spec: ShortVideoPromptSpec,
  input: ShortVideoSystemPromptInput,
): PromptPiece[] {
  return [
    ...summarySystemPromptPieces(
      `You are a video content analyst. Summarize the following ${spec.platform} video, using BOTH its speech transcript and the extracted keyframe images.`,
      VALID_CATEGORIES,
      input.preset.instruction,
      {
        before: [readFramesInstruction(spec), VISUAL_ONLY_INSTRUCTION],
        after: [NO_COMMENTARY_INSTRUCTION],
      },
    ),
    {
      id: "context",
      label: "Video context",
      text: `\n\nVideo title: ${input.title}\nVideo URL: ${input.url}\nAuthor: ${input.author}`,
    },
  ];
}

/** The system prompt one short-video capture sends. */
export function buildShortVideoSystemPrompt(
  spec: ShortVideoPromptSpec,
  input: ShortVideoSystemPromptInput,
): string {
  return joinPromptPieces(shortVideoSystemPromptPieces(spec, input));
}

export interface ShortVideoUserPromptInput {
  /** Whisper's answer — empty on a music/visual-only clip, which is a real capture. */
  readonly transcript: string;
  readonly frames: readonly Keyframe[];
}

/**
 * The user prompt: the transcript (or the sentence that stands in for one), then
 * the keyframe list.
 *
 * An empty transcript is not an error here — a short video can carry everything
 * on screen — so the prompt says so rather than sending a blank section. It is
 * source-neutral: the two verticals' builders were identical here, wording
 * included.
 */
export function buildShortVideoUserPrompt(input: ShortVideoUserPromptInput): string {
  const transcriptSection = input.transcript
    ? `Transcript:\n${input.transcript}`
    : "No speech detected — summarize from the frames.";
  const framesSection =
    input.frames.length > 0
      ? `\n\nKeyframes (read each image before summarizing):\n${frameListBlock(input.frames)}`
      : "";
  return `${transcriptSection}${framesSection}`;
}
