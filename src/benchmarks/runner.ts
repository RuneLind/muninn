/**
 * Phase 1 single-cell runner.
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

import { mkdir, writeFile, readFile, symlink, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { processMessage } from "../core/message-processor.ts";
import type { ProcessMessageResult } from "../core/message-processor.ts";
import { discoverAllBots, type BotConfig, type ConnectorType } from "../bots/config.ts";
import { loadConfig, type Config } from "../config.ts";
import { getLog } from "../logging.ts";
import {
  saveBenchmarkRun,
  completeBenchmarkRun,
  type BenchmarkTreatment,
  type BenchmarkStackConfig,
} from "../db/benchmark-runs.ts";
import { ensureCellContext } from "./cell-context.ts";
import { runJudge, stripReportFrontmatter } from "./judge.ts";
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
  type BenchmarkYggdrasilInstance,
} from "./yggdrasil-manager.ts";
import { shakeoutSimilarity, classify, type ShakeoutVerdict } from "./jaccard.ts";

const log = getLog("benchmarks", "runner");

/** The supported MCP stacks for Phase 1+. */
export type McpStack =
  | "knowledge-only"
  | "knowledge+serena"
  | "knowledge+yggdrasil"
  | "knowledge+serena+yggdrasil";

function stackUsesSerena(stack: McpStack): boolean {
  return stack === "knowledge+serena" || stack === "knowledge+serena+yggdrasil";
}

function stackUsesYggdrasil(stack: McpStack): boolean {
  return stack === "knowledge+yggdrasil" || stack === "knowledge+serena+yggdrasil";
}

/**
 * Base allow-list for the runner's scratch `.claude/settings.json`. Permissions
 * for the benchmark Serena instances are appended per cell (the names depend
 * on the issue key). See benchmarks/known-bugs.md Bug 10 for why this file is
 * runner-generated instead of symlinked from the prod bot.
 */
