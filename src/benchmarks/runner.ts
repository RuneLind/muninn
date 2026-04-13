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

import { mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
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
import { runJudge } from "./judge.ts";
import { loadManifestByKey } from "./manifest.ts";
import type { BenchmarkManifest } from "./types.ts";
import { prepareWorktrees, type PreparedWorktree } from "./worktree.ts";
import {
  benchmarkSerenaManager,
  allocateBenchmarkPort,
  type BenchmarkSerenaInstance,
} from "./serena-benchmark.ts";

const log = getLog("benchmarks", "runner");

/** The supported MCP stacks for Phase 1. Yggdrasil stacks come back when Bug 5 is fixed. */
export type McpStack =
  | "knowledge-only"
  | "knowledge+serena";

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

  // Step 2 — start Serena instances for stacks that need them
  const stack = opts.treatment.mcpStack as McpStack;
  const serenaInstances: BenchmarkSerenaInstance[] = [];
  let scratchDir: string | null = null;
  let cellResult: RunCellResult;

  try {
    if (stack === "knowledge+serena") {
      for (const wt of worktrees) {
        const port = allocateBenchmarkPort([]);
        const inst = await benchmarkSerenaManager.start({
          name: `bench-${manifest.issueKey}-${wt.repo}`,
          projectPath: wt.worktreePath,
          port,
        });
        serenaInstances.push(inst);
      }
    } else if (stack !== "knowledge-only") {
      throw new Error(
        `Stack "${stack}" not supported in Phase 1 (Yggdrasil stacks deferred — see known-bugs.md Bug 5)`,
      );
    }

    // Step 3 — scratch bot dir with overlayed .mcp.json
    scratchDir = await prepareScratchBotDir(baseBot, manifest, opts.treatment, serenaInstances);

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
    // Step 6 — teardown
    if (serenaInstances.length > 0) {
      log.info("Tearing down {n} benchmark Serena instances", {
        botName: "benchmarks",
        n: serenaInstances.length,
      });
      for (const inst of serenaInstances) {
        await benchmarkSerenaManager.stop(inst.name);
      }
    }
    if (scratchDir && existsSync(scratchDir)) {
      // Keep the scratch dir on disk for debugging — gitignored under benchmarks/.
      // Remove only the symlinks; leave the real .mcp.json + CLAUDE.md for inspection.
    }
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

  // All per-cell DB preconditions (unique userId, fresh threads row materialised,
  // tracer created) are set up by ensureCellContext in a single call. See
  // src/benchmarks/cell-context.ts for the full contract and benchmarks/known-bugs.md
  // Bug 9 for why this helper exists.
  const cellCtx = await ensureCellContext({
    issueKey: manifest.issueKey,
    runIndex,
    botName: effectiveBot.name,
    connector: treatment.connector,
  });
  const cellUserId = cellCtx.userId;
  const cellThreadId = cellCtx.threadId;
  const tracer = cellCtx.tracer;
  const analysisTraceId = cellCtx.traceId;

  // Pre-insert the benchmark_runs row so we have a stable id even if the
  // run errors mid-analysis. Filled in with judge results below.
  const stackConfig: BenchmarkStackConfig = {
    stack: args.stack,
    serenaInstances: args.serenaInstances.map((s) => ({
      name: s.name,
      port: s.port,
      projectPath: s.projectPath,
    })),
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
    // processMessage caught an error internally, logged via LogTape, called
    // say() with "Something went wrong: <errorMessage>", and returned undefined.
    // The runner's collected[] buffer is where that say() landed — surface it
    // as the error detail so the failure mode is diagnosable from the CLI
    // output instead of requiring a logfile grep.
    const collectedErr = collected.join("\n\n").trim();
    const detail = collectedErr
      ? collectedErr.slice(0, 1500)
      : "(no say() output captured)";
    // Mark the benchmark_runs row as errored with the detail
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
 *
 * Returns null when promptId is "default" or no variant file exists — the
 * runner then falls back to the base bot's prompts.jiraAnalysis. Throws when
 * a non-default promptId is requested but the file is missing, so typos in
 * treatment.promptId fail loudly instead of silently using the default.
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
 * Build a scratch bot directory under benchmarks/scratch/ that mirrors the
 * base bot via symlinks but with a runner-generated `.mcp.json` overlaid
 * for the requested MCP stack. Returns the absolute path.
 *
 * Why symlinks instead of full copy: the base bot dir contains CLAUDE.md
 * (the persona, often large), `.claude/settings.json` (tool permissions),
 * `reports/`, etc. We need most of these unchanged but with a different
 * `.mcp.json`. Symlinking everything except `.mcp.json` is the smallest
 * possible mutation.
 */
async function prepareScratchBotDir(
  base: BotConfig,
  manifest: BenchmarkManifest,
  treatment: BenchmarkTreatment,
  serenaInstances: BenchmarkSerenaInstance[],
): Promise<string> {
  const scratchRoot = resolve(import.meta.dir, "../../benchmarks/scratch");
  const dirName = `${manifest.issueKey}-${treatment.mcpStack}-${Date.now()}`;
  const scratchDir = join(scratchRoot, dirName);
  await mkdir(scratchDir, { recursive: true });

  // Mirror everything in the base bot dir as a symlink, except `.mcp.json`
  // and `.claude/` which we'll overlay ourselves. The .claude directory needs
  // to be a real subdirectory (not a symlink) so we can write a runner-controlled
  // settings.json without mutating the prod bot's settings.
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(base.dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".mcp.json") continue;
    if (entry.name === ".claude") continue;
    const src = join(base.dir, entry.name);
    const dst = join(scratchDir, entry.name);
    if (existsSync(dst)) await rm(dst, { recursive: true, force: true });
    await symlink(src, dst);
  }

  // Build the runner-controlled .mcp.json
  const baseMcpJson = await readFile(join(base.dir, ".mcp.json"), "utf8")
    .then((t) => JSON.parse(t) as { mcpServers: Record<string, unknown> })
    .catch(() => ({ mcpServers: {} as Record<string, unknown> }));

  const newMcp: { mcpServers: Record<string, unknown> } = { mcpServers: {} };

  // knowledge-* stacks always include the knowledge MCP from the base bot.
  const baseKnowledge = baseMcpJson.mcpServers["knowledge"];
  if (baseKnowledge) {
    newMcp.mcpServers["knowledge"] = baseKnowledge;
  }

  // knowledge+serena: add direct entries pointing at benchmark Serena instances.
  // Bypasses the live tool proxy — the analysis call sees raw serena tools
  // for now. The proxy will come back when the benchmark version of it lands.
  if (treatment.mcpStack === "knowledge+serena") {
    for (const inst of serenaInstances) {
      newMcp.mcpServers[inst.name] = { type: "http", url: inst.mcpUrl };
    }
  }

  await writeFile(join(scratchDir, ".mcp.json"), JSON.stringify(newMcp, null, 2));

  // Write a runner-controlled .claude/settings.json. The prod melosys bot's
  // settings.json has an allow-list hardcoded to mcp__serena-api__*, mcp__serena-web__*
  // etc. — it does NOT match the runner's bench-<issue>-<repo> instance names,
  // so the CLI permission gate silently denies every benchmark Serena call
  // (1-3ms no-op calls visible in the trace). Fix: write a fresh settings.json
  // that allows the same knowledge MCP tools plus explicit per-instance bench-*
  // patterns for the current cell.
  const claudeDir = join(scratchDir, ".claude");
  await mkdir(claudeDir, { recursive: true });
  const benchAllowPatterns = serenaInstances.map((inst) => `mcp__${inst.name}__*`);
  const settingsJson = {
    permissions: {
      deny: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
      allow: [
        "mcp__knowledge__search_knowledge",
        "mcp__knowledge__get_document",
        "mcp__knowledge__get_notion_page",
        "mcp__knowledge__list_collections",
        "mcp__knowledge__get_graph_node",
        "WebFetch",
        ...benchAllowPatterns,
      ],
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
