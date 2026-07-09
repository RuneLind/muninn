/**
 * Shared summary-collection listing — the fetch + error layer only.
 *
 * Lists every `SUMMARY_SOURCES` collection from huginn (`?include_dates=1`),
 * SEQUENTIALLY — never fan unbounded concurrency at huginn's Python server. A
 * collection that fails contributes an empty list and lands in `errors` — never
 * a throw, so callers can render partial data. Consumers map the raw listed docs
 * into their own shapes (summaries Stats → `StatsDoc`, wiki ingest backlog →
 * `ListedDoc`).
 */

import { getLog } from "../logging.ts";
import { fetchKnowledgeApi } from "../ai/knowledge-api-client.ts";
import { SUMMARY_SOURCES } from "./sources.ts";
import type { StatsError } from "./stats.ts";

const log = getLog("summaries", "list-collections");

/** A doc as huginn lists it — id plus whatever metadata the listing carries. */
export interface ListedCollectionDoc {
  id: string;
  url?: string;
  date?: string;
  title?: string;
  [key: string]: unknown;
}

export interface SummaryCollectionListings {
  /** Collection name → its listed docs (empty when the fetch failed). */
  byCollection: Record<string, ListedCollectionDoc[]>;
  /** One entry per collection that failed to load (partial data, non-fatal). */
  errors: StatsError[];
}

export async function listSummaryCollections(
  knowledgeApiUrl: string,
): Promise<SummaryCollectionListings> {
  const byCollection: Record<string, ListedCollectionDoc[]> = {};
  const errors: StatsError[] = [];

  for (const source of SUMMARY_SOURCES) {
    try {
      const data = await fetchKnowledgeApi(
        knowledgeApiUrl,
        `/api/collection/${source.collection}/documents?include_dates=1`,
        { timeoutMs: 10_000 },
      );
      byCollection[source.collection] = (data?.documents ?? []) as ListedCollectionDoc[];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("Summary collection listing failed for {source}: {error}", {
        source: source.id,
        error: message,
      });
      errors.push({ source: source.id, collection: source.collection, error: message });
      byCollection[source.collection] = [];
    }
  }

  return { byCollection, errors };
}
