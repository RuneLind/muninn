/**
 * The /wiki page rail's **Activity** ranking — "what has happened in this wiki",
 * as one score over signals the listing already carries. Pure and DOM-free, so
 * the whole rule is unit-testable; `buildRail` places the section and
 * `renderList` paints it.
 *
 * Why a score rather than two date sorts: the rail's other recall aids answer
 * "what did I open" and "what did I keep". Neither answers "what is new here",
 * and a plain `updated desc` answers it badly — a touch to `how-we-build.mdx`
 * or an old hub page outranks a real new plan, because every write to a wiki
 * touches its hubs. So a page CREATED lately leads, and a CHANGE counts in
 * proportion to how young and how peripheral the page is.
 *
 * The five factors, all from `/api/wiki/pages`:
 *
 *  - **creation recency** — exponential decay on `pageAddedMs`, half-life
 *    `halfLifeNewDays`.
 *  - **change recency** — the same decay on `pageTimeMs`, half-life
 *    `halfLifeChangedDays`. TWO defaults separate it from a creation of equal
 *    age, and they do about equal shares of the work: the half-life is shorter
 *    (3 d against 5 d) and the whole change term is scaled by `changedWeight`
 *    (0.70). On a wiki whose `workedGate` is open, a page the ledger covers
 *    decays on its `workedMs` INSTEAD — see {@link workedGateFor}.
 *  - **page age** — a change to an old page counts for less (`agePenalty`).
 *  - **hub weight** — a change to a page many pages link to counts for less
 *    (`hubPenalty`), which is what keeps `log.md`-shaped traffic out.
 *  - **type** — plans count for more (`planBoost`), in-flight and proposed
 *    plans most; a blog gets a smaller share of the same knob (0.2 against a
 *    plan's 0.6, or 1.2 when it is live).
 *
 * The two signals are the sweep-aware `pageAddedMs`/`pageTimeMs` from
 * `wiki-filter.ts`, never raw `mtimeMs`/`gitCreatedMs`: a mechanical pass over
 * the whole wiki moves every mtime, and ranking on that is exactly the "148
 * plans edited this minute" failure those two functions exist to absorb.
 *
 * The weights are the prototype's defaults, tuned against the real mimir listing
 * (520 pages) in `mimir/plans/muninn-wiki-rail-activity-prototype.html`, and a
 * wiki can override them in its `.wiki-reader.json` `activity` block.
 */

import {
  displayTitleOf,
  isMetaPage,
  isUsableWorkedMs,
  localDay,
  pageDateSignal,
  type WikiListing,
} from "./wiki-filter.ts";

/**
 * The ranking's knobs. The four percent knobs are 0–100 with the prototype
 * slider's semantics (0 = the factor is off, 100 = the reference strength named
 * in {@link rankActivity}); the two half-lives are days; `rows` is how many rows
 * the section renders; `workedGate` is a whole-number coverage percentage, not
 * a factor.
 */
export interface ActivityWeights {
  /** Rows the Activity section renders, 1–20. */
  rows: number;
  /** Days for a newly created page's score to halve. */
  halfLifeNewDays: number;
  /** Days for a change's score to halve. Shorter than `halfLifeNewDays` by
   *  default, which is what makes "created" lead "changed" at equal age. */
  halfLifeChangedDays: number;
  /** How much a page's own AGE discounts a change to it. 0 = a change to a
   *  two-year-old page counts like a change to a new one. */
  agePenalty: number;
  /** How much incoming links discount a change. 0 = a hub counts like any page. */
  hubPenalty: number;
  /** How much a plan (more when in-flight/proposed) and a blog outrank other
   *  changed pages. */
  planBoost: number;
  /**
   * How much of its raw recency a change keeps — the whole change term is
   * multiplied by this. At 100 it keeps all of it, which still does not make a
   * change and a creation of equal age equal: the change decays on the shorter
   * `halfLifeChangedDays` and carries the age/hub discounts too.
   */
  changedWeight: number;
  /**
   * The share of the ranked candidates (a whole number, 0–100) that must carry
   * a worked-on date before a covered page's change term decays on that date
   * instead of its update stamp. Not a weight: 0 substitutes wherever a page is covered, 100
   * only when every candidate is. See {@link workedGateFor}.
   */
  workedGate: number;
}

