/**
 * Re-judge an existing benchmark run N times and persist each pass as a
 * child row linked to the parent.
 *
 * Why this is useful: the v1 judge prompt has ~6-7pp inter-run variance,
 * so a single cell's hit rate sits inside a noise band wider than most
 * hypothesis deltas. Re-judging N times against the same candidate file
 * (no new analysis, ~$0.15 per pass) collapses the variance without
 * re-spending analysis cost. It also gives a cheap way to iterate the
 * judge prompt — draft a new judge prompt version, re-judge every cell
 * in the archive against it, compare against the v1 verdicts.
 *
 * The parent row is never mutated. Each pass becomes a new row with
 * parent_run_id set; the list-view query hides child rows by default.
 */

import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { getLog } from "../logging.ts";
import { loadManifestByKey } from "./manifest.ts";
import { runJudge, findHighestJudgePromptVersion } from "./judge.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import {
  getBenchmarkRun,
  saveBenchmarkRun,
  completeBenchmarkRun,
  type BenchmarkRunRow,
} from "../db/benchmark-runs.ts";

const log = getLog("benchmarks", "rejudge");

/**
 * In-flight re-judge job state shared between the dashboard route handler
 * and the detail-page view. The route maintains the live instance in its
 * `activeRejudgeJobs` map; the view reads a snapshot of it to render the
 * re-judge panel. Kept in a shared module so both sides reference the
 * same type.
 */
export interface RejudgeJobState {
  parentRunId: string;
  totalPasses: number;
  completedPasses: number;
  startedAt: number;
  status: "running" | "done" | "error";
  error: string | null;
  childRunIds: string[];
}

export interface RejudgeOptions {
  /** Number of re-judge passes to run. Each pass becomes one child row. */
  passes: number;
  /**
   * Path to the judge prompt file to use. When omitted, the highest
   * numbered file in benchmarks/judge-prompts/ is picked — same rule the
   * score-report CLI uses.
   */
  judgePromptPath?: string;
  /**
   * Maximum total spend across all passes in USD. Passes past the budget
   * are skipped. Defaults to BENCHMARK_BUDGET_USD or $10.
   */
  budgetUsd?: number;
  /**
   * Optional progress callback fired as each pass's judge stream produces
   * text. Wired by the dashboard route so SSE subscribers can watch the
   * judge JSON stream in real time. Receives the same StreamProgressEvent
   * shape as runJudge, plus an extra `passIndex` so the UI can label deltas
   * with which of N passes they belong to.
   */
  onProgress?: (event: { passIndex: number; type: string; text?: string }) => void;
}

export interface RejudgePassResult {
  runId: string;
  passIndex: number;
  status: "done" | "error";
  hitRate: number | null;
  highlightedRate: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  wallclockMs: number | null;
  traceId: string | null;
  error: string | null;
}

export interface RejudgeResult {
  parentRunId: string;
  judgePromptPath: string;
  passes: RejudgePassResult[];
  meanHitRate: number | null;
  stddevHitRate: number | null;
  totalCostUsd: number;
}

const DEFAULT_BUDGET_USD = Number(process.env.BENCHMARK_BUDGET_USD ?? "10");

/** Rough cost estimator per judge pass — Sonnet pricing at ~10k output tokens. */
const JUDGE_PASS_COST_ESTIMATE_USD = 0.2;

/**
 * Resolve a candidate file path the judge can read for a parent run.
 * Prefers the original candidatePath on disk; falls back to materialising
 * the stored report_md column to /tmp if the file has moved. Returns a
 * cleanup callback for the temp-path branch.
 */
