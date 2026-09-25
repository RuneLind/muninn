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
 * The floors for `.wiki-list-mid` — the title + chip pair — when the row carries
 * a group chip: the title's floor, the row's 8px gap, and the widest COMPACT chip
 * of the chip's digit class. Under the floor the pair cannot hold both at their
 * floors, so the row takes a second line rather than starving one — and the
 * floor is ALSO what decides when a row wraps, which is why it is three numbers
 * and not one. Measured in Chromium on the reader's own rows (the caret
 * included):
 *   - one count of up to three digits, `counts-narrow`: `9` 31.2px, `99` 38.0,
 *     `999` 44.8 → 46;
 *   - two counts of up to two digits, the default: `9 · 9` 47.3, `99 · 99`
 *     60.9 → 62 (#557 budgeted 60 from `10 · 10` at 57.1, which `88 · 88` at
 *     60.9 already exceeds);
 *   - anything wider, `counts-wide`: `120 · 100` 70.2, `999 · 999` 74.5 → 76.
 * Past a bucket's budget the chip does NOT degrade gracefully: the title's own
 * `min-width` and the compact chip's `flex-shrink: 0` hold their widths and the
 * pair overflows `.wiki-list-mid` onto the status pill — measured 1–3.5px with
 * `1000` forced into the old 46px narrow budget at rail 275. So the buckets
 * are sized to what the counts can be: a four-digit single count goes to the
 * wide floor (`1000` 49.5px, `9999` 51.5, under 76 — widening the narrow
 * budget instead cost the 260px rail three chip rows), and a family roll-up of three or four
 * statuses (`10 · 10 · 10 · 10`, ~91px) exceeds the wide budget but sits on a
 * group row, whose mid is the rail minus 46.4px — 213.6px at the narrowest —
 * so no floor here can bind on it.
 *
 * What the buckets buy, stated: with one 140px floor a `3 attached` row carrying
 * a pill and a ⚑ needed 274.5px of rail for one line, so it wrapped at the 300px
 * default (fixed parts 133.3px < 140 — measured on mimir, 1 of 8 chip rows);
 * the narrow floor (126) keeps it on one line. And a three-digit compact chip
 * (70.2px) overflowed the default floor's 60px by 3–9px onto the status pill
 * at rails 260–270; the wide floor (156) makes that row wrap instead.
 */
/**
 * The issue-pill column's reserve on a row that carries pills: the column's
 * `max-width` (92px — one `DEMO-1234`-sized pill, or two short ones, per line)
 * plus the 4px gap to the title text. Added to every floor and chip breakpoint
 * of such a row, so the title text keeps `RAIL_TITLE_MIN` beside the pills.
 */
export const RAIL_ISSUE_PILLS_COL = 96;

export const RAIL_MID_MIN_CHIP_NARROW = RAIL_TITLE_MIN + 8 + 46;
export const RAIL_MID_MIN_CHIP = RAIL_TITLE_MIN + 8 + 62;
export const RAIL_MID_MIN_CHIP_WIDE = RAIL_TITLE_MIN + 8 + 76;

/**
 * The three container breakpoints, in px of REMAINING row space (`.wiki-list-mid`),
 * at or under which a chip swaps its words for its counts. Three of them because
 * the full label's width is a fact about the LABEL and not about the row:
 * measured (the caret included), `99 attached` is 85.5px of chip,
 * `99 superseded` 100.3px and `99 attached · 99 superseded` 170.6px, so one
 * threshold sized for the long form would take the words off every short chip at
 * the default rail width — where they fit with room to spare (210px of remaining
 * space on a plain group row).
 *
 * Each is the title's floor + the gap + that class's widest label, rounded up:
 * 88 for a SHORT one-kind label (an `attached`/status word with up to two
 * digits), 103 for a LONG one (`superseded` at any count — 91.7 to 100.3 — or
 * any one-kind word at three digits: `999 attached` 92.3) and 174 for a
 * two-kind one (166.9 measured at `10 · 10`, 170.6 at `99 · 99`). #557 sized
 * the one-kind class from `1 attached` (76.9 + 7 = 84), which `1 superseded`
 * at 91.7 already exceeds — so a superseded-only chip painted its word clipped
 * (`10 supersede…`, 90 of 98.4px) at the 260px rail, and a live `1 superseded`
 * row on mimir clipped by 4px at 281. The classes are set by
 * `foldChipLabelClass` (`wiki-recents.ts`). So whenever the words are shown the
 * title still has its floor and nothing overflows — and when the measurement is
 * off by a pixel on another machine, the chip degrades to its compact form
 * rather than to a clipped one. The 84→88 raise is unpinned by any test: it
 * removes a sub-pixel clip of `99 attached` in the mid band 164–168 only.
 */
export const RAIL_CHIP_SWITCH_SHORT = RAIL_TITLE_MIN + 8 + 88;
export const RAIL_CHIP_SWITCH_LONG = RAIL_TITLE_MIN + 8 + 103;
export const RAIL_CHIP_SWITCH_WIDE = RAIL_TITLE_MIN + 8 + 174;

/**
 * The same swap for a family/month row's WIDE roll-up chip — its own number,
 * because a group row's chip is not a parent row's chip.
 *
 * `RAIL_CHIP_SWITCH_WIDE` is sized for `10 attached · 10 superseded`, the widest
 * label an ATTACHMENT chip can hold. A roll-up says `9 shipped · 1 superseded`
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
 * There is deliberately no group-specific SHORT constant: a one-kind roll-up
 * measures 61–80.3px (`12 pages`, `10 shipped`, `12 unmarked`), which
 * `RAIL_CHIP_SWITCH_SHORT`'s budget already covers, so a month chip keeps its
 * words down to the 260px rail; a one-status `N superseded` slate carries the
 * page chip's LONG class and breakpoint, which cannot bind on a group row anyway
 * (its mid is ≥ 213px).
 */
export const RAIL_GROUP_CHIP_SWITCH = RAIL_TITLE_MIN + 8 + 155;
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
