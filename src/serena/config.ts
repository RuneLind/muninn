import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { getLog } from "../logging.ts";

const log = getLog("serena", "config");

export interface SerenaInstanceConfig {
  name: string;
  displayName: string;
  projectPath: string;
  port: number;
}

export interface SerenaBotConfig {
  botName: string;
  instances: SerenaInstanceConfig[];
}

/**
 * Scan all bot folders for `config.json` with a `serena` key.
 * Returns configs grouped by bot.
 */
export function discoverSerenaConfigs(botsDir: string): SerenaBotConfig[] {
  const results: SerenaBotConfig[] = [];

  if (!existsSync(botsDir)) return results;

  // The caller hands over the root discovery READ, so this is the second reader
  // of a directory that has already been read once; a failure here is the root
  // going unreadable between the two, and Serena entries are not worth a boot.
  let entries;
  try {
    entries = readdirSync(botsDir, { withFileTypes: true });
  } catch (err) {
    log.warn("Cannot read bots root {path} for Serena configs: {error}", {
      path: botsDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const configPath = join(botsDir, entry.name, "config.json");
    if (!existsSync(configPath)) continue;

    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!Array.isArray(raw.serena) || raw.serena.length === 0) continue;

      const valid: SerenaInstanceConfig[] = [];
      for (const item of raw.serena) {
        if (!item || typeof item !== "object" || !item.name || !item.projectPath || !item.port) {
          log.warn("Bot \"{bot}\" has invalid serena entry (missing name, projectPath, or port) — skipping: {item}", {
            bot: entry.name,
            item: JSON.stringify(item),
          });
          continue;
        }
        valid.push({
          name: item.name,
          displayName: item.displayName ?? item.name,
          projectPath: item.projectPath,
          port: Number(item.port),
        });
      }
      if (valid.length === 0) continue;

      results.push({
        botName: entry.name,
        instances: valid,
      });
    } catch {
      // Skip malformed config files
    }
  }

  return results;
}
