/**
 * Retire the historical backlog tail — the pure + assembly logic behind
 * `scripts/retire-backlog-tail.ts`.
 *
 * The manual "Ingest backlog" drain (see `src/gardener/backlog.ts`) works through
 * the never-ingested tail in bounded batches, but a large slice of that tail is
 * historical material a human already read and judged low-signal during manual
 * ingest sessions. Retirement moves those keys into the drain's **offered** set
 * (`backlog:offered` in `watcher_snapshots`) — the exact set the drain already
 * excludes — so they stop re-surfacing as drain candidates. Nothing is deleted:
 * the offered set is pure membership, and the existing "Reset offered" button on
 * `/wiki/gardener` re-pools everything.
 *
 * This reuses the same data assembly as `assembleBacklog` (list collections →
 * `computeIngestBacklog` with PR 1's URL/id crediting → the offered set from the
 * same `watcher_snapshots` accessors the drain uses); the ONLY difference is that
 * it returns the FULL queued list rather than a capped batch, so the retire plan
 * can cover the whole tail in one write.
 */

import type { QueuedDoc, ListedDoc, WikiRefs } from "../wiki/ingest-backlog.ts";
import type { SummaryCollectionListings } from "../summaries/list-collections.ts";
import type { StatsError } from "../summaries/stats.ts";
import { computeIngestBacklog } from "../wiki/ingest-backlog.ts";
import { SUMMARY_SOURCES } from "../summaries/sources.ts";
import { docDateMs } from "./harvest.ts";

/** Per-collection retire breakdown (queued includes docs already offered). */
export interface RetireCollectionPlan {
  collection: string;
  /** All queued (all-time never-ingested) docs, incl. any already offered. */
  queued: number;
  /** Queued-and-unoffered docs that pass the cutoff — the keys this run retires. */
  toRetire: number;
}

/** The full retire plan — pure over its inputs (no DB, no clock). */
export interface RetirePlan {
  perCollection: RetireCollectionPlan[];
  /** `<collection>/<id>` keys to ADD to the offered set (queued, unoffered, pre-cutoff). */
  keysToRetire: string[];
  /** offeredBefore ∪ keysToRetire — the exact array to persist to `backlog:offered`. */
  newOffered: string[];
  /** Total queued docs across every collection (incl. already-offered). */
  queuedTotal: number;
  /** Size of the offered set BEFORE this run (already-retired keys). */
  alreadyOffered: number;
  /** The `--before` cutoff in epoch ms, or null (retire everything queued-and-unoffered). */
  cutoffMs: number | null;
}

/**
 * Compute the retire plan: every queued-and-unoffered doc becomes a retire key,
 * unless a `cutoffMs` is set — then docs dated **on/after** the cutoff stay in the
 * pool (the fresh window is protected). Undated docs (no parseable date) sort as
 * −∞, matching `selectBacklogBatch`, so they are treated as old tail and retired.
 * Pure — the offered-set read + persist live in the caller.
 */
export function computeRetirePlan(
  byCollection: { collection: string; queuedDocs: QueuedDoc[] }[],
  offeredBefore: Set<string>,
  cutoffMs: number | null,
): RetirePlan {
  const perCollection: RetireCollectionPlan[] = [];
  const keysToRetire: string[] = [];
  let queuedTotal = 0;

  for (const c of byCollection) {
    let toRetire = 0;
    for (const d of c.queuedDocs) {
      queuedTotal += 1;
      const key = `${d.collection}/${d.id}`;
      if (offeredBefore.has(key)) continue; // already retired — idempotent no-op
      if (cutoffMs !== null) {
        const ms = docDateMs(d);
        if (ms !== undefined && ms >= cutoffMs) continue; // dated on/after cutoff — protect
      }
      toRetire += 1;
      keysToRetire.push(key);
    }
    perCollection.push({ collection: c.collection, queued: c.queuedDocs.length, toRetire });
  }

  const newOffered = [...new Set([...offeredBefore, ...keysToRetire])];
  return {
    perCollection,
    keysToRetire,
    newOffered,
    queuedTotal,
    alreadyOffered: offeredBefore.size,
    cutoffMs,
  };
}

/** Parse a `--before YYYY-MM-DD` cutoff to epoch ms (UTC midnight); throws on bad input. */
export function parseCutoffDate(before: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    throw new Error(`--before must be a YYYY-MM-DD date, got "${before}"`);
  }
  const ms = Date.parse(before);
  if (Number.isNaN(ms)) throw new Error(`--before is not a valid date: "${before}"`);
  return ms;
}

/** Seams the retire assembly needs — all injectable so it's unit-testable. */
export interface AssembleRetireDeps {
  botName: string;
  wikiDir: string;
  apiUrl: string;
  listCollections: (apiUrl: string) => Promise<SummaryCollectionListings>;
  sweepWikiRefs: (root: string) => Promise<WikiRefs>;
  getConsumed: (botName: string) => Promise<Set<string>>;
  getPending: (botName: string) => Promise<Set<string>>;
  getOffered: () => Promise<Set<string>>;
}

export interface RetireBacklog {
  /** Per-collection queued docs (the FULL queued list — not capped like the drain batch). */
  byCollection: { collection: string; queuedDocs: QueuedDoc[] }[];
  /** The already-offered set read this run (so the caller persists the union). */
  offeredBefore: Set<string>;
  /** One entry per collection that failed to list (partial data, non-fatal). */
  errors: StatsError[];
}

/**
 * List every summary collection once, sweep the wiki for referenced URLs/ids,
 * pull the consumed/pending/offered sets, and partition into queued docs via the
 * SAME `computeIngestBacklog` (PR 1 crediting) the drain and the counter use.
 * Returns the full per-collection queued list + the offered set.
 */
export async function assembleRetireBacklog(deps: AssembleRetireDeps): Promise<RetireBacklog> {
  const { byCollection: listedRaw, errors } = await deps.listCollections(deps.apiUrl);

  const listedBySource: Record<string, ListedDoc[]> = {};
  for (const source of SUMMARY_SOURCES) {
    listedBySource[source.collection] = (listedRaw[source.collection] ?? []).map((d) => ({
      collection: source.collection,
      id: d.id,
      ...(d.url ? { url: d.url } : {}),
      ...(d.date ? { date: d.date } : {}),
    }));
  }

  const [wikiRefs, consumed, pending, offeredBefore] = await Promise.all([
    deps.sweepWikiRefs(deps.wikiDir),
    deps.getConsumed(deps.botName),
    deps.getPending(deps.botName),
    deps.getOffered(),
  ]);

  const backlog = computeIngestBacklog(listedBySource, wikiRefs, consumed, pending);
  return {
    byCollection: backlog.byCollection.map((c) => ({
      collection: c.collection,
      queuedDocs: c.queuedDocs,
    })),
    offeredBefore,
    errors,
  };
}
