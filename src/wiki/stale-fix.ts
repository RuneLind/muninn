/**
 * The Stale check's fix paths (plan muninn-wiki-drift-check, PR 3): placing a
 * drafted edit (`old` → `new` or `home`) on the LIVE file.
 *
 * Apply (`POST /api/wiki/stale/apply`) runs this inside the per-wiki write
 * queue, under a byte CAS on the page. Send's redraft
 * (`src/gardener/stale-proposals.ts`) runs it OUTSIDE any queue and with no
 * byte CAS: it only builds a draft, stamped with the `baseHash` of the bytes
 * it read, and Accept's CAS on that `baseHash` (`apply.ts`) refuses the card
 * if the page moved since. Accept's preflight places it again.
 * The draft was validated when the model answered (`parseStaleAnswer`), but
 * the page may have moved since, so the edit is placed again from scratch.
 * Refusing a fix is safe and a wrong write is not, so every rule refuses when
 * in doubt:
 *
 * - the windows are RECOMPUTED on the live bytes (the passage rows a Check
 *   reads, or the status-line candidates for the hit's target), never read
 *   from a cached bucket or a stored line number, so a line shift between
 *   draft and apply still lands on the right line;
 * - `old` must occur exactly once across the passage's pieces (rows split at
 *   a window's `…`, each piece without the whitespace next to a `…`, which
 *   may be the ` … ` join's own space), and the row holding it names the
 *   line; a piece is then verbatim from the line, so the one place `old` sits
 *   on the line is a place the model was shown;
 * - `old` must occur exactly once on that FULL file line, and every construct
 *   is read off the full line, never off `old` re-parsed: two stray backticks
 *   inside `old` can mask a live link;
 * - `old` must neither cut into nor lie inside a link of any kind (wikilink,
 *   markdown link, autolink, bare URL, reference link or definition, a
 *   `[…]` that may be a shortcut reference), a code span or an HTML/MDX tag
 *   or comment; an element whose open and close tags are both on the line,
 *   and emphasis (`**`, `*`, `__`, `_`, `~~`), it may lie inside or hold
 *   whole, never hold just one delimiter of;
 * - the replacement is one line of at most `EDIT_TEXT_CAP` characters;
 * - on the edited line, every link, code span and tag outside the
 *   replacement stays as it was, and none straddles the replacement's edge;
 * - inside the replacement, the links are exactly the ones `old` holds, as
 *   written (both variants: adding one is new content, dropping one
 *   de-links the page); no HTML/MDX tag or comment, nor a `<` that could
 *   open one (any `<` on an `.mdx` page); no `{`/`}` outside code on an
 *   `.mdx` page (an MDX expression);
 * - the line starts the same way (fence, heading, quote, list, rule, table,
 *   tag), and a table row keeps its `|` count;
 * - on a front-matter line the YAML parses before and after, and a value
 *   holds the replacement verbatim (no `#` comment cut, no `[` flow list).
 */
import { parseDocument } from "yaml";
import { lineCodeSpanRanges, maskLineCodeSpans } from "../format/code-spans.ts";
import { frontmatterBodyLine, splitFrontmatter } from "./page-text.ts";
import { EDIT_TEXT_CAP, linkingPassageRows } from "./stale-confirm.ts";
import { lineLinks, linkPassagesIn, statusLineCandidates } from "./stale.ts";
import { normalizeRelPath } from "./rel-path.ts";
import type { WikiIndex } from "./store.ts";

export type StaleFixKind = "status-line" | "passage";
export type StaleFixVariant = "new" | "home";

/** One drafted edit, as Apply places it and a Stale check proposal stores it. */
export interface StaleFixEdit {
  kind: StaleFixKind;
  /** The page the edit writes. */
  page: string;
  /** A passage edit: the changed page. A status-line edit: the target plan. */
  link: string;
  old: string;
  /** The replacement: the chosen variant's text. */
  text: string;
  variant: StaleFixVariant;
  /** The verdict's reason, for the card and the log. */
  reason?: string;
}

