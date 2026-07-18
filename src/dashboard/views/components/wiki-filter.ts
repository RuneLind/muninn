/**
 * Pure, side-effect-free helpers for the /wiki reader page. Split out from
 * `wiki-browser.ts` (which has DOM side effects at module load) so these can be
 * unit-tested directly. Mirrors the listing shape sent by
 * `src/dashboard/routes/wiki-routes.ts`.
 */

/**
 * A wiki page's type. Independent client-safe copy of the store's alias (this file
 * has no DOM/server deps so it stays unit-testable). Widened to `string` because a
 * wiki's `.wiki-reader.json` can introduce custom type strings beyond the built-in
 * five — the reader's default ontology lives in `TYPE_ORDER` / `TYPE_LABEL` below.
 */
export type WikiPageType = string;

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
  /** Short prose summary — explainers (sniffed from `<meta description>`) and
   *  native blog `.mdx` pages (frontmatter `description`). Rendered as the article
   *  subtitle for `type: blog` pages; feeds the Similar query for explainers only. */
  description?: string;
  /** Validated CSS color token (`#hex` / `rgb()` / `hsl()`) from a blog page's
   *  frontmatter `accent`. Server-sanitized (see `sanitizeColorToken`) — anything
   *  that isn't a strict color token is dropped before it reaches this field, so
   *  it is safe to inject into a `<style>` sink. Only carried by `type: blog` pages
   *  that declared it. */
  accent?: string;
  /** Dark-theme counterpart of `accent` (frontmatter `accentDark`), same
   *  sanitization. Absent ⇒ the light `accent` is used in both themes. */
  accentDark?: string;
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

/**
 * Strict CSS color-token validator for the user-controlled `accent` / `accentDark`
 * frontmatter fields. These are injected into a `<style>` sink (the per-page accent
 * block in the reader), so the ONLY accepted shapes are a `#rgb` / `#rgba` / `#rrggbb`
 * / `#rrggbbaa` hex literal, or a `rgb()/rgba()/hsl()/hsla()` call whose argument list
 * contains only digits, dots, commas, percent signs, and whitespace. Anything else —
 * a named color, a `var(...)`, or an injection attempt like `red;} body{display:none`
 * — returns `undefined` and is dropped. Shared by the server (parse-time sanitize in
 * `src/wiki/store.ts`) and the client (defense-in-depth re-check before injection), so
 * there is exactly one regex. Lives here because this module is pure (no DOM/server
 * deps) and already imported by both sides.
 */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC_COLOR_RE = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s]+\)$/i;
export function sanitizeColorToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (HEX_COLOR_RE.test(v) || FUNC_COLOR_RE.test(v)) return v;
  return undefined;
}

/** Filter sentinel for pages sitting at the wiki root — no real folder can
 *  collide with it, so it doubles as a selectable value in the folder picker. */
export const ROOT_FOLDER = "/";

export type WikiSortMode = "updated" | "backlinks" | "title";

/** The built-in type order + labels — the no-`.wiki-reader.json` defaults. A wiki's
 *  merged type list (see `mergeWikiTypes`) always starts with these, so a wiki with
 *  no config renders byte-identically to before. */
export const TYPE_ORDER: string[] = [
  "concept",
  "entity",
  "source",
  "analysis",
  "explainer",
  "note",
];
export const TYPE_LABEL: Record<string, string> = {
  concept: "Concepts",
  entity: "Entities",
  source: "Sources",
  analysis: "Analyses",
  explainer: "Explainers",
  note: "Notes",
};

/** The ordered type list + labels the client renders chips/stats/hubs/connections
 *  from — the built-in defaults merged with a wiki's `.wiki-reader.json` customs. */
export interface WikiTypeList {
  order: string[];
  labels: Record<string, string>;
}

