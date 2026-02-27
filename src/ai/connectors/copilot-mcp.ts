import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLog } from "../../logging.ts";

const log = getLog("ai", "copilot-mcp");

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpJsonFile {
  mcpServers?: Record<string, McpServerEntry>;
}

/** Matches MCPLocalServerConfig from @github/copilot-sdk */
export interface CopilotMcpServer {
  type: "local";
  command: string;
  args: string[];
  env?: Record<string, string>;
  tools: string[];
}

/**
 * Read bots/<name>/.mcp.json and convert to Copilot SDK mcpServers format.
 */
export function parseMcpConfig(botDir: string): Record<string, CopilotMcpServer> {
  const mcpPath = join(botDir, ".mcp.json");
  if (!existsSync(mcpPath)) return {};

  try {
    const raw: McpJsonFile = JSON.parse(readFileSync(mcpPath, "utf-8"));
    if (!raw.mcpServers) return {};

    const result: Record<string, CopilotMcpServer> = {};
    for (const [name, entry] of Object.entries(raw.mcpServers)) {
      result[name] = {
        type: "local",
        command: entry.command,
        args: entry.args ?? [],
        env: entry.env,
        tools: ["*"],
      };
    }
    return result;
  } catch (e) {
    log.warn("Failed to parse {path}: {error}", { path: mcpPath, error: String(e) });
    return {};
  }
}
