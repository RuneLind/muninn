interface SearchTraceSummary {
  kept: number;
  fetched: number;
  topTitle: string | null;
  lowConfidence: boolean;
  totalMs: number | null;
}

/** Compress a v1 searchTrace blob into the bits we surface in the waterfall
 *  row: candidate counts, top-ranked hit, low-confidence flag, total ms.
 *  Single pass over candidates regardless of producer shape (Huginn collections[]
 *  or Yggdrasil flat candidates[]). Returns null when there's nothing useful. */
export function summarizeSearchTrace(trace: unknown): SearchTraceSummary | null {
  if (!trace || typeof trace !== "object") return null;
  const t = trace as {
    collections?: Array<{
      candidates?: unknown[];
      confidence?: { lowConfidence?: unknown };
    }>;
    candidates?: unknown[];
    timingsMs?: { total?: unknown };
    totalMs?: unknown;
  };

  let buckets: Array<{ candidates: unknown[]; lowConfidence: boolean }>;
  let isKept: (c: { kept?: unknown; stages?: { final?: unknown } }) => boolean;
  let titleFields: readonly string[];
  let totalMs: number | null = null;

  if (Array.isArray(t.collections) && t.collections.length > 0) {
    buckets = t.collections.map((c) => ({
      candidates: Array.isArray(c?.candidates) ? c.candidates : [],
      lowConfidence: !!(c?.confidence && (c.confidence as { lowConfidence?: unknown }).lowConfidence === true),
    }));
    isKept = (c) => c.kept !== false;
    titleFields = ["docTitle", "documentId"];
    if (typeof t.totalMs === "number") totalMs = t.totalMs;
  } else if (Array.isArray(t.candidates)) {
    buckets = [{ candidates: t.candidates, lowConfidence: false }];
    isKept = (c) => !!(c.stages && c.stages.final);
    titleFields = ["qualifiedName"];
    const total = (t.timingsMs as { total?: unknown } | undefined)?.total;
    if (typeof total === "number") totalMs = total;
  } else {
    return null;
  }

  let kept = 0;
  let fetched = 0;
  let lowConfidence = false;
  let bestRank = Infinity;
  let bestCand: Record<string, unknown> | null = null;

  for (const b of buckets) {
    if (b.lowConfidence) lowConfidence = true;
    for (const cand of b.candidates) {
      if (!cand || typeof cand !== "object") { fetched++; continue; }
      const c = cand as { kept?: unknown; stages?: { final?: { rank?: unknown } } };
      fetched++;
      if (isKept(c)) kept++;
      const rank = c.stages?.final?.rank;
      if (typeof rank === "number" && rank < bestRank) {
        bestRank = rank;
        bestCand = cand as Record<string, unknown>;
      }
    }
  }

  if (fetched === 0) return null;

  let topTitle: string | null = null;
  if (bestCand) {
    for (const f of titleFields) {
      const v = bestCand[f];
      if (typeof v === "string" && v) { topTitle = v; break; }
    }
  }

  return { kept, fetched, topTitle, lowConfidence, totalMs };
}

/** Pull out collection names for chip rendering. Tries searchTrace.collections
 *  first (huginn shape), then synthesizes "yggdrasil" when the trace is the
 *  flatter yggdrasil shape, then falls back to input.collection. */
export function collectionsFor(attrs: { searchTrace?: unknown; input?: unknown }): string[] | null {
  const trace = attrs.searchTrace as
    | { collections?: Array<{ name?: unknown }>; tool?: unknown }
    | undefined;
  if (trace && Array.isArray(trace.collections) && trace.collections.length > 0) {
    const names = trace.collections
      .map((c) => (c && typeof c.name === "string" ? c.name : null))
      .filter((n): n is string => !!n);
    if (names.length > 0) return names;
  }
  // Yggdrasil traces are flatter — no collections, but a `tool` discriminator.
  // Synthesize a single producer chip so the trace dot still shows in the row.
  if (trace && typeof trace.tool === "string" && trace.tool.length > 0) {
    return ["yggdrasil"];
  }
  const raw = attrs.input;
  let input: Record<string, unknown> | null = null;
  if (raw && typeof raw === "object") input = raw as Record<string, unknown>;
  else if (typeof raw === "string") {
    try { input = JSON.parse(raw); } catch { /* ignore */ }
  }
  if (input && typeof input.collection === "string" && input.collection.length > 0) {
    return [input.collection];
  }
  return null;
}

/**
 * Reorder collections so the highest-priority one becomes the primary chip
 * (shown verbatim) instead of getting rolled into "+N". Priority is matched
 * as a case-insensitive substring; ties keep original order. Wiki content is
 * usually the most authoritative source for "how does X work" questions, so
 * it ranks first by default.
 */
export const COLLECTION_PRIORITY: readonly string[] = ["wiki"];

export function sortCollectionsByPriority(collections: string[]): string[] {
  const buckets: string[][] = COLLECTION_PRIORITY.map(() => []);
  const rest: string[] = [];
  for (const name of collections) {
    const lower = name.toLowerCase();
    let placed = false;
    for (let i = 0; i < COLLECTION_PRIORITY.length; i++) {
      if (lower.includes(COLLECTION_PRIORITY[i]!)) {
        buckets[i]!.push(name);
        placed = true;
        break;
      }
    }
    if (!placed) rest.push(name);
  }
  return buckets.flat().concat(rest);
}
