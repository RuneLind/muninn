/**
 * The shapes the wiki reader draws from a page's plain markdown with no tag
 * (plan muninn-wiki-render-richer, D1/D3/D4): a number column in a pipe table,
 * a verdict cell (✅/⚠️/❌ first), and a list whose every item opens with a
 * bold label. `formatWebHtml` asks these only on the reader's render
 * (`opts.reader`), outside the components that draw their own tables and
 * lists, so a chat answer renders as before.
 *
 * Pure and dependency-light: `web-format.ts` ships in the chat bundle.
 */

import { parseCellNumberParts } from "./cell-number.ts";
import { CHART_UNIT_PLURALS } from "./chart-block.ts";
import { FACT_VERDICT_GLYPHS } from "./component-spec.ts";

// ── Number columns ──────────────────────────────────────────────────────────

/** Units a number cell may end in, glued or after a space; compared as written. */
const NUM_UNITS: ReadonlySet<string> = new Set([
  "%", "×", "x", "ms", "s", "sek", "min", "h", "t", "d", "k", "K", "M", "kB", "KB", "MB", "GB", "tokens", "kr", "px", "chars",
  "USD", "EUR", "GBP", "NOK", "SEK", "DKK",
]);
/** Count words (`3 files`, `12 PRs`), compared in any case: the chart's own pairs. */
const NUM_WORDS: ReadonlySet<string> = new Set(CHART_UNIT_PLURALS.flat().map((w) => w.toLowerCase()));

/** Leading marks: an approximation, a bound or a ±, and `ca.`. */
const LEAD_RE = /^(?:[~≈<>≤≥±]|ca\.)\s*/iu;
/** One short trailing parenthesised note: `790 (just lists, no board)`. A
 *  longer one is prose: a column of `~290 (agent skills, ADRs, …)` is text
 *  (measured on the wikis: those right-aligned read as a false positive). */
const TAIL_RE = /\s*\([^()]{0,24}\)\s*$/u;
/** An ungrouped integer of six digits or more is an id (a behandling, a CI
 *  run), not a quantity: every 6–7-digit bare integer in a number column of
 *  the two wikis was a behandling id (PR #832 fix round 1). */
const LONG_ID_RE = /^\d{6,}$/;
/** `1234e56`: an exponent reads as a hash, not a number, in a wiki table. */
const EXPONENT_RE = /\d[eE][+-]?\d/;
/** A day and month (`08.11`, `15.09`). */
const DAY_MONTH_RE = /^(?:0?[1-9]|[12]\d|3[01])\.(?:0[1-9]|1[0-2])$/;
/** A note that is a commit hash: `15.09 (15f7bf5108)` is a date and a commit. */
const HASH_TAIL_RE = /\(\s*(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\s*\)\s*$/u;

/** A cell's text without its short note and leading marks: what the number
 *  rules read. */
function numberCore(text: string): string {
  return text.trim().replace(TAIL_RE, "").trim().replace(LEAD_RE, "");
}

/** True when a cell's visible text reads as one number: an optional `~ ≈ < >
 *  ± ca.`, a sign, a currency sign, the number as `parseCellNumberParts`
 *  reads it (`1,662,435`, `10,3`, `12 345`), a unit from a closed list or a
 *  count word, and an optional short parenthesised note. A range, a date, a
 *  version string, a hash and an id (`#782`, `D7`, `1356583`) are not, nor
 *  is a day and month written with a leading zero (`08.11`) or before a
 *  commit hash (`15.09 (15f7bf5108)`). */
export function isNumberCell(text: string): boolean {
  let t = numberCore(text);
  if (DAY_MONTH_RE.test(t) && (/^0/.test(t) || HASH_TAIL_RE.test(text))) return false;
  t = t.replace(/^[-+−]\s*/u, "");
  t = t.replace(/^[$€£]\s*/u, "");
  if (!/^\d/.test(t) || LONG_ID_RE.test(t) || EXPONENT_RE.test(t)) return false;
  if (parseCellNumberParts(t)) return true;
  const m = /^(.*\d)\s*([^\d\s][^\s]*)$/u.exec(t);
  if (!m) return false;
  const unit = m[2]!;
  if (!NUM_UNITS.has(unit) && !NUM_WORDS.has(unit.toLowerCase())) return false;
  return parseCellNumberParts(m[1]!.trim()) !== null;
}

/** A header's words, its parenthesised note dropped, split at punctuation,
 *  `_` and camelCase, lower-cased: `behandlingsresultat_id` → `…, id`. */
function headerWords(header: string): string[] {
  return header
    .replace(/\([^()]*\)/g, " ")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}#]+/u)
    .filter(Boolean);
}

/** Whole headers that name an id, a date or a position. A verb names a date
 *  only alone: `Merged` holds dates, `PRs merged` a count. */
