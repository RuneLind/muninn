import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface BotConfig {
  name: string;
  /** Absolute path to the bot folder — used as cwd for Claude CLI spawns */
  dir: string;
  telegramBotToken: string;
  persona: string;
  allowedUserIds: number[];
}

/**
 * Scans bots/ directory and returns configs for bots that have:
 * 1. A CLAUDE.md file (persona)
 * 2. A matching TELEGRAM_BOT_TOKEN_<NAME> env var
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
    const token = process.env[`TELEGRAM_BOT_TOKEN_${envName}`];

    if (!token) {
      console.log(`[Jarvis] Skipping bot "${name}" — no TELEGRAM_BOT_TOKEN_${envName} env var`);
      continue;
    }

    const allowedIdsEnv = process.env[`TELEGRAM_ALLOWED_USER_IDS_${envName}`] ?? "";
    const allowedUserIds = allowedIdsEnv
      .split(",")
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id));

    const persona = readFileSync(claudeMdPath, "utf-8");

    const hasMcp = existsSync(join(dir, ".mcp.json"));
    const hasSettings = existsSync(join(dir, ".claude", "settings.local.json"));

    bots.push({
      name,
      dir,
      telegramBotToken: token,
      persona,
      allowedUserIds,
    });

    console.log(
      `[Jarvis] Discovered bot "${name}" (${allowedUserIds.length} allowed users, ` +
        `MCP: ${hasMcp ? "yes" : "no"}, ` +
        `settings: ${hasSettings ? "yes" : "no"}, ` +
        `dir: ${dir})`,
    );
  }

  return bots;
}
