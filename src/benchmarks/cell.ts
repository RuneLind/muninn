/**
 * Single-cell benchmark engine.
 *
 * Given (issue, treatment), produce a fresh analysis against the issue's
 * worktrees at baseCommit and score it end-to-end. No matrix, no parallelism.
 *
 * Why this calls processMessage directly (instead of POSTing to
 * /api/research/chat): the HTTP endpoint stores a "pending message" and
 * relies on the chat WebSocket to pick it up — there's no way to capture
 * the analysis traceId from its response, and no way to override the
 * connector/model/MCP stack per request without restructuring the whole
 * chat pipeline. Calling processMessage directly with a runner-owned
 * Tracer satisfies the deeper intent: the runner knows the trace_id
 * because it created the Tracer.
 *
 * The runner is sequential by default and refuses to spend more than
 * BENCHMARK_BUDGET_USD across an n-runs loop. See benchmarks/CLAUDE.md
 * for the architectural rationale.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { processMessage } from "../core/message-processor.ts";
import type { ProcessMessageResult } from "../core/message-processor.ts";
import type { BotConfig } from "../bots/config.ts";
import { loadConfig, type Config } from "../config.ts";
import { getLog, setupLogging } from "../logging.ts";
import {
  saveBenchmarkRun,
  completeBenchmarkRun,
  type BenchmarkTreatment,
  type BenchmarkStackConfig,
} from "../db/benchmark-runs.ts";
import { ensureCellContext } from "./cell-context.ts";
import { Tracer } from "../tracing/index.ts";
import { runJudge } from "./judge.ts";
import { loadManifestByKey } from "./manifest.ts";
import type { BenchmarkManifest } from "./types.ts";
import { prepareWorktrees, type PreparedWorktree } from "./worktree.ts";
import {
  benchmarkSerenaManager,
  allocateBenchmarkPort,
  type BenchmarkSerenaInstance,
} from "./serena-benchmark.ts";
import {
  benchmarkYggdrasilManager,
  allocateBenchmarkYggdrasilPort,
  toStackEntries as yggdrasilStackEntries,
  type BenchmarkYggdrasilInstance,
} from "./yggdrasil-manager.ts";
import { auditCellForLeaks, failCellWithError } from "./audit.ts";
import {
  applyTreatmentOverlay,
  buildBenchmarkSerenaInstanceName,
  findBot,
  prepareScratchBotDir,
  stackUsesSerena,
  stackUsesYggdrasil,
  type McpStack,
} from "./scratch-bot.ts";
import {
  buildDefaultMessage,
  defaultJudgePromptPath,
  loadPromptVariant,
} from "./prompt-variants.ts";

const log = getLog("benchmarks", "cell");

export type { McpStack } from "./scratch-bot.ts";

export interface RunCellOptions {
  issueKey: string;
  treatment: BenchmarkTreatment;
  /** Override the base bot whose persona/.mcp.json is used as the template (default: melosys) */
  baseBotName?: string;
  /** Number of runs to average over. Phase 1 default 1 — averaging is for matrix runs. */
  nRuns?: number;
  /** Hard budget cap in USD across all n-runs. Refuses next run when exceeded. */
  budgetUsd?: number;
  /** Skip the judge call — just produce the analysis and verify plumbing */
  dryRun?: boolean;
  /** Override the message text sent to the analysis. Defaults to manifest.title plus a synthesised description. */
  messageOverride?: string;
  /** Path to the judge prompt — defaults to highest vN.md in benchmarks/judge-prompts/ */
  judgePromptPath?: string;
  /** @internal — reuse an existing userId/threadId instead of creating a fresh
   *  cell context. Used by runCellMultiPass so sequential passes share a
   *  conversation. Public callers should leave this undefined. */
  preBuiltContext?: { userId: string; threadId: string };
  /** @internal — skip the judge step even if not a dry-run. Used by
   *  runCellMultiPass so the judge runs once per cell on the concatenated
   *  candidate, not per pass. Public callers should leave this undefined. */
  skipJudge?: boolean;
  /**
   * Pre-allocated analysis trace ID. When set, the runner's Tracer uses this
   * UUID instead of generating a fresh one. Used by the dashboard live-run
   * view, which pre-allocates the trace ID before spawning the runner so the
   * client can subscribe to spans from the moment the request lands. Only
   * honoured for nRuns=1; for n-runs loops it's ignored past the first run.
   */
  preAllocatedTraceId?: string;
}

