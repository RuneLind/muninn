/**
 * Wiki Atlas projection — a PURE, side-effect-free transform from a cached
 * `WikiIndex` (+ its trails) into the JSON payload the `/wiki` Atlas tab renders
 * (hybrid Types/Months graph view with curated trails). It reads ONLY the
 * in-memory index — never the wiki page files — so a repeat `/api/wiki/atlas`
 * request within the store's 5-min TTL re-reads nothing on disk. That is the
 * cacheability claim PR 1's test asserts (projection purity), not an absolute zero
 * of I/O.
 *
 * Keying: `nodes`/`months`/`links` are keyed by the store's normalized relPath
 * (`normalizeRelPath` — posix-normalized, lowercased), never by page name, so
 * same-stem pages in different folders (mimir's several `architecture.md` /
 * `index.md` / `tracing.md`) keep DISTINCT nodes and link sets. Each node carries
 * `name` for display and PR 2's relPath-aware navigation.
 */

import {
  mergeWikiTypes,
  TYPE_LABEL,
} from "../dashboard/views/components/wiki-filter.ts";
import {
  normalizeRelPath,
  type WikiIndex,
  type WikiPageMeta,
} from "./store.ts";

// ── Curation constants (mockup-calibrated) ──────────────────────────────────

/** A source is a "hub" (a `Sources — X` catalog page or a heavily-cited source)
 *  when its inbound-link count reaches this. jarvis catalog pages sit at 100–310
 *  inbound; the top regular sources stay under ~140. Hub is a boolean flag on
 *  source nodes, NOT a separate page type. */
export const HUB_MIN_INBOUND = 40;

/** A type column with at most this many pages shows all of them. */
export const TYPE_CAP_FULL = 70;

/** A larger type column shows this many top pages by inbound-link count. */
export const TYPE_CAP_TOP = 50;

/** Visible nodes per month column (top by inbound); the rest land in `omitted.byMonth`. */
export const MONTH_CAP = 26;

/** How many top concepts become `topics` (ranked by linked-source count). */
export const TOPICS_LIMIT = 12;

/**
 * Atlas's OWN column order — source-first, matching the mockup (source hubs /
 * sources / concepts / entities / analyses). Deliberately NOT `wiki-filter.ts`'s
 * `TYPE_ORDER` (concept-first). `note` and `explainer` are absent by design
 * (mirroring `hubTypeList`'s drops) — a `note` column would be noise and
 * explainers never join the link graph. Present types beyond these (custom
 * ontologies, e.g. mimir's subsystem/plan) are appended alphabetically after.
 */
export const ATLAS_TYPE_ORDER: string[] = ["source", "concept", "entity", "analysis"];

/** Types that never get an Atlas column, however present. */
const EXCLUDED_TYPES = new Set(["note", "explainer"]);

// ── Payload shape ───────────────────────────────────────────────────────────

export interface AtlasType {
  key: string;
  label: string;
}

export interface AtlasNode {
  name: string;
  /** Page type — an open `WikiPageType` string (custom ontologies pass through). */
  t: string;
  hub: boolean;
  /** Inbound-link count (backlinks). */
  in: number;
  /** Resolved appearance date `YYYY-MM-DD` (pubDate → created → mtime); omitted when none. */
  date?: string;
  tags: string[];
  /** First prose line (or an explainer's sniffed description); omitted when none. */
  desc?: string;
  /** Outgoing links to OTHER picked nodes (normalized relPath keys), for selection-only edges. */
  links: string[];
}

export interface AtlasTopic {
  name: string;
  count: number;
  /** Per-month linked-source counts, aligned index-for-index with `monthKeys`. */
  perMonth: number[];
  desc?: string;
}

export interface AtlasTrailStep {
  page: string;
  note: string;
  /** Whether `page` resolves to a real wiki page in this index. Unresolved steps are KEPT. */
  resolved: boolean;
}

export interface AtlasTrail {
  title: string;
  blurb: string;
  steps: AtlasTrailStep[];
}

