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
 * Pure and index-only: it takes the built `WikiIndex` and a relPath and returns
 * the DECISION (which pages, and why), never a listing row. The route
 * (`/api/wiki/page`) maps each decision onto `toListing` — the same shape the
 * panel's other rows use — so this module stays unit-testable without a Hono
 * app and the listing shape stays owned by the one function that strips it.
 */

import { bySeriesDateDesc } from "../dashboard/views/components/wiki-groups.ts";
import { isMetaStem } from "../dashboard/views/components/wiki-filter.ts";
import { normalizeRelPath, wikiPageStem, type WikiIndex, type WikiPageMeta } from "./store.ts";

/**
 * A page with more backlinks than this is a HUB and is never a related row: it
 * is cited by everything, so it is about nothing in particular. Without the cut
 * every neighbourhood on mimir contained the same handful of pages.
 *
 * 25 is fitted to today's mimir — the same threshold the campaign-2 dry run
 * measured with, where it cuts `index`, the plan overview and the genesis page
 * and nothing else. A constant, not a name list, so an acceptance run on
 * another wiki can move it.
 */
export const RELATED_HUB_BACKLINKS = 25;

/**
 * BOOKKEEPING pages are never related work, whatever the link graph says —
 * `index`, `log` and `CLAUDE`, by stem, in any folder (`isMetaStem`, the rail's
 * own predicate for the `Bookkeeping` tail).
 *
 * The hub cut alone does not reach them, and that is measured rather than
 * assumed: on mimir (547 pages) `index.md` has **3** backlinks, `log.md` 4 and
 * `plans/index.md` 6 — all far under `RELATED_HUB_BACKLINKS`, because a catalog
 * page LINKS OUT rather than being linked to. So without this they led the block
 * on both acceptance pages. The campaign's dry run cut them by NAME
 * (`slug === "index"`, plus `plan-overview|genesis`); this is the same cut
 * spelled as the predicate the reader already has, rather than a second name
 * list to keep in step.
 */
function isBookkeeping(relPath: string): boolean {
  return isMetaStem(wikiPageStem(relPath));
}

/**
 * A page naming more PR references than this is a DIGEST — a review report, a
 * month's blog, an index — and shared PR numbers say nothing about it: it names
 * half the month by construction. Cut from the PR-sharing source only; a digest
 * that really links to the open page still appears, with the link as its reason.
 *
 * Applied to BOTH ends of a pair, not only to the candidate: the rule reads
 * "≥2 shared refs means one piece of work", and that inference is equally false
 * when the digest is the page you have open. 15 is the dry run's constant
 * (`RELATED_DIGEST_PRS`), where it cuts `index`, the review-9 blog and the
 * plans-index blog.
 */
export const RELATED_DIGEST_PRS = 15;

/** How many shared PR refs a pair needs before it is one piece of work. */
export const RELATED_SHARED_PRS_MIN = 2;

/** How many of the shared refs the `shares …` reason names. */
const SHARED_PRS_SHOWN = 2;

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
 */
export function computeRelated(index: WikiIndex, relPath: string): RelatedRef[] {
  const self = index.resolveRelPath(relPath);
  if (!self) return [];
  const selfKey = normalizeRelPath(self.relPath);

  /** Candidate key → its reasons, in the order this function adds them. */
  const reasons = new Map<string, string[]>();
  const pages = new Map<string, WikiPageMeta>();

  const push = (candidateKey: string, why: string): void => {
    if (candidateKey === selfKey) return;
    const meta = index.resolveRelPath(candidateKey);
    if (!meta) return;
    if (isBookkeeping(meta.relPath)) return;
    // The hub cut applies to EVERY source, link included: a page cited by the
    // whole wiki is not related work just because this page cites it too.
    if ((index.backlinks.get(candidateKey)?.length ?? 0) > RELATED_HUB_BACKLINKS) return;
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
      push(key, `shares ${shared.slice(0, SHARED_PRS_SHOWN).join(", ")}`);
    }
  }

  return [...reasons]
    .map(([key, why]) => ({ meta: pages.get(key)!, why: why.join(" · ") }))
    .sort((a, b) => bySeriesDateDesc(a.meta, b.meta))
    .map(({ meta, why }) => ({ relPath: meta.relPath, why }));
}
