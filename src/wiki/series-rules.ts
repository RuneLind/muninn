/**
 * The series rules a browser bundle needs as well as the linter: which pages a
 * series can be OF (`isNarrativePage`, lint check 8.2's predicate), how a new
 * key is coined so it never folds into an existing one (`coinSeriesKey`), and
 * a page's stem. IO-free on purpose: `lint-series.ts` pulls `store.ts` and
 * through it `postgres`, which a `target: "browser"` build refuses, so the
 * reader's Save as series (plan `muninn-wiki-work-thread-grouping`, D14)
 * imports these from here and `lint-series.ts` re-exports them.
 */

import { seriesCensusKey } from "../dashboard/views/components/wiki-groups.ts";

/** `type:` values that are narrative by declaration, whatever folder they sit
 *  in — a wiki with a `.wiki-reader.json` ontology names its own. */
export const NARRATIVE_TYPES: ReadonlySet<string> = new Set(["blog", "plan", "archive", "report", "handover", "postmortem"]);

/** Top-level folders that are narrative by convention — mimir's three, the ones
 *  the 8.2 dry run scanned. */
export const NARRATIVE_FOLDERS: ReadonlySet<string> = new Set(["plans", "blogs", "archive"]);

/** The fields {@link isNarrativePage} reads — all on the listing, too. */
export interface NarrativeInput {
  relPath: string;
  type?: string;
  plan_status?: string;
  status_date?: string;
}

/**
 * Is this page a piece of WORK-IN-TIME — something a series can be a series OF?
 *
 * A SERIES says these pages are episodes of one effort with a head you can
 * continue at, and applying it to reference material is how one Accept ends up
 * writing `series:` onto a wiki's `overview.md`. Measured on a mimir clone
 * before this predicate existed: the largest 8.2 cluster ran to 68 pages,
 * glued by a 21-backlink reference page, and 8 of the 12 rows of another were
 * permanent reference pages.
 *
 * A page qualifies when it declares a lifecycle (`plan_status`), declares WHEN
 * its state was last affirmed (`status_date`), declares a narrative `type:`, or
 * sits in one of the three narrative folders.
 */
export function isNarrativePage(page: NarrativeInput): boolean {
  if (page.plan_status) return true;
  if (page.status_date) return true;
  if (NARRATIVE_TYPES.has((page.type || "").toLowerCase())) return true;
  const slash = page.relPath.indexOf("/");
  return slash > 0 && NARRATIVE_FOLDERS.has(page.relPath.slice(0, slash).toLowerCase());
}

/**
 * A NEW series key that no existing series owns, under the rail's own fold
 * (`seriesCensusKey`: trimmed, case-insensitive).
 *
 * A coined key is a page stem, and a stem is exactly the kind of name a reader
 * has already typed somewhere else — coining it twice would merge two unrelated
 * pieces of work into one rail fold, with no signal anywhere that it happened.
 * `-2`, `-3`, … is the disambiguation the reader can rename later.
 *
 * `taken` holds census keys and is MUTATED, so two coins of one pass cannot
 * take the same key; a caller that coins once builds a fresh set from the
 * listing's census.
 */
export function coinSeriesKey(stem: string, taken: Set<string>): string {
  let key = stem;
  for (let n = 2; taken.has(seriesCensusKey(key)); n++) key = `${stem}-${n}`;
  taken.add(seriesCensusKey(key));
  return key;
}

/** A page's stem: its file name without `.md`/`.mdx` (an `.html` keeps its
 *  extension, as `wikiPageStem` does). */
export function seriesPageStem(relPath: string): string {
  const base = relPath.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/\.mdx?$/i, "");
}
