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
const COUNT_WORDS: ReadonlySet<string> = new Set(["antall", "count", "n", "total", "totalt", "sum", "number"]);
/** `of`/`av` count only as the whole header (a funnel's `Av`, a gate's `Of`);
 *  beside other words they join two nouns (`Year of release`, `År av vedtak`,
 *  `Number of the year`), and the header counts nothing. */
const JOIN_WORDS: ReadonlySet<string> = new Set(["av", "of"]);
function countsHeader(words: readonly string[]): boolean {
  if (words.length === 1 && JOIN_WORDS.has(words[0]!)) return true;
  return !words.some((w) => JOIN_WORDS.has(w)) && words.some((w) => COUNT_WORDS.has(w));
}

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
    const counts = countsHeader(headerWords(header));
    if (!counts && vals.every((v) => YEAR_RE.test(numberCore(v)))) continue;
    out.add(c);
  }
  return out;
}

/** A number cell's rendered HTML with the number itself, when it holds a
 *  space (`12 345`, `3.2 s`), in a `num-nw` span the CSS keeps on one line,
 *  inside any leading `<strong>`/`<em>`/`<a>`/`<code>` (a bold totals row);
 *  the note after it and the header still wrap at phone width. Any other
 *  cell (no space in the number) unchanged. */
export function numberCellHtml(html: string): string {
  const m = /^((?:\s|<(?:strong|em|a|code)\b[^>]*>)*)([^<(]*?[^\s<(])(?=\s*(?:\(|<|$))/u.exec(html);
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
 *  warning glyph goes into a `v-glyph` span hidden in flow with `font-size: 0`
 *  (screen readers and copy keep it; the CSS draws the round icon), which
 *  keeps a selection reading `✅ text` as the source does. The space after it
 *  sits outside the span only so the gap after the icon stays visible. A
 *  traffic light's cell is returned unchanged: its glyph stays
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
 *  `:`, `—` or `–` with white space after it (the prototype's separator, so
 *  `**2024**–25` is no label), with text after it. A separator after a
 *  punctuated label (`**Label.**: x`) is still the separator, never the text;
 *  a mark with no space after it, or one that would leave no text
 *  (`**Owner:** —`, `**Port:** :3010`), is the text. Deliberately unlike the
 *  prototype, which strips leading `:.—–` before its has-text check and so
 *  leaves a list with `**Owner:** —` as bullets: here that item is a grid
 *  row with value `—`. Null otherwise. */
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

/** The longest label a grid takes, in code points of its visible text with
 *  its `:`/`.` (the prototype's cap, `leadable` in `proto.js`, which counts
 *  `textContent.length`). Longer reads as a finding list, not a key/value
 *  one. How many lines a label takes in the 26% column depends on the width:
 *  a 66-character label took two at 1440 px and three at 900 px. */
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

// ── Before → after chips ────────────────────────────────────────────────────

/** One number as a chip side writes it: a digit, then digits and `,`/`.`
 *  ending in a digit (`1,066`, `10.5`; `6.` at a sentence end stops at `6`).
 *  `parseCellNumberParts` then decides what reads as a number (`1.2.3` does
 *  not). */
const CHIP_PLAIN = String.raw`\d(?:[\d,.]*\d)?`;
/** Groups of three after a space (`12 345`, `−2 480`). */
const CHIP_GROUPED = String.raw`\d{1,3}(?:[ \u00A0\u202F]\d{3})+(?:[.,]\d+)?`;
/** A range of two plain numbers (`3–5`, `3-5`), a grouped number or a plain
 *  one. A range end is never grouped: `101–160 762.2` is a range, then a
 *  number. */
const CHIP_NUM = `(?:${CHIP_PLAIN}[–-]${CHIP_PLAIN}|${CHIP_GROUPED}|${CHIP_PLAIN})`;
/** The space before a unit: a space or a no-break space (U+00A0, U+202F). */
const CHIP_USP = String.raw`[ \u00A0\u202F]`;
/** A unit token: letters, `%` or `×`, and an optional `/` and letters (`MB/s`). */
const CHIP_UNIT = String.raw`[\p{L}%×]+(?:\/\p{L}+)?`;
/** One side: an optional `~`/`≈`, sign and currency sign, the number, then an
 *  optional unit token (glued, or after one space) that {@link chipUnit} vets. */
const CHIP_SIDE = String.raw`(?:[~≈] ?)?[-+−]?[$€£]?${CHIP_NUM}(?:${CHIP_USP}?${CHIP_UNIT})?`;
/** The arrow as escaped text holds it: `→`, or `->` escaped to `-&gt;`, with
 *  at most one space or no-break space on each side. */
const CHIP_ARROW = String.raw`[ \u00A0]?(?:→|-&gt;)[ \u00A0]?`;
/** A side, then one or more arrow + side (`a → b → c` is one chip). Not after
 *  a letter, a digit or `#.,:/_-–` (`v1.2`, `#810`, `2026-11`, `x-3`); not
 *  before a letter or digit, nor before `.,:/-–` and a digit (`1.2.3`,
 *  `10:30`, `2026-11-08`). {@link chipBlocked} reads the text around it. */
const CHIP_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}#.,:/_\-–])${CHIP_SIDE}(?:${CHIP_ARROW}${CHIP_SIDE})+(?![\p{L}\p{N}])(?![.,:/\-–]\d)`,
  "gu",
);
const CHIP_ARROW_SPLIT = new RegExp(`(${CHIP_ARROW})`, "u");
/** One side split: lead marks, the number (a range: both ends), the space
 *  before the unit, and the unit token. */
const CHIP_SIDE_PARTS = new RegExp(
  String.raw`^((?:[~≈] ?)?[-+−]?[$€£]?)(?:(${CHIP_PLAIN})[–-](${CHIP_PLAIN})|(${CHIP_GROUPED}|${CHIP_PLAIN}))(${CHIP_USP}?)((?:${CHIP_UNIT})?)$`,
  "u",
);
/** Units taken only glued: a lone letter after a space is a word (`5 → 6 x`). */
const CHIP_GLUED_ONLY: ReadonlySet<string> = new Set(["x", "t", "d", "k", "K", "M"]);

/** What a rate's `/…` may be: a unit or a span of time (`MB/s`, `kr/mnd`);
 *  `s/claim` is no rate. */
const CHIP_PER: ReadonlySet<string> = new Set([...NUM_UNITS, "day", "dag", "døgn", "uke", "week", "mnd", "month", "år", "year", "run"]);

/** True when `unit`, written after a number (after a space when `spaced`),
 *  is a unit: {@link NUM_UNITS}, a count word, or `pp`; a rate when its
 *  first part is one and its `/…` is in {@link CHIP_PER}. */
function chipUnit(unit: string, spaced: boolean): boolean {
  const slash = unit.indexOf("/");
  if (slash > 0) return CHIP_PER.has(unit.slice(slash + 1)) && chipUnit(unit.slice(0, slash), spaced);
  if (spaced && CHIP_GLUED_ONLY.has(unit)) return false;
  return NUM_UNITS.has(unit) || unit === "pp" || NUM_WORDS.has(unit.toLowerCase());
}

/** A hyphen range that is a date: month and day (`10-29`) or year and month
 *  (`2025-09`). An en dash range (`10–12`) stays a range. */
const DATE_RANGE_RE = /^(?:\d{2}|(?:19|20)\d{2})-\d{2}$/;
/** A day and month with the month's zero optional (`1.1`): a date only next
 *  to a side {@link DAY_MONTH_RE} reads as one (`24.12 → 1.1`). */
const DAY_MONTH_LOOSE_RE = /^(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])$/;

type ChipSide = { bare: boolean; dayMonth: boolean; dayMonthLoose: boolean; integer: boolean; grouped: boolean };

/** One side as the chip reads it: null unless a number (or a range) with an
 *  optional unit, and not a padded id or date (`006`, `08.11`, `08-24`), a
 *  hyphen date range ({@link DATE_RANGE_RE}) or a 6+-digit id; `bare` with no
 *  unit; `dayMonth` when the number reads as a day and month (`15.09`). */
function chipSide(side: string): ChipSide | null {
  const m = CHIP_SIDE_PARTS.exec(side);
  if (!m) return null;
  const [, , lo, hi, one, space, unit] = m;
  const ends = one !== undefined ? [one] : [lo!, hi!];
  if (ends.some((e) => parseCellNumberParts(e) === null || /^0\d/.test(e) || LONG_ID_RE.test(e))) return null;
  if (one === undefined && side.includes(`${lo}-${hi}`) && DATE_RANGE_RE.test(`${lo}-${hi}`)) return null;
  if (unit ? !chipUnit(unit, space !== "") : space) return null;
  return {
    bare: !unit,
    dayMonth: one !== undefined && DAY_MONTH_RE.test(one),
    dayMonthLoose: one !== undefined && DAY_MONTH_LOOSE_RE.test(one),
    integer: one !== undefined && /^[\d \u00A0\u202F]+$/.test(one),
    grouped: one !== undefined && /[ \u00A0\u202F]/.test(one),
  };
}

/** A candidate chain's sides and the arrows between them; null when a side
 *  is no number ({@link chipSide}) or every side is a bare day and month, one
 *  of them with a two-digit month (`15.09 → 16.09`, `24.12 → 1.1`). */
export function beforeAfterParts(text: string): { sides: string[]; arrows: string[] } | null {
  const chain = readChain(text);
  return chain && { sides: chain.sides, arrows: chain.arrows };
}

function readChain(text: string): { sides: string[]; arrows: string[]; read: ChipSide[] } | null {
  const parts = text.split(CHIP_ARROW_SPLIT);
  const sides = parts.filter((_, k) => k % 2 === 0);
  const arrows = parts.filter((_, k) => k % 2 === 1);
  const read = sides.map(chipSide);
  if (read.some((r) => r === null)) return null;
  const ok = read as ChipSide[];
  if (ok.every((r) => r.bare && r.dayMonthLoose) && ok.some((r) => r.dayMonth)) return null;
  return { sides, arrows, read: ok };
}

/** A word that makes the bare integers after it positions, not values: PR,
 *  phase or step numbers and an order (`PR 1 → 2`, `Reasonable order: 4 → 1 →
 *  5`, `strict 1→2→3`); one more word before a colon is allowed (`Final order
 *  shipped:`). `rows` and `PRs went` stay values (`rows 3 → 133`). */
const ORDER_WORD_RE =
  /(?:^|[^\p{L}\p{N}_])(?:order|ordered|sequence|sequencing|sequentially|serially|strict|round|PRs?|phase|fase|steps?|steg|row)(?: \p{L}+:)?[\s:,;(—–-]*$/iu;
/** A word that makes the number after it a version: `Opus 4.6 → 429` is a
 *  model and a status code, `version 1.2 → 1.3` a release. */
const VERSION_WORD_RE =
  /(?:^|[^\p{L}\p{N}_])(?:versions?|versjon(?:en|er)?|release|Opus|Sonnet|Haiku|Fable|Claude|GPT|Gemini|CDM)\s*:?\s*$/iu;
/** Text that glues to the number after it: a letter, a digit or `#.,:/_-–*`
 *  ({@link CHIP_RE}'s lookbehind, across a tag or a parked code span). */
const GLUED_RE = /[\p{L}\p{N}#.,:/_\-–*]$/u;
/** A bound before the first value: `≥3 → 260` is a threshold and a count. */
const BOUND_RE = /(?:[≥≤±]|&[lg]t;) ?$/u;
/** An arrow with a value on its far side, glued to a chip's start or end: the
 *  chain goes on past a side that is no number (`a → 5 → 6`, `1 → 2 → v3`). */
const ARROW_BEFORE_RE = new RegExp(String.raw`\S${CHIP_ARROW}$`, "u");
const ARROW_AFTER_RE = new RegExp(String.raw`^${CHIP_ARROW}\S`, "u");

/** Why a candidate chain draws no chip, from the text around it: glued to a
 *  word or code span, after a bound, a version word or (bare integers only)
 *  an order word, or one link of a longer chain. `before` is the visible text
 *  before it (earlier runs included), `run` the text before it in its own
 *  run, `after` the text after it in its run. */
function chipBlocked(read: ChipSide[], before: string, run: string, after: string): boolean {
  if (GLUED_RE.test(before) || BOUND_RE.test(before) || VERSION_WORD_RE.test(before)) return true;
  if (ARROW_BEFORE_RE.test(run) || ARROW_AFTER_RE.test(after)) return true;
  return read.every((r) => r.bare && r.integer) && ORDER_WORD_RE.test(before);
}

/** The before → after numbers in one run of escaped text as chips: every
 *  value before the last soft (`ba-old`), each arrow in the accent (`ba-arr`),
 *  the last value bold (`ba-new`). The spans hold the source characters and
 *  nothing else (an arrow's spaces sit between them), so what shows and what
 *  a selection copies is the source text. */
function chipText(text: string, earlier: string): string {
  return text.replace(CHIP_RE, (whole: string, at: number) => chipOne(whole, earlier + text.slice(0, at), text.slice(0, at), text.slice(at + whole.length)));
}

/** One candidate chain as a chip, or as it came when it is none. */
function chipOne(whole: string, before: string, run: string, after: string): string {
  let p = readChain(whole);
  let tail = "";
  // A word after the last value that is no unit (`1 → 2 b`, `5 → 6 x`) is
  // the sentence's, not the chip's: read the chain without it.
  const spacedWord = p ? null : new RegExp(`${CHIP_USP}${CHIP_UNIT}$`, "u").exec(whole);
  if (spacedWord) {
    tail = spacedWord[0];
    p = readChain(whole.slice(0, -tail.length));
  }
  if (!p) return whole;
  // `row 1 315→179px`: a grouped first value after an order word is the
  // position and the value (`1` + `315`), not 1,315.
  const lead = p.read[0]!.grouped && ORDER_WORD_RE.test(before) ? /^\d{1,3}[ \u00A0\u202F]/u.exec(whole) : null;
  if (lead) return lead[0] + chipOne(whole.slice(lead[0].length), before + lead[0], run + lead[0], after);
  if (chipBlocked(p.read, before, run, tail + after)) return whole;
  const { sides, arrows } = p;
  const spans = sides.map((side, k) => {
    if (k === sides.length - 1) return `<span class="ba-new">${side}</span>`;
    const a = /^(\s?)(\S+)(\s?)$/u.exec(arrows[k]!)!;
    return `<span class="ba-old">${side}</span>${a[1]}<span class="ba-arr">${a[2]}</span>${a[3]}`;
  });
  return `<span class="ba-chip">${spans.join("")}</span>${tail}`;
}

/** Rendered inline HTML with the before → after chips drawn in its text:
 *  never inside a tag (an `href`, an attribute) and never across a parked
 *  placeholder (`\x00…\x00`: inline code, an inline component). */
export function beforeAfterChipsHtml(html: string): string {
  if (!html.includes("→") && !html.includes("-&gt;")) return html;
  // The visible text so far, so a run's first value reads what precedes it
  // across a tag (`<em>v</em>1`); a parked placeholder reads as a letter
  // (`` `v`1.2 ``), a `<br>` as a space.
  let earlier = "";
  return html
    .split(/(<[^>]*>|\x00[^\x00]*\x00)/)
    .map((seg, k) => {
      const out = k % 2 === 1 || (!seg.includes("→") && !seg.includes("-&gt;")) ? seg : chipText(seg, earlier);
      earlier = (earlier + (k % 2 === 0 ? seg : seg.startsWith("\x00") ? "x" : /^<br\b/i.test(seg) ? " " : "")).slice(-48);
      return out;
    })
    .join("");
}
