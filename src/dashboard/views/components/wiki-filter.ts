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
  /** File mtime (epoch ms) — the recency signal for frontmatter-less wikis. */
  mtimeMs?: number;
  linkCount: number;
  backlinkCount: number;
}

export interface WikiFilters {
  q: string;
  domain: string;
  /** Top-level folder, `ROOT_FOLDER` for wiki-root pages, "" for all. */
  folder: string;
  type: string;
  tag: string;
}

/** Filter sentinel for pages sitting at the wiki root — no real folder can
 *  collide with it, so it doubles as a selectable value in the folder picker. */
export const ROOT_FOLDER = "/";

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

/** The wiki-root-relative top-level folder a page lives in (`ROOT_FOLDER` when it
 *  sits directly in the wiki root). Nested pages report their FIRST segment, so
 *  mimir's `archive/muninn/x.md` is filed under `archive`. */
export function pageFolder(p: WikiListing): string {
  const rel = (p.relPath || "").replace(/\\/g, "/");
  const slash = rel.indexOf("/");
  return slash === -1 ? ROOT_FOLDER : rel.slice(0, slash);
}

/**
 * Recency of a page in epoch ms — the sort key behind "Recently updated".
 *
 * The larger of the file's mtime and its frontmatter `updated`/`created` date.
 * Frontmatter-only ranking left wikis that carry no frontmatter (mimir,
 * melosys-kode-wiki) permanently undated at the bottom of the list; mtime-only
 * ranking would regress a wiki whose files were re-checked-out (mtime resets,
 * frontmatter doesn't). Taking the max keeps whichever signal claims the page was
 * touched more recently. 0 when a page has neither.
 */
export function pageTimeMs(p: WikiListing): number {
  const fm = p.updated || p.created || "";
  const fmMs = fm ? Date.parse(fm) : NaN;
  return Math.max(p.mtimeMs || 0, Number.isNaN(fmMs) ? 0 : fmMs);
}

/** `YYYY-MM-DD` of `pageTimeMs` — what the list shows next to a page when it is
 *  sorted by recency, so the visible date always explains the ordering. */
export function pageDateLabel(p: WikiListing): string {
  const ms = pageTimeMs(p);
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

/** Filter pages by the current domain/folder/type/tag facets and the free-text query.
 *  Query matches title, canonical name, any alias, or any tag (all case-insensitive). */
export function filterPages(pages: WikiListing[], filters: WikiFilters): WikiListing[] {
  const q = filters.q.toLowerCase();
  return pages.filter((p) => {
    if (filters.domain && p.domain !== filters.domain) return false;
    if (filters.folder && pageFolder(p) !== filters.folder) return false;
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

/** Sort a copy of `pages` by the given mode without mutating the input. Recency
 *  ties (two pages stamped the same day by frontmatter alone) fall back to title
 *  so the order is stable rather than scan-order. */
export function sortPages(pages: WikiListing[], mode: WikiSortMode): WikiListing[] {
  const copy = pages.slice();
  if (mode === "title") {
    copy.sort((a, b) => a.title.localeCompare(b.title));
  } else if (mode === "backlinks") {
    copy.sort((a, b) => b.backlinkCount - a.backlinkCount);
  } else {
    copy.sort((a, b) => pageTimeMs(b) - pageTimeMs(a) || a.title.localeCompare(b.title));
  }
  return copy;
}

/** Count pages per top-level folder, honoring the active domain filter (used for
 *  the folder picker). Keyed by `pageFolder`, so wiki-root pages land under
 *  `ROOT_FOLDER`. */
export function folderCounts(pages: WikiListing[], domain: string): Record<string, number> {
  const counts: Record<string, number> = {};
  pages.forEach((p) => {
    if (domain && p.domain !== domain) return;
    const f = pageFolder(p);
    counts[f] = (counts[f] || 0) + 1;
  });
  return counts;
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
