/**
 * Multi-pass analysis cell: N sequential passes sharing userId/threadId,
 * each pass potentially using a different MCP stack and prompt variant.
 *
 * Judge runs once on the concatenated candidate (pass-1 report + pass-2 report
 * + ...), not per pass. The last pass's benchmark_runs row carries the judge
 * verdict; earlier passes' rows are marked `done` without judge data.
 *
 * Each pass's trace is audited for Bug 11 leakage independently — a leak in
 * any pass fails the cell before the judge is called.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { getLog } from "../logging.ts";
import { completeBenchmarkRun, type BenchmarkTreatment } from "../db/benchmark-runs.ts";
import { ensureCellIdentity } from "./cell-context.ts";
import { runJudge, stripReportFrontmatter } from "./judge.ts";
import { loadManifestByKey } from "./manifest.ts";
import { runCell, defaultBudget, type SingleRunResult, type McpStack } from "./cell.ts";
import { defaultJudgePromptPath } from "./prompt-variants.ts";

const log = getLog("benchmarks", "multi-pass");

/**
 * One pass in a multi-pass cell: which prompt variant + which MCP stack to
 * expose for that pass. All passes in the cell share the same connector,
 * model, userId, and threadId — so the nth pass sees the 1..n-1 pass reports
 * in its conversation history.
 */
export interface MultiPassSpec {
  /** Prompt variant id (must resolve to benchmarks/prompts/<promptId>.txt) */
  promptId: string;
  /** MCP stack exposed to this pass */
  mcpStack: McpStack;
  /** Override the user message text for this pass. Defaults to
   *  "{issueKey}: {title}" (same as runCell). Pass 2 typically wants a
   *  short follow-up like "Fortsett analysen med kodesøk." */
  messageOverride?: string;
  /** Short label for logging / combined report section headings */
  label?: string;
}

export interface RunCellMultiPassOptions {
  issueKey: string;
  /** Connector + model held constant across all passes */
  connector: BenchmarkTreatment["connector"];
  model: BenchmarkTreatment["model"];
  passes: MultiPassSpec[];
  baseBotName?: string;
  /** Total budget across all passes */
  budgetUsd?: number;
  dryRun?: boolean;
  judgePromptPath?: string;
}

export interface RunCellMultiPassResult {
  issueKey: string;
  passes: Array<{
    spec: MultiPassSpec;
    run: SingleRunResult;
  }>;
  /** Absolute path to the combined candidate that was handed to the judge */
  combinedCandidatePath: string;
  /** Judge result on the combined candidate */
  hitRate: number | null;
  highlightedRate: number | null;
  /** Sum of analysis + judge costs across all passes. */
  totalCostUsd: number;
  /** benchmark_runs row id that carries the judge result (the last pass's row) */
  judgeBenchmarkRunId: string | null;
  judgeError?: string;
}

