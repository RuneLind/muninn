/**
 * Detection (not discounting) for BULK FRONTMATTER RESTAMPS — the one way a wiki's
 * "Recently updated" ordering can still collapse onto a single day after the
 * sweep-awareness work (`git-dates.ts` + `updatedSignal`).
 *
 * ## The hole this watches
 *
 * The sort discounts sweeps by asking git: a commit touching ≥ `SWEEP_THRESHOLD`
 * wiki files contributes no update date at all. A sweep that REWRITES FRONTMATTER
 * bypasses that by construction — the restamp commit is itself a sweep, so git
 * contributes nothing, and the `updated:` stamps it wrote are then the only surviving
 * signal for every page it touched. One lint pass stamping today's date across a few
 * hundred pages re-collapses the list, and no git-side threshold can see it.
 *
 * There is no safe automatic remedy: the stamps are indistinguishable, page by page,
 * from a page that really was edited that day (a page authored and stamped on the same
 * day is the normal case). So this module does not change any ordering. It names the
 * shape in the log so an operator can go look.
 *
 * ## Why the naive predicate is useless
 *
 * "Many pages share one `updated:` day AND have no non-sweep touch" fires permanently
 * on every benign bulk INGEST: pages born in a sweep share their birth day as their
 * stamp and have no non-sweep touch ever after. Measured on jarvis, 221 pages match
 * that shape for 2026-04-25 alone — and correctly so, since the stamp IS their birth
 * date.
 *
 * The dangerous signature is the RESTAMP: a stamp day X on pages whose git CREATION
 * sits well before X, with no non-sweep commit on or after X to explain the claimed
 * edit. Nothing wrote those pages on day X except a sweep, and a sweep is exactly what
 * the stamp is being trusted over. Measured on jarvis, the real 2026-06-10 restamp
 * cohort (23 pages first committed 04-09 → 05-30) matches while the 04-25 ingest does
 * not.
 */

import { localDay } from "../dashboard/views/components/wiki-filter.ts";

const DAY_MS = 86_400_000;

/**
 * How many pages must share one restamped day before the build warns.
 *
 * 20. The signature is only actionable in bulk — a handful of pages carrying an
 * optimistic `updated:` is ordinary authoring noise, while the failure mode being
 * watched (a lint or backfill sweep) writes hundreds. Sized against the measured
 * jarvis 2026-06-10 cohort (23 pages, the real restamp this was written from) so a
 * repeat of it fires, while sitting far above what a person restamps by hand in one
 * sitting.
 */
export const RESTAMP_COHORT_MIN_PAGES = 20;

/**
 * How much older than the stamp day a page's git creation must be before the stamp
 * counts as a RE-stamp rather than a birth date.
 *
 * 2 days, not 1: a page written late in the evening and committed after midnight —
 * or written and committed across a timezone boundary — is legitimately "created the
 * day after its stamp", and a 1-day lead would sweep those in. Anything genuinely
 * restamped by a later sweep is weeks out, so the slack costs nothing.
 */
export const RESTAMP_MIN_LEAD_DAYS = 2;

/** How many offending relPaths a warn names before collapsing the rest into a count
 *  (same shape as the plan-status drop warn in `store.ts`). */
export const RESTAMP_SAMPLE_CAP = 3;

/** The subset of `WikiPageMeta` this predicate reads. Kept structural so the pure
 *  layer needs no store types (and tests need no full page objects). */
export interface RestampCandidate {
  relPath: string;
  created?: string;
  updated?: string;
  gitCreatedMs?: number;
  gitTouchedMs?: number;
}

/** One day whose frontmatter stamps look mass-rewritten. */
export interface RestampCohort {
  /** The shared stamp day, `YYYY-MM-DD`. */
  day: string;
  /** How many pages carry it in the restamp shape. */
  count: number;
  /** First `RESTAMP_SAMPLE_CAP` relPaths, in input order. */
  samples: string[];
}

/** UTC-midnight ms of the LOCAL day an instant falls in — git stamps are wall-clock
 *  instants, and the day they belong to is the day the author saw. */
function instantDayMs(ms: number): number {
  return Date.parse(localDay(new Date(ms)));
}

/** UTC-midnight ms of a frontmatter stamp, which is authored as a plain day and so
 *  parses to UTC midnight already; the floor only matters for the rare page that
 *  wrote a full timestamp. NaN when unparseable. */
function stampDayMs(raw: string): number {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return NaN;
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * Group the pages whose frontmatter stamp has the restamp shape by their stamp day
 * and return the days at or above `minPages`, oldest first.
 *
 * A page qualifies when all three hold:
 *  - it carries a frontmatter stamp (`updated:`, else `created:` — the same "effective
 *    stamp" `updatedSignal` sorts on, so what is measured is what is ranked),
 *  - git knows the page and first committed it ≥ `RESTAMP_MIN_LEAD_DAYS` before that
 *    day (so the stamp cannot be its birth date), and
 *  - git records NO non-sweep commit on or after that day (so nothing but a sweep
 *    happened when the stamp claims an edit did).
 *
 * A page git has never heard of is skipped rather than counted: without a creation
 * date there is no way to tell a restamp from a birth stamp, and an untracked draft
 * would otherwise join every cohort.
 */
export function detectBulkRestamps(
  pages: readonly RestampCandidate[],
  minPages = RESTAMP_COHORT_MIN_PAGES,
): RestampCohort[] {
  const byDay = new Map<number, { count: number; samples: string[] }>();
  const leadMs = RESTAMP_MIN_LEAD_DAYS * DAY_MS;

  for (const p of pages) {
    const stamp = p.updated || p.created || "";
    if (!stamp) continue;
    if (p.gitCreatedMs === undefined) continue;
    const dayMs = stampDayMs(stamp);
    if (!Number.isFinite(dayMs)) continue;
    if (instantDayMs(p.gitCreatedMs) > dayMs - leadMs) continue;
    // A non-sweep commit ON the stamp day corroborates it — that is a real edit, and
    // the page is out of the cohort even though its creation is older.
    if (p.gitTouchedMs !== undefined && instantDayMs(p.gitTouchedMs) >= dayMs) continue;
    let bucket = byDay.get(dayMs);
    if (!bucket) {
      bucket = { count: 0, samples: [] };
      byDay.set(dayMs, bucket);
    }
    bucket.count++;
    if (bucket.samples.length < RESTAMP_SAMPLE_CAP) bucket.samples.push(p.relPath);
  }

  return [...byDay.entries()]
    .filter(([, b]) => b.count >= minPages)
    .sort((a, b) => a[0] - b[0])
    // `dayMs` is UTC midnight by construction (both normalizers land there), so the
    // ISO prefix IS the day — `localDay` would shift it back a day west of UTC.
    .map(([dayMs, b]) => ({
      day: new Date(dayMs).toISOString().slice(0, 10),
      count: b.count,
      samples: b.samples,
    }));
}
