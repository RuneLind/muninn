import { isAbsolute, resolve } from "node:path";

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
