/**
 * Cutting a long text down to a byte budget, at a boundary a reader can see.
 *
 * Lifted out of `src/youtube/frames.ts` when a SECOND caller appeared: the
 * stored prompt snapshot of a capture (`src/db/prompt-snapshots.ts`) is capped
 * the same way the ingested `## Transcript` is, and neither a vertical
 * importing another vertical nor `src/db` importing `src/youtube` is allowed.
 * So the two pieces both callers need live here — dependency-free, so anything
 * may import them — and `frames.ts` keeps the WINDOW-aware capper built on top,
 * which only its own ingest body needs.
 */

/** The line a truncated text ends on, so a reader never takes the cut for the end of the talk. */
export const TRANSCRIPT_TRUNCATION_NOTE =
  "_(transcript truncated — the talk continues past this point.)_";

/** UTF-8 bytes, which is what every budget here is denominated in. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The longest prefix of `text` that fits in `maxBytes`, cut at a boundary a
 * reader can see and never inside a code point.
 *
 * **The window shape this has to survive is TWO lines**, not many:
 * huginn's `format_transcript_windows` emits `### [HH:MM:SS]\n<the window's
 * 120 s of speech as ONE unbroken line>`. So a cut taken at the last NEWLINE
 * finds only the newline under the heading, and the "head of the first window"
 * comes out as a timestamp with nothing beneath it — inert on the exact input
 * this function exists for. The rule is therefore:
 *
 *  - **A newline PAST the heading** ⇒ cut there, so no half-line survives. This
 *    is the many-line case (a whisper transcript, a hand-written fixture).
 *  - **Otherwise** ⇒ cut at the last SPACE inside the budget, keeping the
 *    heading line, so no half-WORD survives.
 *  - **No space either** — a CJK run has neither — ⇒ the byte cut stands, and
 *    the U+FFFD trim below is the only thing between it and a `�` in the stored
 *    document. That trim is load-bearing exactly here.
 *
 * Byte-safe by construction: the slice is decoded, and a multi-byte sequence
 * cut in half decodes to a single trailing U+FFFD, which is dropped.
 *
 * Returns `""` when the budget did not even reach the end of the text's FIRST
 * line — for a transcript that line is the `### [HH:MM:SS]` heading, and a
 * fragment of a timestamp is not a head of the talk. The caller answers with
 * the note alone.
 */
export function headWithinBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const sliced = new TextDecoder().decode(new TextEncoder().encode(text).slice(0, maxBytes));
  const head = sliced.endsWith("�") ? sliced.slice(0, -1) : sliced;
  const firstNewline = head.indexOf("\n");
  if (firstNewline === -1 && text.includes("\n")) return "";
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline > firstNewline) return head.slice(0, lastNewline).trimEnd();
  const lastSpace = head.lastIndexOf(" ");
  return (lastSpace > firstNewline ? head.slice(0, lastSpace) : head).trimEnd();
}

/**
 * `text`, trimmed to `maxBytes` INCLUDING the truncation note appended to it.
 *
 * The plain byte-budget capper, for text with no window structure to respect —
 * a stored prompt, which is a system-prompt scaffold with a transcript pasted
 * into the middle of it. `capTranscriptWindows` (in `src/youtube/frames.ts`) is
 * the window-aware version and stays there, because only the ingest body it
 * builds has windows to keep whole.
 *
 * ⚠️ **It deliberately does NOT call `headWithinBytes`.** That function's window
 * rule — "a budget that does not reach past the first line has no head to show"
 * — is right for a transcript whose first line is a `### [HH:MM:SS]` heading and
 * catastrophic for a prompt: a capture prompt may be one paragraph with its only
 * newline at the very end, and inheriting the rule threw the whole prompt away.
 * Measured on a 300 KB single-paragraph article with a trailing newline, under
 * the 256 KiB capture cap: the stored row was the 64-byte note alone (62
 * characters — the em dash is three bytes), while the SAME text with the newline
 * removed stored the full 262,144. So the cut here is the last UTF-8 character
 * boundary inside the budget, whatever the newline layout — the answer is never
 * shorter than the budget minus one code point.
 *
 * The note's bytes come out of the budget, so the answer is never over the cap
 * the caller asked for — except in the note-alone band, where the budget cannot
 * fit even the note and there is nothing left to bound.
 */
export function capTextWithNote(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  // The note plus the `\n\n` it is joined on is reserved up front.
  const budget = maxBytes - byteLength(TRANSCRIPT_TRUNCATION_NOTE) - 2;
  if (budget <= 0) return TRANSCRIPT_TRUNCATION_NOTE;
  const head = headAtCharBoundary(text, budget);
  return head === "" ? TRANSCRIPT_TRUNCATION_NOTE : `${head}\n\n${TRANSCRIPT_TRUNCATION_NOTE}`;
}

/**
 * The longest prefix of `text` that fits in `maxBytes` and ends on a code point.
 *
 * Byte-safe by construction rather than by counting: the slice is decoded, and a
 * multi-byte sequence cut in half decodes to a single trailing U+FFFD, which is
 * dropped. (A text whose kept tail is a GENUINE U+FFFD loses that one character
 * — the same trade `headWithinBytes` makes, and a replacement character is not
 * content anyone is reading a prompt for.)
 */
function headAtCharBoundary(text: string, maxBytes: number): string {
  const sliced = new TextDecoder().decode(new TextEncoder().encode(text).slice(0, maxBytes));
  return sliced.endsWith("�") ? sliced.slice(0, -1) : sliced;
}
