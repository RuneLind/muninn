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
 * half the wiki and says nothing. One hop is the whole rule.
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
import { isBookkeeping, neighbours } from "./strength.ts";
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

/** One related page: which page, and the one line saying why it is there. */
export interface RelatedRef {
  /** The candidate's relPath, exactly as `WikiPageMeta.relPath` spells it. */
  relPath: string;
  /** The reasons, joined with ` · ` — e.g.
   *  `cites this page · shares RuneLind/claude-usage#207, RuneLind/muninn#550`. */
  why: string;
}

/** The two link reasons. The four sources below run in a fixed order and a why
 *  line prints its reasons in the order they were added, so a page reached by
 *  two of them reads the same way on every build. */
const REASON_CITES = "cites this page";
const REASON_CITED_BY = "cited by this page";

/**
 * The related pages for `relPath`, newest first.
 *
 * "Newest" is {@link bySeriesDateDesc} — `status_date`, else the durable git
 * touch date, else the file's mtime, at DAY granularity with the rung as the
 * tie-break. The same signal the rail's Series fold orders its members by, and
 * the same function: two surfaces that both claim to show the newest page of a
 * piece of work must not disagree about which one that is.
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
 * With both applied to the open page as well, the largest block on that corpus
 * is **33** rows (`overview.md`), which is the link graph's own bound: no cap is
 * declared, because a cap would silently drop rows from a page that really does
 * have that many neighbours.
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
      return { meta: n.meta, why: why.join(" · ") };
    })
    .sort((a, b) => bySeriesDateDesc(a.meta, b.meta))
    .map(({ meta, why }) => ({ relPath: meta.relPath, why }));
}
