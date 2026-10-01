/// <reference lib="dom" />
/**
 * Header-click sorting for a `<Query>` card's result table (`table.query-table`,
 * server-rendered by `web-format.ts`). By value when every non-empty cell is a
 * number, or a number plus one unit the whole column shares (`0.5 kr`); such a
 * column is marked `query-num`, right-aligned. Otherwise Norwegian collation
 * with digit runs compared as numbers, so `MEL-368918` sorts before
 * `MEL-1172008`; a second click on the same header reverses. Stable, empty and
 * NULL cells last in both directions, `aria-sort` on the sorted header.
 *
 * Idempotent: a table already wired (`data-sortable`) is skipped, so a re-run
 * over the same article adds nothing.
 */

export type SortDir = "ascending" | "descending";

const NUMBER_RE = /^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?$/;
/** `1 000`, `12 345,5`: groups of three after a space, NBSP or narrow NBSP. */
const SPACE_GROUPED_RE = /^[+-]?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?$/;
/** `1,500`, `1,234,567.25`: groups of three after a comma, dot decimals. */
const COMMA_GROUPED_RE = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/** An empty cell, or the NULL spellings a query tool writes (`NULL`, `[NULL]`,
 *  any case): sorted last, and never makes a column text. */
export function isEmptyCell(cell: string): boolean {
  const t = cell.trim();
  return t === "" || /^\[?null\]?$/i.test(t);
}

/** A cell as a number, or null. A leading U+2212 minus is `-`; space- and
 *  comma-grouped thousands read as one number; any other single comma is a
 *  decimal comma (`2,5` is 2.5). */
export function parseCellNumber(cell: string): number | null {
  let t = cell.trim().replace(/^\u2212/, "-");
  if (SPACE_GROUPED_RE.test(t)) t = t.replace(/[ \u00a0\u202f]/g, "").replace(",", ".");
  else if (COMMA_GROUPED_RE.test(t)) t = t.replace(/,/g, "");
  else if (NUMBER_RE.test(t)) t = t.replace(",", ".");
  else return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A unit token: letters, `%` or currency symbols (`kr`, `x`, `%`, `NOK`, `€`). */
const UNIT_RE = /^[\p{L}%\p{Sc}]+$/u;

type CellValue = { n: number; unit: string; text: string };

/** A cell as (a) a plain number (`unit` ""), or (b) a plain number, white
 *  space and ONE unit token; null for anything else. `text` is the number. */
function cellValue(cell: string): CellValue | null {
  const t = cell.trim();
  const n = parseCellNumber(t);
  if (n !== null) return { n, unit: "", text: t };
  const m = /^(.*\S)\s+(\S+)$/u.exec(t);
  if (!m || !UNIT_RE.test(m[2]!)) return null;
  const v = parseCellNumber(m[1]!);
  return v === null ? null : { n: v, unit: m[2]!, text: m[1]! };
}

/** The column's unit: "" when every non-empty cell is a plain number, the
 *  unit when the others carry one and the same unit, null when the column is
 *  text (any other cell, two different units, or no non-empty cell). */
function columnUnit(cells: string[]): string | null {
  let unit = "";
  let filled = 0;
  for (const c of cells) {
    if (isEmptyCell(c)) continue;
    filled++;
    const v = cellValue(c);
    if (!v) return null;
    if (v.unit === "") continue;
    if (unit !== "" && unit !== v.unit) return null;
    unit = v.unit;
  }
  return filled > 0 ? unit : null;
}

/** True when the column sorts by value: every non-empty cell is a number, or
 *  a number plus one unit the whole column shares (and one is non-empty). */
export function isNumericColumn(cells: string[]): boolean {
  return columnUnit(cells) !== null;
}

/** An integer cell as a BigInt, for a tie past 2^53 (`Number` rounds two
 *  19-digit ids to one value); null for a fraction or an exponent. */
function exactInteger(text: string): bigint | null {
  const t = text.replace(/^−/, "-").replace(/[   ,]/g, "");
  return /^[+-]?\d+$/.test(t) ? BigInt(t) : null;
}

/** -1, 0 or 1 — never a difference, which overflows to ±Infinity. */
function compareNumbers(a: CellValue, b: CellValue): number {
  if (a.n !== b.n) return a.n < b.n ? -1 : 1;
  if (Math.abs(a.n) <= Number.MAX_SAFE_INTEGER) return 0;
  const x = exactInteger(a.text);
  const y = exactInteger(b.text);
  return x === null || y === null || x === y ? 0 : x < y ? -1 : 1;
}

/** Text order: Norwegian collation, each digit run compared as a whole number
 *  by ICU (exact at any length): `MEL-9` < `MEL-10`, `10.0.0.9` < `10.0.0.10`. */
const TEXT_ORDER = new Intl.Collator("nb", { numeric: true });

/** The row order (indices into `cells`) for one column and direction. */
export function sortOrder(cells: string[], dir: SortDir): number[] {
  const numeric = isNumericColumn(cells);
  const sign = dir === "ascending" ? 1 : -1;
  return cells
    .map((c, i) => {
      const e = isEmptyCell(c);
      return { c: c.trim(), e, i, v: numeric && !e ? cellValue(c) : null };
    })
    .sort((a, b) => {
      if (a.e || b.e) return a.e === b.e ? a.i - b.i : a.e ? 1 : -1;
      const d = numeric ? compareNumbers(a.v!, b.v!) : TEXT_ORDER.compare(a.c, b.c);
      return d !== 0 ? sign * d : a.i - b.i;
    })
    .map((x) => x.i);
}

function sortTable(table: HTMLTableElement, col: number): void {
  const body = table.tBodies[0];
  const ths = Array.from(table.tHead?.rows[0]?.cells ?? []);
  if (!body || !ths[col]) return;
  const dir: SortDir =
    table.dataset.sortCol === String(col) && table.dataset.sortDir === "ascending" ? "descending" : "ascending";
  table.dataset.sortCol = String(col);
  table.dataset.sortDir = dir;
  const rows = Array.from(body.rows);
  const order = sortOrder(rows.map((r) => r.cells[col]?.textContent ?? ""), dir);
  body.append(...order.map((i) => rows[i]!));
  ths.forEach((th, k) => {
    const mark = th.querySelector<HTMLElement>(".query-sort-mark");
    if (k === col) {
      th.setAttribute("aria-sort", dir);
      if (mark) mark.textContent = dir === "ascending" ? "▲" : "▼";
    } else {
      th.removeAttribute("aria-sort");
      if (mark) mark.textContent = "";
    }
  });
}

export function enhanceQueryTables(root: ParentNode): void {
  root.querySelectorAll<HTMLTableElement>("table.query-table").forEach((table) => {
    if (table.dataset.sortable === "1") return;
    table.dataset.sortable = "1";
    const ths = Array.from(table.tHead?.rows[0]?.cells ?? []);
    const rows = Array.from(table.tBodies[0]?.rows ?? []);
    ths.forEach((th, col) => {
      if (isNumericColumn(rows.map((r) => r.cells[col]?.textContent ?? ""))) {
        th.classList.add("query-num");
        for (const r of rows) r.cells[col]?.classList.add("query-num");
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.title = "Sort by this column";
      btn.append(...Array.from(th.childNodes));
      const mark = document.createElement("span");
      mark.className = "query-sort-mark";
      mark.setAttribute("aria-hidden", "true");
      btn.append(mark);
      th.append(btn);
      btn.addEventListener("click", () => sortTable(table, col));
    });
  });
}