/**
 * One rejected knob: the dotted key and what happened to it, kept APART so a
 * caller logs them as separate LogTape properties (`{key} {reason}`, the key
 * already dotted)
 * and the JSONL sink can group a wiki's warnings by cause. One pre-joined
 * sentence per warning grouped by nothing.
 */
export interface ActivityWeightWarning {
  /** Dotted and fully qualified — `activity.hubPenalty`, or `activity` for a
   *  block that is not an object at all. */
  key: string;
  /** Reads as the predicate after the key: "is not a finite number — ignoring it". */
  reason: string;
}

/** The prototype's defaults. */
export const DEFAULT_ACTIVITY_WEIGHTS: ActivityWeights = {
  rows: 6,
  halfLifeNewDays: 5,
  halfLifeChangedDays: 3,
  agePenalty: 60,
  hubPenalty: 60,
  planBoost: 50,
  changedWeight: 70,
  workedGate: 60,
};

/** Bounds on `rows`: below 1 the section cannot render, past 20 it is the listing
 *  with extra furniture, and a number outside them is CLAMPED rather than dropped
 *  ("as many as you can" is unambiguous). The configured `rows` is the only cut —
 *  measured 2026-09-13 over the full listings, mimir (528 pages), melosys-kode-wiki
 *  (396) and jarvis (1261) clear `ACTIVITY_MIN_SCORE` on about 120 / 46 / 202 rows,
 *  so the floor never binds at 20; today those wikis ask for 10, 6 and 6. */
export const ACTIVITY_ROWS_MIN = 1;
export const ACTIVITY_ROWS_MAX = 20;
/** Upper bound on a half-life. A year of half-life is a constant, not a decay,
 *  and a value past it is a units mistake (ms for days) rather than a choice. */
const HALF_LIFE_MAX_DAYS = 365;

const MS_PER_DAY = 86_400_000;

/**
 * A row must score at least this to be Activity at all.
 *
 * Without a floor the section is never empty: the scores are exponentials, which
 * decay towards zero but reach it only on underflow, so a wiki where nothing has
 * happened in two years still fills six rows — with `+` glyphs reading "created
 * on" a day two years back, under a header that says Activity. The floor is a
 * membership rule like the `isMetaPage` exclusion, not a change to the score: a
 * dormant wiki renders no section and the rail looks exactly as it did before.
 *
 * 0.02 is the point where a creation stops being news. Measured against the
 * DEFAULT weights (2026-09-12): a page reaches it **28.2 days** after it was
 * created; a change with every penalty at 1 and no type boost reaches it 15.4
 * days after the edit, and the latest any change can stay is **~17.4 days** —
 * an in-flight or proposed plan (type ×1.6) with no backlinks and no creation
 * signal, whose unknown age is not discounted (see `scorePage`); measured at
 * 0.0206 at 17.3 d, dropped at 17.5 d. Backlinks and page age only pull it in,
 * which is the intent: a much-linked old page's edit leaves the section sooner.
 */
export const ACTIVITY_MIN_SCORE = 0.02;

/** One ranked row: the page, which signal won, its score and the sentence that
 *  explains the placement (rendered as the row's `title=`). */
export interface ActivityRow {
  page: WikiListing;
  /** `new` when the CREATION signal won, `changed` when a later edit did. */
  kind: "new" | "changed";
  score: number;
  /** Human-readable derivation — every factor with its value. */
  why: string;
  /** Age in ms of the signal that won, so the row can render one relative date
   *  without re-deriving which signal that was. */
  ageMs: number;
  /** Present only on a `changed` row whose change term decayed on `workedMs`,
   *  so the row's date cell names the worked day rather than the update stamp.
   *  Absent — not `false` — so a closed gate's rows are the pre-gate objects. */
  worked?: true;
}

const PERCENT_KEYS = ["agePenalty", "hubPenalty", "planBoost", "changedWeight", "workedGate"] as const;
const HALF_LIFE_KEYS = ["halfLifeNewDays", "halfLifeChangedDays"] as const;

