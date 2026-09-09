/**
 * A capture prompt, as the PIECES it is assembled from.
 *
 * Every capture vertical composes its system prompt out of the same handful of
 * parts — an intro sentence, the CATEGORY/SUMMARY envelope, the kind's structure
 * bullets, zero or more riders, the video's own context lines. The run only ever
 * needs the finished string, so those parts used to exist as sub-expressions of
 * one template literal and nowhere else.
 *
 * `/summaries/prompts` needs them as SPANS: it tints each line of the composed
 * prompt by the piece that produced it. The only honest way to know which piece
 * produced a line is to have built the string from the pieces — a regex over the
 * finished text is a second, weaker parser that disagrees with the builder the
 * moment a rider's wording moves. So each vertical exposes a `…Pieces` function,
 * its `build…` builder is {@link joinPromptPieces} over it, and a test pins the
 * two to each other.
 *
 * Dependency-free on purpose (the `summary-structure.ts` leaf is the one import),
 * so a dashboard view can read it without pulling a summarizer's whole graph.
 */

import { SUMMARY_STRUCTURE_BULLETS } from "./summary-structure.ts";

/** One contiguous span of a composed prompt, and what produced it. */
export interface PromptPiece {
  /** Stable id — the tint class and the chip key. */
  readonly id: string;
  /** What a reader calls this piece on the prompts page. */
  readonly label: string;
  /** The bytes this piece contributes, VERBATIM — separators included. */
  readonly text: string;
}

/** The composed prompt: every piece's bytes, in order, and nothing else. */
export function joinPromptPieces(pieces: readonly PromptPiece[]): string {
  return pieces.map((p) => p.text).join("");
}

/**
 * A piece that is present only under a condition — dropped entirely when it is
 * not, so an absent rider contributes no empty span to tint.
 */
export function optionalPiece(when: boolean, piece: PromptPiece): PromptPiece[] {
  return when ? [piece] : [];
}

/**
 * The rider a capture adds when its transcript came back WINDOWED — huginn's
 * `### [HH:MM:SS]`-headed buckets, the shape both video verticals ingest.
 *
 * A slide can only be placed beside its passage if the model knows the headings
 * are positions rather than speech. The two verticals carried the same sentence
 * twice, differing in one noun; `noun` is that word ("talk" for a conference
 * recording, "video" for anything else), and nothing else about the sentence is
 * per-vertical.
 *
 * It lives HERE rather than in `summarizer-shared.ts` (which re-exports it, so
 * no importer moved) because both video verticals' PROMPT modules need it, and
 * a value import of the seam drags `executeOneShot` and the tracer into the
 * graph of a page whose whole job is composing strings.
 */
export function windowedTranscriptRider(noun: "talk" | "video"): string {
  return (
    "The transcript is grouped into windows, each opened by a `### [HH:MM:SS]` heading " +
    `carrying its absolute position in the ${noun}; those headings are positions, not content — ` +
    "never quote one as if it were speech."
  );
}

/**
 * The shared CATEGORY:/SUMMARY: scaffold, in three pieces: the vertical's own
 * intro sentence, the envelope the shared parser reads, and the KIND's structure
 * bullets.
 *
 * {@link joinPromptPieces} over this is `buildSummarySystemPrompt`
 * (`summarizer-shared.ts`) byte for byte — that function is defined as this join,
 * so there is one template and not two.
 */
export function summarySystemPromptPieces(
  intro: string,
  categories: readonly string[],
  structure: string = SUMMARY_STRUCTURE_BULLETS.join("\n"),
): PromptPiece[] {
  return [
    { id: "intro", label: "Intro", text: `${intro}\n\n` },
    {
      id: "envelope",
      label: "CATEGORY/SUMMARY envelope",
      text:
        `Instructions:\n` +
        `1. Start your response with EXACTLY this line: CATEGORY: <category>\n` +
        `   Choose from: ${categories.join(", ")}\n` +
        `2. Then add a blank line, then SUMMARY: on its own line\n` +
        `3. Then write a structured summary with:\n` +
        `   `,
    },
    {
      id: "structure",
      label: "Structure bullets",
      text: structure.trim().split("\n").join("\n   "),
    },
  ];
}
