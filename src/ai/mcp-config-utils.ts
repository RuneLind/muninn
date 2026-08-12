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

/**
 * A bot's `.mcp.json` re-expressed as a **location-independent** JSON string,
 * suitable for `claude --mcp-config <string>` (the CLI accepts a literal JSON
 * document, not just a path — verified against CLI 2.1.228).
 *
 * Why the rewrite rather than passing the file path: the Claude CLI ignores an
 * stdio entry's own `cwd` field and spawns the server from the CLI's cwd, so
 * jarvis's `uv --directory ../../../huginn` only resolves while the CLI itself
 * runs in `bots/<name>/`. A `spawnHaiku` call now runs in muninn's agent home
 * instead (outside the checkout), which would silently break that server. Every
 * relative `./`/`../` token in `args`, plus the entry's `cwd`, is therefore
 * pre-resolved against the bot dir — the same fix `benchmarks/scratch-bot.ts`
 * applies for the same reason. `env` values are left verbatim: the documented
 * convention (root CLAUDE.md, "Config Sync") is that env blocks are read
 * literally, so rewriting them would change meaning, not preserve it.
 *
 * Returns `null` when the bot has no readable `.mcp.json`, or when it declares
 * no servers — in both cases there is nothing to pass and the caller should
 * omit the flag entirely rather than hand the CLI an empty server set.
 */
export function buildInlineMcpConfig(botDir: string): string | null {
  const servers = loadRawMcpServers(botDir);
  if (!servers || Object.keys(servers).length === 0) return null;

  const resolved: Record<string, RawMcpServerEntry> = {};
  for (const [name, entry] of Object.entries(servers)) {
    // http/sse servers carry a URL, never a filesystem path — pass them through.
    if (entry.type === "http" || entry.type === "sse") {
      resolved[name] = entry;
      continue;
    }
    resolved[name] = {
      ...entry,
      ...(entry.args
        ? {
            args: entry.args.map((arg) =>
              typeof arg === "string" && (arg.startsWith("./") || arg.startsWith("../"))
                ? resolve(botDir, arg)
                : arg,
            ),
          }
        : {}),
      cwd: resolveBotCwd(entry.cwd, botDir),
    };
  }
  return JSON.stringify({ mcpServers: resolved });
}
