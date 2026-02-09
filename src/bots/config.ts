import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
}

/**
 * Scans bots/ directory and returns configs for bots that have:
 * 1. A CLAUDE.md file (persona)
 * 2. At least one platform token (Telegram or Slack)
 *
 * Claude CLI auto-discovers .mcp.json and .claude/settings.local.json
 * from the bot's dir (set as cwd), so we don't need explicit paths.
 */
export function discoverBots(): BotConfig[] {
  const botsDir = resolve(import.meta.dir, "../../bots");

  if (!existsSync(botsDir)) {
    console.warn(`[Jarvis] bots/ directory not found at ${botsDir}`);
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

    if (!hasTelegram && !hasSlack) {
      console.log(`[Jarvis] Skipping bot "${name}" — no platform tokens found (need TELEGRAM_BOT_TOKEN_${envName} or SLACK_BOT_TOKEN_${envName} + SLACK_APP_TOKEN_${envName})`);
      continue;
    }

    const telegramAllowedIdsEnv = process.env[`TELEGRAM_ALLOWED_USER_IDS_${envName}`] ?? "";
    const telegramAllowedUserIds = telegramAllowedIdsEnv
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

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
      } catch (e) {
        console.warn(`[Jarvis] Failed to parse ${configJsonPath}: ${e}`);
      }
    }

    const hasMcp = existsSync(join(dir, ".mcp.json"));
    const hasSettings = existsSync(join(dir, ".claude", "settings.local.json"));

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
    });

    const configParts: string[] = [];
    if (botSettings.model) configParts.push(`model: ${botSettings.model}`);
    if (botSettings.thinkingMaxTokens !== undefined) configParts.push(`thinking: ${botSettings.thinkingMaxTokens}`);
    if (botSettings.timeoutMs !== undefined) configParts.push(`timeout: ${botSettings.timeoutMs}ms`);

    console.log(
      `[Jarvis] Discovered bot "${name}" (platforms: ${platforms.join("+")}, ` +
        `telegram users: ${telegramAllowedUserIds.length}, slack users: ${slackAllowedUserIds.length}, ` +
        `MCP: ${hasMcp ? "yes" : "no"}, ` +
        `settings: ${hasSettings ? "yes" : "no"}, ` +
        `config.json: ${hasConfigJson ? `yes (${configParts.join(", ") || "empty"})` : "no"}, ` +
        `dir: ${dir})`,
    );
  }

  return bots;
}
