/**
 * RELATED WORK — the pages one hop from an open page, with the reason each one
 * is there.
 *
 * ```
 * related = cites ∪ cited-by ∪ shares ≥2 PR refs, minus hubs, never transitive
 * ```
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
 * **All three cuts are SYMMETRIC**: bookkeeping, hub and digest each say "this
 * page is not a piece of work", which is as true of the page you have open as
 * of a candidate. A bookkeeping or hub page therefore gets no block at all —
 * see {@link computeRelated} for what the one-sided version measured.
 *
 * Pure and index-only: it takes the built `WikiIndex` and a relPath and returns
 * the DECISION (which pages, and why), never a listing row. The route
 * (`/api/wiki/page`) maps each decision onto `toListing` — the same shape the
 * panel's other rows use — so this module stays unit-testable without a Hono
 * app and the listing shape stays owned by the one function that strips it.
 */

import { bySeriesDateDesc } from "../dashboard/views/components/wiki-groups.ts";
import { isMetaStem, pageStemOf } from "../dashboard/views/components/wiki-filter.ts";
import { normalizeRelPath, type WikiIndex, type WikiPageMeta } from "./store.ts";
import {
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

/**
 * BOOKKEEPING pages are never related work, whatever the link graph says —
 * `index`, `log` and `CLAUDE`, by stem, in any folder.
 *
 * The stem comes from `pageStemOf`, the RAIL's own spelling, which strips any
 * extension: `wikiPageStem` strips only `.md`/`.mdx`, so `plans/index.html` read
 * as the stem `index.html`, sat under `Bookkeeping` in the rail and arrived here
 * as ordinary related work. ⚠️ `isMetaStem` is case-SENSITIVE on `CLAUDE` alone
 * (inherited from the rail, where the same predicate decides the tail).
 *
 * Exported for the lint's series checks (`lint-series.ts`), which apply the same
 * four cuts — the constants AND this predicate — rather than re-declaring them.
 *
 * The hub cut alone does not reach these pages, and that is measured rather than
 * assumed: on mimir (547 pages) `index.md` has **3** backlinks, `log.md` 4 and
 * `plans/index.md` 6 — all far under `RELATED_HUB_BACKLINKS`, because a catalog
 * page LINKS OUT rather than being linked to. Without the cut they led the block
 * on both acceptance pages.
 */
export function isBookkeeping(relPath: string): boolean {
  return isMetaStem(pageStemOf(relPath));
}

/** How many pages link to this one. The hub test's one reader. */
function backlinkCount(index: WikiIndex, key: string): number {
  return index.backlinks.get(key)?.length ?? 0;
}

/** One related page: which page, and the one line saying why it is there. */
export interface RelatedRef {
  /** The candidate's relPath, exactly as `WikiPageMeta.relPath` spells it. */
  relPath: string;
  /** The reasons, joined with ` · ` — e.g.
   *  `cites this page · shares RuneLind/claude-usage#207, RuneLind/muninn#550`. */
  why: string;
}

/** The two link reasons. The three sources below run in a fixed order and a why
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
  const self = index.resolveRelPath(relPath);
  if (!self) return [];
  const selfKey = normalizeRelPath(self.relPath);
  if (isBookkeeping(self.relPath)) return [];
  if (backlinkCount(index, selfKey) > RELATED_HUB_BACKLINKS) return [];

  /** Candidate key → its reasons, in the order this function adds them. */
  const reasons = new Map<string, string[]>();
  const pages = new Map<string, WikiPageMeta>();

  const push = (candidateKey: string, why: string): void => {
    if (candidateKey === selfKey) return;
    const meta = index.resolveRelPath(candidateKey);
    if (!meta) return;
    if (isBookkeeping(meta.relPath)) return;
    // The open page's OWN attachments are not related work: the rail already
    // shows them as this page's attachment chip, so a row here is the same file
    // twice on one screen. Scoped to THIS page's children — an `.html` explainer
    // belonging to some other page is an ordinary candidate.
    if (meta.parent !== undefined && normalizeRelPath(meta.parent) === selfKey) return;
    // The hub cut applies to EVERY source, link included: a page cited by the
    // whole wiki is not related work just because this page cites it too.
    if (backlinkCount(index, candidateKey) > RELATED_HUB_BACKLINKS) return;
    pages.set(candidateKey, meta);
    const list = reasons.get(candidateKey);
    if (list) {
      if (!list.includes(why)) list.push(why);
    } else {
      reasons.set(candidateKey, [why]);
    }
  };

  // 1. Pages that cite this one, and 2. pages this one cites. Both are already
  //    in the index as normalized relPaths — this is the "one hop" in full.
  for (const from of index.backlinks.get(selfKey) ?? []) push(from, REASON_CITES);
  for (const to of index.outgoing.get(selfKey) ?? []) push(to, REASON_CITED_BY);

  // 3. Pages sharing at least RELATED_SHARED_PRS_MIN PR references.
  const selfRefs = self.prRefs ?? [];
  if (selfRefs.length >= RELATED_SHARED_PRS_MIN && selfRefs.length <= RELATED_DIGEST_PRS) {
    // Case-insensitive, because the two ends may have got their spelling from a
    // frontmatter line and from prose. The VALUE kept is the open page's, so the
    // why line reads in one spelling however the other page wrote it.
    const selfByKey = new Map(selfRefs.map((r) => [r.toLowerCase(), r]));
    for (const candidate of index.pages) {
      const key = normalizeRelPath(candidate.relPath);
      if (key === selfKey) continue;
      const refs = candidate.prRefs ?? [];
      if (refs.length > RELATED_DIGEST_PRS) continue;
      const shared: string[] = [];
      const seen = new Set<string>();
      for (const ref of refs) {
        const k = ref.toLowerCase();
        const mine = selfByKey.get(k);
        if (!mine || seen.has(k)) continue;
        seen.add(k);
        shared.push(mine);
      }
      if (shared.length < RELATED_SHARED_PRS_MIN) continue;
      // Ordered by the OPEN page's own list, so the two refs the reason names
      // are the first two THIS page declares rather than whichever pair the
      // candidate happened to write first.
      shared.sort((a, b) => selfRefs.indexOf(a) - selfRefs.indexOf(b));
      push(key, `shares ${shared.slice(0, RELATED_SHARED_PRS_SHOWN).join(", ")}`);
    }
  }

  return [...reasons]
    .map(([key, why]) => ({ meta: pages.get(key)!, why: why.join(" · ") }))
    .sort((a, b) => bySeriesDateDesc(a.meta, b.meta))
    .map(({ meta, why }) => ({ relPath: meta.relPath, why }));
}
