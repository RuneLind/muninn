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

/**
 * The page title's FLOOR inside a rail row, in px — the one number the row's
 * other rules are sized against, and the reason they exist. A row is a flex
 * line of six things (type dot · title · group chip · status pill · ⚑ · ★+date)
 * and only the title is elastic, so before this floor existed the title was
 * whatever the others left: measured at the 260px rail on a row carrying all
 * six, 10.0px — a named page with no name on it, and a hover target Playwright
 * reports as "element is not visible".
 *
 * 72px is ~9 characters at the row's 12.5px type: enough to tell two plans
 * apart, and the width at which a two-line clamp still reads as a title rather
 * than as a column of syllables. Nothing below the floor is served by shrinking
 * further — the row takes a second line instead (`flex-wrap`, `wiki-page.ts`).
 */
export const RAIL_TITLE_MIN = 72;

/**
 * The floor for `.wiki-list-mid` — the title + chip pair — when the row carries
 * a group chip: the title's floor, the row's 8px gap, and 60px for the widest
 * COMPACT chip. Measured in Chromium on the reader's own rows: `1` is 29.4px of
 * chip, `2 · 1` 45.1px and `10 · 10` 57.1px, so 60 covers every count a wiki
 * folder can realistically produce. Under this the pair cannot hold both at
 * their floors, so the row takes a second line rather than starving one.
 *
 * What it costs, stated: a group row needs 268.7px of rail to keep its ★+date on
 * the first line (7 dot + 8 + 140 + 8 + 73.7, plus 32px of row/list padding), so
 * between `RAIL_WIDTH_MIN` and ~269 every group row is two lines. At the 300px
 * default it is one.
 */
export const RAIL_MID_MIN_CHIP = RAIL_TITLE_MIN + 8 + 60;

/**
 * The two container breakpoints, in px of REMAINING row space (`.wiki-list-mid`),
 * at or under which a chip swaps its words for its counts. Two of them because
 * the full label's width is a fact about the LABEL and not about the row:
 * measured, `1 attached` is 76.9px of chip and `10 attached · 10 superseded`
 * 166.9px, so one threshold sized for the long form would take the words off
 * every short chip at the default rail width — where they fit with room to
 * spare (169.3px of remaining space on a plain group row).
 *
 * Each is the title's floor + the gap + that class's widest chip: 84 for a
 * one-kind label (76.9 measured, +7 for the second digit) and 174 for a two-kind
 * one (166.9, same slack). So whenever the words are shown the title still has
 * its floor and nothing overflows — and when the measurement is off by a pixel
 * on another machine, the chip degrades to its compact form rather than to a
 * clipped one.
 */
export const RAIL_CHIP_SWITCH_SHORT = RAIL_TITLE_MIN + 8 + 84;
export const RAIL_CHIP_SWITCH_WIDE = RAIL_TITLE_MIN + 8 + 174;
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
 * Keyboard and drag both go through this per COMMITTED act — a key press, or a
 * drag's release — judged against the state when that act began. A drag's
 * positions between pointerdown and release are not acts: a dip under the bound
 * and back up stores what the release asks for, while the same path as two
 * key presses commits the dip. That is the one way the two paths differ.
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
