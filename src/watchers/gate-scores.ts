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

/**
 * Default per-run capture limit K — see {@link applyCaptureLimit}.
 *
 * Sized from measurement, not taste: mean floor-passing items per run was **17.9** across
 * 26 logged X capture runs, at ~7.7 capture runs/day — so K=3 lands ~23 inbox rows/day
 * against ~138 before the limit existed.
 */
export const DEFAULT_CAPTURE_MAX_ITEMS = 3;

/**
 * Upper bound accepted for the capture limit. The knob's whole job is to CAP volume, so a
 * fat-fingered `1e9` must not silently uncap it — same stance (and same rationale) as
 * `MAX_AMPLIFICATION_MAX_PROMOTIONS`. Above the largest floor-passing count ever measured
 * (34), so a legitimate setting can never hit it.
 */
export const MAX_CAPTURE_MAX_ITEMS = 25;

/**
 * Keep the best `maxItems` entries of an already-floor-filtered set, by score descending.
 *
 * Lives here, beside the `GateScore` contract, because it is generic over `{n, score}` and
 * the anthropic capture path (`captureGatedCandidates`) has the same uncapped-volume shape
 * this exists to fix — it should import this rather than grow a second copy.
 *
 * **Composition order binds: floor FIRST, then this.** Applying a limit to the raw scored
 * set and filtering by floor afterwards would admit FEWER than `maxItems` whenever a
 * high-scoring item is floor-blocked (a sub-tier X pointer is floor-blocked
 * *unconditionally*), silently under-capturing a strong batch. In the shipped order a weak
 * batch admits fewer than `maxItems` (correct) and a strong batch admits exactly it.
 *
 * Sorting is by SCORE, never parse order: {@link parseGateScores} gives no ordering
 * guarantee, so "first K" would be arbitrary. Ties break toward the lower `n`, which for
 * the X caller is the batch's `combined_score` DESC order — i.e. toward the better-ranked
 * doc when the gate cannot separate two items.
 */
export function applyCaptureLimit(
  passing: { n: number; score: number }[],
  maxItems: number,
): Set<number> {
  if (passing.length <= maxItems) return new Set(passing.map((p) => p.n));
  return new Set(
    [...passing]
      .sort((a, b) => b.score - a.score || a.n - b.n)
      .slice(0, maxItems)
      .map((p) => p.n),
  );
}

/**
 * Append the capture-limit clause to a gate prompt. A wrapper (not a bare fragment) so the
 * composition order is explicit at the call site and testable directly — same shape as
 * `withInterestProfile`, which MUST still wrap last so its "output-format instructions
 * above still apply" trailer stays truthful.
 *
 * **"ranked best-first" is deliberately unconsumed.** `indexScoresByN` keys by `n` and
 * discards array order, and {@link applyCaptureLimit} re-sorts by score. The instruction
 * stays because asking for a ranking is what induces the model to COMPARE items rather
 * than score them independently — that comparison is the entire mechanism. Do not "fix"
 * this by preserving response order downstream; the order is not load-bearing, the
 * comparative reasoning it provokes is.
 *
 * **The anti-padding sentence is load-bearing.** Told only "return at most K", a model
 * reliably returns exactly K — turning a quiet batch into K forced captures. The floors
 * would still hold the bottom, but the shelf would stop reflecting how good the day was.
 */
export function withCaptureLimit(prompt: string, maxItems: number): string {
  return `${prompt}

BUDGET — a hard cap on this response: return AT MOST ${maxItems} items, the ${maxItems} most worth reading, ranked best-first. If more than ${maxItems} clear the bar above, keep only the best ${maxItems} and omit the rest entirely. Returning FEWER than ${maxItems} is correct and expected when the batch is weak — never pad the list to reach ${maxItems}.`;
}

/**
 * The ceiling the X capture-gate prompt asks for on secondhand repackaging, enforced
 * deterministically by {@link clampScores}.
 */
export const REPACKAGING_SCORE_CAP = 0.8;

/**
 * Lower every entry the predicate selects to `cap`. Never raises, never mutates the input.
 *
 * Lives here beside {@link applyCaptureLimit} because it is generic over `{n, score}` for
 * the same reason: the anthropic capture path has the same shape and should import this
 * rather than grow a second copy. `shouldClamp` takes the entry's `n` so the caller owns
 * which items qualify — the X caller clamps only repackaging-shaped long-form `x-post`
 * items, never `x-link` pointers (scored on their destination; capping them would suppress
 * exactly the artifacts the campaign promotes).
 *
 * **Composition order binds: clamp FIRST, before floor and limit.** A clamped 0.8 note now
 * loses the K-slot race in {@link applyCaptureLimit} to a 0.9 primary source — that
 * displacement is the point, not a side effect.
 */
export function clampScores<T extends { n: number; score: number }>(
  scores: T[],
  shouldClamp: (n: number) => boolean,
  cap: number = REPACKAGING_SCORE_CAP,
): { scores: T[]; clamped: number } {
  let clamped = 0;
  const out = scores.map((s) => {
    if (s.score <= cap || !shouldClamp(s.n)) return s;
    clamped++;
    return { ...s, score: cap };
  });
  return { scores: out, clamped };
}
