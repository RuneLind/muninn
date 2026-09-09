/**
 * The two prompts an X-video capture sends, as pure builders.
 *
 * A measured copy-paste twin of `src/tiktok/prompt.ts` — the wording differs in
 * "X/Twitter" and in what the frames typically carry, nothing else. PR 4 merges
 * the two; this module keeps the X spelling EXACTLY as it shipped, because
 * folding a prompt change into an extraction is how a capture quietly starts
 * saying something different.
 */

import { VALID_CATEGORIES } from "../utils/summary-parser.ts";
import { SUMMARY_STRUCTURE_BULLETS } from "../summaries/summary-structure.ts";
import { joinPromptPieces, type PromptPiece } from "../summaries/prompt-pieces.ts";
import type { Keyframe } from "../video/media.ts";

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

export interface XVideoSystemPromptInput {
  readonly title: string;
  readonly url: string;
  readonly author: string;
}

/**
 * The system prompt's pieces. Mirrors the TikTok prompt — the "no commentary"
 * line is load-bearing (see `src/tiktok/prompt.ts`): without it the model
 * narrates between frame Reads and the chatter leaks into the streamed shelf
 * card.
 */
export function xVideoSystemPromptPieces(input: XVideoSystemPromptInput): PromptPiece[] {
  return [
    {
      id: "envelope",
      label: "Hand-rolled envelope",
      text:
        `You are a video content analyst. Summarize the following X/Twitter video, using BOTH its speech transcript and the extracted keyframe images.\n\n` +
        `Instructions:\n` +
        `1. Read ALL the frame images listed below (with the Read tool) FIRST, batching many Read tool calls into one turn (parallel tool calls) — do NOT read one frame per message. X videos often carry key information on screen — capture slides, charts, code, captions, and visual demos.\n` +
        `2. Note explicitly when key information is visual-only (not spoken).\n` +
        `3. Start your response with EXACTLY this line: CATEGORY: <category>\n` +
        `   Choose from: ${VALID_CATEGORIES.join(", ")}\n` +
        `4. Then add a blank line, then SUMMARY: on its own line\n` +
        `5. Then write a structured summary with:\n` +
        `   `,
    },
    {
      id: "structure",
      label: "Structure bullets",
      text: SUMMARY_STRUCTURE_BULLETS.join("\n   "),
    },
    {
      id: "no-commentary",
      label: "No-commentary rule",
      text: `\n6. CRITICAL: produce NO commentary — your only text output is the final CATEGORY/SUMMARY response. Do not narrate the frames as you read them.`,
    },
    {
      id: "context",
      label: "Video context",
      text: `\n\nVideo title: ${input.title}\nVideo URL: ${input.url}\nAuthor: ${input.author}`,
    },
  ];
}

/** The system prompt one X-video capture sends. */
export function buildXVideoSystemPrompt(input: XVideoSystemPromptInput): string {
  return joinPromptPieces(xVideoSystemPromptPieces(input));
}

export interface XVideoUserPromptInput {
  /** Whisper's answer — empty on a music/caption-only clip, which is a real capture. */
  readonly transcript: string;
  readonly frames: readonly Keyframe[];
}

/** The user prompt: the transcript (or its stand-in sentence), then the keyframes. */
export function buildXVideoUserPrompt(input: XVideoUserPromptInput): string {
  const transcriptSection = input.transcript
    ? `Transcript:\n${input.transcript}`
    : "No speech detected — summarize from the frames.";
  const framesSection =
    input.frames.length > 0
      ? `\n\nKeyframes (read each image before summarizing):\n${frameListBlock(input.frames)}`
      : "";
  return `${transcriptSection}${framesSection}`;
}
