/**
 * The Stale check's fix paths (plan muninn-wiki-drift-check, PR 3): placing a
 * drafted edit (`old` → `new` or `home`) on the LIVE file.
 *
 * Every write path runs this under its own CAS, inside the per-wiki write
 * queue: Apply (`POST /api/wiki/stale/apply`), Send's redraft
 * (`src/gardener/stale-proposals.ts`) and Accept's preflight (`apply.ts`).
 * The draft was validated when the model answered (`parseStaleAnswer`), but
 * the page may have moved since, so the edit is placed again from scratch:
 *
 * - the windows are RECOMPUTED on the live bytes (the passage rows a Check
 *   reads, or the status-line candidates for the hit's target), never read
 *   from a cached bucket or a stored line number, so a line shift between
 *   draft and apply still lands on the right line;
 * - `old` must occur exactly once across the passage's pieces (rows split at
 *   a window's `…`), and the row holding it names the line;
 * - `old` must occur exactly once on that FULL file line, and its links and
 *   code spans are read off the full line, never off `old` re-parsed: two
 *   stray backticks inside `old` can mask a live link;
 * - it must neither cut into nor lie inside a link or a code span;
 * - the replacement is one line of at most `EDIT_TEXT_CAP` characters, and a
 *   point-to-the-home text keeps every link `old` holds, as written.
 */
import { lineCodeSpanRanges, maskLineCodeSpans } from "../format/code-spans.ts";
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
export const STALE_FIX_BAD_TEXT = `The replacement must differ from the old text and be one line of at most ${EDIT_TEXT_CAP} characters.`;
export const STALE_FIX_HOME_DROPS_LINK = "The point-to-the-home text drops a link the old text holds.";

export type StalePlaceResult = { ok: true; content: string; line: number } | { ok: false; reason: string };

const occurrences = (hay: string, needle: string) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
};

/** Does `[s, e)` cut into, or lie inside, `[a, b)`? Holding all of it is fine. */
const cuts = (s: number, e: number, a: number, b: number) => a < e && b > s && !(s <= a && b <= e);

/**
 * Why `old` may not be replaced on `line` (a full file line), or null.
 * Links and code spans come off the full line.
 */
export function oldOnLineRefusal(line: string, old: string): string | null {
  if (!old || occurrences(line, old) !== 1) return STALE_FIX_NOT_ON_LINE;
  const at = line.indexOf(old);
  const end = at + old.length;
  if (lineLinks(maskLineCodeSpans(line)).some((l) => cuts(at, end, l.start, l.end))) return STALE_FIX_CUTS_LINK;
  if (lineCodeSpanRanges(line).some((r) => cuts(at, end, r.start, r.end))) return STALE_FIX_CUTS_CODE;
  return null;
}

/** The links `old` holds on `line`, as written: each whole link span the full
 *  line has inside `old`'s position. */
export function linksHeldOnLine(line: string, old: string): string[] {
  const at = line.indexOf(old);
  if (at < 0) return [];
  const end = at + old.length;
  return lineLinks(maskLineCodeSpans(line))
    .filter((l) => at <= l.start && l.end <= end)
    .map((l) => line.slice(l.start, l.end));
}

/** Does `text` hold every one of `links`, as often? */
function holdsAll(text: string, links: readonly string[]): boolean {
  const have = new Map<string, number>();
  for (const l of lineLinks(maskLineCodeSpans(text))) {
    const s = text.slice(l.start, l.end);
    have.set(s, (have.get(s) ?? 0) + 1);
  }
  for (const l of links) {
    const n = have.get(l) ?? 0;
    if (n === 0) return false;
    have.set(l, n - 1);
  }
  return true;
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
  if (edit.text === edit.old || edit.text.length > EDIT_TEXT_CAP || /[\r\n]/.test(edit.text)) return { ok: false, reason: STALE_FIX_BAD_TEXT };
  const rows = staleFixRows(content, edit, index);
  let found: number | null = null;
  let n = 0;
  for (const r of rows) for (const piece of r.text.split("…")) for (let at = piece.indexOf(edit.old); at >= 0; at = piece.indexOf(edit.old, at + 1)) (n++, (found = r.line));
  if (n !== 1 || found === null) return { ok: false, reason: STALE_FIX_NOT_IN_PASSAGE };
  const raw = content.split("\n");
  const rawLine = raw[found - 1];
  if (rawLine === undefined) return { ok: false, reason: STALE_FIX_NOT_IN_PASSAGE };
  // The index counts lines with CRLF folded; the CR stays on the line we write.
  const cr = rawLine.endsWith("\r") ? "\r" : "";
  const line = cr ? rawLine.slice(0, -1) : rawLine;
  const refused = oldOnLineRefusal(line, edit.old);
  if (refused) return { ok: false, reason: refused };
  if (edit.variant === "home" && !holdsAll(edit.text, linksHeldOnLine(line, edit.old))) return { ok: false, reason: STALE_FIX_HOME_DROPS_LINK };
  const at = line.indexOf(edit.old);
  raw[found - 1] = line.slice(0, at) + edit.text + line.slice(at + edit.old.length) + cr;
  return { ok: true, content: raw.join("\n"), line: found };
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
