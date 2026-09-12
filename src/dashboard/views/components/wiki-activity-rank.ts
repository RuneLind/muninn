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
 *    (0.70).
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
  pageAddedMs,
  pageDateKind,
  pageTimeMs,
  type WikiListing,
} from "./wiki-filter.ts";

/**
 * The ranking's knobs. The four percent knobs are 0–100 with the prototype
 * slider's semantics (0 = the factor is off, 100 = the reference strength named
 * in {@link rankActivity}); the two half-lives are days; `rows` is how many rows
 * the section renders.
 */
export interface ActivityWeights {
  /** Rows the Activity section renders, 1–12. */
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
};

/** Bounds on `rows`: below 1 the section cannot render and above 12 it is the
 *  listing with extra furniture. A number outside them is CLAMPED rather than
 *  dropped — the author's intent ("as many as you can") is unambiguous. */
export const ACTIVITY_ROWS_MIN = 1;
export const ACTIVITY_ROWS_MAX = 12;
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
 * 2.1y ago" under a header that says Activity. The floor is a membership rule
 * like the `isMetaPage` exclusion, not a change to the score: a dormant wiki
 * renders no section and the rail looks exactly as it did before.
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
}

const PERCENT_KEYS = ["agePenalty", "hubPenalty", "planBoost", "changedWeight"] as const;
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
    // told an author who wrote 6.4 that 6.4 is "outside 1–12".
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

/**
 * A duration as the rail renders it: `now` · `Nh` · `Nd` · `Nmo` · `N.Ny`.
 *
 * Takes an AGE in ms rather than a timestamp, so the caller owns the clock read
 * (the rail anchors its instant to the server's scan — see `recencyNow`). Only a
 * NON-FINITE age renders as `""`; 0 and a negative age both read "now", which is
 * what a stamp a few minutes ahead of the anchor deserves.
 *
 * Not one of the repo's other relative-time helpers, and deliberately: this one
 * takes an age rather than a timestamp (so it reads no clock and stays pure
 * inside a comparator) and it carries `mo`/`y` buckets, which a chat-scale
 * "N min ago" formatter has no use for.
 *
 * **Each bucket is promoted on its own ROUNDED value, not on the raw one**, so
 * two buckets never print the same duration: at 29.6 days the day bucket rounds
 * to 30 and the label would have been "30d" beside a "1mo" that starts at 30.0.
 * Same seam at 24h/1d and at 12mo/1.0y.
 */
export function formatRelativeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return "";
  const hours = ageMs / 3_600_000;
  if (hours < 1) return "now";
  const h = Math.round(hours);
  if (h < 24) return h + "h";
  const days = ageMs / MS_PER_DAY;
  const d = Math.round(days);
  if (d < 30) return d + "d";
  const mo = Math.round(days / 30);
  if (mo < 12) return mo + "mo";
  return (days / 365).toFixed(1) + "y";
}

/** The age as the `why` sentence says it: "just now" reads as a moment, where
 *  "now ago" reads as a bug. */
function agePhrase(ageMs: number): string {
  const label = formatRelativeAge(ageMs);
  return label === "now" ? "just now" : label + " ago";
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
 */
export function rankActivity(
  pages: readonly WikiListing[],
  weights: ActivityWeights,
  now: number,
): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const page of pages) {
    if (isMetaPage(page)) continue;
    const row = scorePage(page, weights, now);
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
 */
function scorePage(page: WikiListing, w: ActivityWeights, now: number): ActivityRow {
  const createdMs = pageAddedMs(page, now);
  const updatedMs = pageTimeMs(page, now);
  // Ages in DAYS, which is the unit every knob below is expressed in. A page
  // with no creation signal has no `createdDays` at all — see `knownAge`.
  const knownAge = createdMs > 0;
  const createdDays = (now - createdMs) / MS_PER_DAY;
  const updatedDays = (now - updatedMs) / MS_PER_DAY;

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
  const isEdit = updatedMs > 0 && pageDateKind(page, now) === "updated";
  // With a known creation date the edit must also be late enough to be a
  // separate event. The `!knownAge` clause is defensive only: with no creation
  // signal `createdDays` counts from epoch 0, so the gap test would fail solely
  // for an update stamped within half a day of 1970-01-01, which nothing
  // produces — the clause is unpinned and the rule is the same without it.
  const isChange =
    isEdit && (!knownAge || createdDays - updatedDays > CHANGE_MIN_DAYS_AFTER_CREATION);
  let changedScore = 0;
  const parts: string[] = [];
  if (isChange) {
    const recency = Math.pow(0.5, updatedDays / w.halfLifeChangedDays);
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
  const createdPhrase = knownAge ? agePhrase(now - createdMs) : "?";
  const why =
    kind === "new"
      ? `created ${createdPhrase} → ${newScore.toFixed(2)}`
      : `changed ${agePhrase(now - updatedMs)}, created ${createdPhrase}: ` +
        `${parts.join(", ")} → ${changedScore.toFixed(2)}`;
  return { page, kind, score, why, ageMs: kind === "new" ? now - createdMs : now - updatedMs };
}
