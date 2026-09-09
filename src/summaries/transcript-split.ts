/**
 * Reading a STORED capture document back apart — the two things a re-run needs
 * before it can send the same document to the model again.
 *
 * 1. **Where the summary ends and the transcript begins.** {@link splitTranscript}
 *    is the export's rule, moved here so the three server-side readers are one
 *    function: `src/summaries/export.ts` (the standalone page's `<details>`),
 *    the re-run route (which re-summarizes from the appendix) and
 *    `scripts/eval-takeaway.ts` (which regenerates a summary from it). The
 *    CLIENT keeps its own copy inside `sum-article-library.ts`'s template
 *    literal — nothing can import that — and `export.test.ts` pins the two
 *    against shared fixtures.
 *
 * 2. **What the document's frontmatter said, byte for byte.** huginn's ingest
 *    takes no document id: it rewrites the whole file from the request body and
 *    keys the path on `<category>/<sanitized title>.md`, forking a `(2)` sibling
 *    when the stored `url` differs. So a re-run has to RE-SEND every field the
 *    vertical's ingest accepts, `url` and `date` included, with only
 *    `summary_kind` changed — and to do that it has to read them back without
 *    losing what they were.
 *
 * {@link parseCaptureFrontmatter} is why this is not `parseFrontmatter`
 * (`src/wiki/store.ts`): that parser answers `Record<string, string | string[]>`,
 * which cannot tell huginn's BARE integer (`duration_sec: 3180`, written bare so
 * the converter can serve it as a number) from a quoted `"3180"`. Re-sending the
 * string would write `duration_sec: "3180"` on the next pass — a frontmatter
 * diff on a re-run that is supposed to change one field. This reader keeps each
 * value's RAW TEXT and decodes it the way huginn's own `frontmatter_scalar`
 * encodes it, so `encodeFrontmatterScalar(decodeFrontmatterScalar(raw))` is
 * `raw` for every value huginn writes (pinned in the tests).
 *
 * Pure and import-free: the re-run route, the export and a script all read it,
 * and none of them may acquire the wiki store's import graph to do so.
 */

/** The heading the capture verticals put the stored transcript under. */
export const TRANSCRIPT_HEADING_RE = /^## Transcript\s*$/;

/** A windowed transcript's own heading — `### [HH:MM:SS]`, absolute position. */
export const TRANSCRIPT_WINDOW_RE = /^### \[\d{1,2}:\d{2}:\d{2}\]\s*$/;

/**
 * Apply `fn` to every line OUTSIDE a fenced code block. A fence is closed only
 * by its own marker character with at least the opening length — the client's
 * rule, kept because pairing ``` and ~~~ interchangeably linked inside a block
 * and de-linked everything after it.
 *
 * Exported because `src/summaries/export.ts`'s Vimeo timestamp transform reads
 * the same region set and promises PARITY with the client's own copy, which is
 * fence-aware and nothing else.
 *
 * **Do not widen the region set here.** What the Vimeo transforms promise is
 * parity with those client copies, so teaching this walker about inline code or
 * indented blocks would break the property their fixtures pin. The frame quote
 * finder and the rewrite in `export.ts` read `markdownCodeRegions` instead —
 * they promise agreement with the visual-detail pass and the frame copy, not
 * with a browser.
 */
export function mapProseLines(markdown: string, fn: (line: string, i: number) => string): string {
  let fence: string | null = null;
  return markdown.split("\n").map((line, i) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (fence === null) {
        fence = m[1]!;
        return line;
      }
      if (m[1]!.charAt(0) === fence.charAt(0) && m[1]!.length >= fence.length) {
        fence = null;
        return line;
      }
    }
    return fence === null ? fn(line, i) : line;
  }).join("\n");
}

/**
 * Split at the first level-2 `## Transcript` heading outside fenced code: the
 * summary before it, the transcript after. No heading ⇒ transcript is `null`.
 *
 * The transcript comes back with the blank lines that surrounded the heading
 * still on it; a caller that re-appends it trims first, because
 * `appendTranscriptSection` adds its own separator.
 */
