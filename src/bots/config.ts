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
  /** Claude model override (e.g. "opus", "sonnet") — falls back to global CLAUDE_MODEL */
  model?: string;
  /** Max thinking tokens for extended thinking — set 0 to disable, undefined = CLI default */
  thinkingMaxTokens?: number;
  /** Claude timeout override in ms — falls back to global CLAUDE_TIMEOUT_MS */
  timeoutMs?: number;
  /** Per-tool-group user restrictions — tools not listed here are available to all */
  restrictedTools?: RestrictedTools;
  /** Channel listening config — passive relevance-based responses in active channels */
  channelListening?: ChannelListeningConfig;
  /** Collections to search in the Knowledge API (e.g. ["capra-notion"]) */
  knowledgeCollections?: string[];
}

/**
 * Scans bots/ directory and returns configs for bots that have:
 * 1. A CLAUDE.md file (persona)
 * 2. At least one platform token (Telegram or Slack)
 *
 * Claude CLI auto-discovers .mcp.json and .claude/settings.json
 * from the bot's dir (set as cwd), so we don't need explicit paths.
 */
/**
 * Discovers bots for simulator mode — only requires CLAUDE.md (tokens are optional).
 * Uses the same loading logic as discoverBots() but skips the platform token requirement.
 */
export function discoverBotsForSimulator(): BotConfig[] {
  return discoverBotsInternal({ requireTokens: false });
}

export function discoverBots(): BotConfig[] {
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

    // Bot needs at least one platform token (unless in simulator mode)
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
        const knownKeys = new Set(["model", "thinkingMaxTokens", "timeoutMs", "restrictedTools", "channelListening", "knowledgeCollections"]);
        const unknownKeys = Object.keys(botSettings).filter((k) => !knownKeys.has(k));
        if (unknownKeys.length > 0) {
          log.warn("Bot \"{name}\" config.json has unknown keys: {keys} — possible typo?", { name, keys: unknownKeys.join(", ") });
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
      model: botSettings.model as string | undefined,
      thinkingMaxTokens: botSettings.thinkingMaxTokens as number | undefined,
      timeoutMs: botSettings.timeoutMs as number | undefined,
      restrictedTools: botSettings.restrictedTools as RestrictedTools | undefined,
      channelListening: botSettings.channelListening as ChannelListeningConfig | undefined,
      knowledgeCollections: botSettings.knowledgeCollections as string[] | undefined,
    });

    const configParts: string[] = [];
    if (botSettings.model) configParts.push(`model: ${botSettings.model}`);
    if (botSettings.thinkingMaxTokens !== undefined) configParts.push(`thinking: ${botSettings.thinkingMaxTokens}`);
    if (botSettings.timeoutMs !== undefined) configParts.push(`timeout: ${botSettings.timeoutMs}ms`);

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