const ID_HEADERS: ReadonlySet<string> = new Set([
  "#", "id", "ids", "nr", "nr.", "no", "no.", "pr", "år", "year", "dato", "date", "versjon", "version", "port", "line",
  "linje", "rank", "issue", "sak", "run", "uke", "week", "http", "merged", "merget", "landet", "levert", "deployed",
  "deployet", "released", "opened", "closed",
]);
/** A header's last word that names an id or a date: `Behandling ID`, `Aktiv
 *  behandling`, `Merge date`, `Status` (200/500 are codes). */
const ID_LAST_WORDS: ReadonlySet<string> = new Set([
  "id", "ids", "nr", "dato", "date", "versjon", "version", "issue", "sak", "commit", "sha", "hash", "run", "uke", "week",
  "behandling", "uuid", "status", "når", "when", "#",
]);
/** A rate or a qualified count (`Cost per run`, `with trace_id`) is a
 *  quantity whatever its last word names. */
const QUALIFIER_WORDS: ReadonlySet<string> = new Set(["per", "each", "pr", "hver", "with", "without", "med", "uten"]);
/** Count words: their column is a count even when every value falls in 1900–2099. */
const COUNT_WORDS: ReadonlySet<string> = new Set(["antall", "count", "av", "of", "n", "total", "totalt", "sum", "number"]);

/** True when a header names an id, a date or a position (never a number
 *  column): the whole header from {@link ID_HEADERS}, or its last word from
 *  {@link ID_LAST_WORDS} unless an earlier word makes it a rate or a
 *  qualified count. */
export function isIdHeader(header: string): boolean {
  const h = header.trim().toLowerCase();
  if (ID_HEADERS.has(h)) return true;
  const words = headerWords(header);
  if (!words.length) return false;
  if (words.length === 1 && ID_HEADERS.has(words[0]!)) return true;
  if (words.slice(0, -1).some((w) => QUALIFIER_WORDS.has(w))) return false;
  return ID_LAST_WORDS.has(words[words.length - 1]!);
}

/** A lone dash: an empty cell as a table writes it. */
const DASH_RE = /^[—–-]$/u;
const YEAR_RE = /^(?:19|20)\d{2}$/;

/** The columns (after the first) of a table that read as numbers: every
 *  non-empty body cell other than a lone dash is a number cell, at least one
 *  is, the header names no id or date ({@link isIdHeader}), and the column is
 *  not all years (`2026`, `~2026`, `2026 (draft)`) unless the header counts
 *  (`Antall`, `Of`, `Total`). `headers` and `rows` are visible text. */
export function numberColumns(headers: readonly string[], rows: readonly (readonly string[])[]): Set<number> {
  const out = new Set<number>();
  for (let c = 1; c < headers.length; c++) {
    const header = headers[c]!;
    if (isIdHeader(header)) continue;
    const vals = rows.map((r) => (r[c] ?? "").trim()).filter((v) => v !== "" && !DASH_RE.test(v));
    if (!vals.length || !vals.every(isNumberCell)) continue;
    const counts = headerWords(header).some((w) => COUNT_WORDS.has(w));
    if (!counts && vals.every((v) => YEAR_RE.test(numberCore(v)))) continue;
    out.add(c);
  }
  return out;
}

/** A number cell's rendered HTML with the number itself, when it holds a
 *  space (`12 345`, `3.2 s`), in a `num-nw` span the CSS keeps on one line;
 *  the note after it and the header still wrap at phone width. Any other
 *  cell (no space in the number, or a tag first) unchanged. */