export function splitTranscript(markdown: string): { body: string; transcript: string | null } {
  let at = -1;
  mapProseLines(markdown, (line, i) => {
    if (at === -1 && TRANSCRIPT_HEADING_RE.test(line)) at = i;
    return line;
  });
  if (at === -1) return { body: markdown, transcript: null };
  const lines = markdown.split("\n");
  return { body: lines.slice(0, at).join("\n"), transcript: lines.slice(at + 1).join("\n") };
}

/**
 * Whether a stored transcript carries the `### [HH:MM:SS]` window headings.
 *
 * The re-run derives `windowed` from the TRANSCRIPT ITSELF rather than from
 * anything the document claims, for the reason the YouTube vertical derives it
 * from huginn's answer rather than from its own frames decision: the rider tells
 * the model the headings are positions, and stating that over a flat wall of
 * text is a lie the model then acts on.
 *
 * Fence-aware, so a quoted window heading inside a code block does not count.
 */
export function transcriptIsWindowed(transcript: string): boolean {
  let windowed = false;
  mapProseLines(transcript, (line) => {
    if (TRANSCRIPT_WINDOW_RE.test(line)) windowed = true;
    return line;
  });
  return windowed;
}

/** One frontmatter entry, with the value exactly as it is written on disk. */
export interface FrontmatterEntry {
  readonly key: string;
  /** The text after `key: `, verbatim — `"a \"b\""`, `3180`, `ai/general`. */
  readonly raw: string;
}

export interface CaptureFrontmatter {
  /** Entries in FILE order, so a re-send can preserve huginn's own key order. */
  readonly entries: FrontmatterEntry[];
  /** Lookup by key; a repeated key keeps the LAST, as a YAML reader would. */
  readonly byKey: Record<string, string>;
  /** The document after the closing `---` and its trailing newlines. */
  readonly body: string;
  /** False when the text carries no frontmatter block at all. */
  readonly present: boolean;
}

/**
 * The frontmatter block huginn's summary writer emits, read back with each
 * value's raw text intact.
 *
 * Deliberately narrow: `---` on the FIRST line, `key: value` lines until the
 * closing `---`, no nesting and no list support. That is exactly what
 * `write_summary` produces (`main/ingest/_summary_ingest.py`), and a reader that
 * guessed at more would report a shape the re-send cannot reproduce. A line
 * that does not parse is skipped rather than fatal — it still ends up in
 * neither `entries` nor `byKey`, so a re-send simply does not carry it, which is
 * what the caller's "every field the ingest accepts" list is for.
 */
export function parseCaptureFrontmatter(markdown: string): CaptureFrontmatter {
  const empty: CaptureFrontmatter = { entries: [], byKey: {}, body: markdown, present: false };
  if (!markdown.startsWith("---\n")) return empty;
  const lines = markdown.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") { end = i; break; }
  }
  if (end === -1) return empty;

  const entries: FrontmatterEntry[] = [];
  const byKey: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const entry = { key: m[1]!, raw: m[2]! };
    entries.push(entry);
    byKey[entry.key] = entry.raw;
  }
  // The body starts after the closing `---` and the blank line the writer puts
  // between the block and the summary. Only ONE leading newline run is dropped,
  // so a document that opens on a blank line keeps it.
  let start = end + 1;
  if (lines[start] === "") start += 1;
  return { entries, byKey, body: lines.slice(start).join("\n"), present: true };
}

/**
 * A frontmatter value as the ingest body should carry it: a bare integer comes
 * back as a NUMBER, everything else as the unescaped string.
 *
 * The escape rules are huginn's `escape_frontmatter_value`, read backwards —
 * `\\` and `\"` are the only two sequences it produces. An unquoted,
 * non-integer value (nothing huginn writes; a hand edit) is returned trimmed.
 */
export function decodeFrontmatterScalar(raw: string): string | number {
  const text = raw.trim();
  if (/^-?\d+$/.test(text)) {
    const n = Number(text);
    // Past 2^53 the round trip stops being one, so such a value stays a string
    // rather than silently becoming a different number on the way back.
    if (Number.isSafeInteger(n)) return n;
    return text;
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return text;
}

/**
 * The inverse — huginn's `frontmatter_scalar`, so a test can prove the round
 * trip on a real document rather than asserting it in prose.
 */
export function encodeFrontmatterScalar(value: string | number): string {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  const text = String(value).replace(/[\r\n]+/g, " ");
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
