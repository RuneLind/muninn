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

export interface CollectionListings {
  /** Collection name → its listed docs (empty when the fetch failed). */
  byCollection: Record<string, ListedCollectionDoc[]>;
  /** One entry per collection that failed to load (partial data, non-fatal). */
  errors: StatsError[];
}

/** Alias kept for the summaries call sites. */
export type SummaryCollectionListings = CollectionListings;

/**
 * Generic sequential collection listing — the shared fetch + degrade layer. Lists
 * each named collection from huginn SEQUENTIALLY (never fan unbounded concurrency
 * at huginn's Python server); a collection that fails contributes an empty list
 * and a `StatsError` (`source` = collection name) — never a throw. Both the
 * summaries listing (`listSummaryCollections`) and the wiki index-coverage route
 * delegate here.
 */
export async function listCollections(
  knowledgeApiUrl: string,
  names: string[],
  opts?: { includeDates?: boolean },
): Promise<CollectionListings> {
  const byCollection: Record<string, ListedCollectionDoc[]> = {};
  const errors: StatsError[] = [];
  const suffix = opts?.includeDates ? "?include_dates=1" : "";

  for (const name of names) {
    try {
      const data = await fetchKnowledgeApi(
        knowledgeApiUrl,
        `/api/collection/${name}/documents${suffix}`,
        { timeoutMs: 10_000 },
      );
      byCollection[name] = (data?.documents ?? []) as ListedCollectionDoc[];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("Collection listing failed for {collection}: {error}", {
        collection: name,
        error: message,
      });
      errors.push({ source: name, collection: name, error: message });
      byCollection[name] = [];
    }
  }

  return { byCollection, errors };
}

export async function listSummaryCollections(
  knowledgeApiUrl: string,
): Promise<SummaryCollectionListings> {
  const { byCollection, errors } = await listCollections(
    knowledgeApiUrl,
    SUMMARY_SOURCES.map((s) => s.collection),
    { includeDates: true },
  );
  // Keep the summaries error shape byte-identical (its consumers key off the
  // source id, not the collection name): remap each error's `source` back to the
  // owning SUMMARY_SOURCES id. `byCollection` (keyed by collection) is unchanged.
  const idByCollection = new Map(SUMMARY_SOURCES.map((s) => [s.collection, s.id]));
  const remapped = errors.map((e) => ({ ...e, source: idByCollection.get(e.collection) ?? e.source }));
  return { byCollection, errors: remapped };
}