export interface RunCellResult {
  issueKey: string;
  treatment: BenchmarkTreatment;
  runs: SingleRunResult[];
  /** Aggregate cost across all runs */
  totalCostUsd: number;
}

export interface SingleRunResult {
  runIndex: number;
  benchmarkRunId: string | null;
  analysisTraceId: string;
  judgeTraceId: string | null;
  candidatePath: string;
  hitRate: number | null;
  highlightedRate: number | null;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  toolCallCount: number;
  status: "done" | "error";
  error?: string;
}

/** Default budget cap, can be overridden per-call or via $BENCHMARK_BUDGET_USD */
export function defaultBudget(): number {
  const env = process.env.BENCHMARK_BUDGET_USD;
  if (env) {
    const n = parseFloat(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 10;
}

export async function runCell(opts: RunCellOptions): Promise<RunCellResult> {
  const config = loadConfig();
  // Idempotent — the main muninn process configures LogTape via index.ts; this
  // call is only meaningful when runCell is invoked from a subprocess entry
  // point like benchmarks/scripts/run-cell.ts that doesn't bootstrap logging
  // itself. Without it every log.* call inside the runner (judge failures,
  // empty-candidate errors, Bug 11 audit failures) becomes a silent no-op
  // and the dashboard /logs page shows nothing — the only signal is the
  // benchmark_runs.error column. runShakeout and runCellMultiPass both call
  // runCell so this one hook covers every benchmark entry point.
  await setupLogging(config.logDir);
  const manifest = await loadManifestByKey(opts.issueKey);
  const baseBotName = opts.baseBotName ?? "melosys";
  const baseBot = findBot(baseBotName);
  const nRuns = opts.nRuns ?? 1;
  const budget = opts.budgetUsd ?? defaultBudget();
  // Fallback: when the caller didn't set preAllocatedTraceId but the dashboard
  // live-run path exported BENCHMARK_TRACE_ID, honour that for nRuns=1 so the
  // UI that spawned this process can subscribe to spans under the known UUID.
  // Direct callers (runShakeout, runCellMultiPass) pass their own options and
  // aren't affected by this fallback.
  const preAllocatedTraceId =
    opts.preAllocatedTraceId ??
    (nRuns === 1 ? process.env.BENCHMARK_TRACE_ID : undefined);

  log.info(
    "Starting cell: issue={issue} treatment={treatment} nRuns={nRuns} budget=${budget}",
    {
      botName: "benchmarks",
      issue: manifest.issueKey,
      treatment: JSON.stringify(opts.treatment),
      nRuns,
      budget,
    },
  );

  // Step 1 — worktrees (idempotent, reused across runs)
  const worktrees = await prepareWorktrees(manifest);

  // Step 2 — start Serena and/or Yggdrasil instances for stacks that need them
  const stack = opts.treatment.mcpStack as McpStack;
  const serenaInstances: BenchmarkSerenaInstance[] = [];
  let yggdrasilInstance: BenchmarkYggdrasilInstance | null = null;
  let scratchDir: string | null = null;
  let cellResult: RunCellResult;

  // Captured so the finally block can restore even if the cell crashes
  // mid-run. parseYggdrasilTracePointer's allow-list is built from
  // YGGDRASIL_MCP_URL at every call, so overriding it scopes cleanly to
  // the cell.
  const originalYggdrasilMcpUrl = process.env.YGGDRASIL_MCP_URL;

  try {
    if (stackUsesSerena(stack)) {
      const usedPorts = new Set<number>();
      const specs = worktrees.map((wt) => {
        const port = allocateBenchmarkPort(usedPorts);
        usedPorts.add(port);
        return {
          name: buildBenchmarkSerenaInstanceName(manifest.issueKey, wt.repo),
          projectPath: wt.worktreePath,
          port,
        };
      });
      const started = await Promise.all(specs.map((s) => benchmarkSerenaManager.start(s)));
      serenaInstances.push(...started);
    }

    if (stackUsesYggdrasil(stack)) {
      const yggPort = allocateBenchmarkYggdrasilPort([]);
      // Name matches the prod bot's prompt (which references "yggdrasil
      // search", "yggdrasil impact" etc.), so the resulting tool names
      // mcp__yggdrasil__search / __impact / __detect_changes line up with
      // what the bot is primed to call.
      yggdrasilInstance = await benchmarkYggdrasilManager.start({
        name: "yggdrasil",
        issueKey: manifest.issueKey,
        port: yggPort,
        repos: worktrees.map((wt) => ({
          repo: wt.repo,
          worktreePath: wt.worktreePath,
        })),
      });
      // Yggdrasil bakes its own port into the trace pointer URL it emits
      // (yggdrasil/src/tracing/trace-store.ts), and Muninn's pointer parser
      // gates fetches on YGGDRASIL_MCP_URL's origin. Without this override
      // the bench-port URL is silently rejected and `searchTrace` never
      // lands on the span.
      process.env.YGGDRASIL_MCP_URL = yggdrasilInstance.mcpUrl;
    }

    // Step 3 — scratch bot dir with overlayed .mcp.json
    scratchDir = await prepareScratchBotDir(
      baseBot,
      manifest,
      opts.treatment,
      serenaInstances,
      yggdrasilInstance,
    );

    // Step 4 — load the prompt variant (if any) and build the derived bot config
    const jiraPromptOverride = await loadPromptVariant(opts.treatment.promptId);
    const effectiveBot = applyTreatmentOverlay(
      baseBot,
      scratchDir,
      opts.treatment,
      jiraPromptOverride,
    );

    // Step 5 — sequential n-runs loop with budget enforcement
    const runs: SingleRunResult[] = [];
    let totalCost = 0;
    for (let i = 0; i < nRuns; i++) {
      if (totalCost >= budget) {
        log.warn("Budget cap ${budget} reached before run {i} — aborting remaining runs", {
          botName: "benchmarks",
          budget,
          i,
        });
        break;
      }
      const run = await runOneCell({
        runIndex: i,
        manifest,
        worktrees,
        treatment: opts.treatment,
        effectiveBot,
        config,
        serenaInstances,
        yggdrasilInstance,
        stack,
        dryRun: opts.dryRun ?? false,
        messageOverride: opts.messageOverride,
        judgePromptPath: opts.judgePromptPath,
        preBuiltContext: opts.preBuiltContext,
        skipJudge: opts.skipJudge,
        // Only honour the pre-allocated trace ID on the first run — subsequent
        // runs in the same n-runs loop need fresh trace IDs, and the live view
        // only supports nRuns=1 anyway.
        preAllocatedTraceId: i === 0 ? preAllocatedTraceId : undefined,
      });
      runs.push(run);
      totalCost += run.costUsd;
    }

    cellResult = {
      issueKey: manifest.issueKey,
      treatment: opts.treatment,
      runs,
      totalCostUsd: totalCost,
    };
  } finally {
    if (originalYggdrasilMcpUrl === undefined) {
      delete process.env.YGGDRASIL_MCP_URL;
    } else {
      process.env.YGGDRASIL_MCP_URL = originalYggdrasilMcpUrl;
    }
    // allSettled so one hung stop can't block the rest — each instance is
    // independent and a leaked process is worse than a noisy teardown log.
    const teardowns: Promise<unknown>[] = [];
    if (serenaInstances.length > 0) {
      log.info("Tearing down {n} benchmark Serena instances", {
        botName: "benchmarks",
        n: serenaInstances.length,
      });
      for (const inst of serenaInstances) {
        teardowns.push(benchmarkSerenaManager.stop(inst.name));
      }
    }
    if (yggdrasilInstance) {
      log.info("Tearing down benchmark Yggdrasil instance {name}", {
        botName: "benchmarks",
        name: yggdrasilInstance.name,
      });
      teardowns.push(benchmarkYggdrasilManager.stop(yggdrasilInstance.name));
    }
    if (teardowns.length > 0) {
      await Promise.allSettled(teardowns);
    }
    // Scratch dirs are intentionally left on disk for debugging; they're
    // gitignored under benchmarks/scratch/.
  }

  return cellResult;
}

interface RunOneCellArgs {
  runIndex: number;
  manifest: BenchmarkManifest;
  worktrees: PreparedWorktree[];
  treatment: BenchmarkTreatment;
  effectiveBot: BotConfig;
  config: Config;
  serenaInstances: BenchmarkSerenaInstance[];
  yggdrasilInstance: BenchmarkYggdrasilInstance | null;
  stack: McpStack;
  dryRun: boolean;
  messageOverride?: string;
  judgePromptPath?: string;
  /** When set, skip ensureCellContext and reuse the provided userId/threadId.
   *  Used by runCellMultiPass so sequential passes share a conversation. A
   *  fresh Tracer is still created per pass — the trace is the per-pass unit
   *  the Bug 11 audit runs against, not the cell. */
  preBuiltContext?: { userId: string; threadId: string };
  /** When set, skip the judge step even if dryRun is false. Used by
   *  runCellMultiPass so the judge runs once on the concatenated candidate,
   *  not per pass. */
  skipJudge?: boolean;
  /** When set, the fresh Tracer uses this UUID instead of generating one.
   *  See RunCellOptions.preAllocatedTraceId for rationale. */
  preAllocatedTraceId?: string;
}

async function runOneCell(args: RunOneCellArgs): Promise<SingleRunResult> {
  const { runIndex, manifest, worktrees, treatment, effectiveBot, config, dryRun } = args;

  const runDir = resolve(
    import.meta.dir,
    "../../benchmarks/runs",
    manifest.issueKey,
    `${Date.now()}-${treatment.connector}-${treatment.model}-${treatment.mcpStack}-${treatment.promptId}-r${runIndex}`,
  );
  await mkdir(runDir, { recursive: true });

  // Build the user message — same shape as research routes, including the
  // <!-- research:jira --> marker so processMessage skips memory extraction.
  const messageText = args.messageOverride ?? buildDefaultMessage(manifest, dryRun);
  const promptText = `<!-- research:jira -->\n${effectiveBot.prompts?.jiraAnalysis ?? ""}\n\n---\n\n${messageText}`;

  let cellUserId: string;
  let cellThreadId: string;
  let tracer: Tracer;
  if (args.preBuiltContext) {
    cellUserId = args.preBuiltContext.userId;
    cellThreadId = args.preBuiltContext.threadId;
    tracer = new Tracer("benchmark_analysis", {
      botName: effectiveBot.name,
      userId: cellUserId,
      username: cellUserId,
      platform: "web",
      traceId: args.preAllocatedTraceId,
    });
  } else {
    const ctx = await ensureCellContext({
      issueKey: manifest.issueKey,
      runIndex,
      botName: effectiveBot.name,
      preAllocatedTraceId: args.preAllocatedTraceId,
    });
    cellUserId = ctx.userId;
    cellThreadId = ctx.threadId;
    tracer = ctx.tracer;
  }
  const analysisTraceId = tracer.traceId;

  // Pre-insert the benchmark_runs row so we have a stable id even if the
  // run errors mid-analysis. Filled in with judge results below.
  const stackConfig: BenchmarkStackConfig = {
    stack: args.stack,
    serenaInstances: args.serenaInstances.map((s) => ({
      name: s.name,
      port: s.port,
      projectPath: s.projectPath,
    })),
    yggdrasilInstances: args.yggdrasilInstance
      ? yggdrasilStackEntries(args.yggdrasilInstance)
      : undefined,
  };
  const fullPromptHash = createHash("sha256").update(promptText).digest("hex").slice(0, 16);
  const candidatePath = join(runDir, "candidate.md");
  const goldText = await readFile(manifest.gold.path, "utf8").catch(() => "");
  const goldContentHash = createHash("sha256").update(goldText).digest("hex").slice(0, 16);

  const benchmarkRunId = await saveBenchmarkRun({
    issueKey: manifest.issueKey,
    candidatePath,
    goldPath: manifest.gold.path,
    goldContentHash,
    judgePromptVersion: "pending",
    judgeModel: "pending",
    analysisTraceId,
    startedAt: new Date(),
    treatment,
    promptId: treatment.promptId,
    fullPrompt: promptText,
    fullPromptHash,
    stackConfig,
  }).catch((err) => {
    log.warn("Failed to pre-insert benchmark_runs row: {error}", {
      botName: "benchmarks",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });

  log.info(
    "Run {i}/{n} starting — issue={issue} traceId={traceId} dryRun={dryRun}",
    {
      botName: "benchmarks",
      i: runIndex + 1,
      n: 1,
      issue: manifest.issueKey,
      traceId: analysisTraceId,
      dryRun,
    },
  );

  // Stub callbacks — collect responseText into a buffer
  const collected: string[] = [];
  const say = async (msg: string): Promise<void> => {
    collected.push(msg);
  };
  const noop = async (): Promise<void> => {};

  let result: ProcessMessageResult | undefined;
  try {
    result = await processMessage({
      text: promptText,
      userId: cellUserId,
      username: cellUserId,
      platform: "web",
      botConfig: effectiveBot,
      config,
      say,
      setStatus: noop,
      threadId: cellThreadId,
      onTextDelta: () => {},
      onIntent: () => {},
      onToolStatus: () => {},
      tracer,
    });
    tracer.finish("ok", {
      benchmarkRunId,
      issueKey: manifest.issueKey,
      hitRateAvailable: !dryRun,
    });
  } catch (err) {
    tracer.error(err instanceof Error ? err : new Error(String(err)));
    if (benchmarkRunId) {
      await completeBenchmarkRun(benchmarkRunId, {
        finishedAt: new Date(),
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
    }
    return {
      runIndex,
      benchmarkRunId,
      analysisTraceId,
      judgeTraceId: null,
      candidatePath,
      hitRate: null,
      highlightedRate: null,
      costUsd: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      model: effectiveBot.model ?? "unknown",
      toolCallCount: 0,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!result) {
    // processMessage swallows its own exceptions and surfaces them via say();
    // the collected buffer is the only channel that carries the real error.
    const collectedErr = collected.join("\n\n").trim();
    const detail = collectedErr
      ? collectedErr.slice(0, 1500)
      : "(no say() output captured)";
    if (benchmarkRunId) {
      await completeBenchmarkRun(benchmarkRunId, {
        finishedAt: new Date(),
        status: "error",
        error: `processMessage returned undefined. Collected: ${detail}`,
      }).catch(() => {});
    }
    throw new Error(
      `processMessage returned undefined (caught internally). Collected say() output:\n${detail}`,
    );
  }

  const reportText = collected.join("\n\n") || result.responseText;

  // Empty candidate means the agent loop terminated without a final text
  // block (e.g. claude-cli hitting a turn cap mid-tool-loop). Skip the file
  // write and the judge — scoring a blank report yields a misleading 0% that
  // pollutes matrix aggregates.
  if (!reportText.trim()) {
    return failCellWithError({
      benchmarkRunId,
      summary: `Empty candidate report — ${result.numTurns} turns, ${result.outputTokens} output tokens, but no final text block produced. Likely agent loop terminated without finalising (see stream-parser.ts handleAssistant / handleResult).`,
      result,
      reportText,
      runIndex,
      analysisTraceId,
      candidatePath,
    });
  }

  // Frontmatter includes the analysis trace id so the score-report CLI /
  // dashboard can link to it.
  const frontmatter = [
    "---",
    `issue_key: ${manifest.issueKey}`,
    `analysis_trace_id: ${analysisTraceId}`,
    `connector: ${treatment.connector}`,
    `model: ${result.model}`,
    `mcp_stack: ${treatment.mcpStack}`,
    `prompt_id: ${treatment.promptId}`,
    `generated_at: ${new Date().toISOString()}`,
    "---",
    "",
  ].join("\n");
  await writeFile(candidatePath, frontmatter + reportText, "utf8");

  log.info(
    "Analysis complete — run {i}, {tokens} tokens out, ${cost} (cumulative ${cumulative})",
    {
      botName: "benchmarks",
      i: runIndex + 1,
      tokens: result.outputTokens,
      cost: result.costUsd.toFixed(4),
      cumulative: result.costUsd.toFixed(4),
    },
  );

  // Step 5a — Bug 11 isolation audit. Query the trace for any tool spans that
  // shouldn't have been reachable from this cell; fail loud if found, before
  // the judge wastes tokens scoring contaminated output. The connector is
  // passed so claude-sdk's legitimate ToolSearch usage (deferred MCP discovery)
  // is not flagged as a leak.
  const leakedTools = await auditCellForLeaks(analysisTraceId, effectiveBot.connector);
  if (leakedTools.length > 0) {
    return failCellWithError({
      benchmarkRunId,
      summary: `Bug 11 leak detected — forbidden tools called from benchmark cell: ${leakedTools.join(", ")}`,
      result,
      reportText,
      runIndex,
      analysisTraceId,
      candidatePath,
    });
  }

  // Step 5b — judge (skipped on dry-run)
  let judgeTraceId: string | null = null;
  let hitRate: number | null = null;
  let highlightedRate: number | null = null;

  if (!dryRun && !args.skipJudge && benchmarkRunId) {
    try {
      const judgePromptPath = args.judgePromptPath ?? defaultJudgePromptPath();
      // Stream the judge's text deltas to stderr so the dashboard live-page
      // "Subprocess log (tail)" picks them up automatically. Set
      // BENCHMARK_JUDGE_QUIET=1 to suppress (e.g. when running matrices in
      // a terminal where you don't want the per-cell noise).
      const judgeQuiet = process.env.BENCHMARK_JUDGE_QUIET === "1";
      const onJudgeProgress = judgeQuiet
        ? undefined
        : (ev: { type: string; text?: string }) => {
            if (ev.type === "text_delta" && ev.text) {
              process.stderr.write(ev.text);
            } else if (ev.type === "text") {
              process.stderr.write("\n");
            }
          };
      if (!judgeQuiet) {
        process.stderr.write("\n[judge] streaming output:\n");
      }
      const judgeResult = await runJudge({
        manifest,
        candidatePath,
        judgePromptPath,
        ...(onJudgeProgress ? { onProgress: onJudgeProgress } : {}),
        // Attach the judge's tracer as a child of the cell's analysis tracer
        // so judge spans appear in the live-page waterfall alongside the
        // analysis tools instead of in a separate trace.
        parentTrace: tracer.context,
      });
      if (!judgeQuiet) process.stderr.write("\n[judge] done\n");
      judgeTraceId = judgeResult.traceId;
      hitRate = judgeResult.result.stats.hitRate;
      highlightedRate = judgeResult.result.stats.highlightedRate;

      await completeBenchmarkRun(benchmarkRunId, {
        finishedAt: new Date(),
        status: "done",
        wallclockMs: judgeResult.wallclockMs,
        inputTokens: judgeResult.inputTokens,
        outputTokens: judgeResult.outputTokens,
        judgeResult: judgeResult.result,
        reportMd: reportText,
        toolCalls: result.toolCalls ?? null,
        tokens: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          contextTokens: result.contextTokens,
          costUsd: result.costUsd,
          model: result.model,
          durationMs: result.durationMs,
        },
        modelSnapshotId: result.model,
      });
    } catch (err) {
      log.error("Judge failed for run {i}: {error}", {
        botName: "benchmarks",
        i: runIndex + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      await completeBenchmarkRun(benchmarkRunId, {
        finishedAt: new Date(),
        status: "error",
        error: `judge failed: ${err instanceof Error ? err.message : String(err)}`,
        reportMd: reportText,
        tokens: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
          model: result.model,
          durationMs: result.durationMs,
        },
      }).catch(() => {});
    }
  } else if ((dryRun || args.skipJudge) && benchmarkRunId) {
    // Dry-run: mark the row done without judge data so it's not stuck "running".
    await completeBenchmarkRun(benchmarkRunId, {
      finishedAt: new Date(),
      status: "done",
      reportMd: reportText,
      toolCalls: result.toolCalls ?? null,
      tokens: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        contextTokens: result.contextTokens,
        costUsd: result.costUsd,
        model: result.model,
        durationMs: result.durationMs,
      },
      modelSnapshotId: result.model,
    }).catch(() => {});
  }

  return {
    runIndex,
    benchmarkRunId,
    analysisTraceId,
    judgeTraceId,
    candidatePath,
    hitRate,
    highlightedRate,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    model: result.model,
    toolCallCount: result.toolCalls?.length ?? 0,
    status: "done",
  };
}
