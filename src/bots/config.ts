import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getLog } from "../logging.ts";
import { parseHivemindConfig, type HivemindBotConfig } from "../hivemind/config.ts";
import type { McpStatusConfig } from "../ai/mcp-status.ts";
import { resolveCorrectiveConfig } from "../ai/corrective-config.ts";
import type { HaikuBackend } from "../ai/haiku-direct.ts";

const log = getLog("bots");

export interface RestrictedToolGroup {
  description: string;
  allowedUsers: string[];
}

export type RestrictedTools = Record<string, RestrictedToolGroup>;

export interface ChannelListeningConfig {
  enabled: boolean;
  /** Cooldown between responses in a channel (default 120000 = 2 min) */
  cooldownMs?: number;
  /** Max responses per hour across all channels (default 10) */
  maxResponsesPerHour?: number;
  /** Haiku relevance threshold (default "medium") */
  relevanceThreshold?: "low" | "medium" | "high";
  /** Number of recent messages to fetch for context (default 10) */
  contextMessages?: number;
  /** Domain keywords to help Haiku assess relevance */
  topicHints?: string[];
}

export type ConnectorType = "claude-cli" | "copilot-sdk" | "openai-compat" | "claude-sdk";

export interface BotConfig {
  name: string;
  /** Absolute path to the bot folder — used as cwd for Claude CLI spawns */
  dir: string;
  persona: string;
  telegramBotToken?: string;
  telegramAllowedUserIds: string[];
  slackBotToken?: string;
  slackAppToken?: string;
  slackAllowedUserIds: string[];
  /** AI connector backend — defaults to "claude-cli" */
  connector?: ConnectorType;
  /** Override the Haiku backend for this bot's async extractors + research_knowledge
   *  decomposer. When unset, `resolveBackend()` picks via the connector default
   *  (`copilot-sdk` → `copilot`, else `cli`). The process-wide `HAIKU_BACKEND` env
   *  var still trumps this (debug knob). */
  haikuBackend?: HaikuBackend;
  /** Claude model override (e.g. "opus", "sonnet") — falls back to global CLAUDE_MODEL */
  model?: string;
  /** Max thinking tokens for extended thinking — set 0 to disable, undefined = CLI default */
  thinkingMaxTokens?: number;
  /** Claude timeout override in ms — falls back to global CLAUDE_TIMEOUT_MS */
  timeoutMs?: number;
  /** Base URL for OpenAI-compatible API (e.g. "http://localhost:1234/v1") */
  baseUrl?: string;
  /** Context window size in tokens — used to show usage percentage (e.g. 32768 for local models) */
  contextWindow?: number;
  /** Per-tool-group user restrictions — tools not listed here are available to all */
  restrictedTools?: RestrictedTools;
  /** Channel listening config — passive relevance-based responses in active channels */
  channelListening?: ChannelListeningConfig;
  /** Show the request progress waterfall overlay in the web chat (default true) */
  showWaterfall?: boolean;
  /** Configurable prompts for research flows */
  prompts?: BotPrompts;
  /**
   * Extra CLI flags appended to the `claude` spawn (between the trailing
   * `--system-prompt` and the `--` separator). Used by the benchmark runner
   * to inject `--strict-mcp-config` and `--disallowedTools` for cell
   * isolation. Prod bots leave this unset.
   */
  spawnArgs?: string[];
  /**
   * Tool names to exclude from the AI session. Set dynamically per-request
   * (e.g. for jira-analysis flows to block native tools and force MCP usage).
   * For copilot-sdk: passed as `excludedTools` to `createSession`.
   * For claude-cli: converted to `--disallowedTools` spawn args.
   */
  excludedTools?: string[];
  /** Hivemind peer-to-peer integration config — parsed from `hivemind` block in config.json */
  hivemind?: HivemindBotConfig;
  /** MCP status probing config — controls cache TTL and which servers are critical */
  mcpStatus?: McpStatusConfig;
  /** Prompt-level corrective retrieval (Path C). See `resolveCorrectiveConfig`
   *  + CLAUDE.md "Corrective Retrieval" section. */
  correctiveRetrieval?: CorrectiveRetrievalBotConfig;
  /** True when the bot's .mcp.json registers a `research` MCP server (the
   *  muninn-side `research_knowledge` tool). Drives the one-line system-prompt
   *  nudge in `buildPrompt`. Detected once at discovery. */
  hasResearchKnowledge?: boolean;
  /** Default collections from the bot's `knowledge` MCP server env
   *  (`KNOWLEDGE_COLLECTIONS`). Resolved once at discovery so the research MCP
   *  server doesn't re-read .mcp.json on every tool call. `undefined` means
   *  "search all collections huginn knows about". */
  defaultKnowledgeCollections?: string[];
}

