/**
 * The /wiki reader's page-rail width: the clamp, the storage round-trip, the
 * viewport bound and the pointer→width rule, DOM-free so they are unit-testable.
 * The drag handle that uses them is `wiki-rail-resize.ts`.
 *
 * Why a stored width at all: the rail is 300 px and this wiki's titles carry
 * their meaning in the second half («MELOSYS-7588/7969 — Nullable trygdes…» twice
 * in a row is two pages the reader cannot tell apart). Wrapping the title to two
 * lines (CSS, `wiki-page.ts`) fixes most of it; letting the reader drag the rail
 * wider fixes the rest, and the width has to survive a reload or it is a chore.
 */

/** localStorage key. Versioned so a future change of unit or range can start clean. */
export const RAIL_WIDTH_KEY = "muninn.wiki.railWidth.v1";

/** Narrower than this and a two-line title is still clipped mid-word; wider and
 *  the article column loses its ~65-character measure on a laptop screen. */
export const RAIL_WIDTH_MIN = 260;
export const RAIL_WIDTH_MAX = 560;
/** The two CSS defaults (`.wiki-layout` first column), interpolated from here:
 *  the wide layout's, and the one below the 1100px breakpoint. A reset lands on
 *  whichever applies. */
export const RAIL_WIDTH_DEFAULT = 300;
export const RAIL_WIDTH_DEFAULT_NARROW = 260;
/** Pixels one arrow-key press moves the rail. */
export const RAIL_WIDTH_KEY_STEP = 16;
/** The share of the window a stored width may take at apply time. */
export const RAIL_VIEWPORT_SHARE = 0.45;

/** Clamp to the allowed range, rounding to whole pixels. */
export function clampRailWidth(n: number): number {
  if (!Number.isFinite(n)) return RAIL_WIDTH_DEFAULT;
  return Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, Math.round(n)));
}

/**
 * Read a stored value back. `null` for anything that is not a finite number
 * (absent key, an old format, a hand-edited string) — the caller then leaves the
 * CSS default in place rather than applying a clamped garbage value. An
 * out-of-range number IS applied, clamped: a stored width from a machine with a
 * wider screen should degrade to the max here, not be thrown away.
 */
export function parseStoredRailWidth(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return clampRailWidth(n);
}

/**
 * The width to APPLY for a given window: the stored/dragged width, bounded to
 * `RAIL_VIEWPORT_SHARE` of the viewport. The range clamp is a desktop range and
 * has no viewport term, so a 560 stored on a monitor was applied verbatim in a
 * 600px window and left the article column 2px wide (measured in review). The
 * bound is deliberately NOT re-clamped up to `RAIL_WIDTH_MIN` — on a phone that
 * would reintroduce the squeeze — and it is applied, never persisted, so widening
 * the window again gets the stored width back.
 */
export function effectiveRailWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return width;
  return Math.min(width, Math.floor(viewportWidth * RAIL_VIEWPORT_SHARE));
}

/**
 * What to STORE after the reader asks for `requested` while `shown` is on
 * screen and `stored` is remembered (null ⇒ the CSS default). Shown can be less
 * than stored when the viewport bound is in force, and that is the whole case:
 *   - a shrink (`requested < shown`) stores the requested width — the reader
 *     chose something smaller than what they can see, and that choice replaces
 *     a wider stored width on purpose: it is an explicit act on a visible
 *     width, where an inert grow is not;
 *   - a grow stores `max(stored, requested)` — a grow the bound makes INERT
 *     (560 stored, 315 shown, ArrowRight asks 331) must not lower the desktop
 *     width the reader set on a wider screen and cannot see here.
 * Keyboard and drag both go through this, so the two cannot disagree.
 */
export function nextStoredWidth(stored: number | null, shown: number, requested: number): number {
  if (requested < shown) return requested;
  return Math.max(stored ?? 0, requested);
}

/** The width a drag implies: the pointer's x minus the RAIL's left edge, clamped.
 *  The rail's, not the layout's — the layout carries 24px of padding, and
 *  measuring from it made every drag land ~24px wider than the pointer. */
export function railWidthFromPointer(clientX: number, railLeft: number): number {
  return clampRailWidth(clientX - railLeft);
}
