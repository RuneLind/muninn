import { getLog } from "../../logging.ts";

const log = getLog("ai", "mcp-health");

const HEALTH_TIMEOUT_MS = 3000;

export interface McpHealthError {
  name: string;
  url: string;
  error: string;
}

/**
 * Probe a set of HTTP/SSE MCP servers for reachability.
 * Any response (even 404) counts as reachable — we only care that the process is listening.
 *
 * @returns Array of errors for servers that are not reachable (empty = all OK)
 */
export async function probeHttpServers(
  servers: Array<{ name: string; url: string }>,
): Promise<McpHealthError[]> {
  if (servers.length === 0) return [];

  const results = await Promise.all(
    servers.map(async ({ name, url }) => {
      try {
        await fetch(url, { method: "GET", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        return null;
      } catch (err) {
        return { name, url, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  return results.filter((r): r is McpHealthError => r !== null);
}

/**
 * Check that critical HTTP MCP servers from a bot's parsed MCP config are reachable.
 * Non-critical failures are logged as warnings; critical failures are returned.
 *
 * @param servers   Already-parsed MCP servers (from parseMcpConfig or equivalent)
 * @param critical  Server names that MUST be reachable (returned as errors).
 * @param botName   Bot name for log context
 */
export async function checkMcpServerHealth(
  servers: Record<string, { type: string; url?: string }>,
  critical: string[],
  botName: string,
): Promise<McpHealthError[]> {
  const httpEntries = Object.entries(servers)
    .filter(([, cfg]) => (cfg.type === "http" || cfg.type === "sse") && cfg.url)
    .map(([name, cfg]) => ({ name, url: cfg.url! }));

  const failures = await probeHttpServers(httpEntries);

  for (const f of failures) {
    log.warn("MCP server {name} not reachable at {url}: {error}", {
      botName, name: f.name, url: f.url, error: f.error,
    });
  }

  return failures.filter((f) => critical.includes(f.name));
}