export interface CorrectiveRetrievalBotConfig {
  enabled?: boolean;
}

export interface JiraAnalysisVariant {
  /** Variant id derived from the filename (e.g. "coder" for jiraAnalysis.coder.md). */
  id: string;
  /** Human-readable label from `<!-- label: ... -->` on the first line, or title-cased id. */
  label: string;
  /** Prompt body with the label comment stripped. */
  content: string;
}

export interface BotPrompts {
  /** Default Jira task analysis prompt (from Chrome extension). The Jira content is appended automatically. */
  jiraAnalysis?: string;
  /** Named variants of the Jira analysis prompt — discovered from `prompts/jiraAnalysis.<id>.md`. */
  jiraAnalysisVariants?: JiraAnalysisVariant[];
  /** Prompt for the "Investigate Code" follow-up button after Jira analysis. */
  investigateCode?: string;
  /** Prompt for the "Deep Analysis" follow-up button after code investigation — parallel agent verification. */
  deepAnalysis?: string;
  /** Prompt for the "Generate Test Spec" follow-up button after deep analysis. */
  specGeneration?: string;
}

const SINGLE_PROMPT_KEYS = ["jiraAnalysis", "investigateCode", "deepAnalysis", "specGeneration"] as const satisfies readonly (keyof BotPrompts)[];
const VARIANT_PROMPT_KEYS = ["jiraAnalysis"] as const;

const LABEL_COMMENT_RE = /^\s*<!--\s*label:\s*(.+?)\s*-->\s*\r?\n?/;

function parseLabel(content: string, fallbackId: string): { label: string; content: string } {
  const match = content.match(LABEL_COMMENT_RE);
  if (match) {
    return { label: match[1]!, content: content.slice(match[0].length) };
  }
  const label = fallbackId.charAt(0).toUpperCase() + fallbackId.slice(1);
  return { label, content };
}

