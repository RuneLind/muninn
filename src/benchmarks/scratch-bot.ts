/**
 * Per-cell isolated bot directory. Symlinks the prod bot's contents into a
 * fresh scratch dir under benchmarks/scratch/, then overlays a runner-
 * generated `.mcp.json` and `.claude/settings.json`. The `.claude/` dir is
 * a real subdir (not a symlink) so settings.json can be written without
 * mutating the prod bot's file. See benchmarks/known-bugs.md Bug 10.
 */

import { mkdir, writeFile, readFile, symlink, rm, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { discoverAllBots, type BotConfig, type ConnectorType } from "../bots/config.ts";
import { getLog } from "../logging.ts";
import type { BenchmarkTreatment } from "../db/benchmark-runs.ts";
import type { BenchmarkManifest } from "./types.ts";
import type { BenchmarkSerenaInstance } from "./serena-benchmark.ts";
import type { BenchmarkYggdrasilInstance } from "./yggdrasil-manager.ts";
import { buildBenchmarkSpawnArgs } from "./audit.ts";

const log = getLog("benchmarks", "scratch-bot");

/** The supported MCP stacks for Phase 1+. */
export type McpStack =
  | "knowledge-only"
  | "knowledge+serena"
  | "knowledge+yggdrasil"
  | "knowledge+serena+yggdrasil";

export function stackUsesSerena(stack: McpStack): boolean {
  return stack === "knowledge+serena" || stack === "knowledge+serena+yggdrasil";
}

export function stackUsesYggdrasil(stack: McpStack): boolean {
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
] as const;

export function findBot(name: string): BotConfig {
  const bot = discoverAllBots().find((b) => b.name === name);
  if (!bot) {
    throw new Error(`Bot "${name}" not found — check that bots/${name}/CLAUDE.md exists`);
  }
  return bot;
}

export function applyTreatmentOverlay(
  base: BotConfig,
  scratchDir: string,
  treatment: BenchmarkTreatment,
  jiraPromptOverride: string | null,
): BotConfig {
  const prompts = jiraPromptOverride
    ? { ...base.prompts, jiraAnalysis: jiraPromptOverride }
    : base.prompts;
  // spawnArgs only flow through to the claude-cli executor; copilot-sdk
  // and openai-compat ignore them. Setting unconditionally is safe — the
  // benchmark isolation requirement is the same for every connector.
  return {
    ...base,
    dir: scratchDir,
    connector: treatment.connector as ConnectorType,
    model: treatment.model,
    baseUrl: treatment.baseUrl ?? base.baseUrl,
    prompts,
    spawnArgs: buildBenchmarkSpawnArgs(),
  };
}

/**
 * Build the short Serena MCP instance name for a benchmark cell. Kept under
 * copilot-sdk's 64-char MCP tool-name limit (see Bug 10). Exported so the
 * preview view can show the exact name the runner will use without the
 * two places drifting apart.
 */
export function buildBenchmarkSerenaInstanceName(
  issueKey: string,
  repoName: string,
): string {
  const issueNum = issueKey.replace(/^\D+/, "") || issueKey;
  const shortRepo = repoName.replace(/^melosys-/, "").slice(0, 8);
  return `b${issueNum}-${shortRepo}`;
}

/**
 * Build a scratch bot directory that mirrors the base bot via symlinks but
 * overlays a runner-generated `.mcp.json` and `.claude/settings.json`. The
 * `.claude/` dir must be a real subdirectory (not a symlink) so we can write
 * a fresh settings.json without mutating the prod bot's file. See Bug 10 for
 * why the prod settings.json allow-list isn't reusable here.
 */
export async function prepareScratchBotDir(
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
    // Claude CLI ignores the `cwd` field on stdio MCP entries and spawns the
    // subprocess from its own cwd — which is the scratch dir for benchmark
    // cells. Relative paths in `args` (e.g. `uv --directory ../../../huginn`)
    // therefore resolve to the wrong place and the server silently fails to
    // start. Pre-resolve them against the original bot dir so the spawn works
    // regardless of which connector reads the config. Copilot SDK does honour
    // `cwd`, so we keep that field too — absolute args make it a no-op there.
    const entry = baseKnowledge as {
      type?: string;
      cwd?: string;
      args?: unknown[];
    };
    if (entry.type !== "http" && entry.type !== "sse") {
      const resolvedArgs = (entry.args ?? []).map((arg) =>
        typeof arg === "string" && (arg.startsWith("./") || arg.startsWith("../"))
          ? resolve(base.dir, arg)
          : arg,
      );
      newMcp.mcpServers["knowledge"] = {
        ...entry,
        args: resolvedArgs,
        cwd: entry.cwd ?? base.dir,
      };
    } else {
      newMcp.mcpServers["knowledge"] = baseKnowledge;
    }
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
