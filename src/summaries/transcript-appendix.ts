/**
 * The `## Transcript` a capture appends to the document body — source-neutral.
 *
 * Lifted out of `src/youtube/frames.ts` when a SECOND vertical needed it: the
 * short-video captures (`src/video/short-video.ts`) now file their whisper text
 * the same way, and `src/video/` may not import `src/youtube/` — a vertical
 * never imports another vertical, and the frames module is YouTube's own half of
 * the slides decision. `frames.ts` re-exports every name it used to own, so no
 * existing importer moved.
 *
 * **Two shapes of transcript, two cappers, one heading.** huginn's windowed
 * transcript is `### [HH:MM:SS]`-headed buckets and must be cut at a WINDOW
 * boundary ({@link capTranscriptWindows}); whisper's is one flat run of prose
 * with no structure to respect, and putting it through the window capper is not
 * merely imprecise — `headWithinBytes`' "a budget that does not reach past the
 * first line has no head to show" rule throws the WHOLE transcript away for a
 * single-paragraph text, which is the failure `capTextWithNote`
 * (`./truncation.ts`) was written for. {@link capFlatTranscript} is the flat
 * path, and {@link appendTranscriptSection}'s `windowed` argument picks between
 * them.
 *
 * Dependency-free but for the `./truncation.ts` leaf, so anything may import it.
 */

import {
  TRANSCRIPT_TRUNCATION_NOTE,
  byteLength,
  capTextWithNote,
  headWithinBytes,
} from "./truncation.ts";

export { TRANSCRIPT_TRUNCATION_NOTE } from "./truncation.ts";

/**
 * The most bytes of transcript a document body may carry — huginn's own
 * `VIMEO_TRANSCRIPT_MAX_BYTES`, restated here because neither the YouTube nor
 * the short-video ingest has a `transcript_markdown` field to validate it (see
 * {@link appendTranscriptSection}).
 *
 * Source-neutral name: it was `YOUTUBE_TRANSCRIPT_MAX_BYTES` while YouTube was
 * the only caller, and `frames.ts` still exports that spelling as an alias.
 */
export const TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;

/** What a capper did, in the two numbers a caller can log. */
export interface CappedTranscript {
  readonly text: string;
  readonly truncated: boolean;
  /** UTF-8 bytes of the transcript handed in. */
  readonly inputBytes: number;
  /**
   * UTF-8 bytes of {@link text}, the note included. Never above `maxBytes`
   * EXCEPT in the note-alone band: a budget too small for even the heading
   * answers with the note by itself, and the note is ~65 bytes.
   */
  readonly keptBytes: number;
}

/**
 * The windowed transcript, trimmed to `maxBytes` at a WINDOW boundary.
 *
 * At a boundary rather than at a byte, because the windows are the contract: a
 * cut mid-window leaves a `### [HH:MM:SS]` heading over half a sentence, and
 * huginn's heading splitter would carry that timestamp into a chunk that ends
 * mid-word. A transcript over the cap keeps as many whole windows as fit and
 * says so in the text.
 *
 * Two things the first cut of this got wrong, both stated because they are
 * invisible until a real 3-hour talk arrives:
 *
 *  - **The note's bytes come out of the budget.** It is part of what is
 *    returned, so a budget that ignores it hands the caller a string over the
 *    cap it asked for — and the cap exists to keep the ingest body under
 *    huginn's own bound.
 *  - **A first window over the cap keeps a HEAD of it, never the note alone.**
 *    huginn windows at 120 s, but nothing guarantees the first window fits an
 *    arbitrary `maxBytes`, and answering with only the truncation note is a
 *    document that says a talk exists and nothing about it. The head keeps the
 *    `### [HH:MM:SS]` heading and cuts at the last boundary a reader can see
 *    ({@link headWithinBytes} — a line where the window has more than one, a
 *    word where it does not, which is huginn's real shape).
 *
 * **A truncated answer ALWAYS carries the note.** Below roughly a hundred bytes
 * not even the heading fits, and there the note is what goes, alone — a head
 * with no note is a fragment of a three-hour talk that reads as the whole of
 * it, which is what this returned before. The note may then be longer than
 * `maxBytes`: the cap bounds a transcript, and at that budget there is no
 * transcript left to bound. Every budget that fits any of the talk at all keeps
 * the result inside the cap.
 *
 * Pure. `truncated` and the byte counts are returned so a caller can say so —
 * `summarizeVideo` warns with them; without a consumer, a talk whose second
 * half never reached the document was invisible outside the stored file.
 */
