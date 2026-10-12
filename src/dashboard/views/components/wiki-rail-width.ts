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
/** Toolbar width (the content box of `.wiki-browse-head`, i.e. rail − 26px) at
 *  or under which the Filters button drops its word and keeps the funnel and
 *  badge, so sort · Filters · count · options keep one line. Measured: select
 *  134 + Filters 72 + options 26 + three 6px gaps, plus 60 for a four-digit
 *  count = 310. The query includes 310, so the word shows from a 337px rail. */
export const RAIL_TOOLBAR_COMPACT = 310;

/**
 * Since 2026-10-12 a PAGE row is two lines: icon · title · ★+age, then a meta
 * line with the pill, ⚑, ✋, NEW and the chip. The chip sits in its own slot
 * that takes what the other marks leave, and swaps words for counts at the
 * `RAIL_CHIP_LABEL_*` widths with a `RAIL_CHIP_COMPACT_*` floor. The one-line
 * budget below (`RAIL_TITLE_MIN` + gap + chip) now applies only to family and
 * month header rows, which keep the roll-up chip beside the label (a series
 * header carries no chip). Its page-row measurements are history.
 *
 * The page title's FLOOR inside a rail row, in px — the one number the row's
 * other rules are sized against, and the reason they exist. A row is a flex
 * line of six things (type icon · title · group chip · status pill · ⚑ · ★+date)
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
 * The compact chip's widest form per counts class (the caret included),
 * measured in Chromium on the reader's own rows:
 *   - one count of up to three digits, `counts-narrow`: `9` 31.2px, `99` 38.0,
 *     `999` 44.8 → 46;
 *   - two counts of up to two digits, the default: `9 · 9` 47.3, `99 · 99`
 *     60.9 → 62 (#557 budgeted 60 from `10 · 10` at 57.1, which `88 · 88` at
 *     60.9 already exceeds);
 *   - anything wider, `counts-wide`: `120 · 100` 70.2, `999 · 999` 74.5 → 76;
 *     a four-digit single count goes here too (`1000` 49.5px, `9999` 51.5).
 *
 * On a PAGE row these are the floor of the chip's slot on the meta line
 * (`.wiki-fold-chip-wrap`): a line with less room than that wraps the slot onto
 * a line of its own rather than clipping a count. `RAIL_MID_MIN_CHIP*` add the
 * title floor and gap for a family or month header row, whose label and chip
 * share `.wiki-list-mid`; the header box is the rail less 46.4px, so they bind
 * only in a narrow window, where the 45% viewport bound (`effectiveRailWidth`)
 * takes the rail under its 260px minimum (measured: a 133.6px header box at a
 * 400px window, under the 142px default floor). They were the page row's floors
 * while page rows were one line, and the measurements behind them (a `3
 * attached` row with a pill and a ⚑ wrapping at 300px under one 140px floor; a
 * three-digit compact chip overflowing a 60px budget onto the pill) are history.
 */
export const RAIL_CHIP_COMPACT_NARROW = 46;
export const RAIL_CHIP_COMPACT = 62;
export const RAIL_CHIP_COMPACT_WIDE = 76;
export const RAIL_MID_MIN_CHIP_NARROW = RAIL_TITLE_MIN + 8 + RAIL_CHIP_COMPACT_NARROW;
export const RAIL_MID_MIN_CHIP = RAIL_TITLE_MIN + 8 + RAIL_CHIP_COMPACT;
export const RAIL_MID_MIN_CHIP_WIDE = RAIL_TITLE_MIN + 8 + RAIL_CHIP_COMPACT_WIDE;

/**
 * The widest an issue mark may be: the 11px glyph, its gap and a two-digit
 * count (measured 18.7px with one digit). A budget the e2e pins on every mark's
 * own box, not a CSS cap. The column sits beside the title text while the text
 * keeps `RAIL_TITLE_MIN` and wraps UNDER it otherwise, so it takes no reserve
 * in the floors above or the breakpoints below.
 */
export const RAIL_ISSUE_PILLS_COL = 28;

