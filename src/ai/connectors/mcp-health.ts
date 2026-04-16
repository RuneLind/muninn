import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BotConfig } from "../../bots/config.ts";
import { getLog } from "../../logging.ts";

const log = getLog("ai", "mcp-health");

export interface McpHealthError {
  name: string;
  url: string;
  error: string;
}

/**
 * Check that HTTP MCP servers from a bot's .mcp.json are reachable.
 *
 * @param botConfig  Bot whose .mcp.json to read
 * @param critical   Server names that MUST be reachable (returns errors for these).
 *                   Other HTTP servers are checked but only logged as warnings.
 * @returns Array of errors for critical servers that are not reachable (empty = all OK)
 */
export async function checkMcpServerHealth(
  botConfig: BotConfig,
  critical: string[],
): Promise<McpHealthError[]> {
  const mcpPath = join(botConfig.dir, ".mcp.json");
  if (!existsSync(mcpPath)) return [];

  let mcpJson: { mcpServers?: Record<string, { type?: string; url?: string }> };
  try {
    mcpJson = JSON.parse(readFileSync(mcpPath, "utf-8"));
  } catch {
    return [];
  }
  if (!mcpJson.mcpServers) return [];

  const httpServers = Object.entries(mcpJson.mcpServers)
    .filter(([, cfg]) => (cfg.type === "http" || cfg.type === "sse") && cfg.url);

  if (httpServers.length === 0) return [];

  const errors: McpHealthError[] = [];

  await Promise.all(
    httpServers.map(async ([name, cfg]) => {
      const url = cfg.url!;
      try {
        // Simple connectivity check — any response (even 404) means the server is up
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        await fetch(url, { method: "GET", signal: controller.signal });
        clearTimeout(timeout);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (critical.includes(name)) {
          errors.push({ name, url, error: message });
        }
        log.warn("MCP server {name} not reachable at {url}: {error}", {
          botName: botConfig.name, name, url, error: message,
        });
      }
    }),
  );

  return errors;
}