export const STALE_FIX_NOT_IN_PASSAGE = "The text to replace is no longer in the passage exactly once.";
export const STALE_FIX_NOT_ON_LINE = "The text to replace is no longer on its line exactly once.";
export const STALE_FIX_CUTS_LINK = "The edit would cut a link.";
export const STALE_FIX_CUTS_CODE = "The edit would cut a code span.";
export const STALE_FIX_CUTS_TAG = "The edit would cut an HTML or MDX tag.";
export const STALE_FIX_CUTS_EMPHASIS = "The edit would cut an emphasis marker.";
export const STALE_FIX_BAD_TEXT = `The replacement must differ from the old text and be one line of at most ${EDIT_TEXT_CAP} characters.`;
export const STALE_FIX_HOME_DROPS_LINK = "The point-to-the-home text drops a link the old text holds.";
export const STALE_FIX_DROPS_LINK = "The replacement drops a link the old text holds.";
export const STALE_FIX_ADDS_LINK = "The replacement adds a link, or changes a link next to it.";
export const STALE_FIX_TEXT_CODE = "The replacement changes a code span next to it.";
export const STALE_FIX_TEXT_TAG = "The replacement adds an HTML or MDX tag or comment.";
export const STALE_FIX_TEXT_MDX_EXPR = "The replacement adds a { or } outside code on an MDX page.";
export const STALE_FIX_TEXT_BLOCK = "The replacement changes how its line starts, or a table row's cells.";
export const STALE_FIX_FRONTMATTER = "The replacement would change the front matter's YAML beyond the text.";

export type StalePlaceResult = { ok: true; content: string; line: number } | { ok: false; reason: string };

type Span = { start: number; end: number };

const occurrences = (hay: string, needle: string) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
};

/** Does `[s, e)` cut into, or lie inside, `[a, b)`? Holding all of it is fine. */
const cuts = (s: number, e: number, a: number, b: number) => a < e && b > s && !(s <= a && b <= e);

/** `s` with each span overwritten by `fill`, length-preserving. */
function blank(s: string, spans: readonly Span[], fill: string): string {
  let out = s;
  for (const x of spans) out = out.slice(0, x.start) + fill.repeat(x.end - x.start) + out.slice(x.end);
  return out;
}

const spansOf = (s: string, re: RegExp): Span[] => [...s.matchAll(re)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));

// ── The constructs on one line, one helper per class ────────────────────────

const AUTOLINK_RE = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s@<>]+@[^\s@<>]+)>/g;
const BARE_URL_RE = /(?:\b[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/|\bwww\.)[^\s<>]*/g;
const REF_LINK_RE = /\[[^[\]\n]*\]\[[^[\]\n]*\]/g;
const REF_DEF_RE = /^ {0,3}\[[^\]\n]+\]:.*$/g;
const BRACKET_RE = /\[[^[\]\n]*\]/g;

/**
 * Every link on `line`, of any kind, as spans on it: wikilinks and markdown
 * links (`lineLinks`), autolinks, bare URLs, reference links, a reference
 * definition (the whole line) and any other `[…]` (it may be a shortcut
 * reference). Code spans are masked first. Each class is blanked before the
 * next is read, so a URL inside a markdown link is one link, not two.
 */
export function lineLinkSpans(line: string): Span[] {
  let m = maskLineCodeSpans(line);
  const out: Span[] = [];
  const take = (spans: Span[]) => {
    out.push(...spans);
    m = blank(m, spans, "\u0001");
  };
  take(lineLinks(m));
  for (const re of [AUTOLINK_RE, BARE_URL_RE, REF_DEF_RE, REF_LINK_RE, BRACKET_RE]) take(spansOf(m, re));
  return out.sort((a, b) => a.start - b.start);
}

const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
const TAG_RE = /<\/?[A-Za-z][^<>]*(?:>|$)|<[!?][^<>]*(?:>|$)/g;

/** Every HTML/MDX tag or comment on `line` (an unclosed one runs to the
 *  line's end), read with code spans and links blanked. */
export function lineTagSpans(line: string): Span[] {
  let m = blank(maskLineCodeSpans(line), lineLinkSpans(line), "\u0001");
  const comments = spansOf(m, COMMENT_RE);
  m = blank(m, comments, "\u0001");
  return [...comments, ...spansOf(m, TAG_RE)].sort((a, b) => a.start - b.start);
}

/** A delimited span — emphasis, or an element's open and close tags — and
 *  the lengths of its two delimiters. */
type Pair = Span & { open: number; close: number };
const EMPHASIS_RES: [RegExp, number][] = [
  [/\*\*(?=\S)[\s\S]*?\S\*\*/g, 2],
  [/(?<![A-Za-z0-9_])__(?=\S)[\s\S]*?\S__(?![A-Za-z0-9_])/g, 2],
  [/~~(?=\S)[\s\S]*?\S~~/g, 2],
  [/(?<!\*)\*(?![\s*])[^*]*?(?<![\s*])\*(?!\*)/g, 1],
  [/(?<![A-Za-z0-9_])_(?![\s_])[^_]*?(?<![\s_])_(?![A-Za-z0-9_])/g, 1],
];