/**
 * The three container breakpoints of a page row's chip slot
 * (`.wiki-fold-chip-wrap`, the room the meta line's other marks leave), at or
 * under which the chip swaps its words for its counts. Three of them because
 * the full label's width is a fact about the LABEL: measured (the caret
 * included), `99 attached` is 85.5px of chip, `99 superseded` 100.3px and
 * `99 attached · 99 superseded` 170.6px, so one threshold sized for the long
 * form would take the words off every short chip where they fit.
 *
 * Each is that class's widest label, rounded up: 88 for a SHORT one-kind label
 * (an `attached`/status word with up to two digits), 103 for a LONG one
 * (`superseded` at any count — 91.7 to 100.3 — or any one-kind word at three
 * digits: `999 attached` 92.3) and 174 for a two-kind one (166.9 measured at
 * `10 · 10`, 170.6 at `99 · 99`). #557 sized the one-kind class from
 * `1 attached` (76.9 + 7 = 84), which `1 superseded` at 91.7 already exceeds,
 * and a superseded-only chip painted its word clipped. The classes are set by
 * `foldChipLabelClass` (`wiki-recents.ts`). When a measurement is off by a
 * pixel on another machine, the chip degrades to its compact form rather than
 * to a clipped one.
 */
export const RAIL_CHIP_LABEL_SHORT = 88;
export const RAIL_CHIP_LABEL_LONG = 103;
export const RAIL_CHIP_LABEL_WIDE = 174;
/** A two-kind label with a three- or four-digit count (`counts-wide`). On
 *  macOS: 180.0px of chip for `120 attached · 100 superseded`, up to 197.7px
 *  for a four-digit pair. CI's Linux fonts paint it wider: at 186 the
 *  no-clipped-chip sweep found `120 attached · 100 superseded` clipped at a
 *  326px rail (run 38313899886). So 198. */
export const RAIL_CHIP_LABEL_WIDE_3D = 198;

/**
 * The same swap for a family/month row's WIDE roll-up chip — its own number,
 * because a group row's chip is not a parent row's chip.
 *
 * The page chip's wide breakpoint (`RAIL_CHIP_LABEL_WIDE`, 254 as a one-line
 * row's mid) is sized for `10 attached · 10 superseded`, the widest label an
 * ATTACHMENT chip can hold. A roll-up says `9 shipped · 1 superseded`
 * instead, and status words are shorter than "attached": measured in Chromium on
 * the reader's own rows, `9 shipped · 1 superseded` is **142.6px** of chip and
 * `10 shipped · 10 superseded` **154.2px**, against 158.4px for the attachment
 * worst case. Borrowing the parent's 254 therefore hid the roll-up at a mid of
 * 253.6px — which is EXACTLY the 300px shipped default (a group row's mid is the
 * rail minus 46.4px), so the acceptance artifact `9 shipped · 1 superseded` was
 * hover-only on every rail anybody has and appeared at 302.
 *
 * 155 is the widest measured two-count roll-up plus the same rounding slack the
 * other two carry, so the words show from a mid of 236px (rail ~282) and the
 * label still has its floor when they do. A roll-up wider than that — three or
 * four statuses in one slate, `3 draft · 3 ready · 3 shipped · 3 superseded` at
 * 234.8px — falls back to the chip's own ellipsis exactly as an over-long
 * attachment label does; it is a backstop, not a fourth breakpoint.
 *
 * A one-kind roll-up uses the page chip's label budgets plus the label floor:
 * `RAIL_CHIP_SWITCH_SHORT` (61–80.3px of chip: `12 pages`, `10 shipped`,
 * `12 unmarked`) and `RAIL_CHIP_SWITCH_LONG` for a one-status `N superseded`
 * slate. They fire only in a narrow window: the header box is the rail less
 * 46.4px, and the 45% viewport bound takes the rail under its 260px minimum in
 * a window narrower than ~578px (measured: 205.6px of box at a 560px window,
 * 133.6px at 400, where `12 superseded` clipped with no breakpoint).
 */
export const RAIL_GROUP_CHIP_SWITCH = RAIL_TITLE_MIN + 8 + 155;
/** A family or month header's one-kind breakpoints, on its box (`railmid`):
 *  the label's floor, the gap and the short or long label budget. */
export const RAIL_CHIP_SWITCH_SHORT = RAIL_TITLE_MIN + 8 + RAIL_CHIP_LABEL_SHORT;
export const RAIL_CHIP_SWITCH_LONG = RAIL_TITLE_MIN + 8 + RAIL_CHIP_LABEL_LONG;
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
