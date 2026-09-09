/**
 * The two prompts a TikTok capture sends, as pure builders.
 *
 * The envelope is HAND-ROLLED rather than `buildSummarySystemPrompt`'s — this
 * vertical's frame-reading instructions come first and the CATEGORY/SUMMARY
 * contract is numbered 3–5 inside them — and it stays that way here: merging it
 * with the X-video twin next door is PR 4's, and doing it under an extraction
 * would hide a prompt change inside a refactor. The pieces below are the same
 * bytes, split at the seams `/summaries/prompts` tints by.
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

export interface TikTokSystemPromptInput {
  readonly title: string;
  readonly url: string;
  readonly author: string;
}

/**
 * The system prompt's pieces.
 *
 * The "no commentary" line is its own piece because it is load-bearing: without
 * it the model narrates ("let me look at frame 3…") between Read calls and that
 * chatter leaks into the streamed shelf card. The summarizer reads each frame
 * image before it writes the CATEGORY/SUMMARY — a multi-turn agentic session.
 */
export function tikTokSystemPromptPieces(input: TikTokSystemPromptInput): PromptPiece[] {
  return [
    {
      id: "envelope",
      label: "Hand-rolled envelope",
      text:
        `You are a video content analyst. Summarize the following TikTok video, using BOTH its speech transcript and the extracted keyframe images.\n\n` +
        `Instructions:\n` +
        `1. Read ALL the frame images listed below (with the Read tool) FIRST, batching many Read tool calls into one turn (parallel tool calls) — do NOT read one frame per message. TikToks often carry most of their information on screen — capture diagrams, code, on-screen text, and visual demos.\n` +
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

/** The system prompt one TikTok capture sends. */
export function buildTikTokSystemPrompt(input: TikTokSystemPromptInput): string {
  return joinPromptPieces(tikTokSystemPromptPieces(input));
}

export interface TikTokUserPromptInput {
  /** Whisper's answer — empty on a music/visual-only clip, which is a real capture. */
  readonly transcript: string;
  readonly frames: readonly Keyframe[];
}

/**
 * The user prompt: the transcript (or the sentence that stands in for one), then
 * the keyframe list.
 *
 * An empty transcript is not an error here — a TikTok can carry everything on
 * screen — so the prompt says so rather than sending a blank section.
 */
export function buildTikTokUserPrompt(input: TikTokUserPromptInput): string {
  const transcriptSection = input.transcript
    ? `Transcript:\n${input.transcript}`
    : "No speech detected — summarize from the frames.";
  const framesSection =
    input.frames.length > 0
      ? `\n\nKeyframes (read each image before summarizing):\n${frameListBlock(input.frames)}`
      : "";
  return `${transcriptSection}${framesSection}`;
}
