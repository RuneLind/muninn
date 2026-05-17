import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Resolve an MCP server's `cwd` field against a bot directory.
 * Convention: relative cwd is relative to the bot dir (so `.mcp.json` configs
 * with `../-paths` work the same whether spawned by the executor, the SDK,
 * or the MCP debug client).
 */
export function resolveBotCwd(cwd: string | undefined, botDir: string): string {
  if (!cwd) return botDir;
  return isAbsolute(cwd) ? cwd : resolve(botDir, cwd);
}

/** Raw shape of an entry in `bots/<name>/.mcp.json`. Shared by all connector
 *  MCP adapters — each maps this to its own SDK's server-config shape. */
export interface RawMcpServerEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface RawMcpJsonFile {
  mcpServers?: Record<string, RawMcpServerEntry>;
}

/**
 * Read and parse `bots/<botDir>/.mcp.json`. Returns the parsed `mcpServers`
 * record, or `null` if the file is missing or unparseable. Logging is the
 * caller's responsibility (so each connector can attribute the log to its
 * own category).
 */
export function loadRawMcpServers(botDir: string): Record<string, RawMcpServerEntry> | null {
  const mcpPath = join(botDir, ".mcp.json");
  if (!existsSync(mcpPath)) return null;
  try {
    const raw: RawMcpJsonFile = JSON.parse(readFileSync(mcpPath, "utf-8"));
    return raw.mcpServers ?? {};
  } catch {
    return null;
  }
}
