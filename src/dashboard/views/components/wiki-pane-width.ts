/**
 * The /wiki reader's right pane width (Connections, Stale, Ask, Discuss): the
 * clamp, the storage round-trip, the viewport bound and the pointer→width rule,
 * DOM-free so they are unit-testable. The drag handle is `wiki-pane-resize.ts`;
 * the store rule (`nextStoredWidth`) is the rail's, from `wiki-rail-width.ts`.
 *
 * Why: at 300px a Discuss answer wraps a repo path over three lines (27.11).
 */
import { nextStoredWidth } from "./wiki-rail-width.ts";

export { nextStoredWidth };

/** localStorage key. Versioned so a future change of unit or range can start clean. */
export const PANE_WIDTH_KEY = "muninn.wiki.paneWidth.v1";
export const PANE_WIDTH_MIN = 260;
export const PANE_WIDTH_MAX = 720;
/** The CSS default (`.wiki-layout` last column), interpolated from here. */
export const PANE_WIDTH_DEFAULT = 300;
/** Pixels one arrow-key press moves the pane's edge. */
export const PANE_WIDTH_KEY_STEP = 16;
/** The share of the window a stored width may take at apply time. */
export const PANE_VIEWPORT_SHARE = 0.4;
/** What the rest of the row keeps beside the rail: the layout's 2×24px padding,
 *  its two 16px gaps and a 420px article column. */
export const PANE_ARTICLE_RESERVE = 48 + 32 + 420;

/** Clamp to the allowed range, rounding to whole pixels. */
export function clampPaneWidth(n: number): number {
  if (!Number.isFinite(n)) return PANE_WIDTH_DEFAULT;
  return Math.min(PANE_WIDTH_MAX, Math.max(PANE_WIDTH_MIN, Math.round(n)));
}

/** A stored value read back: null for anything that is not a finite number
 *  (the CSS default stays), an out-of-range number clamped. */
export function parseStoredPaneWidth(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return clampPaneWidth(n);
}

/**
 * The width to APPLY: the chosen width, bounded by `PANE_VIEWPORT_SHARE` of the
 * window and by what the rail and the article's reserve leave, never under
 * `PANE_WIDTH_MIN` (the pane has no column under 1100px, so the floor cannot
 * squeeze a phone). Applied, never persisted: a wider window gets the stored
 * width back.
 */
export function effectivePaneWidth(width: number, viewportWidth: number, railWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return width;
  const rail = Number.isFinite(railWidth) && railWidth > 0 ? railWidth : 0;
  const bound = Math.min(Math.floor(viewportWidth * PANE_VIEWPORT_SHARE), Math.floor(viewportWidth - rail - PANE_ARTICLE_RESERVE));
  return Math.min(width, Math.max(PANE_WIDTH_MIN, bound));
}

/** The width a drag implies: the pane's RIGHT edge minus the pointer's x, clamped. */
export function paneWidthFromPointer(clientX: number, paneRight: number): number {
  return clampPaneWidth(paneRight - clientX);
}
