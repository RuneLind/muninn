import type { Tracer } from "../tracing/index.ts";

/**
 * Synthesize child spans for each Huginn search stage from a captured searchTrace.
 *
 * The trace records *durations* per stage (indexFetch / chunkLoad / rerank /
 * titleBoost / assembly) but not start offsets, so we lay the stages out
 * sequentially within the tool span's window. The waterfall then shows where
 * the time went without the operator having to expand the trace JSON.
 *
 * Schema documented in huginn/docs/search-tracing-plan.md (schemaVersion 1).
 */

/** Source of truth for the v1 searchTrace stage list. The dashboard panel
 *  reuses both arrays via {@link STAGE_KEYS} / {@link STAGE_NAMES} so a rename
 *  here automatically flows to the table, strip, and CSS selectors. */
export const STAGE_KEYS = ["indexFetch", "chunkLoad", "rerank", "titleBoost", "assembly"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export const STAGE_NAMES: Record<StageKey, string> = {
  indexFetch: "index.fetch",
  chunkLoad: "chunk.load",
  rerank: "rerank.ce",
  titleBoost: "boost.title",
  assembly: "assemble",
};

interface SearchTrace {
  schemaVersion?: number;
  collections?: Array<{
    name?: string;
    indexer?: string;
    fetchK?: number;
    candidates?: unknown[];
    confidence?: { lowConfidence?: boolean; bestScore?: number };
    timingsMs?: Partial<Record<StageKey | "total", number>>;
  }>;
}

export interface SynthesizeOpts {
  tracer: Tracer;
  toolSpanId: string;
  toolStartedAt: Date;
  searchTrace: unknown;
}

export interface SynthesizedSpan {
  name: string;
  durationMs: number;
  attributes: Record<string, unknown>;
  startOffsetMs: number;
}

/** Pure planner — returns the spans we'd emit. Exposed for testing. */
export function planSearchTraceSpans(searchTrace: unknown): SynthesizedSpan[] {
  if (!isV1Trace(searchTrace)) return [];

  const out: SynthesizedSpan[] = [];
  let cursor = 0;

  for (const collection of searchTrace.collections ?? []) {
    const timings = collection.timingsMs ?? {};
    const candidates = collection.candidates ?? [];
    const droppedCount = candidates.filter(
      (c) => c && typeof c === "object" && (c as { kept?: boolean }).kept === false,
    ).length;
    const baseAttrs: Record<string, unknown> = {
      collection: collection.name,
      indexer: collection.indexer,
      fetchK: collection.fetchK,
      candidateCount: candidates.length,
      droppedCount,
      lowConfidence: collection.confidence?.lowConfidence,
      bestScore: collection.confidence?.bestScore,
      synthesized: true,
    };

    for (const key of STAGE_KEYS) {
      const ms = timings[key];
      if (typeof ms !== "number" || ms <= 0) continue;
      out.push({
        name: STAGE_NAMES[key],
        durationMs: ms,
        attributes: { ...baseAttrs, stage: key },
        startOffsetMs: cursor,
      });
      cursor += ms;
    }
  }

  return out;
}

/** Emit synthesized stage spans under a tool span using the given tracer. */
export function emitSearchTraceSpans(opts: SynthesizeOpts): void {
  const planned = planSearchTraceSpans(opts.searchTrace);
  for (const s of planned) {
    opts.tracer.addSubSpan(opts.toolSpanId, s.name, s.durationMs, s.attributes, {
      parentStartedAt: opts.toolStartedAt,
      startOffsetMs: s.startOffsetMs,
    });
  }
}

function isV1Trace(t: unknown): t is SearchTrace & { schemaVersion: 1; collections: NonNullable<SearchTrace["collections"]> } {
  if (!t || typeof t !== "object") return false;
  const obj = t as SearchTrace;
  return obj.schemaVersion === 1 && Array.isArray(obj.collections);
}
