/**
 * Build a preview of what a benchmark cell run would do without actually
 * doing any of it. Pure reads: loads the manifest, the base bot config,
 * the treatment JSON, and the jiraAnalysis prompt variant; resolves the
 * exact user message that would be sent; lists the MCP servers that
 * would run and the tools the bot would be denied; produces a cost
 * estimate from published per-model pricing.
 *
 * Never spawns Serena/Yggdrasil, never calls the connector, never writes
 * to the DB. The goal is to let the operator confirm that the treatment
 * is what they think it is before spending tokens, and to make the
 * resolved prompt + MCP catalogue legible as documentation.
 *
 * The preview mirrors the runner's actual behaviour by calling the same
 * `buildDefaultMessage` / `loadPromptVariant` helpers the runner uses.
 * If someone changes how the runner builds its prompt, the preview will
 * drift unless it keeps calling the same helpers — which is why they're
 * exported from runner.ts rather than duplicated here.
 */

import { readFile } from "node:fs/promises";
import { discoverAllBots, type BotConfig, type ConnectorType } from "../bots/config.ts";
import { loadManifest } from "./manifest.ts";
import type { BenchmarkManifest } from "./types.ts";
import type { BenchmarkTreatment } from "../db/benchmark-runs.ts";
import {
  disallowedToolsForConnector,
  buildBenchmarkSerenaInstanceName,
  buildDefaultMessage,
  loadPromptVariant,
  promptVariantPath,
} from "./runner.ts";

export interface PreviewIssue {
  issueKey: string;
  title: string;
  category: string;
  goldPath: string;
  goldExcerpt: string;
  goldLineCount: number;
  highlightedCount: number;
  repos: Array<{ name: string; path: string; baseCommit: string | null }>;
}

export interface PreviewMcpServer {
  name: string;
  role: "knowledge" | "serena" | "yggdrasil";
  note: string;
}

export interface PreviewMcpPlan {
  stack: string;
  servers: PreviewMcpServer[];
  /** Tool names the benchmark will deny via --disallowedTools */
  disallowedTools: readonly string[];
  /** Worktrees the code-intel stacks would index */
  worktrees: Array<{ repo: string; path: string; baseCommit: string | null }>;
}

export interface PreviewCost {
  analysisLowUsd: number;
  analysisHighUsd: number;
  judgeUsd: number;
  totalLowUsd: number;
  totalHighUsd: number;
  note: string;
}

export interface CellPreview {
  issue: PreviewIssue;
  baseBot: { name: string; dir: string };
  treatment: BenchmarkTreatment;
  treatmentPath: string;
  /** Resolved path to the prompt variant file, or null if using the bot's default jiraAnalysis. */
  promptVariantPath: string | null;
  /** The jiraAnalysis prompt text that will be used (override takes priority over base). */
  jiraAnalysisPrompt: string;
  /** The user-message portion (what buildDefaultMessage returns for dryRun=false). */
  userMessage: string;
  /** The full string passed to processMessage, including the research:jira marker and the jiraAnalysis prompt. */
  fullPrompt: string;
  mcp: PreviewMcpPlan;
  cost: PreviewCost;
  warnings: string[];
}

export interface BuildCellPreviewOptions {
  /**
   * Absolute path to the benchmark manifest (`benchmarks/issues/<KEY>.yml`).
   * Preferred over issueKey so the preview handler can stay a pure-reads
   * function without knowing the manifest layout.
   */
  manifestPath: string;
  /** Absolute path to the treatment JSON file. */
  treatmentPath: string;
  baseBotName?: string;
}

const GOLD_EXCERPT_LINES = 30;

