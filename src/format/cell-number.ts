/**
 * The ONE number reading for a table cell, shared by the `<Query>` table's
 * client sort (`wiki-query-table.ts`) and the `<DeltaTable>` delta, computed
 * server-side (`delta-table.ts`). Dependency-free: the reader bundle carries it.
 */

const NUMBER_RE = /^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?$/;
/** `1 000`, `12 345,5`: groups of three after a space, NBSP or narrow NBSP. */
const SPACE_GROUPED_RE = /^[+-]?\d{1,3}(?:[\u0020\u00A0\u202F]\d{3})+(?:[.,]\d+)?$/;
/** `1,500`, `1,234,567.25`: groups of three after a comma, dot decimals. A
 *  leading `0` group is no thousands group: `0,125` is a decimal. */
const COMMA_GROUPED_RE = /^[+-]?[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/;
/** `1,500` alone: one comma, three digits after it — thousands in an English
 *  table, a decimal in a table that writes decimal commas elsewhere. */
const AMBIGUOUS_COMMA_RE = /^[+-]?[1-9]\d{0,2},\d{3}$/;

/** How a table writes its numbers. `decimalComma`: some cell in the table uses
 *  an unambiguous decimal comma ({@link tableDecimalComma}), so a `1,500` cell
 *  is 1.5, not 1500. */
export type NumberContext = { decimalComma?: boolean };

/** An empty cell, or the NULL spellings a query tool writes (`NULL`, `[NULL]`,
 *  any case): sorted last, and never makes a column text. */
export function isEmptyCell(cell: string): boolean {
  const t = cell.trim();
  return t === "" || /^\[?null\]?$/i.test(t);
}

/** A number as written: its value, the digits after its decimal separator
 *  (the mantissa's, for an exponent form) and whether that separator is a
 *  comma. */
export type CellNumberParts = { n: number; decimals: number; decimalComma: boolean };

/** {@link parseCellNumber} with the decimals and separator it read. */
export function parseCellNumberParts(cell: string, ctx: NumberContext = {}): CellNumberParts | null {
  const raw = cell.trim().replace(/^\u2212/, "-");
  let t: string;
  // Comma thousands are the one shape where a comma is not the decimal mark.
  let commaIsDecimal = raw.includes(",");
  if (SPACE_GROUPED_RE.test(raw)) t = raw.replace(/[\u0020\u00A0\u202F]/g, "").replace(",", ".");
  else if (COMMA_GROUPED_RE.test(raw) && !(ctx.decimalComma && AMBIGUOUS_COMMA_RE.test(raw))) {
    t = raw.replace(/,/g, "");
    commaIsDecimal = false;
  } else if (NUMBER_RE.test(raw)) t = raw.replace(",", ".");
  else return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const frac = /\.(\d+)/.exec(t);
  return { n, decimals: frac ? frac[1]!.length : 0, decimalComma: commaIsDecimal };
}

/** A cell as a number, or null. A leading U+2212 minus is `-`; space- and
 *  comma-grouped thousands read as one number; any other single comma is a
 *  decimal comma (`2,5` is 2.5, `0,125` is 0.125). `1,500` is 1500 unless
 *  `ctx.decimalComma`. */
export function parseCellNumber(cell: string, ctx: NumberContext = {}): number | null {
  return parseCellNumberParts(cell, ctx)?.n ?? null;
}

/** A unit token: letters, `%` or currency symbols (`kr`, `x`, `%`, `NOK`, `€`). */
const UNIT_RE = /^[\p{L}%\p{Sc}]+$/u;

/** A cell's value: the number as {@link CellNumberParts}, and its unit (`""`
 *  for none). */
export type CellValue = CellNumberParts & { unit: string };

/** A cell as (a) a plain number (`unit` ""), (b) a plain number, white space
 *  and ONE unit token, or (c) a number with a glued `%` (`12%`, unit `%`; no
 *  other unit is read glued). Null for anything else. */
export function parseCellValue(cell: string, ctx: NumberContext = {}): CellValue | null {
  const t = cell.trim();
  const p = parseCellNumberParts(t, ctx);
  if (p !== null) return { ...p, unit: "" };
  const glued = /^(.*\d)%$/u.exec(t);
  if (glued) {
    const v = parseCellNumberParts(glued[1]!, ctx);
    return v === null ? null : { ...v, unit: "%" };
  }
  const m = /^(.*\S)\s+(\S+)$/u.exec(t);
  if (!m || !UNIT_RE.test(m[2]!)) return null;
  const v = parseCellNumberParts(m[1]!, ctx);
  return v === null ? null : { ...v, unit: m[2]! };
}

/** True when the cell reads as a number whose comma can only be a decimal
 *  comma: `,d`, `,dd`, `,dddd…`, `0,ddd`, `1 500,5` — every comma decimal but
 *  the `1,500` shape, which is ambiguous on its own. */
export function isUnambiguousDecimalComma(cell: string): boolean {
  const v = parseCellValue(cell);
  if (!v || !v.decimalComma) return false;
  const t = cell.trim().replace(/^\u2212/, "-");
  const num = v.unit ? /^(.*?\d)\s*[\p{L}%\p{Sc}]+$/u.exec(t)?.[1] ?? t : t;
  return !AMBIGUOUS_COMMA_RE.test(num);
}

/** The context for a set of cells (one table, or one column): a decimal comma
 *  when ANY cell writes an unambiguous one. */
export function tableDecimalComma(cells: Iterable<string>): NumberContext {
  for (const c of cells) if (isUnambiguousDecimalComma(c)) return { decimalComma: true };
  return {};
}
