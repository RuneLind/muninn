/**
 * Jaccard 5-gram similarity for candidate reports.
 *
 * Used by the shake-out invariant (huginn's suggestion — see below). Two
 * benchmark cells with deliberately different MCP stacks on the same issue
 * SHOULD differ in ways consistent with the tool difference: Serena should
 * find call sites that knowledge-only doesn't, yggdrasil should surface
 * blast-radius data that Serena doesn't, etc. If two such cells produce
 * near-identical reports, that's the Bug-9-class signature — "the bot is
 * paraphrasing something it already has in context rather than using the
 * tools we think we're giving it."
 *
 * The right metric here is cheap and lexical, not LLM-judged. Run a Jaccard
 * index on 5-token n-grams extracted from the two reports:
 *
 *   0.95+  → real contamination (Bug 9 style). Abort the session.
 *   0.80-0.95 → calibration band. Inspect manually.
 *   0.40-0.65 → legitimate tool-stack difference. Pass.
 *   <0.40     → suspicious in the other direction — something changed
 *               non-deterministically or a prompt differs unexpectedly.
 *
 * Credit: the thresholds and the "lexical diff is sufficient, don't pay for
 * an LLM judge" framing come from the huginn peer agent during the Bug 9
 * debugging session on 2026-04-13.
 */

/**
 * Tokenise text for n-gram extraction. Keeps it simple: split on whitespace
 * and punctuation, lowercase, drop empty tokens. Not perfect (loses code
 * semantics) but consistent — the goal is comparing two reports that were
 * produced the same way, not building a language model.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[`*_#>|[\](){}<>"':;,.!?—–-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Extract n-grams as a Set of joined strings. n=5 is the default that huginn
 * suggested — short enough to capture local phrasing, long enough that random
 * overlap between unrelated texts is rare.
 */
export function ngrams(tokens: string[], n: number): Set<string> {
  if (tokens.length < n) return new Set();
  const out = new Set<string>();
  for (let i = 0; i <= tokens.length - n; i++) {
    out.add(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

/**
 * Jaccard index of two sets: |A ∩ B| / |A ∪ B|. Returns 0-1.
 * Empty inputs → 0 (no similarity derivable from nothing).
 */
export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * High-level helper for the shake-out check: returns the 5-gram Jaccard
 * similarity between two candidate reports.
 *
 *   shakeoutSimilarity(reportA, reportB) → 0-1
 *
 * The runner or CLI compares this against the thresholds above and decides
 * whether the pair of reports passes a shake-out test.
 */
export function shakeoutSimilarity(
  reportA: string,
  reportB: string,
  n: number = 5,
): number {
  const a = ngrams(tokenize(reportA), n);
  const b = ngrams(tokenize(reportB), n);
  return jaccard(a, b);
}

/**
 * Classify a similarity score into one of four bands. The runner can use this
 * to decide whether to fail fast, warn, or pass a shake-out check.
 */
export type ShakeoutVerdict =
  | "contamination-very-likely" // >= 0.95
  | "calibration-band"          // 0.80-0.95
  | "legitimate-tool-diff"      // 0.40-0.80
  | "unexpectedly-divergent";   // < 0.40

export function classify(similarity: number): ShakeoutVerdict {
  if (similarity >= 0.95) return "contamination-very-likely";
  if (similarity >= 0.80) return "calibration-band";
  if (similarity >= 0.40) return "legitimate-tool-diff";
  return "unexpectedly-divergent";
}
