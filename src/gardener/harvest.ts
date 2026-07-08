/**
 * Harvest stage — list recent summary docs across the four summary collections,
 * filter to the lookback window, drop consumed docs, and fetch full bodies.
 *
 * The listing endpoint returns only `{id, url, date}`, so titles/categories are
 * derived from the fetched body (there is no top-level title/summary/author —
 * see the grounding notes in the plan).
 */

import type { HarvestedDoc, ListedDoc, RawFetchedDoc } from "./types.ts";
import { getLog } from "../logging.ts";

const log = getLog("gardener", "harvest");

const FETCH_BATCH_SIZE = 20;
const DAY_MS = 86_400_000;

/** Parse a doc's date to epoch ms: prefer an explicit `date`, else the `YYYY-MM-DD` filename prefix. */
export function docDateMs(listedOrId: { id: string; date?: string }): number | undefined {
  const { id, date } = listedOrId;
  if (date) {
    const parsed = Date.parse(date);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const prefix = id.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(prefix)) {
    const parsed = Date.parse(prefix);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Keep docs dated within the lookback window. Docs with an undeterminable date
 * are kept (best-effort — summaries always carry a date, so this only guards a
 * malformed row, and dropping a genuinely-recent doc is worse than keeping a
 * stray old one that clustering will simply ignore).
 */
export function filterWindow(
  docs: ListedDoc[],
  lookbackDays: number,
  now: number,
): ListedDoc[] {
  const cutoff = now - lookbackDays * DAY_MS;
  return docs.filter((d) => {
    const ms = docDateMs(d);
    return ms === undefined || ms >= cutoff;
  });
}

/**
 * Derive a human title from a fetched doc: the body's first `# ` heading if
 * present, else the filename stem (date prefix + extension stripped, separators
 * humanized).
 */
export function deriveTitle(id: string, text: string): string {
  const headingMatch = text.match(/^#\s+(.+?)\s*$/m);
  if (headingMatch && headingMatch[1]!.trim()) return headingMatch[1]!.trim();

  let stem = id.replace(/\.md$/i, "");
  // Strip a leading YYYY-MM-DD_ or YYYY-MM-DD- date prefix.
  stem = stem.replace(/^\d{4}-\d{2}-\d{2}[_-]?/, "");
  stem = stem.replace(/[_-]+/g, " ").trim();
  return stem || id;
}

function normalizeDoc(collection: string, listed: ListedDoc, raw: RawFetchedDoc): HarvestedDoc {
  const text = raw.text ?? "";
  return {
    key: `${collection}/${listed.id}`,
    collection,
    id: listed.id,
    url: raw.metadata?.url || raw.url || listed.url || "",
    title: deriveTitle(listed.id, text),
    category: raw.metadata?.category,
    author: raw.metadata?.author,
    text,
  };
}

export interface HarvestDeps {
  /** List a collection's docs (id/url/date only). */
  listDocs: (collection: string) => Promise<ListedDoc[]>;
  /** Fetch one doc's full body. Returns null on a per-doc error (skipped). */
  fetchDoc: (collection: string, id: string) => Promise<RawFetchedDoc | null>;
}

/**
 * Harvest recent, unconsumed docs across the given collections, returning full
 * bodies. Batches body fetches at {@link FETCH_BATCH_SIZE} concurrency (the X
 * watcher lesson — don't fire N concurrent requests at huginn's Python server).
 */
export async function harvestDocs(
  collections: string[],
  deps: HarvestDeps,
  opts: { lookbackDays: number; consumed: Set<string>; now: number; botName?: string },
): Promise<HarvestedDoc[]> {
  const { lookbackDays, consumed, now, botName } = opts;
  const harvested: HarvestedDoc[] = [];

  for (const collection of collections) {
    let listed: ListedDoc[];
    try {
      listed = await deps.listDocs(collection);
    } catch (err) {
      log.warn("Failed to list collection {collection}: {error}", {
        botName,
        collection,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const window = filterWindow(listed, lookbackDays, now).filter(
      (d) => !consumed.has(`${collection}/${d.id}`),
    );

    for (let i = 0; i < window.length; i += FETCH_BATCH_SIZE) {
      const batch = window.slice(i, i + FETCH_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (listedDoc) => {
          try {
            const raw = await deps.fetchDoc(collection, listedDoc.id);
            if (!raw) return null;
            return normalizeDoc(collection, listedDoc, raw);
          } catch (err) {
            log.warn("Failed to fetch doc {collection}/{id}: {error}", {
              botName,
              collection,
              id: listedDoc.id,
              error: err instanceof Error ? err.message : String(err),
            });
            return null;
          }
        }),
      );
      for (const r of results) if (r) harvested.push(r);
    }

    log.info("Harvested {count} doc(s) from {collection} (window {days}d)", {
      botName,
      count: window.length,
      collection,
      days: lookbackDays,
    });
  }

  return harvested;
}