export function capTranscriptWindows(
  transcript: string,
  maxBytes: number = TRANSCRIPT_MAX_BYTES,
): CappedTranscript {
  const inputBytes = byteLength(transcript);
  if (inputBytes <= maxBytes) {
    return { text: transcript, truncated: false, inputBytes, keptBytes: inputBytes };
  }

  // The note plus the `\n\n` it is joined on is reserved up front.
  const noteBytes = byteLength(TRANSCRIPT_TRUNCATION_NOTE) + 2;
  const budget = maxBytes - noteBytes;

  const windows = transcript.split("\n\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const w of windows) {
    // The separator is only paid for from the second window on.
    const size = byteLength(w) + (kept.length === 0 ? 0 : 2);
    if (bytes + size > budget) break;
    kept.push(w);
    bytes += size;
  }

  // Not one whole window fits: keep a head of the first one instead. With no
  // room even for its heading, the note is what goes — alone, because a head
  // with no note reads as a complete transcript.
  const body = kept.length > 0 ? kept.join("\n\n") : headWithinBytes(transcript, budget);
  const text = body === "" ? TRANSCRIPT_TRUNCATION_NOTE : `${body}\n\n${TRANSCRIPT_TRUNCATION_NOTE}`;
  return { text, truncated: true, inputBytes, keptBytes: byteLength(text) };
}

/**
 * The FLAT transcript — whisper's plain prose — trimmed to `maxBytes`.
 *
 * It is {@link capTextWithNote}, wrapped so both paths answer the same shape.
 * The window capper is the wrong tool here and not just a blunt one: a flat
 * transcript has no `\n\n` windows, so `split("\n\n")` yields ONE element that
 * is the whole text, nothing fits the budget, and the answer falls through to
 * `headWithinBytes` — whose first rule is "a budget that does not reach past
 * the text's first line has no head to show". A whisper transcript is
 * frequently one unbroken line, so that rule returns `""` and the stored
 * document becomes the truncation note and nothing else. `capTextWithNote`
 * cuts at the last code-point boundary inside the budget instead, which is the
 * right cut for text with no structure to keep whole.
 */
export function capFlatTranscript(
  transcript: string,
  maxBytes: number = TRANSCRIPT_MAX_BYTES,
): CappedTranscript {
  const inputBytes = byteLength(transcript);
  if (inputBytes <= maxBytes) {
    return { text: transcript, truncated: false, inputBytes, keptBytes: inputBytes };
  }
  const text = capTextWithNote(transcript, maxBytes);
  return { text, truncated: true, inputBytes, keptBytes: byteLength(text) };
}

/**
 * The ingest body's `summary` field with the transcript appended under a
 * `## Transcript` heading.
 *
 * **Why the SUMMARY string and not a field of its own:** neither huginn's
 * YouTube ingest (`main/ingest/youtube.py`) nor its tiktok/x-articles ones have
 * a `transcript_markdown` — the Vimeo vertical's `body_suffix` route into
 * `write_summary` exists only for Vimeo — so the document body is exactly what
 * is posted as `summary`. Appending here is what puts the transcript in the
 * indexed document, which is what makes a hit inside a long talk citable to the
 * minute (huginn's `MarkdownHeadingSplitter` carries the nearest heading into
 * every chunk). A `transcript_markdown` field on those ingests is the better
 * shape and is filed as a follow-up.
 *
 * `windowed` picks the capper: `true` (the default, so every pre-existing
 * caller is unchanged) for huginn's `### [HH:MM:SS]` buckets, `false` for a
 * flat whisper transcript — see {@link capFlatTranscript} for why the wrong one
 * is destructive rather than merely imprecise.
 *
 * Only the INGEST body carries it: `completeJob`, the shelf card's text and the
 * source-page draft all get the summary alone. ⚠️ The `similar` list is NOT in
 * that group — huginn computes it from `result["summary"][:2000]`, i.e. from
 * the string this function returns, so a summary under 2 000 characters lets
 * the head of the transcript into the similarity query (huginn
 * `main/ingest/registry.py`). It is a query, not stored content; the
 * `transcript_markdown` follow-up retires it.
 *
 * Returns what the cap did, so the caller can warn when a talk did not fit. The
 * byte counts describe the TRANSCRIPT (in, and what survived the cap) — not
 * `text`, which is the summary and the heading on top of it.
 */
export function appendTranscriptSection(
  summary: string,
  transcript: string,
  maxBytes: number = TRANSCRIPT_MAX_BYTES,
  windowed: boolean = true,
): CappedTranscript {
  const capped = windowed
    ? capTranscriptWindows(transcript, maxBytes)
    : capFlatTranscript(transcript, maxBytes);
  return { ...capped, text: `${summary.trimEnd()}\n\n## Transcript\n\n${capped.text}\n` };
}
