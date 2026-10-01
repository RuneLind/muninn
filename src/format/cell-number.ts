/**
 * The ONE number reading for a table cell, shared by the `<Query>` table's
 * client sort (`wiki-query-table.ts`) and the `<DeltaTable>` delta, computed
 * server-side (`delta-table.ts`). Dependency-free: the reader bundle carries it.
 */

const NUMBER_RE = /^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?$/;
/** `1 000`, `12 345,5`: groups of three after a space, NBSP or narrow NBSP. */
const SPACE_GROUPED_RE = /^[+-]?\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?$/;
/** `1,500`, `1,234,567.25`: groups of three after a comma, dot decimals. */
const COMMA_GROUPED_RE = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

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
export function parseCellNumberParts(cell: string): CellNumberParts | null {
  const raw = cell.trim().replace(/^−/, "-");
  let t: string;
  // Comma thousands are the one shape where a comma is not the decimal mark.
  let commaIsDecimal = raw.includes(",");
  if (SPACE_GROUPED_RE.test(raw)) t = raw.replace(/[   ]/g, "").replace(",", ".");
  else if (COMMA_GROUPED_RE.test(raw)) {
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
 *  decimal comma (`2,5` is 2.5). */
export function parseCellNumber(cell: string): number | null {
  return parseCellNumberParts(cell)?.n ?? null;
}

/** A unit token: letters, `%` or currency symbols (`kr`, `x`, `%`, `NOK`, `€`). */
const UNIT_RE = /^[\p{L}%\p{Sc}]+$/u;

/** A cell's value: the number as {@link CellNumberParts}, and its unit (`""`
 *  for none). */
export type CellValue = CellNumberParts & { unit: string };

/** A cell as (a) a plain number (`unit` ""), or (b) a plain number, white
 *  space and ONE unit token; null for anything else. */
export function parseCellValue(cell: string): CellValue | null {
  const t = cell.trim();
  const p = parseCellNumberParts(t);
  if (p !== null) return { ...p, unit: "" };
  const m = /^(.*\S)\s+(\S+)$/u.exec(t);
  if (!m || !UNIT_RE.test(m[2]!)) return null;
  const v = parseCellNumberParts(m[1]!);
  return v === null ? null : { ...v, unit: m[2]! };
}
