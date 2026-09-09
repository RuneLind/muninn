/**
 * The two prompts a Vimeo capture sends, as pure builders.
 *
 * `buildVimeoSystemPrompt` moved here from `summarizer.ts` and the user prompt
 * joined it, for the reason `src/vimeo/limits.ts` exists: `summarizer.ts` pulls
 * in playwright-core and the whole harvest pipeline, and neither
 * `/summaries/prompts` nor a re-run may import that to compose a string.
 * `summarizer.ts` re-exports both names, so every existing importer is unchanged.
 *
 * **The rider order is a contract** (`src/vimeo/CLAUDE.md`): the kind's structure
 * bullets, then the video's context lines, then the auto-caption rider, then the
 * LANGUAGE rider last — the language is the reader's explicit pick (or the talk's
 * own), and nothing a preset says may un-pick it.
 */

import { VALID_CATEGORIES } from "../utils/summary-parser.ts";
import { windowedTranscriptRider } from "../summaries/summarizer-shared.ts";
import {
  joinPromptPieces,
  optionalPiece,
  summarySystemPromptPieces,
  type PromptPiece,
} from "../summaries/prompt-pieces.ts";
import type { CapturePreset } from "../summaries/presets.ts";
import { languageRider } from "../summaries/language.ts";
import { VIMEO_FRAME_SOURCE, framesPromptSection, type CaptureFrame } from "../summaries/frames.ts";

export const SUMMARIZE_INTRO =
  "You are a conference-talk analyst. Summarize the following Vimeo video transcript. " +
  // The windowed-transcript sentence is the seam's, shared with the YouTube
  // prompt (which says "video"). Byte-identical to what shipped.
  windowedTranscriptRider("talk");

/**
 * The rider appended when the chosen track is machine-generated.
 *
 * Vimeo's auto-captions garble proper nouns — measured on a real JavaZone talk,
 * "JavaBin" comes through as "JavaBeen" — and the failure mode that matters is
 * a summary confidently naming a library, product or person that was never
 * said. The instruction is to describe rather than to assert, not to omit.
 */
export const AUTO_CAPTION_RIDER =
  "\n\nIMPORTANT: this transcript is MACHINE-GENERATED and garbles proper nouns " +
  "(measured: \"JavaBeen\" for JavaBin). Do not assert the spelling of any name, " +
  "product, library or acronym the captions cannot corroborate — describe it " +
  "(\"a JVM testing library\") or mark it uncertain rather than guessing a spelling.";

export interface VimeoSystemPromptInput {
  readonly preset: CapturePreset;
  readonly title: string;
  readonly url: string;
  readonly captionKind: "manual" | "auto";
  readonly outputLang: "nb" | "en";
}

/** The system prompt's pieces, in the contract's order. */
export function vimeoSystemPromptPieces(input: VimeoSystemPromptInput): PromptPiece[] {
  return [
    ...summarySystemPromptPieces(SUMMARIZE_INTRO, VALID_CATEGORIES, input.preset.instruction),
    {
      id: "context",
      label: "Video context",
      text: `\n\nVideo title: ${input.title}\nVideo URL: ${input.url}`,
    },
    ...optionalPiece(input.captionKind === "auto", {
      id: "rider-auto-caption",
      label: "Auto-caption rider",
      text: AUTO_CAPTION_RIDER,
    }),
    {
      id: "rider-language",
      label: "Language rider",
      text: `\n\n${languageRider(input.outputLang, "summary")}`,
    },
  ];
}

/**
 * The system prompt for one capture: the shared envelope around the KIND's
 * structure bullets, then the video, then the riders — language LAST, after
 * the auto-caption one, for the reason the share prompt puts its rider after
 * the instruction: the language is the reader's explicit pick (or the talk's
 * own), and nothing a preset says may un-pick it.
 */
export function buildVimeoSystemPrompt(input: VimeoSystemPromptInput): string {
  return joinPromptPieces(vimeoSystemPromptPieces(input));
}

export interface VimeoUserPromptInput {
  readonly videoId: string;
  readonly frames: readonly CaptureFrame[];
}

/**
 * The user prompt: the transcript, then the frame list.
 *
 * NO policy argument, unlike YouTube's: this vertical takes
 * `framesPromptSection`'s default rules paragraph, which is the wording every
 * caller had before policies existed and is pinned byte for byte in
 * `src/summaries/frames.test.ts`. A transcript-only capture's prompt is the
 * transcript alone (the section returns "" before it looks at the id).
 */
export function buildVimeoUserPrompt(transcript: string, input: VimeoUserPromptInput): string {
  return transcript + framesPromptSection(VIMEO_FRAME_SOURCE, input.videoId, input.frames);
}
