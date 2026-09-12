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
 *    `halfLifeChangedDays` (shorter by default, so a creation outranks a change
 *    of equal age).
 *  - **page age** — a change to an old page counts for less (`agePenalty`).
 *  - **hub weight** — a change to a page many pages link to counts for less
 *    (`hubPenalty`), which is what keeps `log.md`-shaped traffic out.
 *  - **type** — plans, and in-flight/proposed plans more, count for more
 *    (`planBoost`).
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
  /** A fresh change against a fresh creation. 100 = equal. */
  changedWeight: number;
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
 * created, and a change to an unpenalised page — no backlinks, no age discount —
 * reaches it **15.4 days** after the edit. Every penalty pulls that in, which is
 * the intent: a much-linked old page's edit leaves the section sooner.
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
export function parseActivityWeights(raw: unknown): { weights: ActivityWeights; warnings: string[] } {
  const weights: ActivityWeights = { ...DEFAULT_ACTIVITY_WEIGHTS };
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { weights, warnings };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("activity is not an object — ignoring it");
    return { weights, warnings };
  }
  const obj = raw as Record<string, unknown>;
  const num = (key: string): number | null => {
    const v = obj[key];
    if (v === undefined) return null;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      warnings.push(`activity.${key} is not a finite number — ignoring it`);
      return null;
    }
    return v;
  };
  for (const key of PERCENT_KEYS) {
    const v = num(key);
    if (v === null) continue;
    if (v < 0 || v > 100) {
      warnings.push(`activity.${key} is outside 0–100 — ignoring it`);
      continue;
    }
    weights[key] = v;
  }
  for (const key of HALF_LIFE_KEYS) {
    const v = num(key);
    if (v === null) continue;
    if (v <= 0 || v > HALF_LIFE_MAX_DAYS) {
      warnings.push(`activity.${key} is outside 0–${HALF_LIFE_MAX_DAYS} days — ignoring it`);
      continue;
    }
    weights[key] = v;
  }
  const rows = num("rows");
  if (rows !== null) {
    const clamped = Math.min(ACTIVITY_ROWS_MAX, Math.max(ACTIVITY_ROWS_MIN, Math.round(rows)));
    if (clamped !== rows) {
      warnings.push(
        `activity.rows ${rows} is outside ${ACTIVITY_ROWS_MIN}–${ACTIVITY_ROWS_MAX} — using ${clamped}`,
      );
    }
    weights.rows = clamped;
  }
  // A typo'd key is silent in every other way: it changes nothing and the rail
  // looks exactly as it did.
  const known = new Set<string>(Object.keys(DEFAULT_ACTIVITY_WEIGHTS));
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) warnings.push(`activity.${key} is not a known weight — ignoring it`);
  }
  return { weights, warnings };
}

/**
 * A duration as the rail renders it: `now` · `Nh` · `Nd` · `Nmo` · `N.Ny`.
 *
 * Takes an AGE in ms rather than a timestamp, so the caller owns the clock read
 * (the rail anchors its instant to the server's scan — see `recencyNow`).
 * A non-positive or non-finite age renders as `""`: a page with no usable date
 * signal must show no date rather than a number derived from epoch 0.
 */
export function formatRelativeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return "";
  const days = ageMs / MS_PER_DAY;
  // Negative falls in here too: a stamp a few minutes ahead of the anchor is
  // clock skew, and "now" is the honest reading of it.
  if (days < 1 / 24) return "now";
  if (days < 1) return Math.round(days * 24) + "h";
  if (days < 30) return Math.round(days) + "d";
  if (days < 365) return Math.round(days / 30) + "mo";
  return (days / 365).toFixed(1) + "y";
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
    if (row && row.score >= ACTIVITY_MIN_SCORE) rows.push(row);
  }
  rows.sort((a, b) => b.score - a.score || displayTitleOf(a.page).localeCompare(displayTitleOf(b.page)));
  return rows.slice(0, weights.rows);
}

/** One page's score, or null when it carries no usable date signal at all. */
function scorePage(page: WikiListing, w: ActivityWeights, now: number): ActivityRow | null {
  const createdMs = pageAddedMs(page, now);
  const updatedMs = pageTimeMs(page, now);
  if (createdMs <= 0 && updatedMs <= 0) return null;
  // Ages in DAYS, which is the unit every knob below is expressed in. A page
  // with no creation signal is treated as maximally old rather than as new:
  // `createdDays` then runs from epoch 0 and the decay answers ~0.
  const createdDays = (now - createdMs) / MS_PER_DAY;
  const updatedDays = (now - updatedMs) / MS_PER_DAY;

  const newScore = Math.pow(0.5, createdDays / w.halfLifeNewDays);

  const isChange = createdMs > 0 && updatedMs > 0 && createdDays - updatedDays > CHANGE_MIN_DAYS_AFTER_CREATION;
  let changedScore = 0;
  const parts: string[] = [];
  if (isChange) {
    const recency = Math.pow(0.5, updatedDays / w.halfLifeChangedDays);
    const age = 1 / (1 + (w.agePenalty / 100) * (createdDays / AGE_PENALTY_REFERENCE_DAYS));
    const backlinks = page.backlinkCount || 0;
    const hub = 1 / (1 + (w.hubPenalty / 100) * (backlinks / HUB_PENALTY_REFERENCE_BACKLINKS));
    let boost = 1;
    if (page.type === "plan") {
      boost += (w.planBoost / 100) * (page.plan_status === "in-flight" || page.plan_status === "proposed" ? 1.2 : 0.6);
    }
    if (page.type === "blog") boost += (w.planBoost / 100) * 0.2;
    changedScore = (w.changedWeight / 100) * recency * age * hub * boost;
    parts.push(
      `recency ${recency.toFixed(2)}`,
      `age ×${age.toFixed(2)}`,
      `hub ×${hub.toFixed(2)} (${backlinks}←)`,
      `type ×${boost.toFixed(2)}`,
    );
  }

  const kind: "new" | "changed" = newScore >= changedScore ? "new" : "changed";
  const score = Math.max(newScore, changedScore);
  const why =
    kind === "new"
      ? `created ${formatRelativeAge(now - createdMs)} ago → ${newScore.toFixed(2)}`
      : `changed ${formatRelativeAge(now - updatedMs)} ago, created ${formatRelativeAge(now - createdMs)} ago: ` +
        `${parts.join(", ")} → ${changedScore.toFixed(2)}`;
  return { page, kind, score, why, ageMs: kind === "new" ? now - createdMs : now - updatedMs };
}