/** Capitalize a raw type slug for a fallback label ("subsystem" → "Subsystem"). */
function titleCaseType(t: string): string {
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * Merge the built-in ontology (`TYPE_ORDER`/`TYPE_LABEL`) with a wiki's optional
 * `.wiki-reader.json` config into the ordered type list + labels sent to the
 * client. Standard types always come first in their canonical order — so a wiki
 * with no config yields exactly today's constants. Custom types the config
 * introduces (its `typeLabels` keys + `typeMap` values that aren't already
 * standard) are appended, but only when at least one page actually carries them
 * (`presentTypes`); a custom type's label is its `typeLabels` entry, else a
 * title-cased slug. Declaration order is preserved (typeLabels first, then typeMap).
 */
export function mergeWikiTypes(
  config: { typeMap: Record<string, string>; typeLabels: Record<string, string> } | null | undefined,
  presentTypes: Iterable<string>,
): WikiTypeList {
  const order = [...TYPE_ORDER];
  const labels: Record<string, string> = { ...TYPE_LABEL };
  if (!config) return { order, labels };
  const present = new Set(presentTypes);
  const seen = new Set(order);
  const candidates = [...Object.keys(config.typeLabels), ...Object.values(config.typeMap)];
  for (const t of candidates) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (!present.has(t)) continue;
    order.push(t);
    labels[t] = config.typeLabels[t] || titleCaseType(t);
  }
  return { order, labels };
}

/** Distinct non-note page types present in `pages` (the ontology's "content" types). */
function contentTypes(pages: WikiListing[]): Set<string> {
  const s = new Set<string>();
  for (const p of pages) if (p.type !== "note") s.add(p.type);
  return s;
}

/** The per-type hub sections to render on the start view: non-note, non-explainer
 *  types present in `pages`, ordered by `order` (extras alpha-sorted after). Explainers
 *  never join the link graph, so a "by connections" hub of them is always degenerate. */
export function hubTypeList(pages: WikiListing[], order: string[]): string[] {
  const present = contentTypes(pages);
  present.delete("explainer");
  const known = order.filter((t) => t !== "note" && t !== "explainer" && present.has(t));
  const extras = [...present].filter((t) => !order.includes(t)).sort();
  return [...known, ...extras];
}

/** Grouping order for a connections panel: the stored `order` first (types actually
 *  present), then any extra types present in the items but missing from `order`
 *  (alpha). Belt-and-suspenders so a custom-typed neighbor is NEVER dropped even if
 *  the stored list is late/empty — the pre-fix bug excluded such items entirely. */
export function connectionTypeOrder(itemTypes: Iterable<string>, order: string[]): string[] {
  const present = new Set(itemTypes);
  const known = order.filter((t) => present.has(t));
  const extras = [...present].filter((t) => !order.includes(t)).sort();
  return [...known, ...extras];
}

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

/**
 * `YYYY-MM-DD` for `pageTimeMs` — what the list shows next to a page when it is
 * sorted by recency, so the visible date always explains the ordering.
 *
 * A frontmatter date is echoed back verbatim (it was authored as a plain day, and
 * re-deriving it from the parsed UTC instant would shift it in negative-offset
 * timezones). An mtime is a wall-clock instant, so it renders as a LOCAL day —
 * `toISOString()` would label a 00:30 edit in UTC+2 as the previous day, which is
 * exactly the drift `computeWikiFreshness` avoids for `log.md`.
 */
export function pageDateLabel(p: WikiListing): string {
  const fm = p.updated || p.created || "";
  const fmMs = fm ? Date.parse(fm) : NaN;
  const fmValid = !Number.isNaN(fmMs);
  if (fmValid && fmMs >= (p.mtimeMs || 0)) return fm;
  if (!p.mtimeMs) return fmValid ? fm : "";
  return localDay(new Date(p.mtimeMs));
}

/** `YYYY-MM-DD` in the viewer's timezone (no UTC shift). */
function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

/** True when the wiki has ≥2 distinct non-note types — enough of an ontology to
 *  warrant per-type "Top … by connections" hub sections (jarvis: concept/entity/…;
 *  mimir: subsystem/plan/report/…). Wikis that are all `note` (plain markdown, no
 *  frontmatter `type`, no config) fall back to a single cross-type hub instead. */
export function hasTypedHubs(pages: WikiListing[]): boolean {
  return contentTypes(pages).size >= 2;
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
