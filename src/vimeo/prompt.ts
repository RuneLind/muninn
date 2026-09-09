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
import {
  joinPromptPieces,
  optionalPiece,
  summarySystemPromptPieces,
  windowedTranscriptRider,
  type PromptPiece,
} from "../summaries/prompt-pieces.ts";
import type { CapturePreset } from "../summaries/presets.ts";
import { languageRider } from "../summaries/language.ts";
import { VIMEO_FRAME_SOURCE, framesPromptSection, type CaptureFrame } from "../summaries/frames.ts";

/** The vertical's own opening sentence, WITHOUT the shared rider after it. */
const INTRO_LEAD = "You are a conference-talk analyst. Summarize the following Vimeo video transcript. ";

/**
 * The windowed-transcript sentence — the seam's, shared with the YouTube prompt
 * (which says "video"). This vertical bakes it into the intro STRING rather than
 * appending it as a separate rider, because a Vimeo transcript is always
 * windowed; YouTube's is conditional and therefore a piece of its own.
 */
const WINDOWED_RIDER = windowedTranscriptRider("talk");

/** Byte-identical to what shipped: the lead sentence and the rider, in order. */
export const SUMMARIZE_INTRO = INTRO_LEAD + WINDOWED_RIDER;

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

/**
 * The system prompt's pieces, in the contract's order.
 *
 * The scaffold's single `intro` piece is SPLIT here, at the boundary between
 * this vertical's own sentence and the shared windowed rider: the rider is a
 * rider wherever it appears, and tinting it as "Intro" told the reader the Vimeo
 * prompt lacks a sentence the YouTube prompt shows. It is a split and not a
 * rewrite — each text is a `slice` of the piece it replaces, taken at offsets
 * that leave no gap, so the three concatenate to it and no byte of the prompt
 * moves.
 *
 * THREE spans and not two, because that piece ends in the `\n\n` separating the
 * intro block from the envelope. Those bytes are the intro's — leaving them on
 * the rider span tints a rider that runs to the blank line.
 */
export function vimeoSystemPromptPieces(input: VimeoSystemPromptInput): PromptPiece[] {
  const riderEnd = INTRO_LEAD.length + WINDOWED_RIDER.length;
  return [
    ...summarySystemPromptPieces(SUMMARIZE_INTRO, VALID_CATEGORIES, input.preset.instruction).flatMap(
      (piece): PromptPiece[] =>
        piece.id === "intro"
          ? [
              { id: "intro", label: piece.label, text: piece.text.slice(0, INTRO_LEAD.length) },
              {
                id: "rider-windowed",
                // The label the YouTube prompt gives the same sentence, so the
                // two rows show one chip and not two spellings of it.
                label: "Windowed transcript rider",
                text: piece.text.slice(INTRO_LEAD.length, riderEnd),
              },
              { id: "intro", label: piece.label, text: piece.text.slice(riderEnd) },
            ]
          : [piece],
    ),
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
