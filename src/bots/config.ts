import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getLog } from "../logging.ts";

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

export type ConnectorType = "claude-cli" | "copilot-sdk" | "openai-compat";

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
  /** Claude model override (e.g. "opus", "sonnet") — falls back to global CLAUDE_MODEL */
  model?: string;
  /** Max thinking tokens for extended thinking — set 0 to disable, undefined = CLI default */
  thinkingMaxTokens?: number;
  /** Claude timeout override in ms — falls back to global CLAUDE_TIMEOUT_MS */
  timeoutMs?: number;
  /** Base URL for OpenAI-compatible API (e.g. "http://localhost:1234/v1") */
  baseUrl?: string;
  /** Per-tool-group user restrictions — tools not listed here are available to all */
  restrictedTools?: RestrictedTools;
  /** Channel listening config — passive relevance-based responses in active channels */
  channelListening?: ChannelListeningConfig;
  /** Show the request progress waterfall overlay in the web chat (default true) */
  showWaterfall?: boolean;
  /** Configurable prompts for research flows */
  prompts?: BotPrompts;
}

export interface BotPrompts {
  /** Prompt for Jira task analysis (from Chrome extension). The Jira content is appended automatically. */
  jiraAnalysis?: string;
  /** Prompt for the "Investigate Code" follow-up button after Jira analysis. */
  investigateCode?: string;
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
      log.info("Skipping bot \"{name}\" — no platform tokens found (need TELEGRAM_BOT_TOKEN_{env} or SLACK_BOT_TOKEN_{env} + SLACK_APP_TOKEN_{env})", { name, env: envName });
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
        const knownKeys = new Set(["connector", "model", "thinkingMaxTokens", "timeoutMs", "restrictedTools", "channelListening", "serena", "baseUrl", "showWaterfall", "prompts"]);
        const unknownKeys = Object.keys(botSettings).filter((k) => !knownKeys.has(k));
        if (unknownKeys.length > 0) {
          log.warn("Bot \"{name}\" config.json has unknown keys: {keys} — possible typo?", { name, keys: unknownKeys.join(", ") });
        }
        // Validate connector type
        const validConnectors: ConnectorType[] = ["claude-cli", "copilot-sdk", "openai-compat"];
        if (botSettings.connector && !validConnectors.includes(botSettings.connector as ConnectorType)) {
          log.warn("Bot \"{name}\" has unknown connector \"{connector}\" — valid values: {valid}", { name, connector: String(botSettings.connector), valid: validConnectors.join(", ") });
          delete botSettings.connector;
        }
      } catch (e) {
        log.warn("Failed to parse {path}: {error}", { path: configJsonPath, error: String(e) });
      }
    }

    const hasMcp = existsSync(join(dir, ".mcp.json"));
    const hasSettings = existsSync(join(dir, ".claude", "settings.json")) || existsSync(join(dir, ".claude", "settings.local.json"));

    const platforms: string[] = [];
    if (hasTelegram) platforms.push("telegram");
    if (hasSlack) platforms.push("slack");

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
      model: botSettings.model as string | undefined,
      thinkingMaxTokens: botSettings.thinkingMaxTokens as number | undefined,
      timeoutMs: botSettings.timeoutMs as number | undefined,
      baseUrl: botSettings.baseUrl as string | undefined,
      restrictedTools: botSettings.restrictedTools as RestrictedTools | undefined,
      channelListening: botSettings.channelListening as ChannelListeningConfig | undefined,
      showWaterfall: botSettings.showWaterfall as boolean | undefined,
      prompts: botSettings.prompts as BotPrompts | undefined,
    });

    const configParts: string[] = [];
    if (botSettings.connector) configParts.push(`connector: ${botSettings.connector}`);
    if (botSettings.model) configParts.push(`model: ${botSettings.model}`);
    if (botSettings.thinkingMaxTokens !== undefined) configParts.push(`thinking: ${botSettings.thinkingMaxTokens}`);
    if (botSettings.timeoutMs !== undefined) configParts.push(`timeout: ${botSettings.timeoutMs}ms`);
    if (botSettings.baseUrl) configParts.push(`baseUrl: ${botSettings.baseUrl}`);

    const channelListening = botSettings.channelListening as ChannelListeningConfig | undefined;

    log.info(
      "Discovered bot \"{name}\" (platforms: {platforms}, " +
        `telegram users: ${telegramAllowedUserIds.length}, slack users: ${slackAllowedUserIds.length}, ` +
        `MCP: ${hasMcp ? "yes" : "no"}, ` +
        `settings: ${hasSettings ? "yes" : "no"}, ` +
        `config.json: ${hasConfigJson ? `yes (${configParts.join(", ") || "empty"})` : "no"}, ` +
        `channelListening: ${channelListening?.enabled ? "yes" : "no"}, ` +
        `dir: ${dir})`,
      { name, platforms: platforms.join("+") },
    );
  }

  return bots;
}