/**
 * Merge a wiki's declared `activity` block over the defaults.
 *
 * Same validate-warn-**degrade** shape as `.wiki-reader.json`'s other keys: a
 * value that is not a finite number of the right magnitude is dropped and the
 * default stands, and the other keys in the same block are unaffected — one bad
 * knob must not cost the wiki the whole section. Warnings name the key, since
 * the block is invisible from the rail.
 *
 * `rows` is the one knob that CLAMPS rather than drops (see
 * {@link ACTIVITY_ROWS_MIN}); a non-integer is rounded.
 */
export function parseActivityWeights(raw: unknown): {
  weights: ActivityWeights;
  warnings: ActivityWeightWarning[];
} {
  const weights: ActivityWeights = { ...DEFAULT_ACTIVITY_WEIGHTS };
  const warnings: ActivityWeightWarning[] = [];
  const warn = (key: string, reason: string): void => void warnings.push({ key, reason });
  if (raw === undefined || raw === null) return { weights, warnings };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warn("activity", "is not an object — ignoring it");
    return { weights, warnings };
  }
  const obj = raw as Record<string, unknown>;
  const num = (key: string): number | null => {
    const v = obj[key];
    if (v === undefined) return null;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      warn(`activity.${key}`, "is not a finite number — ignoring it");
      return null;
    }
    return v;
  };
  for (const key of PERCENT_KEYS) {
    const v = num(key);
    if (v === null) continue;
    if (v < 0 || v > 100) {
      warn(`activity.${key}`, "is outside 0–100 — ignoring it");
      continue;
    }
    // The gate compares integers (see `workedGateFor`); a fraction is refused
    // rather than rounded, since either rounding moves the boundary.
    if (key === "workedGate" && !Number.isInteger(v)) {
      warn(`activity.${key}`, "is not a whole number — ignoring it");
      continue;
    }
    weights[key] = v;
  }
  for (const key of HALF_LIFE_KEYS) {
    const v = num(key);
    if (v === null) continue;
    if (v <= 0 || v > HALF_LIFE_MAX_DAYS) {
      warn(`activity.${key}`, `is outside 0–${HALF_LIFE_MAX_DAYS} days — ignoring it`);
      continue;
    }
    weights[key] = v;
  }
  const rows = num("rows");
  if (rows !== null) {
    const clamped = Math.min(ACTIVITY_ROWS_MAX, Math.max(ACTIVITY_ROWS_MIN, Math.round(rows)));
    // Two different things happened to the value, and one warning text for both
    // told an author who wrote 6.4 that 6.4 is "outside 1–20".
    if (rows < ACTIVITY_ROWS_MIN || rows > ACTIVITY_ROWS_MAX) {
      warn("activity.rows", `is outside ${ACTIVITY_ROWS_MIN}–${ACTIVITY_ROWS_MAX} — using ${clamped}`);
    } else if (clamped !== rows) {
      warn("activity.rows", `rounded to ${clamped}`);
    }
    weights.rows = clamped;
  }
  // A typo'd key is silent in every other way: it changes nothing and the rail
  // looks exactly as it did.
  const known = new Set<string>(Object.keys(DEFAULT_ACTIVITY_WEIGHTS));
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) warn(`activity.${key}`, "is not a known weight — ignoring it");
  }
  return { weights, warnings };
}

/** Past this many days the rail stops counting days and names the day instead.
 *  A `4mo`/`1.2y` reading answers "roughly how long ago" for a page nobody is
 *  ranking by recency any more, where the date answers it exactly — at ten glyphs
 *  against three, which is why the seam is late rather than at a month. */
export const RAIL_AGE_MAX_DAYS = 99;

/**
 * The rail's age scale, discriminated so no caller has to sniff the text:
 * `relative` is one of `now` · `Nh` · `Nd`, and `false` is a calendar day.
 * `null` means "no usable stamp" — the same answer `pageDateLabel` gives for a
 * page carrying no date signal at all, which the callers render as `""` / `?`.
 *
 * Takes the STAMP plus the anchored instant rather than an age: the calendar
 * branch has to name a day, and an age cannot. The instant is the caller's
 * (`recencyNow()`, server-anchored — see `anchorNow`), so this reads no clock
 * and stays pure inside a render or a comparator.
 *
 * **Each bucket promotes on its own ROUNDED value, not on the raw one**, so two
 * buckets never print the same duration: at 23.6h the hour bucket would round to
 * "24h" beside a day bucket that starts at 24. Same seam at 99d and the date.
 *
 * `dayLabel` is the winning signal's own label, preferred for the calendar branch
 * under the one rule {@link calendarDay} states. Resolving it HERE is what keeps
 * the cell and the `why` sentence agreeing: both callers below read one answer.
 */
