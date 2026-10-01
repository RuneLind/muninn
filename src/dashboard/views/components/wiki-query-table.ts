/// <reference lib="dom" />
/**
 * Header-click sorting for a `<Query>` card's result table (`table.query-table`,
 * server-rendered by `web-format.ts`). Numeric when every non-empty cell of the
 * column parses as a number (such a column is marked `query-num`, right-aligned),
 * else natural order (`naturalCompare`), so `MEL-368918` sorts before
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

/** True when every non-empty cell parses as a number (and one is non-empty). */
export function isNumericColumn(cells: string[]): boolean {
  const filled = cells.filter((c) => !isEmptyCell(c));
  return filled.length > 0 && filled.every((c) => parseCellNumber(c) !== null);
}

/** A number inside a text cell: an optional sign only where it cannot be a
 *  separator (start of the cell, or after a space or `(`), then digits with at
 *  most one `.`/`,` fraction. `MEL-10` is `MEL-` + 10; `-5 x` is -5 + ` x`. */
const NUMBER_RUN_RE = /(?:(?<=^|[\s(])[-−])?\d+(?:[.,]\d+)?/gu;

type Run = string | number;

/** A cell split into text runs and number runs. */
function naturalRuns(cell: string): Run[] {
  const runs: Run[] = [];
  let last = 0;
  for (const m of cell.matchAll(NUMBER_RUN_RE)) {
    if (m.index! > last) runs.push(cell.slice(last, m.index));
    runs.push(Number(m[0].replace("−", "-").replace(",", ".")));
    last = m.index! + m[0].length;
  }
  if (last < cell.length) runs.push(cell.slice(last));
  return runs;
}

/** Natural order for a text column: run by run, numbers by value, text by
 *  Norwegian collation, a number before text; a tie falls back to collation. */
export function naturalCompare(a: string, b: string): number {
  const ra = naturalRuns(a);
  const rb = naturalRuns(b);
  for (let k = 0; k < Math.min(ra.length, rb.length); k++) {
    const x = ra[k]!;
    const y = rb[k]!;
    let d: number;
    if (typeof x === "number" && typeof y === "number") d = x - y;
    else if (typeof x === "number") d = -1;
    else if (typeof y === "number") d = 1;
    else d = x.localeCompare(y, "nb");
    if (d !== 0) return d;
  }
  return ra.length - rb.length || a.localeCompare(b, "nb");
}

/** The row order (indices into `cells`) for one column and direction. */
export function sortOrder(cells: string[], dir: SortDir): number[] {
  const numeric = isNumericColumn(cells);
  const sign = dir === "ascending" ? 1 : -1;
  return cells
    .map((c, i) => ({ c: c.trim(), e: isEmptyCell(c), i }))
    .sort((a, b) => {
      if (a.e || b.e) return a.e === b.e ? a.i - b.i : a.e ? 1 : -1;
      const d = numeric
        ? parseCellNumber(a.c)! - parseCellNumber(b.c)!
        : naturalCompare(a.c, b.c);
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
