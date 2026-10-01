/**
 * `<DeltaTable src="runs.csv" better="lower" />`, or with a pipe table as its
 * body: run-to-run numbers, the first column a row label and each later
 * column a run, plus a computed delta between the last two runs. Wiki-only,
 * like `Query`: not in `COMPONENT_VOCABULARY_RULES`.
 *
 * Pure. Cells are read by `parseCellValue` (`cell-number.ts`), the reading the
 * `<Query>` table's client sort uses, so a cell that sorts as a number is the
 * cell that gets a delta.
 */
import { isEmptyCell, parseCellValue } from "./cell-number.ts";

export type DeltaBetter = "lower" | "higher" | "";

export interface DeltaAttrs {
  src: string;
  better: DeltaBetter;
}

export function parseDeltaAttrs(attrs: Record<string, string>): DeltaAttrs {
  const b = (attrs.better ?? "").trim().toLowerCase();
  return { src: (attrs.src ?? "").trim(), better: b === "lower" || b === "higher" ? b : "" };
}

/** `good`/`bad` follow `better`; `flat` is no change; `""` is a change with no
 *  `better` to judge it by. */
export type DeltaTone = "good" | "bad" | "flat" | "";

export interface Delta {
  /** `+5,71 sek`, `-116`, `0`. */
  abs: string;
  /** `+25,8%`; empty for a zero base. */
  pct: string;
  tone: DeltaTone;
}

/** `x` with `d` decimals and an explicit sign, `0` (no sign) when it rounds to zero. */
function signed(x: number, d: number, comma: boolean): string {
  const s = Math.abs(x).toFixed(d);
  if (Number(s) === 0) return comma ? s.replace(".", ",") : s;
  const out = (x < 0 ? "-" : "+") + s;
  return comma ? out.replace(".", ",") : out;
}

/**
 * The change from `prev` to `last`, or null when either cell is empty, not a
 * number (with an optional unit) or the two units differ. The absolute delta
 * keeps the larger of the two cells' decimals and their unit; the percent is
 * relative to `|prev|` with one decimal, and absent when `prev` is zero. A
 * decimal comma in either cell gives a decimal comma in both parts.
 */
export function computeDelta(prev: string, last: string, better: DeltaBetter): Delta | null {
  if (isEmptyCell(prev) || isEmptyCell(last)) return null;
  const a = parseCellValue(prev);
  const b = parseCellValue(last);
  if (!a || !b || a.unit !== b.unit) return null;
  const comma = a.decimalComma || b.decimalComma;
  const d = Math.max(a.decimals, b.decimals);
  const diff = b.n - a.n;
  const abs = signed(diff, d, comma) + (a.unit ? ` ${a.unit}` : "");
  const pct = a.n === 0 ? "" : `${signed((diff / Math.abs(a.n)) * 100, 1, comma)}%`;
  const zero = Number(Math.abs(diff).toFixed(d)) === 0;
  const tone: DeltaTone = zero ? "flat" : !better ? "" : (diff < 0) === (better === "lower") ? "good" : "bad";
  return { abs, pct, tone };
}

/** The table a DeltaTable renders: a header row and data rows, every row
 *  padded or cut to the header's width. */
export interface DeltaGrid {
  header: string[];
  rows: string[][];
}

export function deltaGrid(header: string[], rows: string[][]): DeltaGrid {
  const w = header.length;
  return {
    header,
    rows: rows.map((r) => (r.length >= w ? r.slice(0, w) : [...r, ...Array<string>(w - r.length).fill("")])),
  };
}