function railAge(ms: number, now: number, dayLabel?: string): { relative: boolean; text: string } | null {
  if (!Number.isFinite(ms) || ms <= 0 || !Number.isFinite(now)) return null;
  const ageMs = now - ms;
  const hours = ageMs / 3_600_000;
  // 0 and a NEGATIVE age both read "now": a stamp a few minutes ahead of the
  // anchored instant is clock skew, not the future.
  if (hours < 1) return { relative: true, text: "now" };
  const h = Math.round(hours);
  if (h < 24) return { relative: true, text: h + "h" };
  const d = Math.round(ageMs / MS_PER_DAY);
  if (d <= RAIL_AGE_MAX_DAYS) return { relative: true, text: d + "d" };
  return { relative: false, text: calendarDay(ms, dayLabel) };
}

/**
 * A label the rail may show INSTEAD of the stamp's own local day: exactly a bare
 * `YYYY-MM-DD`.
 *
 * That is the one spelling with no instant behind it — `Date.parse` reads it as
 * UTC midnight, so re-deriving the day renders the 14th for an authored
 * `created: 2026-01-15` anywhere west of UTC, and the rail would name a different
 * day than the article header. Any other label (a timestamp, a zone suffix) DOES
 * have an instant, so `localDay(ms)` is both the right day and ten glyphs wide in
 * a `flex-shrink: 0` cell.
 *
 * It is a guard on an input muninn does not validate, not a repair of live data:
 * `store.ts` passes any STRING `created:`/`updated:` through and `addedSignal`
 * echoes whatever `Date.parse` accepted as the label. Measured 2026-09-13 over
 * all three registered wikis (mimir 528 pages, melosys-kode-wiki 395, jarvis
 * 1261): every frontmatter date is already a bare day, so today the branch is
 * reached zero times.
 */
const BARE_DAY_LABEL = /^\d{4}-\d{2}-\d{2}$/;
function calendarDay(ms: number, dayLabel?: string): string {
  return dayLabel && BARE_DAY_LABEL.test(dayLabel) ? dayLabel : localDay(new Date(ms));
}

/**
 * A page's date as EVERY rail row renders it: `now` · `Nh` · `Nd` up to
 * {@link RAIL_AGE_MAX_DAYS} days, then a plain `YYYY-MM-DD`.
 *
 * A relative age is what the rail needs of a recent page — "2d" reads as news
 * where a calendar day reads as a sort key — and the reverse holds for an old
 * one, where the count has stopped being a duration anyone subtracts. The full
 * date stays one hover away on every row (`renderList` puts it on the meta
 * element's own `title=`) and the ARTICLE header still shows both dates in full:
 * this is the rail's compact spelling, not a change to what is known.
 *
 * `dayLabel` is the day the caller ALREADY has for this stamp — the winning
 * signal's own label (`pageDateSignal().label`). Past the relative window it wins
 * over this function's own `localDay(ms)` when, and only when, it is a bare day:
 * see {@link calendarDay}. Omitted, blank or time-bearing ⇒ the local day of the
 * stamp.
 */
export function formatRailAge(ms: number, now: number, dayLabel?: string): string {
  return railAge(ms, now, dayLabel)?.text ?? "";
}

/** The age as the `why` sentence says it: "just now" reads as a moment where
 *  "now ago" reads as a bug, and past {@link RAIL_AGE_MAX_DAYS} the calendar day
 *  takes "on" rather than "ago" for the same reason. `?` for a page with no
 *  stamp, which is the sentence's own spelling for an unknown age (a page with
 *  no creation signal reaches here through exactly that branch).
 *
 *  It takes the signal's `dayLabel` for the same reason the cell does, and reads
 *  the SAME resolved text: a sentence explaining a row must not name a different
 *  day than the row. */
function agePhrase(ms: number, now: number, dayLabel?: string): string {
  const age = railAge(ms, now, dayLabel);
  if (!age) return "?";
  if (!age.relative) return "on " + age.text;
  return age.text === "now" ? "just now" : age.text + " ago";
}