export function numberCellHtml(html: string): string {
  const m = /^(\s*)([^<(]*?[^\s<(])(?=\s*(?:\(|<|$))/u.exec(html);
  if (!m || !/\s/u.test(m[2]!)) return html;
  return `${m[1]}<span class="num-nw">${m[2]}</span>${html.slice(m[0].length)}`;
}

// ── Verdict cells ───────────────────────────────────────────────────────────

export type CellVerdict = "good" | "warn" | "bad";

/** The glyphs a verdict cell opens with: the fact-check's three
 *  (`FACT_VERDICT_GLYPHS`) and the check, cross and traffic-light marks.
 *  Read with or without the VS16 (U+FE0F). */
export const CELL_VERDICT_GLYPHS: Readonly<Record<string, CellVerdict>> = {
  ...Object.fromEntries(
    Object.entries(FACT_VERDICT_GLYPHS).flatMap(([g, v]): [string, CellVerdict][] =>
      v === "ok" ? [[g, "good"]] : v === "warn" || v === "bad" ? [[g, v]] : [],
    ),
  ),
  "✔": "good",
  "🟢": "good",
  "⚠": "warn",
  "🟡": "warn",
  "✗": "bad",
  "🔴": "bad",
};

const GLYPH_ALT = [...new Set(Object.keys(CELL_VERDICT_GLYPHS).map((g) => g.replace(/️/g, "")))]
  .sort((a, b) => b.length - a.length)
  .join("|");
/** Leading tags (never a code span) and white space, the glyph, its VS16, then white space. */
const VERDICT_LEAD_RE = new RegExp(`^((?:\\s|<(?!code)[a-z][^>]*>)*)(${GLYPH_ALT})(\\uFE0F?)(\\s*)`, "u");

/** Traffic lights: a priority or a status, not a pass or a fail. Their cell
 *  is tinted but keeps its glyph on screen: drawn as ✕ / ! / ✓, `🔴 Critical`
 *  read as failed (18 of the 34 traffic-light cells in the two wikis sit in
 *  `Priority` columns). */
const TRAFFIC_LIGHTS: ReadonlySet<string> = new Set(["🔴", "🟡", "🟢"]);

/** A rendered cell that opens with a verdict glyph: its tone, whether the
 *  glyph is a traffic light (`light`), and the cell's HTML. A check, cross or
 *  warning glyph goes into a visually hidden `v-glyph` span (screen readers
 *  and copy keep it; the CSS draws the round icon), and the space after it
 *  stays outside the span, in flow, so a selection reads `✅ text` as the
 *  source does. A traffic light's cell is returned unchanged: its glyph stays
 *  visible and draws no icon. Null when the glyph is not first. */
export function verdictCell(html: string): { tone: CellVerdict; light: boolean; html: string } | null {
  const m = VERDICT_LEAD_RE.exec(html);
  if (!m) return null;
  const tone = CELL_VERDICT_GLYPHS[m[2]!] ?? CELL_VERDICT_GLYPHS[`${m[2]!}️`];
  if (!tone) return null;
  if (TRAFFIC_LIGHTS.has(m[2]!)) return { tone, light: true, html };
  const rest = html.slice(m[0].length);
  return { tone, light: false, html: `${m[1]}<span class="v-glyph">${m[2]}${m[3]}</span>${m[4]}${rest}` };
}

// ── Label lists ─────────────────────────────────────────────────────────────

/** An item split at its bold label. `punct` is the `:`/`.` that ends the
 *  label inside the bold; `sep` the `:`/`—`/`–` after the bold (with its
 *  spaces), or only the spaces. */
export interface LabelItem {
  label: string;
  punct: string;
  sep: string;
  rest: string;
}

/** D3: an item that opens `**Label:**` / `**Label.**`, or `**Label**` then
 *  `:`, `—` or `–` with white space after it (the prototype's rule, so
 *  `**2024**–25` is no label), with text after it. A separator after a
 *  punctuated label (`**Label.**: x`) is still the separator, never the text;
 *  a mark with no space after it, or one that would leave no text
 *  (`**Owner:** —`, `**Port:** :3010`), is the text. Null otherwise. */
export function labelItem(item: string): LabelItem | null {
  const m = /^\*\*(?!\*)([^\n]+?)\*\*(?!\*)([\s\S]*)$/u.exec(item);
  if (!m) return null;
  const inner = m[1]!;
  const after = m[2]!;
  const inside = /^([\s\S]*?\S)\s*([:.])$/u.exec(inner);
  const mark = /^\s*[:—–]\s+/u.exec(after)?.[0];
  const sep = mark !== undefined && /\S/.test(after.slice(mark.length)) ? mark : inside ? /^\s*/.exec(after)![0] : null;
  if (sep === null) return null;
  const rest = after.slice(sep.length);
  if (!/\S/.test(rest)) return null;
  return inside
    ? { label: inside[1]!, punct: inside[2]!, sep, rest }
    : { label: inner, punct: "", sep, rest };
}

/** The longest label a grid takes, in visible characters with its `:`/`.`:
 *  the prototype's cap (`leadable`, `proto.js`). Over it a label wraps to
 *  three or more lines in the 26% column, and the list is a finding list,
 *  not a key/value one. */
export const LABEL_MAX_CHARS = 70;

/** The items of a list the reader draws as a label grid: three or more (the
 *  prototype's floor; D3 takes 0 of the 4 bold-label lists on the plans-format
 *  blog, two of which hold only two items), every one a {@link labelItem}
 *  whose label is at most {@link LABEL_MAX_CHARS} long as `labelText` reads
 *  it, none with a nested list. Null otherwise. */
export function labelGridItems(
  items: readonly string[],
  hasNestedList: (k: number) => boolean,
  labelText: (label: string) => string = (l) => l,
): LabelItem[] | null {
  if (items.length < 3) return null;
  const out: LabelItem[] = [];
  for (let k = 0; k < items.length; k++) {
    if (hasNestedList(k)) return null;
    const it = labelItem(items[k]!);
    if (!it) return null;
    if ([...labelText(it.label).trim()].length + it.punct.length > LABEL_MAX_CHARS) return null;
    out.push(it);
  }
  return out;
}

// ── Visible text of a rendered cell ─────────────────────────────────────────

/** Rendered inline HTML as the text a reader sees: tags dropped, the common
 *  entities decoded. */
export function htmlText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
