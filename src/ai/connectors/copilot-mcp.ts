import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLog } from "../../logging.ts";

const log = getLog("ai", "copilot-mcp");

interface McpServerEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface McpJsonFile {
  mcpServers?: Record<string, McpServerEntry>;
}

/** Matches MCPLocalServerConfig from @github/copilot-sdk */
export interface CopilotMcpLocalServer {
  type: "local";
  command: string;
  args: string[];
  env?: Record<string, string>;
  tools: string[];
}

/** Matches MCPRemoteServerConfig from @github/copilot-sdk */
export interface CopilotMcpRemoteServer {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  tools: string[];
}

export type CopilotMcpServer = CopilotMcpLocalServer | CopilotMcpRemoteServer;

/**
 * Read bots/<name>/.mcp.json and convert to Copilot SDK mcpServers format.
 * Supports both local (stdio) and remote (http/sse) server entries.
 */
export function parseMcpConfig(botDir: string): Record<string, CopilotMcpServer> {
  const mcpPath = join(botDir, ".mcp.json");
  if (!existsSync(mcpPath)) return {};

  try {
    const raw: McpJsonFile = JSON.parse(readFileSync(mcpPath, "utf-8"));
    if (!raw.mcpServers) return {};

    const result: Record<string, CopilotMcpServer> = {};
    for (const [name, entry] of Object.entries(raw.mcpServers)) {
      if (entry.type === "http" || entry.type === "sse") {
        if (!entry.url) {
          log.warn("MCP server {name} has type {type} but no url — skipping", { name, type: entry.type });
          continue;
        }
        result[name] = {
          type: entry.type,
          url: entry.url,
          headers: entry.headers,
          tools: ["*"],
        };
      } else {
        if (!entry.command) {
          log.warn("MCP server {name} has no command — skipping", { name });
          continue;
        }
        result[name] = {
          type: "local",
          command: entry.command,
          args: entry.args ?? [],
          env: entry.env,
          tools: ["*"],
        };
      }
    }
    return result;
  } catch (e) {
    log.warn("Failed to parse {path}: {error}", { path: mcpPath, error: String(e) });
    return {};
  }
}
