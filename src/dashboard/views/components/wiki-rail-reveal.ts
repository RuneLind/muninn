/**
 * Where the rail scrolls to bring the open page's row into view. Pure — the
 * reader hands it `getBoundingClientRect()` boxes — so the "already visible"
 * test and the centering arithmetic are unit-testable without a browser.
 */

export interface VerticalBox {
  top: number;
  bottom: number;
}

/** Is `row` wholly inside `box`? A row clipped at either edge is not. */
export function rowFullyVisible(box: VerticalBox, row: VerticalBox): boolean {
  return row.top >= box.top && row.bottom <= box.bottom;
}

/**
 * The `scrollTop` that centers `row` in the scroll `box`, or `null` when the row
 * is already wholly visible — a row the reader just clicked never moves under
 * the pointer. Clamped at 0; the browser clamps the far end itself.
 */
export function revealScrollTop(box: VerticalBox, row: VerticalBox, scrollTop: number): number | null {
  if (rowFullyVisible(box, row)) return null;
  const rowMid = (row.top + row.bottom) / 2 - box.top;
  return Math.max(0, Math.round(scrollTop + rowMid - (box.bottom - box.top) / 2));
}
