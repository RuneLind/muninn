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

/**
 * Every content-bearing piece carries an id, and no two carry the same one —
 * refused with the offending id named.
 *
 * The envelope's own check ({@link assertEnvelopeInstructions}) sees the four
 * ids it emits plus the slot entries, which is everything the ENVELOPE knows
 * about and nothing about the pieces a vertical appends around it. A slot entry
 * spelled `{ id: "context" }` therefore passed it and collided with the
 * vertical's own context piece one line later — two different parts claiming one
 * tint class and one chip name, with a page that renders both and says nothing.
 * The whole list only exists at the join, so the whole-list check lives here.
 *
 * A WHITESPACE-only span is exempt, and the exemption is Vimeo's: its intro is
 * split around the windowed rider, and the trailing slice is the `\n\n` before
 * the envelope — one part in two spans with a separator between them. It
 * contributes no chip (`pieceChips` filters it) and has no visible tint, so it
 * is not a second part claiming the name.
 *
 * Blast radius, stated on purpose: this runs inside {@link joinPromptPieces},
 * which is on every capture's path, so a builder that repeats an id does not
 * render a mis-tinted page — it THROWS, the capture's catch `failJob`s it, and
 * `/summaries/prompts` 500s. That is the intended shape for a code-authored
 * invariant (it cannot happen from user input), and it is what makes the page
 * trustworthy; it is also why the builders' own tests pin this at construction.
 */
export function assertUniquePieceIds(pieces: readonly PromptPiece[]): void {
  const seen = new Set<string>();
  for (const piece of pieces) {
    if (piece.text.trim() === "") continue;
    if (piece.id.trim() === "") {
      throw new Error(
        `Prompt piece "${piece.label}" has an empty piece id — /summaries/prompts tints and chips by id, so every part needs one.`,
      );
    }
    if (seen.has(piece.id)) {
      throw new Error(
        `Two prompt pieces share the piece id "${piece.id}" — /summaries/prompts tints and chips by id, so two parts cannot claim one.`,
      );
    }
    seen.add(piece.id);
  }
}

/** The composed prompt: every piece's bytes, in order, and nothing else. */
export function joinPromptPieces(pieces: readonly PromptPiece[]): string {
  assertUniquePieceIds(pieces);
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
 * One numbered instruction a vertical slots into the shared envelope, either
 * ahead of the CATEGORY/SUMMARY steps or after the structure bullets.
 *
 * `text` is the instruction's own words WITHOUT its number: the envelope owns
 * the numbering, so a `before` entry renumbers the three shared steps rather
 * than leaving a prompt with two step 1s. That is the whole reason the slot
 * exists — the short-video verticals put their frame-reading rules first and
 * their no-commentary rule last, which a vertical cannot express by
 * concatenating around a fixed `1. / 2. / 3.` block.
 *
 * That contract is CHECKED ({@link assertEnvelopeInstructions}) rather than
 * documented: every way of breaking it composed a malformed prompt in silence.
 * `{ text: "\n6. legacy" }` in the `after` slot produced a step 4 with no words
 * after its number and an orphan `6.` on the line below — and the page tinted
 * both as one piece, since a piece is a contiguous span.
 */
export interface EnvelopeInstruction {
  /** Stable piece id — the tint class and the chip key, exactly as {@link PromptPiece}. */
  readonly id: string;
  readonly label: string;
  /** The instruction, unnumbered and unterminated. */
  readonly text: string;
}

/** The instructions a vertical slots around the shared envelope's own three. */
export interface SummaryEnvelopeSlots {
  /** Numbered 1..n, ahead of the CATEGORY step, which then starts at n+1. */
  readonly before?: readonly EnvelopeInstruction[];
  /** Numbered after the structure step, on its own line each. */
  readonly after?: readonly EnvelopeInstruction[];
}

/** The piece ids {@link summarySystemPromptPieces} emits itself, in every shape. */
const ENVELOPE_OWN_PIECE_IDS = ["intro", "instructions", "envelope", "structure"] as const;

/**
 * The slot contract, refused at construction with the offending id named.
 *
 * A slot entry is written once, in code, by the author of a vertical — so a
 * shape the envelope cannot number is a mistake to report, never one to paper
 * over. The id rules are here for the PAGE's sake rather than the prompt's:
 * `/summaries/prompts` keys its tint and its chip on the id, so two spans
 * sharing one claim to be the same piece and a span with no id claims nothing.
 *
 * This sees the envelope's own ids and the slot entries only — a collision with
 * a piece the VERTICAL appends around the envelope is caught at the join
 * ({@link assertUniquePieceIds}), which is where the whole list exists.
 */
function assertEnvelopeInstructions(
  before: readonly EnvelopeInstruction[],
  after: readonly EnvelopeInstruction[],
): void {
  const seen = new Set<string>(ENVELOPE_OWN_PIECE_IDS);
  for (const [slot, list] of [
    ["before", before],
    ["after", after],
  ] as const) {
    for (const inst of list) {
      const where = `Envelope \`${slot}\` instruction "${inst.id}"`;
      if (inst.id.trim() === "") {
        throw new Error(
          `Envelope \`${slot}\` instruction "${inst.label}" has an empty piece id — /summaries/prompts tints and chips by id, so every instruction needs one.`,
        );
      }
      if (inst.text.trim() === "") {
        throw new Error(`${where} has no text — an empty slot entry composes a bare number.`);
      }
      if (inst.text !== inst.text.trim()) {
        throw new Error(
          `${where} has leading or trailing whitespace — the envelope owns the separators, so the text is its words alone.`,
        );
      }
      if (inst.text.includes("\n")) {
        throw new Error(
          `${where} spans more than one line — a slotted instruction is one line, because the envelope numbers it as one step.`,
        );
      }
      if (/^\d+[.)]/.test(inst.text)) {
        throw new Error(
          `${where} numbers itself — the envelope owns the numbering, and a second number renumbers nothing.`,
        );
      }
      if (seen.has(inst.id)) {
        throw new Error(
          `${where} has a duplicate piece id "${inst.id}" — /summaries/prompts tints and chips by id, so two spans cannot share one.`,
        );
      }
      seen.add(inst.id);
    }
  }
}