function loadPromptsFromDir(botDir: string, botName: string): BotPrompts | undefined {
  const promptsDir = join(botDir, "prompts");
  if (!existsSync(promptsDir)) return undefined;

  const result: BotPrompts = {};
  const singleKeys = new Set<string>(SINGLE_PROMPT_KEYS);
  const variantKeys = new Set<string>(VARIANT_PROMPT_KEYS);
  const variantsByKey: Record<string, JiraAnalysisVariant[]> = {};

  for (const entry of readdirSync(promptsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const stem = entry.name.slice(0, -3);
    const raw = readFileSync(join(promptsDir, entry.name), "utf-8");

    if (singleKeys.has(stem)) {
      result[stem as keyof BotPrompts] = raw as never;
      continue;
    }

    const dotIdx = stem.indexOf(".");
    if (dotIdx > 0) {
      const baseKey = stem.slice(0, dotIdx);
      const variantId = stem.slice(dotIdx + 1);
      if (variantKeys.has(baseKey) && variantId.length > 0) {
        const { label, content } = parseLabel(raw, variantId);
        (variantsByKey[baseKey] ??= []).push({ id: variantId, label, content });
        continue;
      }
    }

    log.warn("Bot \"{name}\" has unknown prompt file prompts/{file} — expected <key>.md or jiraAnalysis.<id>.md", {
      name: botName,
      file: entry.name,
    });
  }

  if (variantsByKey.jiraAnalysis) {
    variantsByKey.jiraAnalysis.sort((a, b) => a.id.localeCompare(b.id));
    result.jiraAnalysisVariants = variantsByKey.jiraAnalysis;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Discovers all bot folders that have a CLAUDE.md — no platform tokens required.
 * Used by dashboard (MCP debug, chat page).
 */
export function discoverAllBots(): BotConfig[] {
  return discoverBotsInternal({ requireTokens: false });
}

/**
 * Discovers bots that have both a CLAUDE.md and at least one platform token
 * (Telegram or Slack). Used for starting actual bot instances.
 */
export function discoverActiveBots(): BotConfig[] {
  return discoverBotsInternal({ requireTokens: true });
}

function validateEnumField<T extends string>(
  settings: Record<string, unknown>,
  key: string,
  valid: readonly T[],
  botName: string,
): void {
  const value = settings[key];
  if (value && !valid.includes(value as T)) {
    log.warn(
      `Bot "{name}" has unknown ${key} "{value}" — valid values: {valid}`,
      { name: botName, value: String(value), valid: valid.join(", ") },
    );
    delete settings[key];
  }
}

function discoverBotsInternal(opts: { requireTokens: boolean }): BotConfig[] {
  const botsDir = resolve(import.meta.dir, "../../bots");

  if (!existsSync(botsDir)) {
    log.warn("bots/ directory not found at {path}", { path: botsDir });
    return [];
  }

  const entries = readdirSync(botsDir, { withFileTypes: true });
  const bots: BotConfig[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const name = entry.name;
    const dir = join(botsDir, name);
    const claudeMdPath = join(dir, "CLAUDE.md");

    if (!existsSync(claudeMdPath)) continue;

    const envName = name.toUpperCase();
    const telegramToken = process.env[`TELEGRAM_BOT_TOKEN_${envName}`];
    const slackBotToken = process.env[`SLACK_BOT_TOKEN_${envName}`];
    const slackAppToken = process.env[`SLACK_APP_TOKEN_${envName}`];

    // Bot needs at least one platform token
    const hasTelegram = !!telegramToken;
    const hasSlack = !!slackBotToken && !!slackAppToken;

    if (opts.requireTokens && !hasTelegram && !hasSlack) {
      log.info("Skipping bot \"{name}\" — no platform tokens found (need TELEGRAM_BOT_TOKEN_{env} or SLACK_BOT_TOKEN_{env} + SLACK_APP_TOKEN_{env})", { botName: name, name, env: envName });
      continue;
    }

    const telegramAllowedIdsEnv = process.env[`TELEGRAM_ALLOWED_USER_IDS_${envName}`] ?? "";
    const telegramAllowedUserIds = telegramAllowedIdsEnv
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    if (hasTelegram && telegramAllowedUserIds.length === 0) {
      log.warn("Bot \"{name}\" has a Telegram token but no TELEGRAM_ALLOWED_USER_IDS_{env} — all messages will be rejected", { name, env: envName });
    }

    const slackAllowedIdsEnv = process.env[`SLACK_ALLOWED_USER_IDS_${envName}`] ?? "";
    const slackAllowedUserIds = slackAllowedIdsEnv
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    const persona = readFileSync(claudeMdPath, "utf-8");

    // Read optional per-bot config.json
    const configJsonPath = join(dir, "config.json");
    let botSettings: Record<string, unknown> = {};
    const hasConfigJson = existsSync(configJsonPath);
    if (hasConfigJson) {
      try {
        botSettings = JSON.parse(readFileSync(configJsonPath, "utf-8"));
        // Warn about unknown keys to catch typos
        const knownKeys = new Set(["connector", "haikuBackend", "model", "thinkingMaxTokens", "timeoutMs", "restrictedTools", "channelListening", "serena", "baseUrl", "showWaterfall", "contextWindow", "hivemind", "mcpStatus", "correctiveRetrieval"]);
        const unknownKeys = Object.keys(botSettings).filter((k) => !knownKeys.has(k));
        if (unknownKeys.length > 0) {
          const hint = unknownKeys.includes("prompts")
            ? " (note: `prompts` moved to bots/<name>/prompts/<key>.md — see CLAUDE.md)"
            : "";
          log.warn("Bot \"{name}\" config.json has unknown keys: {keys} — possible typo?" + hint, { name, keys: unknownKeys.join(", ") });
        }
        validateEnumField(botSettings, "connector", ["claude-cli", "copilot-sdk", "openai-compat", "claude-sdk"] as const, name);
        validateEnumField(botSettings, "haikuBackend", ["cli", "anthropic", "copilot"] as const, name);
      } catch (e) {
        log.warn("Failed to parse {path}: {error}", { path: configJsonPath, error: String(e) });
      }
    }

    const mcpJsonPath = join(dir, ".mcp.json");
    const hasMcp = existsSync(mcpJsonPath);
    const hasSettings = existsSync(join(dir, ".claude", "settings.json")) || existsSync(join(dir, ".claude", "settings.local.json"));

    let hasResearchKnowledge = false;
    let defaultKnowledgeCollections: string[] | undefined;
    if (hasMcp) {
      try {
        const mcp = JSON.parse(readFileSync(mcpJsonPath, "utf-8")) as {
          mcpServers?: Record<string, { env?: Record<string, string> } | undefined>;
        };
        hasResearchKnowledge = !!mcp.mcpServers?.["research"];
        for (const server of Object.values(mcp.mcpServers ?? {})) {
          const value = server?.env?.KNOWLEDGE_COLLECTIONS;
          if (value) {
            defaultKnowledgeCollections = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            break;
          }
        }
      } catch (err) {
        log.warn("Failed to parse .mcp.json for bot \"{name}\": {error}", {
          botName: name,
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const platforms: string[] = [];
    if (hasTelegram) platforms.push("telegram");
    if (hasSlack) platforms.push("slack");

    const correctiveRetrieval = botSettings.correctiveRetrieval as CorrectiveRetrievalBotConfig | undefined;

    bots.push({
      name,
      dir,
      persona,
      telegramBotToken: telegramToken,
      telegramAllowedUserIds,
      slackBotToken,
      slackAppToken,
      slackAllowedUserIds,
      connector: botSettings.connector as ConnectorType | undefined,
      haikuBackend: botSettings.haikuBackend as HaikuBackend | undefined,
      model: botSettings.model as string | undefined,
      thinkingMaxTokens: botSettings.thinkingMaxTokens as number | undefined,
      timeoutMs: botSettings.timeoutMs as number | undefined,
      baseUrl: botSettings.baseUrl as string | undefined,
      restrictedTools: botSettings.restrictedTools as RestrictedTools | undefined,
      channelListening: botSettings.channelListening as ChannelListeningConfig | undefined,
      showWaterfall: botSettings.showWaterfall as boolean | undefined,
      prompts: loadPromptsFromDir(dir, name),
      contextWindow: botSettings.contextWindow as number | undefined,
      hivemind: parseHivemindConfig(botSettings.hivemind) ?? undefined,
      mcpStatus: botSettings.mcpStatus as McpStatusConfig | undefined,
      correctiveRetrieval,
      hasResearchKnowledge,
      defaultKnowledgeCollections,
    });

    const configParts: string[] = [];
    if (botSettings.connector) configParts.push(`connector: ${botSettings.connector}`);
    if (botSettings.haikuBackend) configParts.push(`haikuBackend: ${botSettings.haikuBackend}`);
    if (botSettings.model) configParts.push(`model: ${botSettings.model}`);
    if (botSettings.thinkingMaxTokens !== undefined) configParts.push(`thinking: ${botSettings.thinkingMaxTokens}`);
    if (botSettings.timeoutMs !== undefined) configParts.push(`timeout: ${botSettings.timeoutMs}ms`);
    if (botSettings.baseUrl) configParts.push(`baseUrl: ${botSettings.baseUrl}`);
    if (resolveCorrectiveConfig({ correctiveRetrieval }).enabled) {
      configParts.push("correctiveRetrieval: on");
    } else if (correctiveRetrieval) {
      configParts.push("correctiveRetrieval: off (configured but disabled)");
    }

    const channelListening = botSettings.channelListening as ChannelListeningConfig | undefined;

    log.info(
      "Discovered bot \"{name}\" (platforms: {platforms}, " +
        `telegram users: ${telegramAllowedUserIds.length}, slack users: ${slackAllowedUserIds.length}, ` +
        `MCP: ${hasMcp ? "yes" : "no"}, ` +
        `settings: ${hasSettings ? "yes" : "no"}, ` +
        `config.json: ${hasConfigJson ? `yes (${configParts.join(", ") || "empty"})` : "no"}, ` +
        `channelListening: ${channelListening?.enabled ? "yes" : "no"}, ` +
        `dir: ${dir})`,
      { botName: name, name, platforms: platforms.join("+") },
    );
  }

  return bots;
}
