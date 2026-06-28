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

export const RESEARCH_CORPUS: ResearchCollection[] = [
  { collection: "anthropic-summaries", label: "Claude summaries", badge: "Claude", sourceId: "anthropic" },
  { collection: "anthropic-knowledge", label: "Anthropic firehose", badge: "Anthropic" },
  { collection: "youtube-summaries", label: "YouTube", badge: "YouTube", sourceId: "youtube" },
  { collection: "x-articles", label: "X articles", badge: "X", sourceId: "x-article" },
  { collection: "wiki", label: "Knowledge wiki", badge: "Wiki" },
];

/** The bare collection names — passed straight to `researchKnowledge({ collections })`. */
export const RESEARCH_COLLECTIONS: string[] = RESEARCH_CORPUS.map((c) => c.collection);

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
