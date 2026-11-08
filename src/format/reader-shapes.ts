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
/** An ungrouped integer of eight digits or more is an id (a CI run, a commit
 *  count no one writes ungrouped), not a quantity. */
const LONG_ID_RE = /^\d{8,}$/;

/** True when a cell's visible text reads as one number: an optional `~ ≈ < >
 *  ± ca.`, a sign, a currency sign, the number as `parseCellNumberParts`
 *  reads it (`1,662,435`, `10,3`, `12 345`), a unit from a closed list or a
 *  count word, and an optional short parenthesised note. A range, a date, a
 *  version string and an id (`#782`, `D7`, `27305752256`) are not. */
export function isNumberCell(text: string): boolean {
  let t = text.trim().replace(TAIL_RE, "").trim();
  t = t.replace(LEAD_RE, "");
  t = t.replace(/^[-+−]\s*/u, "");
  t = t.replace(/^[$€£]\s*/u, "");
  if (!/^\d/.test(t) || LONG_ID_RE.test(t)) return false;
  if (parseCellNumberParts(t)) return true;
  const m = /^(.*\d)\s*([^\d\s][^\s]*)$/u.exec(t);
  if (!m) return false;
  const unit = m[2]!;
  if (!NUM_UNITS.has(unit) && !NUM_WORDS.has(unit.toLowerCase())) return false;
  return parseCellNumberParts(m[1]!.trim()) !== null;
}

/** Headers that name an id, a date or a position: their column is never a number column. */
const ID_HEADER_RE = /^(?:#|id|ids|nr\.?|no\.?|pr|år|year|dato|date|versjon|version|port|line|linje|rank|issue|sak)$/iu;
/** A lone dash: an empty cell as a table writes it. */
const DASH_RE = /^[—–-]$/u;
const YEAR_RE = /^(?:19|20)\d{2}$/;

/** The columns (after the first) of a table that read as numbers: every
 *  non-empty body cell other than a lone dash is a number cell, at least one
 *  is, the header names no id or date, and the column is not all bare years.
 *  `headers` and `rows` are visible text. */
export function numberColumns(headers: readonly string[], rows: readonly (readonly string[])[]): Set<number> {
  const out = new Set<number>();
  for (let c = 1; c < headers.length; c++) {
    if (ID_HEADER_RE.test(headers[c]!.trim())) continue;
    const vals = rows.map((r) => (r[c] ?? "").trim()).filter((v) => v !== "" && !DASH_RE.test(v));
    if (!vals.length || !vals.every(isNumberCell)) continue;
    if (vals.every((v) => YEAR_RE.test(v))) continue;
    out.add(c);
  }
  return out;
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

/** A rendered cell that opens with a verdict glyph: its tone and the cell with
 *  the glyph in a visually hidden `v-glyph` span (screen readers and copy keep
 *  it; the CSS draws the round icon). The space after the glyph stays outside
 *  the span, in flow, so a selection reads `✅ text` as the source does. Null
 *  when the glyph is not first. */
export function verdictCell(html: string): { tone: CellVerdict; html: string } | null {
  const m = VERDICT_LEAD_RE.exec(html);
  if (!m) return null;
  const tone = CELL_VERDICT_GLYPHS[m[2]!] ?? CELL_VERDICT_GLYPHS[`${m[2]!}️`];
  if (!tone) return null;
  const rest = html.slice(m[0].length);
  return { tone, html: `${m[1]}<span class="v-glyph">${m[2]}${m[3]}</span>${m[4]}${rest}` };
}

// ── Label lists ─────────────────────────────────────────────────────────────

/** An item split at its bold label. `punct` is the `:`/`.` that ends the
 *  label inside the bold; `sep` the `:`/`—` after the bold (with its spaces). */
export interface LabelItem {
  label: string;
  punct: string;
  sep: string;
  rest: string;
}

/** D3: an item that opens `**Label:**` / `**Label.**`, or `**Label**` then
 *  `:` or `—`, with text after it. Null for anything else. */
export function labelItem(item: string): LabelItem | null {
  const m = /^\*\*(?!\*)([^\n]+?)\*\*(?!\*)([\s\S]*)$/u.exec(item);
  if (!m) return null;
  const inner = m[1]!;
  const after = m[2]!;
  const inside = /^([\s\S]*?\S)\s*([:.])$/u.exec(inner);
  if (inside) {
    if (!/\S/.test(after)) return null;
    const sp = /^\s*/.exec(after)![0];
    return { label: inside[1]!, punct: inside[2]!, sep: sp, rest: after.slice(sp.length) };
  }
  const sep = /^(\s*:\s*|\s*—\s*)/u.exec(after);
  if (!sep) return null;
  const rest = after.slice(sep[0].length);
  if (!/\S/.test(rest)) return null;
  return { label: inner, punct: "", sep: sep[0], rest };
}

/** The items of a list the reader draws as a label grid: three or more (the
 *  prototype's floor; D3 takes 0 of the 4 bold-label lists on the plans-format
 *  blog, two of which hold only two items), every one a {@link labelItem},
 *  none with a nested list. Null otherwise. */
export function labelGridItems(items: readonly string[], hasNestedList: (k: number) => boolean): LabelItem[] | null {
  if (items.length < 3) return null;
  const out: LabelItem[] = [];
  for (let k = 0; k < items.length; k++) {
    if (hasNestedList(k)) return null;
    const it = labelItem(items[k]!);
    if (!it) return null;
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
