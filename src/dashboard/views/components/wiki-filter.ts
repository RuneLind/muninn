/**
 * Pure, side-effect-free helpers for the /wiki reader page. Split out from
 * `wiki-browser.ts` (which has DOM side effects at module load) so these can be
 * unit-tested directly. Mirrors the listing shape sent by
 * `src/dashboard/routes/wiki-routes.ts`.
 */

export type WikiPageType = "source" | "concept" | "entity" | "analysis" | "note" | "explainer";

export interface WikiListing {
  name: string;
  title: string;
  type: WikiPageType;
  domain: "ai" | "life";
  tags: string[];
  aliases: string[];
  created?: string;
  updated?: string;
  url?: string;
  relPath: string;
  linkCount: number;
  backlinkCount: number;
}

export interface WikiFilters {
  q: string;
  domain: string;
  type: string;
  tag: string;
}

export type WikiSortMode = "updated" | "backlinks" | "title";

export const TYPE_ORDER: WikiPageType[] = [
  "concept",
  "entity",
  "source",
  "analysis",
  "explainer",
  "note",
];
export const TYPE_LABEL: Record<WikiPageType, string> = {
  concept: "Concepts",
  entity: "Entities",
  source: "Sources",
  analysis: "Analyses",
  explainer: "Explainers",
  note: "Notes",
};

/** Filter pages by the current domain/type/tag facets and the free-text query.
 *  Query matches title, canonical name, any alias, or any tag (all case-insensitive). */
export function filterPages(pages: WikiListing[], filters: WikiFilters): WikiListing[] {
  const q = filters.q.toLowerCase();
  return pages.filter((p) => {
    if (filters.domain && p.domain !== filters.domain) return false;
    if (filters.type && p.type !== filters.type) return false;
    if (filters.tag && p.tags.indexOf(filters.tag) === -1) return false;
    if (!q) return true;
    if (p.title.toLowerCase().indexOf(q) !== -1) return true;
    if (p.name.toLowerCase().indexOf(q) !== -1) return true;
    for (const a of p.aliases) {
      if (a.toLowerCase().indexOf(q) !== -1) return true;
    }
    for (const t of p.tags) {
      if (t.toLowerCase().indexOf(q) !== -1) return true;
    }
    return false;
  });
}

/** Sort a copy of `pages` by the given mode without mutating the input. */
export function sortPages(pages: WikiListing[], mode: WikiSortMode): WikiListing[] {
  const copy = pages.slice();
  if (mode === "title") {
    copy.sort((a, b) => a.title.localeCompare(b.title));
  } else if (mode === "backlinks") {
    copy.sort((a, b) => b.backlinkCount - a.backlinkCount);
  } else {
    copy.sort((a, b) =>
      (b.updated || b.created || "").localeCompare(a.updated || a.created || ""),
    );
  }
  return copy;
}

/** Count pages per type, honoring the active domain filter (used for the type chip row). */
export function typeCounts(pages: WikiListing[], domain: string): Record<string, number> {
  const counts: Record<string, number> = {};
  pages.forEach((p) => {
    if (domain && p.domain !== domain) return;
    counts[p.type] = (counts[p.type] || 0) + 1;
  });
  return counts;
}

/** The hub types with dedicated "Top … by connections" sections on the start view. */
export const HUB_TYPES: WikiPageType[] = ["concept", "entity"];

/** True when the wiki has any typed hub pages (concepts/entities). Wikis that use
 *  plain markdown links and no frontmatter `type` have none — they fall back to a
 *  single "Top pages by connections" hub section instead. */
export function hasTypedHubs(pages: WikiListing[]): boolean {
  return pages.some((p) => HUB_TYPES.includes(p.type));
}

/** Top `limit` pages matching `predicate`, most-linked-to first. Drives the hub
 *  sections: per-type for typed wikis, `backlinkCount > 0` for the untyped fallback. */
export function topPages(
  pages: WikiListing[],
  predicate: (p: WikiListing) => boolean,
  limit = 12,
): WikiListing[] {
  return sortPages(pages.filter(predicate), "backlinks").slice(0, limit);
}

/** Count pages per tag, honoring the active domain + type filters (used for the tag chip row). */
export function tagCounts(
  pages: WikiListing[],
  domain: string,
  type: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  pages.forEach((p) => {
    if (domain && p.domain !== domain) return;
    if (type && p.type !== type) return;
    p.tags.forEach((t) => {
      counts[t] = (counts[t] || 0) + 1;
    });
  });
  return counts;
}
