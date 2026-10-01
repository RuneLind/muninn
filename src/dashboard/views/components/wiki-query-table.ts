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

import {
  isEmptyCell,
  parseCellNumber,
  parseCellValue,
  tableDecimalComma,
  type CellValue,
} from "../../../format/cell-number.ts";

export type SortDir = "ascending" | "descending";

// Shared with `<DeltaTable>`'s delta (`src/format/delta-table.ts`): one reading.
export { isEmptyCell, parseCellNumber };

const cellValue = parseCellValue;

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

/** -1, 0 or 1 — never a difference, which overflows to ±Infinity. */
function compareNumbers(a: CellValue, b: CellValue): number {
  return a.n === b.n ? 0 : a.n < b.n ? -1 : 1;
}

/** Text order: Norwegian collation, each digit run compared as a number by ICU
 *  (runs up to 254 digits): `MEL-9` < `MEL-10`, `10.0.0.9` < `10.0.0.10`. */
const TEXT_ORDER = new Intl.Collator("nb", { numeric: true });

/** The row order (indices into `cells`) for one column and direction. */
export function sortOrder(cells: string[], dir: SortDir): number[] {
  const numeric = isNumericColumn(cells);
  // The column's own decimal context, as a DeltaTable reads its table: one
  // `0,5` makes `1,500` 1.5 rather than 1500.
  const ctx = numeric ? tableDecimalComma(cells) : {};
  const sign = dir === "ascending" ? 1 : -1;
  return cells
    .map((c, i) => {
      const e = isEmptyCell(c);
      return { c: c.trim(), e, i, v: numeric && !e ? cellValue(c, ctx) : null };
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