/** Every emphasis span on `line` (bold, italic, strikethrough), read with
 *  code spans, links and tags overwritten by a plain letter so a link inside
 *  bold text keeps the bold whole and a URL's `_` opens nothing. */
export function lineEmphasisSpans(line: string): Pair[] {
  const m = blank(line, [...lineCodeSpanRanges(line), ...lineLinkSpans(line), ...lineTagSpans(line)], "x");
  return EMPHASIS_RES.flatMap(([re, delim]) => spansOf(m, re).map((s) => ({ ...s, open: delim, close: delim })));
}

/** Every element on `line` whose open and close tags are both on it: an
 *  open tag (not `/>`) paired with the next close tag of its name. */
export function lineElementSpans(line: string): Pair[] {
  const out: Pair[] = [];
  const open: { name: string; tag: Span }[] = [];
  for (const t of lineTagSpans(line)) {
    const m = /^<(\/?)([A-Za-z][\w.:-]*)/.exec(line.slice(t.start, t.end));
    if (!m || line.slice(t.start, t.end).endsWith("/>")) continue;
    if (!m[1]) open.push({ name: m[2]!, tag: t });
    else {
      const k = open.map((o) => o.name).lastIndexOf(m[2]!);
      if (k < 0) continue;
      const o = open[k]!.tag;
      open.splice(k);
      out.push({ start: o.start, end: t.end, open: o.end - o.start, close: t.end - t.start });
    }
  }
  return out;
}

/** Does `[s, e)` cut a delimiter of `x`? Lying inside its text, holding it
 *  whole or missing it is fine. */
const cutsPair = (s: number, e: number, x: Pair) => cuts(s, e, x.start, x.end) && !(x.start + x.open <= s && e <= x.end - x.close);

/**
 * Why `old` may not be replaced on `line` (a full file line), or null.
 * Every construct comes off the full line.
 */
export function oldOnLineRefusal(line: string, old: string): string | null {
  if (!old || occurrences(line, old) !== 1) return STALE_FIX_NOT_ON_LINE;
  const at = line.indexOf(old);
  const end = at + old.length;
  if (lineLinkSpans(line).some((l) => cuts(at, end, l.start, l.end))) return STALE_FIX_CUTS_LINK;
  if (lineCodeSpanRanges(line).some((r) => cuts(at, end, r.start, r.end))) return STALE_FIX_CUTS_CODE;
  if (lineTagSpans(line).some((t) => cuts(at, end, t.start, t.end))) return STALE_FIX_CUTS_TAG;
  if (lineElementSpans(line).some((x) => cutsPair(at, end, x))) return STALE_FIX_CUTS_TAG;
  if (lineEmphasisSpans(line).some((x) => cutsPair(at, end, x))) return STALE_FIX_CUTS_EMPHASIS;
  return null;
}

/** The links `old` holds on `line`, as written: each whole link span the full
 *  line has inside `old`'s position. */
export function linksHeldOnLine(line: string, old: string): string[] {
  const at = line.indexOf(old);
  if (at < 0) return [];
  const end = at + old.length;
  return lineLinkSpans(line)
    .filter((l) => at <= l.start && l.end <= end)
    .map((l) => line.slice(l.start, l.end));
}

// ── The replacement, checked on the edited line ─────────────────────────────

/**
 * Do the spans outside the edit stay as they were? `before` are the spans
 * of the line, `after` those of the edited line, where `[at, at + oldLen)`
 * became `[at, at + textLen)`. Spans past the edit shift by the length
 * change; a span of `after` that straddles the replacement's edge fails.
 */
function outsideKept(before: readonly Span[], after: readonly Span[], at: number, oldLen: number, textLen: number): boolean {
  const key = (s: Span) => `${s.start}:${s.end}`;
  const shift = textLen - oldLen;
  const was = before
    .filter((s) => s.end <= at || s.start >= at + oldLen)
    .map((s) => (s.start >= at + oldLen ? { start: s.start + shift, end: s.end + shift } : s))
    .map(key);
  const textEnd = at + textLen;
  if (after.some((s) => cuts(at, textEnd, s.start, s.end))) return false;
  const now = after.filter((s) => s.end <= at || s.start >= textEnd).map(key);
  return was.length === now.length && was.every((k, i) => k === now[i]);
}

