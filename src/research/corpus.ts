/**
 * Research corpus registry — the set of Huginn collections the Research layer
 * answers questions over (the Claude Learning Center's third layer: cited Q&A).
 *
 * This is intentionally separate from `src/summaries/sources.ts`: the summary
 * registry only lists *summary* shelves (YouTube / X / Anthropic). The research
 * corpus is broader — it also spans the raw `anthropic-knowledge` firehose and
 * the curated `wiki`, neither of which is a summary source. Where a corpus
 * collection *does* correspond to a summary source, `sourceId` links the two so
 * a citation can route the doc panel through that source's apiBase if needed.
 *
 * Citations open via the shared doc panel, which fetches
 * `/api/search/document/<collection>/<id>` — a generic passthrough that works for
 * every collection here, so no per-source plumbing is required to render them.
 *
 * ## Corpus profiles (`ai` / `life`)
 *
 * The knowledge base spans two domains: `ai` (tech/AI/career) and `life`
 * (health/parenting/entertainment). Rather than mix them at retrieval time, the
 * Research layer scopes each ask to a *profile* — a named subset of collections.
 * `RESEARCH_CORPUS` stays the deduped **union** of every profile's collections so
 * a citation from ANY collection still renders its badge/label, while the actual
 * search is scoped to the selected profile's list. See the domain-split plan
 * (`mimir/plans/muninn-knowledge-domain-split.md`) for the full rationale — in
 * particular why the shared summary collections (youtube/x/tiktok) appear in both
 * profiles (v1 accepts intra-collection domain mixing; only the wiki slice is
 * domain-pure).
 */

export interface ResearchCollection {
  /** Huginn collection name (passed to researchKnowledge + /api/document). */
  collection: string;
  /** Human label for the corpus chip / "searched across" line. */
  label: string;
  /** Short badge shown on a citation row. */
  badge: string;
  /** Summary-source id (see sources.ts), when this collection is also a shelf. */
  sourceId?: string;
}

/** A named subset of the corpus the Research layer can scope an ask to. */
export interface ResearchProfile {
  /** Human label for the profile toggle chip. */
  label: string;
  /** Collections searched when this profile is active. */
  collections: string[];
}

/**
 * Metadata for every collection any profile references. `RESEARCH_CORPUS` (the
 * deduped union of all profiles) is derived from this, so citations render for
 * any collection regardless of which profile surfaced them.
 */
const COLLECTION_META: ResearchCollection[] = [
  { collection: "anthropic-summaries", label: "Claude summaries", badge: "Claude", sourceId: "anthropic" },
  { collection: "anthropic-knowledge", label: "Anthropic firehose", badge: "Anthropic" },
  { collection: "youtube-summaries", label: "YouTube", badge: "YouTube", sourceId: "youtube" },
  { collection: "x-articles", label: "X articles", badge: "X", sourceId: "x-article" },
  { collection: "tiktok-summaries", label: "TikTok", badge: "TikTok", sourceId: "tiktok" },
  { collection: "wiki", label: "Knowledge wiki", badge: "Wiki" },
  { collection: "wiki-life", label: "Life wiki", badge: "Life" },
];

/**
 * The retrieval profiles. `ai` is the default (see {@link RESEARCH_COLLECTIONS}
 * and {@link resolveProfile}). Adding a third domain later = one entry here plus
 * its collection metadata above.
 */
export const RESEARCH_PROFILES: Record<string, ResearchProfile> = {
  ai: {
    label: "AI & tech",
    collections: [
      "anthropic-summaries",
      "anthropic-knowledge",
      "youtube-summaries",
      "x-articles",
      "tiktok-summaries",
      "wiki",
    ],
  },
  life: {
    label: "Life",
    collections: ["wiki-life", "youtube-summaries", "tiktok-summaries", "x-articles"],
  },
};

/** The default profile name — the `??` fallback everywhere a profile is optional. */
export const DEFAULT_PROFILE = "ai";

const META_BY_NAME = new Map(COLLECTION_META.map((c) => [c.collection, c]));

/**
 * The full corpus — the deduped union of every profile's collections, preserving
 * first-seen order (ai profile first, then life-only additions). Kept as the
 * union (not any single profile) so `getResearchCollection`/`badgeForCollection`/
 * `clientCorpusJson` resolve a citation from ANY collection.
 */
export const RESEARCH_CORPUS: ResearchCollection[] = Array.from(
  new Set(Object.values(RESEARCH_PROFILES).flatMap((p) => p.collections)),
).map((name) => META_BY_NAME.get(name) ?? { collection: name, label: name, badge: name });

/**
 * The default collection list — the `ai` profile's collections. This is the `??`
 * fallback in `streamResearchAnswer` (ask.ts), so when a caller passes no
 * `collections` (or no `profile`), the behavior is the default `ai` profile.
 */
export const RESEARCH_COLLECTIONS: string[] = RESEARCH_PROFILES[DEFAULT_PROFILE]!.collections;

/** Resolve a profile by name, defaulting to `ai` on unknown/missing input. */
export function resolveProfile(name?: string | null): ResearchProfile {
  return (name ? RESEARCH_PROFILES[name] : undefined) ?? RESEARCH_PROFILES[DEFAULT_PROFILE]!;
}

export function getResearchCollection(collection: string): ResearchCollection | undefined {
  return RESEARCH_CORPUS.find((c) => c.collection === collection);
}

/** Badge for a collection, falling back to the collection name for anything off-corpus. */
export function badgeForCollection(collection: string): string {
  return getResearchCollection(collection)?.badge ?? collection;
}

/** Minimal corpus projection for the browser (badge/label per collection). */
export function clientCorpusJson(): string {
  const map: Record<string, { label: string; badge: string; sourceId?: string }> = {};
  for (const c of RESEARCH_CORPUS) {
    map[c.collection] = { label: c.label, badge: c.badge, sourceId: c.sourceId };
  }
  return JSON.stringify(map);
}

/**
 * Profiles projection for the browser: `{ name: { label, collections } }`. The
 * page renders the profile toggle + per-profile "searched across" line from this,
 * keeping this module the single source of truth (mirrors clientCorpusJson).
 */
export function clientProfilesJson(): string {
  return JSON.stringify(RESEARCH_PROFILES);
}
