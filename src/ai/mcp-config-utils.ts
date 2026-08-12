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
 *
 * **Known limit:** only `./`- and `../`-prefixed tokens are rewritten, in `args`
 * and in `command`. A BARE relative token (`scripts/adapter.py`) and a `~`-prefixed
 * one are left alone, because neither is distinguishable from a value that is
 * meant to be literal — a bare `command` is a PATH lookup, and a bare arg is
 * usually a subcommand. No bot on this machine uses those shapes; one that did
 * would find its server failing to start from the agent home. Prefer an absolute
 * path or an explicit `./` in `.mcp.json`.
 */
export function buildInlineMcpConfig(botDir: string): string | null {
  const servers = loadRawMcpServers(botDir);
  if (!servers || Object.keys(servers).length === 0) return null;

  const relocate = (token: string): string =>
    token.startsWith("./") || token.startsWith("../") ? resolve(botDir, token) : token;

  const resolved: Record<string, RawMcpServerEntry> = {};
  for (const [name, entry] of Object.entries(servers)) {
    // Remote servers carry a URL and never a filesystem path. Keyed on the URL
    // rather than on `type`, because `{"url": "..."}` with no `type` is legal
    // shorthand — reading `type` alone stamps a meaningless `cwd` onto it.
    if (entry.type === "http" || entry.type === "sse" || (entry.url && !entry.command)) {
      resolved[name] = entry;
      continue;
    }
    resolved[name] = {
      ...entry,
      // `command` is relocated too: `"command": "./scripts/mcp.sh"` resolved
      // against the bot dir under the old spawn cwd and would otherwise now
      // resolve against the agent home and fail to start.
      ...(entry.command ? { command: relocate(entry.command) } : {}),
      ...(entry.args ? { args: entry.args.map((a) => (typeof a === "string" ? relocate(a) : a)) } : {}),
      cwd: resolveBotCwd(entry.cwd, botDir),
    };
  }
  return JSON.stringify({ mcpServers: resolved });
}

/**
 * A bot's tool PERMISSIONS as a JSON string for `claude --settings <string>`.
 *
 * Two files, merged, because `--settings` is not repeatable and the CLI's own
 * discovery reads both: `.claude/settings.json` (checked in / synced) and
 * `.claude/settings.local.json` (per-machine — **and the file Claude Code itself
 * writes when a permission is approved in place**). Passing only the first means
 * a tool the user granted interactively is denied on the next watcher run, which
 * surfaces as an empty inbox rather than an error. `bots/capra/` carries a local
 * file today.
 *
 * Merge rule mirrors the CLI's precedence: local wins per key, except the
 * `permissions` allow/deny/ask lists, which are UNIONED (order-preserving,
 * de-duplicated) — a local file that grants one extra tool must not silently
 * revoke everything the shared file granted.
 *
 * Returns `null` when neither file is readable, so the caller omits the flag.
 */
export function buildInlineSettings(botDir: string): string | null {
  const read = (name: string): Record<string, unknown> | null => {
    const path = join(botDir, ".claude", name);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const shared = read("settings.json");
  const local = read("settings.local.json");
  if (!shared && !local) return null;

  const merged: Record<string, unknown> = { ...(shared ?? {}), ...(local ?? {}) };

  const sharedPerms = (shared?.permissions ?? {}) as Record<string, unknown>;
  const localPerms = (local?.permissions ?? {}) as Record<string, unknown>;
  if (shared?.permissions || local?.permissions) {
    const perms: Record<string, unknown> = { ...sharedPerms, ...localPerms };
    for (const key of ["allow", "deny", "ask"]) {
      const a = Array.isArray(sharedPerms[key]) ? (sharedPerms[key] as unknown[]) : [];
      const b = Array.isArray(localPerms[key]) ? (localPerms[key] as unknown[]) : [];
      if (a.length || b.length) perms[key] = [...new Set([...a, ...b])];
    }
    merged.permissions = perms;
  }
  return JSON.stringify(merged);
}