/** Does `a` hold a string `b` does not, counted as multisets? */
function missing(a: readonly string[], b: readonly string[]): boolean {
  const have = new Map<string, number>();
  for (const s of b) have.set(s, (have.get(s) ?? 0) + 1);
  for (const s of a) {
    const n = have.get(s) ?? 0;
    if (n === 0) return true;
    have.set(s, n - 1);
  }
  return false;
}

/** The links a span of `line` holds whole, as written. */
const linksWithin = (line: string, spans: readonly Span[], s: number, e: number) =>
  spans.filter((l) => s <= l.start && l.end <= e).map((l) => line.slice(l.start, l.end));

/** The line's block-level start: a fence, heading, quote, list marker,
 *  rule or setext underline, table pipe, tag, or an MDX import/export/brace. */
const BLOCK_START = /^ {0,3}(?:`{3,}|~{3,}|#{1,6}(?=\s|$)|>|(?:[-*_][ \t]*){3,}$|=+[ \t]*$|[-*+](?=\s|$)|\d{1,9}[.)](?=\s|$)|\||<|\{|import\s|export\s)/;
const blockStart = (line: string) => BLOCK_START.exec(line)?.[0].trim() ?? "";

/**
 * Why the edited line `after` (where `old` at `at` on `line` became `text`)
 * may not be written, or null: links, code spans and tags outside the
 * replacement unchanged; inside it exactly `old`'s links and no tag; no MDX
 * brace on an `.mdx` page; the same line start.
 */
function textOnLineRefusal(line: string, at: number, old: string, text: string, after: string, edit: StaleFixEdit): string | null {
  const textEnd = at + text.length;
  // Code first: a code span that moves masks or unmasks the links around it.
  if (!outsideKept(lineCodeSpanRanges(line), lineCodeSpanRanges(after), at, old.length, text.length)) return STALE_FIX_TEXT_CODE;
  const linksBefore = lineLinkSpans(line);
  const linksAfter = lineLinkSpans(after);
  if (!outsideKept(linksBefore, linksAfter, at, old.length, text.length)) return STALE_FIX_ADDS_LINK;
  const held = linksWithin(line, linksBefore, at, at + old.length);
  const kept = linksWithin(after, linksAfter, at, textEnd);
  if (missing(kept, held)) return STALE_FIX_ADDS_LINK;
  if (missing(held, kept)) return edit.variant === "home" ? STALE_FIX_HOME_DROPS_LINK : STALE_FIX_DROPS_LINK;
  const mdx = edit.page.toLowerCase().endsWith(".mdx");
  // The replacement with its code spans and links blanked: what is left is
  // where a tag or an MDX expression could start.
  const bare = blank(maskLineCodeSpans(after), linksAfter, "\u0001").slice(at, textEnd);
  if (/<[A-Za-z/!?]/.test(bare) || (mdx && bare.includes("<"))) return STALE_FIX_TEXT_TAG;
  if (!outsideKept(lineTagSpans(line), lineTagSpans(after), at, old.length, text.length)) return STALE_FIX_TEXT_TAG;
  if (mdx && /[{}]/.test(bare)) return STALE_FIX_TEXT_MDX_EXPR;
  if (blockStart(after) !== blockStart(line)) return STALE_FIX_TEXT_BLOCK;
  // On a table row a `|` is a cell border.
  if (blockStart(line) === "|" && occurrences(text, "|") !== occurrences(old, "|")) return STALE_FIX_TEXT_BLOCK;
  return null;
}

/** Every string a parsed YAML value holds, at any depth. */
function yamlStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(yamlStrings);
  if (v && typeof v === "object") return Object.values(v).flatMap(yamlStrings);
  return [];
}
/**
 * Does an edit on a front-matter line keep the YAML whole? Both front
 * matters parse without error, and some string value of the edited one holds
 * the replacement verbatim — a ` #` that turns the rest of the value into a
 * comment, or a `[` that turns it into a list, fails that. (A one-line edit
 * cannot add a key without a parse error, nor move the closing fence without
 * changing how its line starts.)
 */
function frontmatterKept(before: string, after: string, text: string): boolean {
  const [fb, fa] = [splitFrontmatter(before).frontmatter, splitFrontmatter(after).frontmatter];
  if (fb === null || fa === null) return false;
  const [db, da] = [parseDocument(fb), parseDocument(fa)];
  if (db.errors.length || da.errors.length) return false;
  const want = text.trim();
  return !want || yamlStrings(da.toJS()).some((s) => s.includes(want));
}

/** The verbatim pieces of a window row: the row split at `…`, each piece
 *  without the whitespace next to a `…` — that may be the ` … ` join's own
 *  space, which the line does not hold there. */
function windowPieces(row: string): string[] {
  const parts = row.split("…");
  return parts.map((p, i) => {
    let s = i > 0 ? p.trimStart() : p;
    if (i < parts.length - 1) s = s.trimEnd();
    return s;
  });
}

/** The rows an edit is placed against, recomputed from `content`: a passage
 *  edit's claim rows (else every passage line) on its changed page, or the
 *  status-line candidates for its target, one per line. */
export function staleFixRows(content: string, edit: Pick<StaleFixEdit, "kind" | "page" | "link">, index: Pick<WikiIndex, "resolve">): { line: number; text: string }[] {
  if (edit.kind === "passage") return linkingPassageRows({ passages: linkPassagesIn(content, edit.page, edit.link, index) });
  const want = normalizeRelPath(edit.link);
  const seen = new Set<number>();
  const out: { line: number; text: string }[] = [];
  for (const c of statusLineCandidates(content)) {
    const t = index.resolve(c.target);
    if (!t || normalizeRelPath(t.relPath) !== want || seen.has(c.line)) continue;
    seen.add(c.line);
    out.push({ line: c.line, text: c.text });
  }
  return out;
}

/** Place one edit on `content`, or say why it does not place. */
export function placeStaleEdit(content: string, edit: StaleFixEdit, index: Pick<WikiIndex, "resolve">): StalePlaceResult {
  // A blank `old` would never place, and `indexOf("", i)` never moves past
  // the end, so the count loop below would not end.
  if (!edit.old.trim()) return { ok: false, reason: STALE_FIX_NOT_IN_PASSAGE };
  if (edit.text === edit.old || edit.text.length > EDIT_TEXT_CAP || /[\r\n]/.test(edit.text)) return { ok: false, reason: STALE_FIX_BAD_TEXT };
  const rows = staleFixRows(content, edit, index);
  let found: number | null = null;
  let n = 0;
  for (const r of rows) for (const piece of windowPieces(r.text)) for (let at = piece.indexOf(edit.old); at >= 0; at = piece.indexOf(edit.old, at + 1)) (n++, (found = r.line));
  if (n !== 1 || found === null) return { ok: false, reason: STALE_FIX_NOT_IN_PASSAGE };
  const raw = content.split("\n");
  const rawLine = raw[found - 1];
  if (rawLine === undefined) return { ok: false, reason: STALE_FIX_NOT_IN_PASSAGE };
  // The index counts lines with CRLF folded; the CR stays on the line we write.
  const cr = rawLine.endsWith("\r") ? "\r" : "";
  const line = cr ? rawLine.slice(0, -1) : rawLine;
  const refused = oldOnLineRefusal(line, edit.old);
  if (refused) return { ok: false, reason: refused };
  const at = line.indexOf(edit.old);
  const after = line.slice(0, at) + edit.text + line.slice(at + edit.old.length);
  const textRefused = textOnLineRefusal(line, at, edit.old, edit.text, after, edit);
  if (textRefused) return { ok: false, reason: textRefused };
  raw[found - 1] = after + cr;
  const out = raw.join("\n");
  const folded = (s: string) => s.replace(/\r\n/g, "\n");
  if (found - 1 < frontmatterBodyLine(folded(content)) && !frontmatterKept(folded(content), folded(out), edit.text)) return { ok: false, reason: STALE_FIX_FRONTMATTER };
  return { ok: true, content: out, line: found };
}

/** Place `edits` in order, each against the content the ones before it left.
 *  An edit that does not place is dropped with its reason. */
export function applyStaleEdits(
  content: string,
  edits: readonly StaleFixEdit[],
  index: Pick<WikiIndex, "resolve">,
): { content: string; applied: StaleFixEdit[]; dropped: { edit: StaleFixEdit; reason: string }[] } {
  let out = content;
  const applied: StaleFixEdit[] = [];
  const dropped: { edit: StaleFixEdit; reason: string }[] = [];
  for (const e of edits) {
    const r = placeStaleEdit(out, e, index);
    if (r.ok) {
      out = r.content;
      applied.push(e);
    } else dropped.push({ edit: e, reason: r.reason });
  }
  return { content: out, applied, dropped };
}

/** Two edits are one when they replace the same text the same way on one page. */
export const sameStaleEdit = (a: StaleFixEdit, b: StaleFixEdit) => a.kind === b.kind && a.page === b.page && a.link === b.link && a.old === b.old;
