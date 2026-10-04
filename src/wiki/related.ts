/**
 * RELATED WORK — the pages one hop from an open page, with the reason each one
 * is there.
 *
 * ```
 * related = cites ∪ cited-by ∪ shares ≥2 PR refs ∪ shares a session,
 *           minus hubs, never transitive
 * ```
 *
 * The membership rule is `neighbours()` in `strength.ts` — the ONE neighbour
 * rule, which the find palette's near map reads too. This module turns each
 * neighbour into a why line and orders the rows.
 *
 * Deterministic, no model and no embedding: it changes only when a page's text
 * changes. That is the point — the `Similar` section beside it in the same panel
 * is the semantic answer, and this one is the answer a reader can reproduce.
 *
 * **Never transitive**, and that is a measurement rather than a preference: the
 * largest connected component of mimir's raw link graph is 189 of 379 narrative
 * pages (`scripts/lint-series-dryrun.ts`, 2026-09-20), so "reachable" groups
 * half the wiki and says nothing. One hop is the whole rule. The reader's ▸
 * SECOND hop (`GET /api/wiki/related`) does not bend it: it is an explicit
 * request for ANOTHER page's one hop, minus the page already open.
 *
 * **Why ≥2 shared PR refs and not one.** A single shared PR number pairs every
 * page that mentions a busy week; two is what made the dry run's pairs read as
 * one piece of work.
 *
 * **Bookkeeping, hub and PR digest are SYMMETRIC cuts**: each says "this page
 * is not a piece of work", which is as true of the page you have open as of a
 * candidate. A bookkeeping or hub page therefore gets no block at all — see
 * {@link computeRelated} for what the one-sided version measured. The FOURTH,
 * the session digest (`STRENGTH_SESSION_DIGEST`), cuts a session stamped on
 * too many pages, whichever end is open.
 *
 * Pure and index-only: it takes the built `WikiIndex` and a relPath and returns
 * the DECISION (which pages, and why), never a listing row. The route
 * (`/api/wiki/page`) maps each decision onto `toListing` — the same shape the
 * panel's other rows use — so this module stays unit-testable without a Hono
 * app and the listing shape stays owned by the one function that strips it.
 */

import { bySeriesDateDesc } from "../dashboard/views/components/wiki-groups.ts";
import type { WikiIndex } from "./store.ts";
import { isBookkeeping, linkOf, neighbours } from "./strength.ts";
import {
  REASON_SESSION_PREFIX,
  RELATED_DIGEST_PRS,
  RELATED_HUB_BACKLINKS,
  RELATED_SHARED_PRS_MIN,
  RELATED_SHARED_PRS_SHOWN,
} from "./related-constants.ts";

// Re-exported so the rule and its tests read one name each — the numbers and
// what they were measured against live in `related-constants.ts`, which imports
// nothing and therefore loads under Playwright's loader too.
export {
  RELATED_DIGEST_PRS,
  RELATED_HUB_BACKLINKS,
  RELATED_SHARED_PRS_MIN,
  RELATED_SHARED_PRS_SHOWN,
};

// `isBookkeeping` lives with the neighbour rule in `strength.ts` and is
// re-exported here so `lint-series.ts`'s import is unchanged and the
// dependency runs one way: `related.ts` → `strength.ts`.
export { isBookkeeping };

/** Which signals tie a row to the open page, in the shape the reader's bar
 *  draws. `link` is `in` when the row cites the open page, `out` when the open
 *  page cites the row. `prs` and `sessions` are every shared ref, in the open
 *  page's spelling; `prs` is `[]` when the PR signal does not count (under two
 *  shared, or a digest at either end). */
export interface RelatedSignals {
  link: "out" | "in" | "both" | null;
  prs: string[];
  sessions: string[];
}

/** One related page: which page, how strongly, and the one line saying why. */
export interface RelatedRef {
  /** The candidate's relPath, exactly as `WikiPageMeta.relPath` spells it. */
  relPath: string;
  /** The reasons, joined with ` · ` — e.g.
   *  `cites this page · shares RuneLind/claude-usage#207, RuneLind/muninn#550`. */
  why: string;
  /** `neighbours()`' score, rounded to one decimal — the value the reader
   *  prints, and the value the order compares, so two rows printing the same
   *  number are a tie. */
  strength: number;
  signals: RelatedSignals;
}

/** The two link reasons. A why line pushes its reasons in one fixed order —
 *  cites, cited by, shares PRs, shares session — so a page reached by two
 *  signals reads the same way on every build. */
const REASON_CITES = "cites this page";
const REASON_CITED_BY = "cited by this page";

/**
 * The related pages for `relPath`, strongest first.
 *
 * "Strongest" is `neighbours()`' score — one rule for membership and weight
 * (`strength.ts`). Ties, which are common (every one-way link alone scores
 * 1.0), fall to {@link bySeriesDateDesc}: `status_date`, else the durable git
 * touch date, else the file's mtime, at DAY granularity with the rung as the
 * tie-break — the series fold's own order. The reader's `Newest` toggle
 * re-sorts client-side on the worked-on axis its age column shows.
 *
 * Returns `[]` for an unknown relPath and for a page with no neighbours — the
 * route passes that through and the reader renders no block at all.
 *
 * **The bookkeeping and hub cuts apply to the OPEN page too**, the way the
 * digest cut already did: each one says "this page is not a piece of work", and
 * that is as true of the page you have open as of a candidate. Measured on the
 * 547-page mimir clone with the cuts on candidates only, opening `index.md`
 * yielded **340** rows (+220 KB on one response), `plans/index.md` 246, `log.md`
 * 189 and `flows/how-we-build.mdx` — cut as a candidate at 27 backlinks — 36.
 * With both applied to the open page as well, the largest block on that clone
 * was **33** rows (`overview.md`, 2026-09-20) — the link graph's own bound, and
 * a past measurement: live mimir on 2026-10-04 (585 pages) gave 58. No cap is declared, because a cap
 * would silently drop rows from a page that really does have that many
 * neighbours.
 */
export function computeRelated(index: WikiIndex, relPath: string): RelatedRef[] {
  return neighbours(index, relPath)
    .map((n) => {
      const why: string[] = [];
      if (n.signals.cites) why.push(REASON_CITES);
      if (n.signals.citedBy) why.push(REASON_CITED_BY);
      if (n.signals.prs.length) why.push(`shares ${n.signals.prs.slice(0, RELATED_SHARED_PRS_SHOWN).join(", ")}`);
      if (n.signals.sessions.length) {
        why.push(`${REASON_SESSION_PREFIX}${n.signals.sessions.slice(0, RELATED_SHARED_PRS_SHOWN).join(", ")}`);
      }
      return {
        meta: n.meta,
        ref: {
          relPath: n.meta.relPath,
          why: why.join(" · "),
          strength: Math.round(n.score * 10) / 10,
          signals: { link: linkOf(n.signals), prs: [...n.signals.prs], sessions: [...n.signals.sessions] },
        },
      };
    })
    .sort((a, b) => b.ref.strength - a.ref.strength || bySeriesDateDesc(a.meta, b.meta))
    .map(({ ref }) => ref);
}
