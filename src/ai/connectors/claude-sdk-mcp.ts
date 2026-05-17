import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { logTraceFlagsOnce } from "../huginn-trace.ts";
import { getLog } from "../../logging.ts";

const log = getLog("ai", "claude-sdk-mcp");

interface McpServerEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

interface McpJsonFile {
  mcpServers?: Record<string, McpServerEntry>;
}

/**
 * Read bots/<name>/.mcp.json and convert to Claude Agent SDK mcpServers format.
 * Supports stdio, http, and sse server entries.
 *
 * The Agent SDK's `McpStdioServerConfig` does not expose a per-server `cwd`,
 * so stdio servers inherit the cwd we set on the `query()` call (the bot dir).
 * None of the bots ship a `cwd` field today; if that changes, this converter
 * will warn so we notice.
 */
export function parseMcpConfig(botDir: string): Record<string, McpServerConfig> {
  const mcpPath = join(botDir, ".mcp.json");
  if (!existsSync(mcpPath)) return {};

  logTraceFlagsOnce();

  try {
    const raw: McpJsonFile = JSON.parse(readFileSync(mcpPath, "utf-8"));
    if (!raw.mcpServers) return {};

    const result: Record<string, McpServerConfig> = {};
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
        };
      } else {
        if (!entry.command) {
          log.warn("MCP server {name} has no command — skipping", { name });
          continue;
        }
        if (entry.cwd) {
          log.warn(
            "MCP server {name} has cwd but Agent SDK doesn't support per-server cwd — falling back to bot dir",
            { name },
          );
        }
        // Inherit parent env so HUGINN_TRACE_POINTER etc. reach stdio children;
        // forced HUGINN_TRACE_DEFAULT covers the legacy fence path; entry.env wins.
        result[name] = {
          type: "stdio",
          command: entry.command,
          args: entry.args ?? [],
          env: { ...process.env, HUGINN_TRACE_DEFAULT: "1", ...(entry.env ?? {}) } as Record<string, string>,
        };
      }
    }
    return result;
  } catch (e) {
    log.warn("Failed to parse {path}: {error}", { path: mcpPath, error: String(e) });
    return {};
  }
}