/**
 * A change counts as a CHANGE only when it landed more than this many days after
 * the page was created. Under it the "edit" is the same writing session as the
 * creation — a page committed, then fixed an hour later — and reporting it as a
 * change would list every new page twice, once under each kind.
 */
const CHANGE_MIN_DAYS_AFTER_CREATION = 1;

/** Reference scales for the two penalties, so `agePenalty`/`hubPenalty` = 100
 *  means "a page this old / this linked scores half". Named because the numbers
 *  are the prototype's and the sliders' hints are written against them. */
const AGE_PENALTY_REFERENCE_DAYS = 30;
const HUB_PENALTY_REFERENCE_BACKLINKS = 5;

/**
 * Whether this wiki's Activity ranking may substitute `workedMs` for the update
 * stamp, and the numbers behind the verdict.
 *
 * The denominator is the RANKED CANDIDATE SET — non-meta `.md`/`.mdx` pages
 * clearing {@link ACTIVITY_MIN_SCORE} with substitution off. `.html` pages are
 * left out because the upstream ledger query returns only those two extensions,
 * so one could never be covered — and so is `WikiIndex.workedCoverage`, whose
 * denominator includes them.
 */
export interface WorkedGate {
  /** `covered / candidates ≥ workedGate / 100`; with no candidates, only a
   *  gate of 0 is open. */
  open: boolean;
  candidates: number;
  /** Candidates carrying a usable `workedMs`. */
  covered: number;
  /** `covered / candidates`, 0 when there are no candidates. */
  coverage: number;
  /** The ledger's horizon (`workedCoverage.horizonMs`): the newest session
   *  stamp it reported for this root. A covered page is demoted to an OLDER
   *  worked date only when its update stamp is at or before this; absent ⇒
   *  never. It does not affect `open`. */
  horizonMs?: number;
}

/**
 * A page's worked stamp, or 0 when it has none this ranking may use.
 *
 * ⚠️ Reads `page.workedMs` DIRECTLY, through `workedSignal`'s predicate but not
 * `workedSignal` itself: that falls back to the update signal, so every
 * uncovered page would "substitute" its own update stamp and every wiki would
 * measure fully covered.
 */
function usableWorkedMs(page: WikiListing, now: number): number {
  return isUsableWorkedMs(page.workedMs, now) ? page.workedMs : 0;
}

/** The extensions the upstream ledger query returns (`sessionPagesUnderRoot`,
 *  case-sensitive there too). */
const LEDGER_PAGE_EXT = /\.mdx?$/;

/**
 * Measure the worked gate for ONE listing — once per payload, over the FULL page
 * set. Measured over the rail's filtered rows it would open and shut as the
 * reader changes a facet, which is a fact about the facet, not the wiki.
 *
 * Pass 1 scores with substitution forced off, so the candidate set cannot be
 * reshaped by the substitution it decides about. The comparison is on integers
 * (`covered × 100 ≥ gate × candidates`), so 60% of 5 is exactly 3.
 */
export function workedGateFor(
  pages: readonly WikiListing[],
  weights: ActivityWeights,
  now: number,
  horizonMs?: number,
): WorkedGate {
  let candidates = 0;
  let covered = 0;
  for (const page of pages) {
    if (isMetaPage(page) || !LEDGER_PAGE_EXT.test(page.relPath)) continue;
    if (scorePage(page, weights, now, null).score < ACTIVITY_MIN_SCORE) continue;
    candidates++;
    if (usableWorkedMs(page, now) > 0) covered++;
  }
  return {
    // With no candidates the product test is 0 ≥ 0 at every gate; only 0 opens.
    open: candidates > 0 ? covered * 100 >= weights.workedGate * candidates : weights.workedGate === 0,
    candidates,
    covered,
    coverage: candidates > 0 ? covered / candidates : 0,
    ...(horizonMs === undefined ? {} : { horizonMs }),
  };
}

/**
 * Rank pages by activity, best first, truncated to `weights.rows`.
 *
 * Bookkeeping pages are excluded outright (`isMetaPage`): nearly every wiki
 * write touches `log.md` and `index.md`, so their recency is the write traffic
 * itself — the same reason the recency sorts sink them. So is anything scoring
 * below {@link ACTIVITY_MIN_SCORE}, which is what lets the section be EMPTY on a
 * wiki where nothing has happened.
 *
 * `now` is a parameter, not a clock read, for the same reason `pageTimeMs`'s is:
 * this runs inside a comparator and one instant per pass keeps it pure. The
 * caller passes the server-anchored instant.
 *
 * Ties break on the displayed title, so the order is total and a re-render of an
 * unchanged listing paints the same rows in the same places.
 *
 * `gate` is the payload's {@link workedGateFor} verdict. Absent or closed ⇒ the
 * ranking is the pre-gate one exactly.
 */
