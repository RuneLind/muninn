import type { Tracer } from "../tracing/index.ts";
import type { CorrectiveToolMeta } from "../types.ts";

/**
 * Synthesize waterfall spans for a knowledge-search tool call's CRAG-lite
 * corrective pass (see src/ai/corrective-retrieval.ts):
 *
 *   - one `knowledge_grade` span — the Haiku retrieval evaluator (attrs:
 *     verdicts per pass, the triggering reason, the final verdict, model)
 *   - one `knowledge_requery` span per corrective re-query (attrs: the rewritten
 *     query, the collection scope)
 *
 * They're nested under the tool span and laid out sequentially starting at the
 * tool span's nominal end (the corrective work runs *after* Huginn's search, in
 * the connector's onPostToolUse hook), so they extend just past the tool bar's
 * right edge — which is the honest picture of the added latency.
 *
 * Mirrors the structure of {@link emitSearchTraceSpans} in search-trace-spans.ts.
 */

export interface SynthesizedCorrectiveSpan {
  name: string;
  durationMs: number;
  attributes: Record<string, unknown>;
  /** Offset from the *tool span's* start. */
  startOffsetMs: number;
}

/** Pure planner — returns the spans we'd emit for a tool call with corrective
 *  metadata. `toolDurationMs` is where the corrective spans begin (just after
 *  the tool's own work). Exposed for testing. */
export function planCorrectiveSpans(
  corrective: CorrectiveToolMeta | undefined,
  toolDurationMs: number,
): SynthesizedCorrectiveSpan[] {
  if (!corrective || !Array.isArray(corrective.verdicts) || corrective.verdicts.length === 0) return [];

  const out: SynthesizedCorrectiveSpan[] = [];
  let cursor = Math.max(0, toolDurationMs);

  const graderMs = typeof corrective.graderMs === "number" && corrective.graderMs > 0 ? corrective.graderMs : 1;
  out.push({
    name: "knowledge_grade",
    durationMs: graderMs,
    startOffsetMs: cursor,
    attributes: {
      model: "haiku",
      passes: corrective.verdicts.length,
      verdicts: corrective.verdicts,
      finalVerdict: corrective.finalVerdict,
      reason: corrective.reasons?.[0],
      retries: corrective.retries,
      synthesized: true,
    },
  });
  cursor += graderMs;

  const requeryMs = corrective.requeryMs ?? [];
  corrective.queriesTried.forEach((query, i) => {
    const ms = typeof requeryMs[i] === "number" && requeryMs[i]! > 0 ? requeryMs[i]! : 1;
    const collection = corrective.collectionsTried?.[i] ?? null;
    out.push({
      name: "knowledge_requery",
      durationMs: ms,
      startOffsetMs: cursor,
      attributes: {
        query,
        collection: collection && collection.length > 0 ? collection.join(", ") : "(all)",
        index: i + 1,
        synthesized: true,
      },
    });
    cursor += ms;
  });

  return out;
}

/** Emit the corrective spans under the given tool span. No-op when there's no
 *  corrective metadata. */
export function emitCorrectiveSpans(opts: {
  tracer: Tracer;
  toolSpanId: string;
  toolStartedAt: Date;
  toolDurationMs: number;
  corrective: CorrectiveToolMeta | undefined;
}): void {
  for (const s of planCorrectiveSpans(opts.corrective, opts.toolDurationMs)) {
    opts.tracer.addSubSpan(opts.toolSpanId, s.name, s.durationMs, s.attributes, {
      parentStartedAt: opts.toolStartedAt,
      startOffsetMs: s.startOffsetMs,
    });
  }
}
