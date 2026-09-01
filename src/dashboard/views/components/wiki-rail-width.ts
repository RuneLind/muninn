/**
 * The /wiki reader's page-rail width: the clamp, the storage round-trip and the
 * pointer→width rule, DOM-free so they are unit-testable. The drag handle that
 * uses them is `wiki-rail-resize.ts`.
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
/** The width the CSS ships (`.wiki-layout` first column) when nothing is stored. */
export const RAIL_WIDTH_DEFAULT = 300;

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

/** The width a drag implies: the pointer's x minus the layout's left edge, clamped. */
export function railWidthFromPointer(clientX: number, layoutLeft: number): number {
  return clampRailWidth(clientX - layoutLeft);
}