export function rankActivity(
  pages: readonly WikiListing[],
  weights: ActivityWeights,
  now: number,
  gate?: WorkedGate | null,
): ActivityRow[] {
  const substitute = gate?.open === true ? gate : null;
  const rows: ActivityRow[] = [];
  for (const page of pages) {
    if (isMetaPage(page)) continue;
    const row = scorePage(page, weights, now, substitute);
    if (row.score >= ACTIVITY_MIN_SCORE) rows.push(row);
  }
  rows.sort((a, b) => b.score - a.score || displayTitleOf(a.page).localeCompare(displayTitleOf(b.page)));
  return rows.slice(0, weights.rows);
}

/**
 * One page's score.
 *
 * A page with NO date signal at all scores 0 and the floor drops it — there is
 * no separate guard, because the two gates below already answer for it: with no
 * creation signal there is no `newScore`, and with no update signal there is no
 * change. An `if (both absent) return null` line sat here and was untestable by
 * construction, which is its own kind of wrong.
 *
 * `substitute` (an open gate, or null) puts a covered page's `workedMs` in place
 * of the update stamp for the change term and counts it as an edit whatever the
 * update signal's kind: a ledger write IS a known edit event. Two limits, both
 * falling back to the unsubstituted score:
 *  - an OLDER worked date replaces the update only when the update is at or
 *    before the gate's `horizonMs` — past it, the ledger has not seen that far;
 *  - on an `added`-floor page (whose update stamp is its git arrival) the worked
 *    date must land more than {@link CHANGE_MIN_DAYS_AFTER_CREATION} after the
 *    floor, or it is the session that brought the page there, not an edit.
 */
