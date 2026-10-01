/**
 * `<DeltaTable src="runs.csv" better="lower" />`, or with a pipe table as its
 * body: run-to-run numbers, the first column a row label and each later
 * column a run, oldest on the left, plus a computed delta between the last two
 * runs. Wiki-only, like `Query`: not in `COMPONENT_VOCABULARY_RULES`.
 *
 * Pure. Cells are read by `parseCellValue` (`cell-number.ts`), the reading the
 * `<Query>` table's client sort uses, so a cell that sorts as a number is the
 * cell that gets a delta.
 */
import { isEmptyCell, parseCellValue, tableDecimalComma, type NumberContext } from "./cell-number.ts";

export type DeltaBetter = "lower" | "higher" | "";

export interface DeltaAttrs {
  src: string;
  /** The direction for every row; `""` with a per-row list or none. */
  better: DeltaBetter;
  /** `better="Label=lower; Label=higher"`: the direction per row label (as
   *  {@link normalizeLabel} reads it); null for a table-wide value or none.
   *  A label cannot hold `;`, the list separator; it may hold `=`, since the
   *  direction is read after the last one. A label given twice keeps the last
   *  direction. */
  rows: Map<string, "lower" | "higher"> | null;
  /** A one-line warning for a `better` this cannot read; `""` when none. */
  warning: string;
  /** With a per-row list only: each valid label as written, in order, repeats
   *  included, for {@link betterLabelWarnings}. */
  labels?: string[];
}

/** One wrapping `**…**`, `__…__`, `*…*` or `_…_` removed: a pipe-body cell is
 *  read past the emphasis it is rendered with. */
export function stripEmphasis(cell: string): string {
  const t = cell.trim();
  const m = /^\*\*(.+)\*\*$/s.exec(t) ?? /^__(.+)__$/s.exec(t) ?? /^\*(.+)\*$/s.exec(t) ?? /^_(.+)_$/s.exec(t);
  return m ? m[1]!.trim() : t;
}

/** A row label as a per-row `better` key: emphasis and backticks dropped,
 *  trimmed, NFC, lower-cased. */