export interface AtlasPayload {
  types: AtlasType[];
  nodes: Record<string, AtlasNode>;
  monthKeys: string[];
  months: Record<string, string[]>;
  topics: AtlasTopic[];
  trails: AtlasTrail[];
  omitted: {
    byType: Record<string, number>;
    byMonth: Record<string, number>;
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` in the local timezone (no UTC shift) — matches the reader's
 *  mtime→day convention (`pageDateLabel`), so an 00:30 edit in UTC+2 isn't labeled
 *  the previous day. */
function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A `YYYY-MM-DD` prefix if the string starts with one, else undefined. */
function isoDayPrefix(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : undefined;
}

/**
 * A page's Atlas appearance date, publication-flavored: the body `Source:` pub
 * date → frontmatter `created` → frontmatter `updated` → file mtime (local day).
 * Diverges from the reader's `pageTimeMs` (max of mtime and updated/created) on
 * purpose — "when did this appear", not "what changed most recently" — so date-poor
 * wikis (mimir) still bucket via mtime. Undefined only when a page has none of them.
 */
export function pageAppearDate(p: WikiPageMeta): string | undefined {
  return (
    isoDayPrefix(p.pubDate) ??
    isoDayPrefix(p.created) ??
    isoDayPrefix(p.updated) ??
    (p.mtimeMs ? localDay(new Date(p.mtimeMs)) : undefined)
  );
}

const key = (p: WikiPageMeta) => normalizeRelPath(p.relPath);
const inboundOf = (index: WikiIndex, p: WikiPageMeta) =>
  index.backlinks.get(key(p))?.length ?? 0;

/** Sort a copy of pages by inbound desc, tie-broken by relPath for stable output. */
function byInboundDesc(index: WikiIndex, pages: WikiPageMeta[]): WikiPageMeta[] {
  return pages
    .slice()
    .sort(
      (a, b) => inboundOf(index, b) - inboundOf(index, a) || key(a).localeCompare(key(b)),
    );
}

// ── Projection ──────────────────────────────────────────────────────────────

/**
 * Project the cached index into the Atlas payload. Pure — no filesystem access,
 * no mutation of the index. All seven top-level keys are always present.
 */
export function projectAtlas(index: WikiIndex): AtlasPayload {
  const pages = index.pages;
  const omittedByType: Record<string, number> = {};
  const omittedByMonth: Record<string, number> = {};

  // ── Type columns ──────────────────────────────────────────────────────────
  const presentTypes = new Set(pages.map((p) => p.type));
  const knownCols = ATLAS_TYPE_ORDER.filter((t) => presentTypes.has(t));
  const customCols = [...presentTypes]
    .filter((t) => !ATLAS_TYPE_ORDER.includes(t) && !EXCLUDED_TYPES.has(t))
    .sort();
  const columnTypes = [...knownCols, ...customCols];

  // Labels only from mergeWikiTypes (seeds all six standard labels + present
  // customs); we filter to columns ourselves — a bare merge would emit empty
  // note/explainer columns and use the concept-first order.
  const { labels } = mergeWikiTypes(index.readerConfig, presentTypes);
  const labelFor = (t: string) => labels[t] ?? TYPE_LABEL[t] ?? t;
  const types: AtlasType[] = columnTypes.map((key) => ({ key, label: labelFor(key) }));

  // Pick nodes per column with the generic caps.
  const pagesByType = new Map<string, WikiPageMeta[]>();
  for (const p of pages) {
    if (EXCLUDED_TYPES.has(p.type)) continue;
    (pagesByType.get(p.type) ?? pagesByType.set(p.type, []).get(p.type)!).push(p);
  }
  const pickedByRelPath = new Map<string, WikiPageMeta>();
  const pick = (p: WikiPageMeta) => pickedByRelPath.set(key(p), p);
  for (const t of columnTypes) {
    const cols = byInboundDesc(index, pagesByType.get(t) ?? []);
    if (cols.length <= TYPE_CAP_FULL) {
      cols.forEach(pick);
    } else {
      cols.slice(0, TYPE_CAP_TOP).forEach(pick);
      omittedByType[t] = cols.length - TYPE_CAP_TOP;
    }
  }

  // ── Months ────────────────────────────────────────────────────────────────
  // Source-flavored timeline: bucket source pages when the wiki has any (jarvis);
  // otherwise every non-note/explainer page (mimir, date-poor — buckets via mtime)
  // so a wiki with no sources still gets a Months axis.
  const hasSources = presentTypes.has("source");
  const monthPop = pages.filter((p) => {
    if (EXCLUDED_TYPES.has(p.type)) return false;
    return hasSources ? p.type === "source" : true;
  });

  const monthDate = new Map<string, string>(); // relPath key → YYYY-MM-DD
  const monthBuckets = new Map<string, WikiPageMeta[]>();
  for (const p of monthPop) {
    const date = pageAppearDate(p);
    if (!date) continue; // no date at all — can't place on the timeline
    monthDate.set(key(p), date);
    const mk = date.slice(0, 7);
    (monthBuckets.get(mk) ?? monthBuckets.set(mk, []).get(mk)!).push(p);
  }
  const monthKeys = [...monthBuckets.keys()].sort();
  const months: Record<string, string[]> = {};
  for (const mk of monthKeys) {
    const ranked = byInboundDesc(index, monthBuckets.get(mk)!);
    const visible = ranked.slice(0, MONTH_CAP);
    visible.forEach(pick);
    months[mk] = visible.map(key);
    if (ranked.length > MONTH_CAP) omittedByMonth[mk] = ranked.length - MONTH_CAP;
  }

  // ── Nodes ─────────────────────────────────────────────────────────────────
  const pickedKeys = new Set(pickedByRelPath.keys());
  const nodes: Record<string, AtlasNode> = {};
  for (const [k, p] of pickedByRelPath) {
    const inbound = inboundOf(index, p);
    const outgoing = (index.outgoing.get(k) ?? []).filter(
      (target) => target !== k && pickedKeys.has(target),
    );
    const node: AtlasNode = {
      name: p.name,
      t: p.type,
      hub: p.type === "source" && inbound >= HUB_MIN_INBOUND,
      in: inbound,
      tags: p.tags,
      links: outgoing,
    };
    // Prefer the month-resolved date (already computed) else the page's own.
    const date = monthDate.get(k) ?? pageAppearDate(p);
    if (date) node.date = date;
    // Explainers take the store's early return with no `desc` — coalesce their
    // sniffed `description`. (Explainers aren't picked today, but keep the rule.)
    const desc = p.desc ?? p.description;
    if (desc) node.desc = desc;
    nodes[k] = node;
  }

  // ── Topics ────────────────────────────────────────────────────────────────
  // Top concepts by linked-source count, with a per-month sparkline aligned to
  // monthKeys. A wiki with no `concept` type simply has no topics.
  const monthIndex = new Map(monthKeys.map((mk, i) => [mk, i]));
  const concepts = pages.filter((p) => p.type === "concept");
  const topicRows = concepts
    .map((c) => {
      const backKeys = index.backlinks.get(key(c)) ?? [];
      const perMonth = new Array(monthKeys.length).fill(0);
      let count = 0;
      for (const bk of backKeys) {
        const src = index.resolveRelPath(bk);
        if (!src || src.type !== "source") continue;
        count++;
        const mk = pageAppearDate(src)?.slice(0, 7);
        const idx = mk !== undefined ? monthIndex.get(mk) : undefined;
        if (idx !== undefined) perMonth[idx]++;
      }
      return { name: c.name, count, perMonth, desc: c.desc ?? c.description };
    })
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, TOPICS_LIMIT);
  const topics: AtlasTopic[] = topicRows.map((t) => {
    const row: AtlasTopic = { name: t.name, count: t.count, perMonth: t.perMonth };
    if (t.desc) row.desc = t.desc;
    return row;
  });

  // ── Trails ────────────────────────────────────────────────────────────────
  // Unresolvable steps are KEPT and flagged resolved:false, never dropped.
  const trails: AtlasTrail[] = (index.trails ?? []).map((t) => ({
    title: t.title,
    blurb: t.blurb ?? "",
    steps: t.steps.map((s) => ({
      page: s.page,
      note: s.note ?? "",
      resolved: index.resolve(s.page) !== undefined,
    })),
  }));

  return {
    types,
    nodes,
    monthKeys,
    months,
    topics,
    trails,
    omitted: { byType: omittedByType, byMonth: omittedByMonth },
  };
}