async function candidatePathForParent(
  parent: BenchmarkRunRow,
): Promise<{ path: string; cleanup: (() => Promise<void>) | null }> {
  try {
    await readFile(parent.candidatePath);
    return { path: parent.candidatePath, cleanup: null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (!parent.reportMd) {
    throw new Error(
      `Parent run ${parent.id}: candidate file missing at ${parent.candidatePath} and no report_md stored`,
    );
  }
  const dir = "/tmp/muninn-rejudge";
  await mkdir(dir, { recursive: true });
  const path = `${dir}/${parent.id}.md`;
  await writeFile(path, parent.reportMd);
  return {
    path,
    cleanup: async () => {
      try {
        await unlink(path);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Sample mean and stddev (n-1 denominator) for a plain number array.
 * Exported so the dashboard detail page can aggregate parent + child
 * hit rates without re-implementing the formula.
 */
export function meanStddev(values: number[]): { mean: number; stddev: number } {
  if (values.length === 0) return { mean: 0, stddev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length === 1) return { mean, stddev: 0 };
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Re-judge a parent run N times. Writes a new benchmark_runs row per pass
 * with parent_run_id set. Returns aggregated hit-rate stats.
 *
 * Runs passes sequentially — the judge is already the bottleneck in any
 * re-judge workflow and parallelising multiple Sonnet calls on one machine
 * buys very little while making log output harder to read.
 */
export async function rejudgeCandidate(
  parentRunId: string,
  opts: RejudgeOptions,
): Promise<RejudgeResult> {
  if (opts.passes < 1) throw new Error("passes must be >= 1");

  const parent = await getBenchmarkRun(parentRunId);
  if (!parent) throw new Error(`Parent run not found: ${parentRunId}`);
  if (parent.parentRunId) {
    throw new Error(
      `Cannot re-judge a re-judge pass — parent run ${parentRunId} already has parent_run_id=${parent.parentRunId}. Re-judge its grandparent instead.`,
    );
  }

  const judgePromptPath = opts.judgePromptPath
    ? resolve(opts.judgePromptPath)
    : findHighestJudgePromptVersion();
  const budgetUsd = opts.budgetUsd ?? DEFAULT_BUDGET_USD;

  const manifest = await loadManifestByKey(parent.issueKey);

  const { path: candidatePathForJudge, cleanup: cleanupTemp } =
    await candidatePathForParent(parent);

  log.info("Re-judging {parentRunId} × {passes} passes against {judgePrompt}", {
    botName: "benchmarks",
    parentRunId,
    passes: opts.passes,
    judgePrompt: judgePromptPath,
    budgetUsd,
  });

  const passes: RejudgePassResult[] = [];
  let totalCostUsd = 0;

  for (let i = 0; i < opts.passes; i++) {
    if (totalCostUsd + JUDGE_PASS_COST_ESTIMATE_USD > budgetUsd) {
      log.warn("Re-judge budget exceeded at pass {pass}/{total} — stopping", {
        botName: "benchmarks",
        pass: i + 1,
        total: opts.passes,
        totalCostUsd,
        budgetUsd,
      });
      break;
    }

    const startedAt = new Date();
    const runId = await saveBenchmarkRun({
      issueKey: parent.issueKey,
      candidatePath: parent.candidatePath,
      goldPath: parent.goldPath,
      goldContentHash: parent.goldContentHash,
      judgePromptVersion: "pending",
      judgeModel: parent.judgeModel,
      startedAt,
      parentRunId,
      analysisTraceId: parent.analysisTraceId,
      treatment: parent.treatment ?? undefined,
      promptId: parent.promptId ?? undefined,
    });

    try {
      const passIndex = i;
      const onJudgeProgress: StreamProgressCallback | undefined = opts.onProgress
        ? (ev) => {
            // Forward only text/text_delta — tool events never fire on the
            // judge call (no MCP tools) but keep the type aligned.
            opts.onProgress!({
              passIndex,
              type: ev.type,
              ...(ev.type === "text_delta" ? { text: ev.text } : {}),
            });
          }
        : undefined;
      const judged = await runJudge({
        manifest,
        candidatePath: candidatePathForJudge,
        judgePromptPath,
        ...(onJudgeProgress ? { onProgress: onJudgeProgress } : {}),
      });

      await completeBenchmarkRun(runId, {
        finishedAt: new Date(),
        status: "done",
        wallclockMs: judged.wallclockMs,
        inputTokens: judged.inputTokens,
        outputTokens: judged.outputTokens,
        judgeResult: judged.result,
        traceId: judged.traceId,
        judgePromptVersion: judged.judgePromptVersion,
        judgeModel: judged.judgeModel,
      });

      // Estimate cost per pass from token counts — Sonnet 4.6: $3/M input + $15/M output.
      const passCost =
        (judged.inputTokens * 3) / 1_000_000 + (judged.outputTokens * 15) / 1_000_000;
      totalCostUsd += passCost;

      passes.push({
        runId,
        passIndex: i,
        status: "done",
        hitRate: judged.result.stats.hitRate,
        highlightedRate: judged.result.stats.highlightedRate,
        inputTokens: judged.inputTokens,
        outputTokens: judged.outputTokens,
        wallclockMs: judged.wallclockMs,
        traceId: judged.traceId,
        error: null,
      });

      log.info("Re-judge pass {pass}/{total} done: hit={hitRate}%", {
        botName: "benchmarks",
        pass: i + 1,
        total: opts.passes,
        runId,
        hitRate: (judged.result.stats.hitRate * 100).toFixed(1),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Re-judge pass {pass}/{total} failed: {error}", {
        botName: "benchmarks",
        pass: i + 1,
        total: opts.passes,
        runId,
        error: msg,
      });
      await completeBenchmarkRun(runId, {
        finishedAt: new Date(),
        status: "error",
        error: msg,
      });
      passes.push({
        runId,
        passIndex: i,
        status: "error",
        hitRate: null,
        highlightedRate: null,
        inputTokens: null,
        outputTokens: null,
        wallclockMs: null,
        traceId: null,
        error: msg,
      });
    }
  }

  if (cleanupTemp) await cleanupTemp();

  const doneHits = passes
    .filter((p) => p.status === "done" && p.hitRate !== null)
    .map((p) => p.hitRate as number);
  const { mean, stddev } = meanStddev(doneHits);

  return {
    parentRunId,
    judgePromptPath,
    passes,
    meanHitRate: doneHits.length > 0 ? mean : null,
    stddevHitRate: doneHits.length > 0 ? stddev : null,
    totalCostUsd,
  };
}