export function normalizeLabel(label: string): string {
  return stripEmphasis(label).replace(/`/g, "").trim().normalize("NFC").toLowerCase();
}

const direction = (v: string): "lower" | "higher" | null => {
  const d = v.trim().toLowerCase();
  return d === "lower" || d === "higher" ? d : null;
};

export function parseDeltaAttrs(attrs: Record<string, string>): DeltaAttrs {
  const src = (attrs.src ?? "").trim();
  const raw = (attrs.better ?? "").trim();
  if (!raw) return { src, better: "", rows: null, warning: "" };
  const all = direction(raw);
  if (all) return { src, better: all, rows: null, warning: "" };
  if (!raw.includes("=")) return { src, better: "", rows: null, warning: unknownBetter(raw) };
  const rows = new Map<string, "lower" | "higher">();
  const labels: string[] = [];
  const bad: string[] = [];
  for (const part of raw.split(";").map((p) => p.trim()).filter(Boolean)) {
    const eq = part.lastIndexOf("=");
    const d = eq > 0 ? direction(part.slice(eq + 1)) : null;
    const label = eq > 0 ? normalizeLabel(part.slice(0, eq)) : "";
    if (!d || !label) bad.push(part);
    else {
      rows.set(label, d);
      labels.push(part.slice(0, eq).trim());
    }
  }
  return { src, better: "", rows, warning: bad.length ? unknownBetter(bad.join("; ")) : "", labels };
}

function unknownBetter(v: string): string {
  return `Unknown better value: ${v} — use lower, higher, or "Label=lower; Label=higher"`;
}

/** A per-row list's warning lines against the table's row labels: a label
 *  given more than once, and a label that matches no row, each named as
 *  written. */
export function betterLabelWarnings(attrs: DeltaAttrs, rowLabels: string[]): string[] {
  if (!attrs.labels?.length) return [];
  const present = new Set(rowLabels.map(normalizeLabel));
  const seen = new Set<string>();
  const twice: string[] = [];
  const missing: string[] = [];
  for (const label of attrs.labels) {
    const key = normalizeLabel(label);
    if (seen.has(key)) twice.push(label);
    else if (!present.has(key)) missing.push(label);
    seen.add(key);
  }
  return [
    twice.length ? `better names a row more than once: ${twice.join(", ")}` : "",
    missing.length ? `better names no row: ${missing.join(", ")}` : "",
  ].filter(Boolean);
}

/** The direction for one row: the table-wide value, else the row's entry in a
 *  per-row list, else none. */
export function rowBetter(attrs: DeltaAttrs, label: string): DeltaBetter {
  if (attrs.better) return attrs.better;
  return attrs.rows?.get(normalizeLabel(label)) ?? "";
}

/** `good`/`bad` follow `better`; `flat` is no change; `""` is a change with no
 *  `better` to judge it by. */
export type DeltaTone = "good" | "bad" | "flat" | "";

export interface Delta {
  /** `+5,71 sek`, `-116`, `0`, `+3 pp`. */
  abs: string;
  /** `+25,8%`; empty for a zero base. */
  pct: string;
  tone: DeltaTone;
}

/** `x` with `d` decimals and an explicit sign, `0` (no sign) when it is zero.
 *  A non-zero `x` that rounds to zero at `d` decimals (an exponent cell:
 *  `2e-7 - 1e-7`) is written with three significant digits instead. */
function signed(x: number, d: number, comma: boolean): string {
  let s = Math.abs(x).toFixed(d);
  if (x !== 0 && Number(s) === 0) s = String(Number(Math.abs(x).toPrecision(3)));
  const out = x === 0 ? s : (x < 0 ? "-" : "+") + s;
  return comma ? out.replace(".", ",") : out;
}

/**
 * The change from `prev` to `last`, or null when either cell is empty, not a
 * number (with an optional unit) or the two units differ. The absolute delta
 * keeps the larger of the two cells' decimals and their unit — a `%` unit is a
 * change in percentage points (`+3 pp`); the percent is relative to `|prev|`
 * with one decimal (three significant digits when that rounds a change to
 * zero), and absent when `prev` is zero. Both cells are read in `ctx` (the
 * row's context). A decimal comma in either cell, or `ctx.decimalComma`,
 * gives a decimal comma in both parts; `pctComma` (the table writes one
 * anywhere) gives one in the percent. The tone comes from the unrounded
 * difference.
 */
export function computeDelta(
  prev: string,
  last: string,
  better: DeltaBetter,
  ctx: NumberContext = {},
  pctComma = false,
): Delta | null {
  if (isEmptyCell(prev) || isEmptyCell(last)) return null;
  const a = parseCellValue(prev, ctx);
  const b = parseCellValue(last, ctx);
  if (!a || !b || a.unit !== b.unit) return null;
  const comma = !!ctx.decimalComma || a.decimalComma || b.decimalComma;
  const d = Math.max(a.decimals, b.decimals);
  const diff = b.n - a.n;
  const unit = a.unit === "%" ? "pp" : a.unit;
  const abs = signed(diff, d, comma) + (unit ? ` ${unit}` : "");
  const pct = a.n === 0 ? "" : `${signed((diff / Math.abs(a.n)) * 100, 1, comma || pctComma)}%`;
  const tone: DeltaTone = diff === 0 ? "flat" : !better ? "" : (diff < 0) === (better === "lower") ? "good" : "bad";
  return { abs, pct, tone };
}

/** The table a DeltaTable renders: a header row and data rows, every row cut
 *  or padded to the header's width; `overflow[k]` marks a row that had a
 *  non-empty cell past the header's columns (no delta for it). `runs` is the
 *  pair of columns the delta compares, or null when fewer than two run
 *  columns hold a value. */
export interface DeltaGrid {
  header: string[];
  rows: string[][];
  overflow: boolean[];
  runs: [number, number] | null;
}

/**
 * The grid from a header and rows as read. A column of the header that is
 * blank in the header AND in every row is dropped (a trailing comma on a CSV
 * line makes one), except the label column; every other column is kept,
 * a blank header cell over a value included. A row with a non-empty cell past
 * the header's last cell as written (`headerWidth`: a CSV parser pads the
 * header) is an overflow row (an escaped `\|` in a pipe body, an over-long
 * CSV line). The delta compares the last two run columns that hold a value in
 * some row, so a column headed for a run not made yet still renders and is
 * skipped.
 */
export function deltaGrid(header: string[], rows: string[][], headerWidth = header.length): DeltaGrid {
  const cell = (r: string[], k: number) => (r[k] ?? "").trim();
  const keep = Array.from({ length: headerWidth }, (_, k) => k).filter(
    (k) => k === 0 || cell(header, k) !== "" || rows.some((r) => cell(r, k) !== ""),
  );
  const pick = (r: string[]) => keep.map((k) => r[k] ?? "");
  const picked = rows.map(pick);
  const filled = keep
    .map((_, j) => j)
    .filter((j) => j > 0 && picked.some((r) => !isEmptyCell(r[j]!)));
  return {
    header: pick(header),
    rows: picked,
    overflow: rows.map((r) => r.slice(headerWidth).some((c) => c.trim() !== "")),
    runs: filled.length >= 2 ? [filled[filled.length - 2]!, filled[filled.length - 1]!] : null,
  };
}

/** The number context of one row: its run cells (every column but the
 *  label), read through `cellText` (a pipe body's emphasis stripped). Each
 *  row is a measure of its own, so a `0,5` in one row never makes another
 *  row's `1,309` a decimal. */
export function rowContext(row: string[], cellText: (s: string) => string = (s) => s): NumberContext {
  return tableDecimalComma(row.slice(1).map(cellText));
}

/** True when any run cell of the grid writes an unambiguous decimal comma:
 *  the table's percents then write a comma in every row. */
export function gridWritesComma(grid: DeltaGrid, cellText: (s: string) => string = (s) => s): boolean {
  return !!tableDecimalComma(grid.rows.flatMap((r) => r.slice(1).map(cellText))).decimalComma;
}
