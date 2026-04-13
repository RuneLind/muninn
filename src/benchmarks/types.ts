/**
 * Shared types for the Jira-analysis benchmark.
 *
 * The benchmark scores how much of a "reviewed analysis" (the gold) each
 * (model × tool stack × prompt) configuration captures in its first-pass
 * analysis. Plan: benchmarks/jira-analysis-benchmark-plan-v2.2.md.
 */

export interface BenchmarkManifest {
  schemaVersion: number;
  issueKey: string;
  title: string;
  category: string;
  gold: GoldRef;
  /** repos affected by this issue — runner needs the path to set up worktrees */
  repos: RepoRef[];
  baseCommits: Record<string, string>;
  /** branch + head per repo. Commits between base and head are recoverable
   *  via `git log <base>..<head>` on the branch — storing them in the manifest
   *  duplicates git's authoritative state and rots on rebase. */
  implementationCommits: Record<string, ImplementationRef>;
  highlightedClaims: HighlightedClaim[];
  curationLog?: CurationEntry[];
}

export interface RepoRef {
  name: string;
  /** Absolute path to the working repo on disk */
  path: string;
}

export interface ImplementationRef {
  branch: string;
  head: string;
}

export interface GoldRef {
  /** "implementeringsplan" (Source A) or "opus-generated" (Source B) */
  source: "implementeringsplan" | "opus-generated";
  /** Absolute filesystem path to the gold markdown */
  path: string;
}

export interface HighlightedClaim {
  id: string;
  /** Canonical wording of the claim — used by the judge for matching */
  claim: string;
  rationale?: string;
}

export interface CurationEntry {
  date: string;
  author: string;
  note: string;
}

/**
 * The judge's structured output. Contains one entry per substantive claim
 * the judge extracted from the gold, plus aggregate statistics.
 */
export interface JudgeResult {
  goldClaims: GoldClaim[];
  stats: JudgeStats;
}

export interface GoldClaim {
  id: string;
  claim: string;
  section: string | null;
  highlighted: boolean;
  verdict: ClaimVerdict;
  /** Verbatim substring from the candidate that supports the verdict */
  evidenceQuote: string | null;
  notes: string | null;
}

export type ClaimVerdict = "found" | "partial" | "missing";

export interface JudgeStats {
  totalClaims: number;
  found: number;
  partial: number;
  missing: number;
  highlightedTotal: number;
  highlightedFound: number;
  highlightedPartial: number;
  highlightedMissing: number;
  /** (found + 0.5 * partial) / total_claims */
  hitRate: number;
  /** (highlighted_found + 0.5 * highlighted_partial) / highlighted_total */
  highlightedRate: number;
}

/**
 * Output of one judge run on one (gold, candidate) pair.
 * The CLI prints this; later phases store it in benchmark_runs.
 */
export interface ScoreReport {
  issueKey: string;
  candidatePath: string;
  goldPath: string;
  goldContentHash: string;
  judgePromptVersion: string;
  judgeModel: string;
  startedAt: string;
  finishedAt: string;
  wallclockMs: number;
  inputTokens: number;
  outputTokens: number;
  result: JudgeResult;
}
