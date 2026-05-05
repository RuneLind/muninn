/**
 * Run two cells on the same issue with different MCP stacks and compare
 * their candidate reports via 5-gram Jaccard similarity. High similarity
 * between cells that should have differed is a structural signal for
 * cross-cell state leaks that hit-rate/highlighted-rate metrics miss.
 */

import { readFile } from "node:fs/promises";
import { getLog } from "../logging.ts";
import type { BenchmarkTreatment } from "../db/benchmark-runs.ts";
import { stripReportFrontmatter } from "./judge.ts";
import { shakeoutSimilarity, classify, type ShakeoutVerdict } from "./jaccard.ts";
import { runCell, type RunCellResult, type McpStack } from "./cell.ts";

const log = getLog("benchmarks", "shakeout");

export interface RunShakeoutOptions {
  issueKey: string;
  /**
   * Base treatment. `mcpStack` is ignored; the shake-out always runs
   * `stackA` and `stackB` (defaulting to knowledge-only vs knowledge+serena).
   */
  baseTreatment: BenchmarkTreatment;
  baseBotName?: string;
  /** Total budget across both cells combined, not per-cell. */
  budgetUsd?: number;
  dryRun?: boolean;
  stackA?: McpStack;
  stackB?: McpStack;
}

export interface RunShakeoutResult {
  cellA: RunCellResult;
  cellB: RunCellResult;
  stackA: McpStack;
  stackB: McpStack;
  similarity: number;
  verdict: ShakeoutVerdict;
  inconclusive: boolean;
  inconclusiveReason?: string;
}

/**
 * Both cells share the connector/model/promptId from `baseTreatment`;
 * only `mcpStack` differs. `nRuns` is fixed at 1 per cell because the
 * similarity bands assume single-run pairs.
 */
export async function runShakeout(
  opts: RunShakeoutOptions,
): Promise<RunShakeoutResult> {
  const stackA: McpStack = opts.stackA ?? "knowledge-only";
  const stackB: McpStack = opts.stackB ?? "knowledge+serena";
  if (stackA === stackB) {
    throw new Error(
      `Shake-out requires two different stacks; got stackA=${stackA} stackB=${stackB}. ` +
        "Comparing a stack to itself produces similarity≈1 by construction and tells you nothing.",
    );
  }

  log.info(
    "Shake-out: {issue} cellA={stackA} cellB={stackB} dryRun={dry}",
    {
      botName: "benchmarks",
      issue: opts.issueKey,
      stackA,
      stackB,
      dry: !!opts.dryRun,
    },
  );

  const makeTreatment = (stack: McpStack): BenchmarkTreatment => ({
    ...opts.baseTreatment,
    mcpStack: stack,
  });

  const cellA = await runCell({
    issueKey: opts.issueKey,
    treatment: makeTreatment(stackA),
    baseBotName: opts.baseBotName,
    nRuns: 1,
    budgetUsd: opts.budgetUsd,
    dryRun: opts.dryRun,
  });

  const budgetRemaining = opts.budgetUsd !== undefined
    ? Math.max(0, opts.budgetUsd - cellA.totalCostUsd)
    : undefined;

  const cellB = await runCell({
    issueKey: opts.issueKey,
    treatment: makeTreatment(stackB),
    baseBotName: opts.baseBotName,
    nRuns: 1,
    budgetUsd: budgetRemaining,
    dryRun: opts.dryRun,
  });

  const runA = cellA.runs[0];
  const runB = cellB.runs[0];
  if (!runA || !runB || runA.status !== "done" || runB.status !== "done") {
    return {
      cellA,
      cellB,
      stackA,
      stackB,
      similarity: 0,
      verdict: "unexpectedly-divergent",
      inconclusive: true,
      inconclusiveReason:
        `at least one cell did not complete: cellA=${runA?.status ?? "missing"}` +
        (runA?.error ? ` (${runA.error})` : "") +
        ` cellB=${runB?.status ?? "missing"}` +
        (runB?.error ? ` (${runB.error})` : ""),
    };
  }

  let textA: string;
  let textB: string;
  try {
    const [rawA, rawB] = await Promise.all([
      readFile(runA.candidatePath, "utf8"),
      readFile(runB.candidatePath, "utf8"),
    ]);
    textA = stripReportFrontmatter(rawA);
    textB = stripReportFrontmatter(rawB);
  } catch (err) {
    return {
      cellA,
      cellB,
      stackA,
      stackB,
      similarity: 0,
      verdict: "unexpectedly-divergent",
      inconclusive: true,
      inconclusiveReason: `failed to read candidate files: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const similarity = shakeoutSimilarity(textA, textB, 5);
  const verdict = classify(similarity);

  log.info(
    "Shake-out result: similarity={sim} verdict={verdict}",
    {
      botName: "benchmarks",
      sim: similarity.toFixed(4),
      verdict,
    },
  );

  return {
    cellA,
    cellB,
    stackA,
    stackB,
    similarity,
    verdict,
    inconclusive: false,
  };
}
