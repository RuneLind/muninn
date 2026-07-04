import { extractJson } from "../ai/json-extract.ts";

/**
 * One scored candidate from a quality-gate model call. Shared contract between the
 * anthropic watcher's alert/capture gate and the x watcher's capture gate: the model
 * returns a JSON array of `{n, score, why}` objects and OMITS routine items entirely.
 */
export interface GateScore {
  n: number;
  score: number;
  why: string;
}

/**
 * Parse a gate model result into GateScores. Throws on unparseable output (no JSON
 * array) so callers can retry/fall back; malformed entries are dropped.
 */
export function parseGateScores(result: string): GateScore[] {
  const parsed = extractJson<unknown[]>(result);
  if (!Array.isArray(parsed)) throw new Error("gate did not return a JSON array");
  return parsed
    .map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      return { n: Number(o.n), score: Number(o.score), why: String(o.why ?? "") };
    })
    .filter((p) => Number.isFinite(p.n) && Number.isFinite(p.score));
}

/**
 * Index gate scores by candidate number (1-based, bounded by `count`). If the model
 * emits more than one object for the same number (off-contract — the prompts ask for
 * one each), keep the HIGHEST score so a passing score is never masked by a later
 * failing duplicate.
 */
export function indexScoresByN(scored: GateScore[], count: number): Map<number, GateScore> {
  const byN = new Map<number, GateScore>();
  for (const s of scored) {
    if (s.n < 1 || s.n > count) continue;
    const prev = byN.get(s.n);
    if (!prev || s.score > prev.score) byN.set(s.n, s);
  }
  return byN;
}