const BENCHMARK_SETTINGS_DENY = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"] as const;
const BENCHMARK_SETTINGS_ALLOW_BASE = [
  "mcp__knowledge__search_knowledge",
  "mcp__knowledge__get_document",
  "mcp__knowledge__get_notion_page",
  "mcp__knowledge__list_collections",
  "mcp__knowledge__get_graph_node",
  "WebFetch",
] as const;

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
function defaultBudget(): number {
  const env = process.env.BENCHMARK_BUDGET_USD;
  if (env) {
    const n = parseFloat(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 10;
}

export async function runCell(opts: RunCellOptions): Promise<RunCellResult> {
  const config = loadConfig();
  const manifest = await loadManifestByKey(opts.issueKey);
  const baseBotName = opts.baseBotName ?? "melosys";
  const baseBot = findBot(baseBotName);
  const nRuns = opts.nRuns ?? 1;
  const budget = opts.budgetUsd ?? defaultBudget();

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

  const issueNum = manifest.issueKey.replace(/^\D+/, "") || manifest.issueKey;

  try {
    if (stackUsesSerena(stack)) {
      // Short names to fit under the 64-char MCP tool-name limit copilot-sdk
      // enforces. See benchmarks/known-bugs.md Bug 10.
      const usedPorts = new Set<number>();
      const specs = worktrees.map((wt) => {
        const port = allocateBenchmarkPort(usedPorts);
        usedPorts.add(port);
        return {
          name: `b${issueNum}-${wt.repo.replace(/^melosys-/, "").slice(0, 8)}`,
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

  const { userId: cellUserId, threadId: cellThreadId, tracer } = await ensureCellContext({
    issueKey: manifest.issueKey,
    runIndex,
    botName: effectiveBot.name,
  });
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
      ? args.yggdrasilInstance.indexedRepos.map((r) => ({
          name: r.repoName,
          port: args.yggdrasilInstance!.port,
          projectPath: r.worktreePath,
        }))
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

  // Persist the candidate report. Frontmatter includes the analysis trace id
  // so the score-report CLI / dashboard can link to it.
  const reportText = collected.join("\n\n") || result.responseText;
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

  // Step 5b — judge (skipped on dry-run)
  let judgeTraceId: string | null = null;
  let hitRate: number | null = null;
  let highlightedRate: number | null = null;

  if (!dryRun && benchmarkRunId) {
    try {
      const judgePromptPath = args.judgePromptPath ?? defaultJudgePromptPath();
      const judgeResult = await runJudge({
        manifest,
        candidatePath,
        judgePromptPath,
      });
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
  } else if (dryRun && benchmarkRunId) {
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

function buildDefaultMessage(manifest: BenchmarkManifest, dryRun: boolean): string {
  if (dryRun) {
    // Tiny prompt — the dry-run is about plumbing, not real analysis.
    return `[DRY RUN] Analyser kort: ${manifest.issueKey} — ${manifest.title}. Svar i én setning.`;
  }
  return `${manifest.issueKey}: ${manifest.title}`;
}

function findBot(name: string): BotConfig {
  const bot = discoverAllBots().find((b) => b.name === name);
  if (!bot) {
    throw new Error(`Bot "${name}" not found — check that bots/${name}/CLAUDE.md exists`);
  }
  return bot;
}

function applyTreatmentOverlay(
  base: BotConfig,
  scratchDir: string,
  treatment: BenchmarkTreatment,
  jiraPromptOverride: string | null,
): BotConfig {
  const prompts = jiraPromptOverride
    ? { ...base.prompts, jiraAnalysis: jiraPromptOverride }
    : base.prompts;
  return {
    ...base,
    dir: scratchDir,
    connector: treatment.connector as ConnectorType,
    model: treatment.model,
    prompts,
  };
}

/**
 * Load a jiraAnalysis prompt variant from benchmarks/prompts/<promptId>.txt.
 * Returns null for the default promptId. Throws loudly on a missing variant
 * file so typos in treatment.promptId don't silently fall back to default.
 */
async function loadPromptVariant(promptId: string): Promise<string | null> {
  if (promptId === "default") return null;
  const promptsDir = resolve(import.meta.dir, "../../benchmarks/prompts");
  const path = join(promptsDir, `${promptId}.txt`);
  if (!existsSync(path)) {
    throw new Error(
      `Treatment requested promptId="${promptId}" but no variant file at ${path}. ` +
        `Create the file or use promptId "default" to fall back to the base bot's prompt.`,
    );
  }
  return readFile(path, "utf8");
}

/**
 * Build a scratch bot directory that mirrors the base bot via symlinks but
 * overlays a runner-generated `.mcp.json` and `.claude/settings.json`. The
 * `.claude/` dir must be a real subdirectory (not a symlink) so we can write
 * a fresh settings.json without mutating the prod bot's file. See Bug 10 for
 * why the prod settings.json allow-list isn't reusable here.
 */
async function prepareScratchBotDir(
  base: BotConfig,
  manifest: BenchmarkManifest,
  treatment: BenchmarkTreatment,
  serenaInstances: BenchmarkSerenaInstance[],
  yggdrasilInstance: BenchmarkYggdrasilInstance | null,
): Promise<string> {
  const scratchRoot = resolve(import.meta.dir, "../../benchmarks/scratch");
  const dirName = `${manifest.issueKey}-${treatment.mcpStack}-${Date.now()}`;
  const scratchDir = join(scratchRoot, dirName);
  await mkdir(scratchDir, { recursive: true });

  const entries = await readdir(base.dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".mcp.json" || entry.name === ".claude") continue;
    const src = join(base.dir, entry.name);
    const dst = join(scratchDir, entry.name);
    await rm(dst, { recursive: true, force: true });
    await symlink(src, dst);
  }

  const baseMcpJson = await readFile(join(base.dir, ".mcp.json"), "utf8")
    .then((t) => JSON.parse(t) as { mcpServers: Record<string, unknown> })
    .catch(() => ({ mcpServers: {} as Record<string, unknown> }));

  const stack = treatment.mcpStack as McpStack;
  const newMcp: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  const baseKnowledge = baseMcpJson.mcpServers["knowledge"];
  if (baseKnowledge) {
    newMcp.mcpServers["knowledge"] = baseKnowledge;
  }
  if (stackUsesSerena(stack)) {
    for (const inst of serenaInstances) {
      newMcp.mcpServers[inst.name] = { type: "http", url: inst.mcpUrl };
    }
  }
  if (stackUsesYggdrasil(stack) && yggdrasilInstance) {
    newMcp.mcpServers[yggdrasilInstance.name] = {
      type: "http",
      url: yggdrasilInstance.mcpUrl,
    };
  }
  await writeFile(join(scratchDir, ".mcp.json"), JSON.stringify(newMcp, null, 2));

  const claudeDir = join(scratchDir, ".claude");
  await mkdir(claudeDir, { recursive: true });
  const benchAllowPatterns: string[] = serenaInstances.map((inst) => `mcp__${inst.name}__*`);
  if (yggdrasilInstance) {
    benchAllowPatterns.push(`mcp__${yggdrasilInstance.name}__*`);
  }
  const settingsJson = {
    permissions: {
      deny: [...BENCHMARK_SETTINGS_DENY],
      allow: [...BENCHMARK_SETTINGS_ALLOW_BASE, ...benchAllowPatterns],
    },
    enableAllProjectMcpServers: true,
  };
  await writeFile(
    join(claudeDir, "settings.json"),
    JSON.stringify(settingsJson, null, 2),
  );

  log.info("Scratch bot dir ready: {dir} (allow patterns: {patterns})", {
    botName: "benchmarks",
    dir: scratchDir,
    patterns: benchAllowPatterns.join(", ") || "(none — knowledge-only)",
  });
  return scratchDir;
}

function defaultJudgePromptPath(): string {
  // Highest vN.md in benchmarks/judge-prompts/
  const promptsDir = resolve(import.meta.dir, "../../benchmarks/judge-prompts");
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const files = readdirSync(promptsDir).filter((f: string) => /^v\d+\.md$/.test(f));
  if (files.length === 0) {
    throw new Error(`No judge prompts found in ${promptsDir}`);
  }
  files.sort((a: string, b: string) => {
    const av = parseInt(a.replace(/[^0-9]/g, ""), 10);
    const bv = parseInt(b.replace(/[^0-9]/g, ""), 10);
    return bv - av;
  });
  return join(promptsDir, files[0]!);
}

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
 * Run two cells on the same issue with different MCP stacks and compare
 * their candidate reports via 5-gram Jaccard similarity. High similarity
 * between cells that should have differed is a structural signal for
 * cross-cell state leaks that hit-rate/highlighted-rate metrics miss.
 *
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
