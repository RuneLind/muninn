/**
 * Lexical shake-out check for benchmark cells. Compares two candidate
 * reports via 5-gram Jaccard similarity; high similarity between cells
 * that should have differed (e.g. different MCP stacks on the same issue)
 * is the signature of the Bug 9 class of cross-cell state leaks — see
 * benchmarks/known-bugs.md Bug 9. Cheap, deterministic, no LLM dependency.
 */

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[`*_#>|[\](){}<>"':;,.!?—–-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export function ngrams(tokens: string[], n: number): Set<string> {
  if (tokens.length < n) return new Set();
  const out = new Set<string>();
  for (let i = 0; i <= tokens.length - n; i++) {
    out.add(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function shakeoutSimilarity(
  reportA: string,
  reportB: string,
  n: number = 5,
): number {
  const a = ngrams(tokenize(reportA), n);
  const b = ngrams(tokenize(reportB), n);
  return jaccard(a, b);
}

export type ShakeoutVerdict =
  | "contamination-very-likely" // >= 0.95
  | "calibration-band"          // 0.80-0.95
  | "legitimate-tool-diff"      // 0.40-0.80
  | "unexpectedly-divergent";   // < 0.40

/**
 * Band thresholds from huginn's Bug 9 debugging session:
 *   ≥0.95 → contamination (bot paraphrasing its own prior output)
 *   0.80-0.95 → calibration band, inspect manually
 *   0.40-0.80 → legitimate tool-stack difference
 *   <0.40 → unexpectedly divergent, something else changed
 */
export function classify(similarity: number): ShakeoutVerdict {
  if (similarity >= 0.95) return "contamination-very-likely";
  if (similarity >= 0.80) return "calibration-band";
  if (similarity >= 0.40) return "legitimate-tool-diff";
  return "unexpectedly-divergent";
}