export async function runCellMultiPass(
  opts: RunCellMultiPassOptions,
): Promise<RunCellMultiPassResult> {
  if (opts.passes.length === 0) {
    throw new Error("runCellMultiPass requires at least one pass");
  }

  const baseBotName = opts.baseBotName ?? "melosys";
  // Each pass makes its own Tracer against this shared identity, so the
  // Bug-11 audit runs per-trace. Shared userId/threadId is what lets pass N
  // see passes 1..N-1 in <conversation_history>.
  const sharedIdentity = await ensureCellIdentity({
    issueKey: opts.issueKey,
    runIndex: 0,
    botName: baseBotName,
  });

  log.info(
    "Multi-pass cell: {issue} userId={userId} threadId={threadId} passes={n}",
    {
      botName: "benchmarks",
      issue: opts.issueKey,
      userId: sharedIdentity.userId,
      threadId: sharedIdentity.threadId,
      n: opts.passes.length,
    },
  );

  const budget = opts.budgetUsd ?? defaultBudget();
  const passResults: Array<{ spec: MultiPassSpec; run: SingleRunResult }> = [];
  let cumulativeCost = 0;

  for (let i = 0; i < opts.passes.length; i++) {
    const spec = opts.passes[i]!;
    if (cumulativeCost >= budget) {
      log.warn("Budget cap ${budget} reached before pass {i} — aborting remaining passes", {
        botName: "benchmarks",
        budget,
        i,
      });
      break;
    }
    const remainingBudget = budget - cumulativeCost;

    log.info(
      "Multi-pass: starting pass {i}/{n} — promptId={promptId} mcpStack={stack}",
      {
        botName: "benchmarks",
        i: i + 1,
        n: opts.passes.length,
        promptId: spec.promptId,
        stack: spec.mcpStack,
      },
    );

    const passTreatment: BenchmarkTreatment = {
      connector: opts.connector,
      model: opts.model,
      mcpStack: spec.mcpStack,
      promptId: spec.promptId,
    };

    // Each pass spins up its own Serena/Yggdrasil instances and tears them
    // down on exit (via runCell's finally block). That's intentional: pass 1
    // runs knowledge-only with no yggdrasil reachable, pass 2 spins up a
    // fresh yggdrasil instance and indexes the worktrees. The re-index cost
    // (~30s per yggdrasil start) is paid by the pass that needs it, not by
    // pass 1.
    const cellResult = await runCell({
      issueKey: opts.issueKey,
      treatment: passTreatment,
      baseBotName,
      nRuns: 1,
      budgetUsd: remainingBudget,
      dryRun: opts.dryRun,
      messageOverride: spec.messageOverride,
      judgePromptPath: opts.judgePromptPath,
      preBuiltContext: sharedIdentity,
      // Judge runs once at the end on the combined candidate; per-pass
      // runs are marked `done` without judge data.
      skipJudge: true,
    });

    const run = cellResult.runs[0];
    if (!run) {
      throw new Error(
        `Multi-pass: pass ${i} returned no run result (cellResult.runs is empty)`,
      );
    }
    passResults.push({ spec, run });
    cumulativeCost += run.costUsd;

    if (run.status === "error") {
      log.error(
        "Multi-pass: pass {i} errored — aborting remaining passes. error={error}",
        {
          botName: "benchmarks",
          i: i + 1,
          error: run.error ?? "(unknown)",
        },
      );
      break;
    }
  }

  const combinedCandidateDir = resolve(
    import.meta.dir,
    "../../benchmarks/runs",
    opts.issueKey,
    `${Date.now()}-multipass-${opts.connector}-${opts.model}`,
  );
  await mkdir(combinedCandidateDir, { recursive: true });
  const combinedCandidatePath = join(combinedCandidateDir, "candidate.md");

  const sections: string[] = [];
  for (let i = 0; i < passResults.length; i++) {
    const pr = passResults[i]!;
    let body = "";
    try {
      const raw = await readFile(pr.run.candidatePath, "utf8");
      body = stripReportFrontmatter(raw).trim();
    } catch (err) {
      log.warn("Multi-pass: could not read pass {i} candidate at {path}: {err}", {
        botName: "benchmarks",
        i: i + 1,
        path: pr.run.candidatePath,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    const label =
      pr.spec.label ??
      `Pass ${i + 1} — promptId=${pr.spec.promptId} mcpStack=${pr.spec.mcpStack}`;
    sections.push(`## ${label}\n\n${body}`);
  }

  const lastPass = passResults[passResults.length - 1];
  const combinedTraceId =
    lastPass?.run.analysisTraceId ?? passResults[0]?.run.analysisTraceId ?? "multipass-none";
  const frontmatter = [
    "---",
    `issue_key: ${opts.issueKey}`,
    `analysis_trace_id: ${combinedTraceId}`,
    `connector: ${opts.connector}`,
    `model: ${opts.model}`,
    `mcp_stack: multi-pass`,
    `prompt_id: multi-pass`,
    `multi_pass_specs: ${JSON.stringify(opts.passes.map((p) => ({ promptId: p.promptId, mcpStack: p.mcpStack })))}`,
    `multi_pass_trace_ids: ${JSON.stringify(passResults.map((p) => p.run.analysisTraceId))}`,
    `generated_at: ${new Date().toISOString()}`,
    "---",
    "",
  ].join("\n");
  const combinedText = frontmatter + sections.join("\n\n---\n\n") + "\n";
  await writeFile(combinedCandidatePath, combinedText, "utf8");

  log.info("Multi-pass: combined candidate written to {path}", {
    botName: "benchmarks",
    path: combinedCandidatePath,
  });

  const anyPassError = passResults.some((p) => p.run.status === "error");
  if (opts.dryRun || anyPassError || passResults.length === 0) {
    return {
      issueKey: opts.issueKey,
      passes: passResults,
      combinedCandidatePath,
      hitRate: null,
      highlightedRate: null,
      totalCostUsd: cumulativeCost,
      judgeBenchmarkRunId: null,
      judgeError: anyPassError ? "at least one pass errored — judge skipped" : undefined,
    };
  }

  const manifest = await loadManifestByKey(opts.issueKey);
  const judgePromptPath = opts.judgePromptPath ?? defaultJudgePromptPath();
  let hitRate: number | null = null;
  let highlightedRate: number | null = null;
  let judgeError: string | undefined;

  const judgeTargetRunId = lastPass?.run.benchmarkRunId ?? null;

  try {
    const judgeResult = await runJudge({
      manifest,
      candidatePath: combinedCandidatePath,
      judgePromptPath,
    });
    hitRate = judgeResult.result.stats.hitRate;
    highlightedRate = judgeResult.result.stats.highlightedRate;

    if (judgeTargetRunId && lastPass) {
      await completeBenchmarkRun(judgeTargetRunId, {
        finishedAt: new Date(),
        status: "done",
        wallclockMs: judgeResult.wallclockMs,
        inputTokens: judgeResult.inputTokens,
        outputTokens: judgeResult.outputTokens,
        judgeResult: judgeResult.result,
        reportMd: combinedText,
      }).catch((err) => {
        log.warn("Multi-pass: failed to update last pass row with judge result: {err}", {
          botName: "benchmarks",
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (err) {
    judgeError = err instanceof Error ? err.message : String(err);
    log.error("Multi-pass: judge failed: {err}", {
      botName: "benchmarks",
      err: judgeError,
    });
    if (judgeTargetRunId) {
      // Last pass's row was already marked status=done by its own runOneCell
      // (skipJudge=true branch). Overwrite with status=error so the row
      // reflects reality — we produced a candidate but couldn't score it.
      await completeBenchmarkRun(judgeTargetRunId, {
        finishedAt: new Date(),
        status: "error",
        error: `multi-pass judge failed: ${judgeError}`,
        reportMd: combinedText,
      }).catch(() => {});
    }
  }

  return {
    issueKey: opts.issueKey,
    passes: passResults,
    combinedCandidatePath,
    hitRate,
    highlightedRate,
    totalCostUsd: cumulativeCost,
    judgeBenchmarkRunId: judgeTargetRunId,
    judgeError,
  };
}
