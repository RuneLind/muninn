/// <reference lib="dom" />
/**
 * Header-click sorting for a `<Query>` card's result table (`table.query-table`,
 * server-rendered by `web-format.ts`). Numeric when every non-empty cell of the
 * column parses as a number, else `localeCompare(…, "nb")`; a second click on
 * the same header reverses. Stable, empty cells last in both directions,
 * `aria-sort` on the sorted header.
 *
 * Idempotent: a table already wired (`data-sortable`) is skipped, so a re-run
 * over the same article adds nothing.
 */

export type SortDir = "ascending" | "descending";

const NUMBER_RE = /^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?$/;

/** A cell as a number, or null. A comma decimal (`1,5`) reads as `1.5`. */
export function parseCellNumber(cell: string): number | null {
  const t = cell.trim();
  if (!NUMBER_RE.test(t)) return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** True when every non-empty cell parses as a number (and one is non-empty). */
export function isNumericColumn(cells: string[]): boolean {
  const filled = cells.filter((c) => c.trim() !== "");
  return filled.length > 0 && filled.every((c) => parseCellNumber(c) !== null);
}

/** The row order (indices into `cells`) for one column and direction. */
export function sortOrder(cells: string[], dir: SortDir): number[] {
  const numeric = isNumericColumn(cells);
  const sign = dir === "ascending" ? 1 : -1;
  return cells
    .map((c, i) => ({ c: c.trim(), i }))
    .sort((a, b) => {
      const ae = a.c === "";
      const be = b.c === "";
      if (ae || be) return ae === be ? a.i - b.i : ae ? 1 : -1;
      const d = numeric ? parseCellNumber(a.c)! - parseCellNumber(b.c)! : a.c.localeCompare(b.c, "nb");
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
    ths.forEach((th, col) => {
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