/**
 * The shared CATEGORY:/SUMMARY: scaffold, in three pieces: the vertical's own
 * intro sentence, the envelope the shared parser reads, and the KIND's structure
 * bullets — plus, where a vertical passes them, its own numbered instructions
 * before and after those.
 *
 * {@link joinPromptPieces} over this is `buildSummarySystemPrompt`
 * (`summarizer-shared.ts`) byte for byte — that function is defined as this join,
 * so there is one template and not two.
 *
 * **With no slots the answer is byte-identical to what shipped before them, and
 * so is the PIECE LIST** — same three ids, same three texts. That is not an
 * accident of the arithmetic: the `Instructions:\n` header stays inside the
 * `envelope` piece when there is no `before`, and becomes a piece of its own
 * only when one arrives (a `before` entry has to sit between the header and the
 * CATEGORY step, and a span cannot be split around another span). So the five
 * callers that pass no slots — youtube, vimeo, x-article, article, anthropic —
 * keep their prompts AND their `/summaries/prompts` chips unchanged.
 */
export function summarySystemPromptPieces(
  intro: string,
  categories: readonly string[],
  structure: string = SUMMARY_STRUCTURE_BULLETS.join("\n"),
  slots: SummaryEnvelopeSlots = {},
): PromptPiece[] {
  const before = slots.before ?? [];
  const after = slots.after ?? [];
  assertEnvelopeInstructions(before, after);
  // The envelope's own steps start after whatever `before` numbered.
  const first = before.length + 1;
  // The steps THEMSELVES, so `after` numbers on from however many there are
  // rather than from a hardcoded 3 that a fourth step would silently orphan.
  // The first two end their line; the third ends with the continuation indent
  // the structure piece is re-indented against.
  const envelopeSteps: readonly string[] = [
    `Start your response with EXACTLY this line: CATEGORY: <category>\n   Choose from: ${categories.join(", ")}`,
    "Then add a blank line, then SUMMARY: on its own line",
    "Then write a structured summary with:",
  ];
  return [
    { id: "intro", label: "Intro", text: `${intro}\n\n` },
    ...(before.length > 0
      ? [{ id: "instructions", label: "Instructions", text: "Instructions:\n" }]
      : []),
    ...before.map((b, i) => ({ id: b.id, label: b.label, text: `${i + 1}. ${b.text}\n` })),
    {
      id: "envelope",
      label: "CATEGORY/SUMMARY envelope",
      text:
        (before.length > 0 ? "" : "Instructions:\n") +
        envelopeSteps.map((step, i) => `${first + i}. ${step}\n`).join("") +
        `   `,
    },
    {
      id: "structure",
      label: "Structure bullets",
      text: structure.trim().split("\n").join("\n   "),
    },
    ...after.map((a, i) => ({
      id: a.id,
      label: a.label,
      text: `\n${first + envelopeSteps.length + i}. ${a.text}`,
    })),
  ];
}