function scorePage(
  page: WikiListing,
  w: ActivityWeights,
  now: number,
  substitute: Pick<WorkedGate, "horizonMs"> | null,
): ActivityRow {
  // ONE derivation per signal, because each carries three facts this function
  // needs: the stamp, the label the `why` sentence must quote, and (for the update
  // signal) the kind the `isEdit` gate reads.
  const created = pageDateSignal(page, "added", now);
  const updated = pageDateSignal(page, "updated", now);
  const createdMs = created?.ms ?? 0;
  const workedMs = substitute ? usableWorkedMs(page, now) : 0;
  const updMs = updated?.ms ?? 0;
  const worked =
    workedMs > 0 &&
    (updated?.kind === "added"
      ? workedMs - updMs > CHANGE_MIN_DAYS_AFTER_CREATION * MS_PER_DAY
      : workedMs >= updMs || (substitute?.horizonMs !== undefined && updMs <= substitute.horizonMs));
  // A demotion set an update aside (named in the `why` below, when it moved
  // the row, so a page git changed yesterday that now reads `+ 6d` says why).
  const setAside = worked && updated?.kind === "updated" && updMs > workedMs;
  // The change term's stamp — the only thing substitution replaces.
  const changeMs = worked ? workedMs : updMs;
  // Ages in DAYS, which is the unit every knob below is expressed in. A page
  // with no creation signal has no `createdDays` at all — see `knownAge`.
  const knownAge = createdMs > 0;
  const createdDays = (now - createdMs) / MS_PER_DAY;
  const changeDays = (now - changeMs) / MS_PER_DAY;

  // No creation signal ⇒ the page cannot be NEW. (It can still be a change; the
  // branch below says so.)
  const newScore = knownAge ? Math.pow(0.5, createdDays / w.halfLifeNewDays) : 0;

  /**
   * ⚠️ **An update signal is not the same thing as an EDIT.** `updatedSignal`
   * falls back to the git CREATION date for a page whose every commit was a
   * sweep, and flags that fallback `kind: "added"` precisely because nothing is
   * known about when the page was last edited. Read as a date alone it opens a
   * gap against `pageAddedMs`, which takes the OLDEST of its three inputs — so a
   * birthtime or a frontmatter `created:` older than the git floor made the page
   * "changed <the day it was created>", scoring ABOVE the creation it is made
   * of. Measured on the jarvis wiki (2026-09-12, 1242 pages): 611 pages carry
   * the floor as their date and 534 of those open such a gap; none clears the
   * floor TODAY, because every one is over 50 days old — the shape bites when
   * the floor is recent (a re-clone, an import), which is what the unit fixture
   * builds. The gate is the signal's own kind, never a threshold on the dates.
   */
  const isEdit = worked || updated?.kind === "updated";
  // With a known creation date the edit must also be late enough to be a
  // separate event. The `!knownAge` clause is defensive only: with no creation
  // signal `createdDays` counts from epoch 0, so the gap test would fail solely
  // for an update stamped within half a day of 1970-01-01, which nothing
  // produces — the clause is unpinned and the rule is the same without it.
  const isChange =
    isEdit && (!knownAge || createdDays - changeDays > CHANGE_MIN_DAYS_AFTER_CREATION);
  let changedScore = 0;
  const parts: string[] = [];
  if (isChange) {
    const recency = Math.pow(0.5, changeDays / w.halfLifeChangedDays);
    // An UNKNOWN age is not evidence of an old page, so it is not discounted:
    // the penalty exists to say "this page has been around a long time", which
    // is a claim no signal here supports.
    const age = knownAge
      ? 1 / (1 + (w.agePenalty / 100) * (createdDays / AGE_PENALTY_REFERENCE_DAYS))
      : 1;
    const backlinks = page.backlinkCount || 0;
    const hub = 1 / (1 + (w.hubPenalty / 100) * (backlinks / HUB_PENALTY_REFERENCE_BACKLINKS));
    let boost = 1;
    if (page.type === "plan") {
      boost += (w.planBoost / 100) * (page.plan_status === "in-flight" || page.plan_status === "proposed" ? 1.2 : 0.6);
    }
    if (page.type === "blog") boost += (w.planBoost / 100) * 0.2;
    changedScore = (w.changedWeight / 100) * recency * age * hub * boost;
    // `weight` leads the list because it leads the product: without it the
    // factors a reader multiplies come out 1/0.7 too high against the score
    // printed beside them.
    parts.push(
      `weight ×${(w.changedWeight / 100).toFixed(2)}`,
      `recency ${recency.toFixed(2)}`,
      `age ×${age.toFixed(2)}`,
      `hub ×${hub.toFixed(2)} (${backlinks}←)`,
      `type ×${boost.toFixed(2)}`,
    );
  }

  const kind: "new" | "changed" = newScore >= changedScore ? "new" : "changed";
  const score = Math.max(newScore, changedScore);
  // `agePhrase` answers "?" for a stamp of 0 on its own, which is exactly what
  // `!knownAge` means here. Both phrases get their signal's LABEL, so a sentence
  // explaining a row names the same day the row's cell shows — for the creation
  // phrase that is the reachable case (a change to an old page), while the change
  // phrase's calendar branch is UNPINNED: at default weights a change survives the
  // floor for ~13 days, so it is reachable only under a configured
  // `halfLifeChangedDays` (365 keeps a 550-day-old change); no test covers it.
  const createdPhrase = agePhrase(createdMs, now, created?.label);
  // A worked stamp is a wall-clock instant with no label of its own — its local
  // day, which is what `calendarDay` derives when given none.
  const changedPhrase = worked
    ? `worked on ${agePhrase(changeMs, now)}`
    : `changed ${agePhrase(changeMs, now, updated?.label)}`;
  let why =
    kind === "new"
      ? `created ${createdPhrase} → ${newScore.toFixed(2)}`
      : `${changedPhrase}, created ${createdPhrase}: ${parts.join(", ")} → ${changedScore.toFixed(2)}`;
  if (setAside) {
    const unsubstituted = scorePage(page, w, now, null);
    if (unsubstituted.kind !== kind || unsubstituted.score !== score) {
      why += `; update ${agePhrase(updMs, now, updated?.label)} not a session write`;
    }
  }
  const row: ActivityRow = { page, kind, score, why, ageMs: kind === "new" ? now - createdMs : now - changeMs };
  if (worked && kind === "changed") row.worked = true;
  return row;
}