export async function buildCellPreview(
  opts: BuildCellPreviewOptions,
): Promise<CellPreview> {
  const warnings: string[] = [];

  // Manifest, treatment, and base bot are independent — parallelise. findBot
  // is synchronous but wrapping it in the Promise.all keeps the code symmetric.
  const [manifest, treatment, baseBot] = await Promise.all([
    loadManifest(opts.manifestPath),
    loadTreatmentFile(opts.treatmentPath),
    Promise.resolve(findBot(opts.baseBotName ?? "melosys")),
  ]);

  // Once manifest + treatment are known, the gold excerpt and the prompt
  // variant file can load in parallel — neither depends on the other.
  const [promptVariant, gold] = await Promise.all([
    loadPromptVariant(treatment.promptId).catch((err) => {
      warnings.push(`Prompt variant failed to load: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }),
    loadGoldExcerpt(manifest.gold.path).catch((err) => {
      warnings.push(`Gold file read failed: ${err instanceof Error ? err.message : String(err)}`);
      return { excerpt: "(failed to read gold file)", lineCount: 0 };
    }),
  ]);

  const jiraAnalysisPrompt =
    promptVariant ??
    baseBot.prompts?.jiraAnalysis ??
    "(no jiraAnalysis prompt configured on the base bot)";
  const variantPath =
    treatment.promptId === "default" ? null : promptVariantPath(treatment.promptId);

  const userMessage = buildDefaultMessage(manifest, false);
  const fullPrompt = `<!-- research:jira -->\n${jiraAnalysisPrompt}\n\n---\n\n${userMessage}`;

  const mcp = buildMcpPlan(manifest, treatment);
  const cost = estimateCost(treatment);

  return {
    issue: {
      issueKey: manifest.issueKey,
      title: manifest.title,
      category: manifest.category,
      goldPath: manifest.gold.path,
      goldExcerpt: gold.excerpt,
      goldLineCount: gold.lineCount,
      highlightedCount: manifest.highlightedClaims.length,
      repos: (manifest.repos ?? []).map((r) => ({
        name: r.name,
        path: r.path,
        baseCommit: manifest.baseCommits?.[r.name] ?? null,
      })),
    },
    baseBot: { name: baseBot.name, dir: baseBot.dir },
    treatment,
    treatmentPath: opts.treatmentPath,
    promptVariantPath: variantPath,
    jiraAnalysisPrompt,
    userMessage,
    fullPrompt,
    mcp,
    cost,
    warnings,
  };
}

async function loadTreatmentFile(path: string): Promise<BenchmarkTreatment> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Treatment file does not exist: ${path}`);
    }
    throw err;
  }
  const raw = JSON.parse(text) as Partial<BenchmarkTreatment>;
  if (!raw.connector || !raw.model || !raw.mcpStack || !raw.promptId) {
    throw new Error(
      `Treatment ${path} missing required fields (connector, model, mcpStack, promptId). Got: ${JSON.stringify(raw)}`,
    );
  }
  return {
    connector: raw.connector,
    model: raw.model,
    mcpStack: raw.mcpStack,
    promptId: raw.promptId,
  };
}

function findBot(name: string): BotConfig {
  const bot = discoverAllBots().find((b) => b.name === name);
  if (!bot) {
    throw new Error(`Base bot "${name}" not found — check bots/${name}/CLAUDE.md exists`);
  }
  return bot;
}

async function loadGoldExcerpt(
  path: string,
): Promise<{ excerpt: string; lineCount: number }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Gold path does not exist: ${path}`);
    }
    throw err;
  }
  const lines = text.split("\n");
  const excerpt = lines.slice(0, GOLD_EXCERPT_LINES).join("\n");
  return { excerpt, lineCount: lines.length };
}

function buildMcpPlan(
  manifest: BenchmarkManifest,
  treatment: BenchmarkTreatment,
): PreviewMcpPlan {
  const stack = treatment.mcpStack;
  const servers: PreviewMcpServer[] = [
    {
      name: "knowledge",
      role: "knowledge",
      note: "Always on — inherited from the base bot's .mcp.json",
    },
  ];

  const usesSerena = stack === "knowledge+serena" || stack === "knowledge+serena+yggdrasil";
  const usesYggdrasil =
    stack === "knowledge+yggdrasil" || stack === "knowledge+serena+yggdrasil";

  if (usesSerena) {
    for (const repo of manifest.repos ?? []) {
      servers.push({
        name: buildBenchmarkSerenaInstanceName(manifest.issueKey, repo.name),
        role: "serena",
        note: `LSP server on a short-lived port (allocated per cell from 9200+)`,
      });
    }
  }
  if (usesYggdrasil) {
    servers.push({
      name: "yggdrasil",
      role: "yggdrasil",
      note: `Tree-sitter indexer + HTTP server on a short-lived port (allocated per cell from 9250+)`,
    });
  }

  const worktrees = (manifest.repos ?? []).map((r) => ({
    repo: r.name,
    path: r.path,
    baseCommit: manifest.baseCommits?.[r.name] ?? null,
  }));

  return {
    stack,
    servers,
    disallowedTools: disallowedToolsForConnector(treatment.connector as ConnectorType),
    worktrees,
  };
}

/**
 * Rough per-cell cost estimate using the v2.2 plan's §8 pricing. These are
 * deliberately coarse: the point is to catch "oh that's $5 not $0.50" before
 * pressing Run, not to be a billing-grade number. Each cell's real cost is
 * recorded on its benchmark_runs row after the fact.
 */
function estimateCost(treatment: BenchmarkTreatment): PreviewCost {
  const isOpus = treatment.model.toLowerCase().includes("opus");
  const analysisLow = isOpus ? 3.0 : 0.4;
  const analysisHigh = isOpus ? 8.0 : 1.3;
  // Yggdrasil stacks have historically spent more tool-call budget on
  // impact/search, so bump the high-end estimate.
  const stackMultiplier =
    treatment.mcpStack === "knowledge+yggdrasil" ||
    treatment.mcpStack === "knowledge+serena+yggdrasil"
      ? 1.5
      : 1.0;
  const judge = 0.2;
  return {
    analysisLowUsd: analysisLow,
    analysisHighUsd: analysisHigh * stackMultiplier,
    judgeUsd: judge,
    totalLowUsd: analysisLow + judge,
    totalHighUsd: analysisHigh * stackMultiplier + judge,
    note:
      `Analysis estimate based on v2.2 plan §8 per-model pricing ` +
      `(Sonnet $0.40-$1.30, Opus $3-$8 per cell). Judge is flat $0.20 on Sonnet. ` +
      `Real spend is recorded on the benchmark_runs row after the cell completes.`,
  };
}
