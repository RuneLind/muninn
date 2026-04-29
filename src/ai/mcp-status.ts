import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { BotConfig } from "../bots/config.ts";
import { getLog } from "../logging.ts";

const log = getLog("ai", "mcp-status");

const DEFAULT_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
/** list_collections is called after the MCP is already warm, but it does its
 *  own HTTP roundtrip to the backing knowledge API — give it some headroom. */
const CALL_TIMEOUT_MS = 15_000;

export type McpStatus = "ok" | "down" | "unknown";

export interface McpToolInfo {
  name: string;
  description?: string;
}

export interface McpCollectionInfo {
  name: string;
  documentCount?: number;
}

export interface McpServerStatus {
  /** Server name as it appears in `.mcp.json` */
  name: string;
  /** Friendly name shown in the panel */
  displayName: string;
  status: McpStatus;
  toolCount?: number;
  /** Tool list — populated on a successful probe. Names + optional descriptions. */
  tools?: McpToolInfo[];
  /**
   * Collection list — populated when the server exposes a `list_collections`
   * tool and the call succeeds. Each entry has a name and optional doc count.
   */
  collections?: McpCollectionInfo[];
  /**
   * Set when a server exposes `list_collections` but the call failed or
   * returned an unparseable response. Distinguishes "no collections support"
   * from "collections support exists but is broken" — the latter usually
   * means the underlying API is down, which is a real outage.
   */
  collectionsError?: string;
  errorMessage?: string;
  /** Epoch ms — when the probe last completed (or 0 if never probed) */
  lastCheckedMs: number;
  /** Whether the bot considers this server critical (down → user is warned) */
  critical: boolean;
}

export interface McpStatusConfig {
  /** Re-probe before every send (slow but always accurate). Default false. */
  probeOnSend?: boolean;
  /** TTL for cached probe results in ms. Default 60_000. */
  cacheTtlMs?: number;
  /** Server names that should be treated as critical when down. */
  critical?: string[];
}

interface CacheEntry {
  servers: McpServerStatus[];
  expiresAtMs: number;
}

/** Friendly names for known MCP servers. Falls back to the raw name. */
const DISPLAY_NAMES: Record<string, string> = {
  code: "Serena",
  yggdrasil: "Yggdrasil",
  knowledge: "Knowledge",
  gmail: "Gmail",
  "google-calendar": "Google Calendar",
  "claude-hivemind": "Hivemind",
};

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<McpServerStatus[]>>();

type EventListener = (botName: string, servers: McpServerStatus[]) => void;
const listeners = new Set<EventListener>();

/** Subscribe to status updates. Returns an unsubscribe function. */
export function onMcpStatusChange(fn: EventListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(botName: string, servers: McpServerStatus[]): void {
  for (const fn of listeners) {
    try {
      fn(botName, servers);
    } catch {
      // Ignore listener errors
    }
  }
}

/** Read `.mcp.json` for a bot. Returns empty record if missing or unparseable. */
interface RawMcpEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
}

function readMcpServers(botDir: string): Record<string, RawMcpEntry> {
  const path = join(botDir, ".mcp.json");
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return (raw.mcpServers ?? {}) as Record<string, RawMcpEntry>;
  } catch (e) {
    log.warn("Failed to parse {path}: {error}", { path, error: String(e) });
    return {};
  }
}

function getStatusConfig(bot: BotConfig): Required<McpStatusConfig> {
  const cfg = bot.mcpStatus ?? {};
  return {
    probeOnSend: cfg.probeOnSend ?? false,
    cacheTtlMs: cfg.cacheTtlMs ?? DEFAULT_TTL_MS,
    critical: cfg.critical ?? [],
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

interface ProbeOk {
  tools: McpToolInfo[];
  collections?: McpCollectionInfo[];
  collectionsError?: string;
}

async function probeOne(
  name: string,
  entry: RawMcpEntry,
  botDir: string,
): Promise<ProbeOk | { error: string }> {
  const isRemote = entry.type === "http" || entry.type === "sse";
  let transport: Transport | null = null;
  let client: Client | null = null;

  try {
    if (isRemote) {
      if (!entry.url) return { error: `missing url for ${entry.type}` };
      transport = new StreamableHTTPClientTransport(new URL(entry.url));
    } else {
      if (!entry.command) return { error: "missing command" };
      const cwd = entry.cwd
        ? isAbsolute(entry.cwd)
          ? entry.cwd
          : resolve(botDir, entry.cwd)
        : botDir;
      transport = new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: { ...process.env, ...entry.env } as Record<string, string>,
        cwd,
        stderr: "pipe",
      });
    }

    client = new Client(
      { name: "muninn-mcp-status", version: "1.0.0" },
      { capabilities: {} },
    );

    await withTimeout(client.connect(transport), PROBE_TIMEOUT_MS, `connect ${name}`);
    const { tools: rawTools } = await withTimeout(
      client.listTools(),
      PROBE_TIMEOUT_MS,
      `listTools ${name}`,
    );
    const tools: McpToolInfo[] = rawTools.map((t) => ({
      name: t.name,
      description: t.description,
    }));

    // If the server exposes list_collections, call it to enrich the row.
    // Failures keep the row "ok" (listTools succeeded) but record a
    // collectionsError so the panel can flag it — a server that can't
    // enumerate its collections is usually broken for retrieval.
    let collections: McpCollectionInfo[] | undefined;
    let collectionsError: string | undefined;
    const listCollectionsTool = tools.find(
      (t) => t.name === "list_collections" || t.name.endsWith("__list_collections"),
    );
    if (listCollectionsTool) {
      try {
        const result = await withTimeout(
          client.callTool({ name: listCollectionsTool.name, arguments: {} }),
          CALL_TIMEOUT_MS,
          `list_collections ${name}`,
        );
        const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
        if (r?.isError) {
          collectionsError = extractTextSummary(r.content) || "Tool reported an error";
        } else {
          collections = parseCollectionsResult(result);
          if (!collections || collections.length === 0) {
            const summary = extractTextSummary(r?.content);
            collectionsError = summary
              ? `Could not parse collections from response: ${summary}`
              : "Empty response from list_collections";
          }
        }
      } catch (e) {
        collectionsError = e instanceof Error ? e.message : String(e);
        log.warn("list_collections failed for {server}: {error}", {
          server: name,
          error: collectionsError,
        });
      }
    }

    return { tools, collections, collectionsError };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore close errors — transport may already be torn down
      }
    }
  }
}

/**
 * Parse the `list_collections` MCP tool response into a normalized list.
 * MCP tool results have shape `{ content: [{ type, text }, ...] }`.
 * We accept several shapes since each server formats its payload differently:
 *   - `[{ name, document_count }]`
 *   - `[{ name, count }]`
 *   - `[{ name, size }]`
 *   - `[{ collection, ... }]`
 *   - `["wiki", "x-feed"]` (just names)
 *   - `{ collections: [...] }`
 */
export function parseCollectionsResult(result: unknown): McpCollectionInfo[] | undefined {
  // MCP returns content as array of TextContent. We try, in order:
  //   1. structuredContent (if the server set it)
  //   2. Each text part as JSON
  //   3. Each text part as markdown bullet list (huginn-style)
  const r = result as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
  let payload: unknown = r?.structuredContent;
  const textParts: string[] = [];
  if (payload === undefined && Array.isArray(r?.content)) {
    for (const part of r.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        textParts.push(part.text);
        try {
          payload = JSON.parse(part.text);
          break;
        } catch {
          // Not JSON — try the next content part.
        }
      }
    }
  }
  // Markdown fallback for human-readable text responses (e.g. huginn's
  // `- **wiki**: 1234 documents, ...`).
  if (payload === undefined && textParts.length > 0) {
    const md = parseCollectionsMarkdown(textParts.join("\n"));
    if (md && md.length > 0) return md;
    return undefined;
  }
  if (payload === undefined) return undefined;

  // Unwrap `{ collections: [...] }`
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.collections)) payload = obj.collections;
    else if (Array.isArray(obj.results)) payload = obj.results;
  }

  if (!Array.isArray(payload)) return undefined;

  const out: McpCollectionInfo[] = [];
  for (const item of payload) {
    if (typeof item === "string") {
      out.push({ name: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string"
      ? o.name
      : typeof o.collection === "string"
        ? o.collection
        : typeof o.id === "string"
          ? o.id
          : undefined;
    if (!name) continue;
    const count = typeof o.document_count === "number"
      ? o.document_count
      : typeof o.count === "number"
        ? o.count
        : typeof o.size === "number"
          ? o.size
          : typeof o.documents === "number"
            ? o.documents
            : undefined;
    out.push({ name, ...(count !== undefined ? { documentCount: count } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

async function runProbe(bot: BotConfig): Promise<McpServerStatus[]> {
  const cfg = getStatusConfig(bot);
  const servers = readMcpServers(bot.dir);
  const names = Object.keys(servers);

  if (names.length === 0) return [];

  const now = Date.now();
  const probes = await Promise.all(
    names.map(async (name) => {
      const entry = servers[name];
      if (!entry) {
        return {
          name,
          displayName: DISPLAY_NAMES[name] ?? name,
          status: "unknown" as const,
          lastCheckedMs: now,
          critical: cfg.critical.includes(name),
        };
      }
      const result = await probeOne(name, entry, bot.dir);
      const status: McpServerStatus = {
        name,
        displayName: DISPLAY_NAMES[name] ?? name,
        status: "error" in result ? "down" : "ok",
        lastCheckedMs: now,
        critical: cfg.critical.includes(name),
        ...("error" in result
          ? { errorMessage: result.error }
          : {
              toolCount: result.tools.length,
              tools: result.tools,
              ...(result.collections ? { collections: result.collections } : {}),
              ...(result.collectionsError ? { collectionsError: result.collectionsError } : {}),
            }),
      };
      if (status.status === "down") {
        log.warn("MCP {name} probe failed for {bot}: {error}", {
          botName: bot.name,
          name,
          error: status.errorMessage,
        });
      }
      return status;
    }),
  );

  // Sort: critical-down first, then ok, then non-critical-down
  probes.sort((a, b) => {
    const score = (s: McpServerStatus) =>
      s.status === "down" && s.critical ? 0 : s.status === "ok" ? 1 : 2;
    return score(a) - score(b) || a.displayName.localeCompare(b.displayName);
  });

  return probes;
}

/**
 * Get MCP status for a bot. Uses cache if fresh.
 * Concurrent calls for the same bot share a single in-flight probe.
 */
export async function getMcpStatus(
  bot: BotConfig,
  opts: { force?: boolean } = {},
): Promise<McpServerStatus[]> {
  const cfg = getStatusConfig(bot);
  const cached = cache.get(bot.name);
  const now = Date.now();

  if (!opts.force && cached && cached.expiresAtMs > now) {
    return cached.servers;
  }

  const existing = inFlight.get(bot.name);
  if (existing && !opts.force) return existing;

  const promise = (async () => {
    try {
      const servers = await runProbe(bot);
      cache.set(bot.name, {
        servers,
        expiresAtMs: Date.now() + cfg.cacheTtlMs,
      });
      emit(bot.name, servers);
      return servers;
    } finally {
      inFlight.delete(bot.name);
    }
  })();

  inFlight.set(bot.name, promise);
  return promise;
}

/** Return cached status without probing. Null if never probed. */
export function getCachedMcpStatus(botName: string): McpServerStatus[] | null {
  return cache.get(botName)?.servers ?? null;
}

/** Drop the cache entry for a bot — next `getMcpStatus` will re-probe. */
export function invalidateMcpStatus(botName: string): void {
  cache.delete(botName);
}

/** Clear all cached entries. Used in tests. */
export function _resetMcpStatusCache(): void {
  cache.clear();
  inFlight.clear();
}

/** Pull a short text summary from MCP `content` for diagnostics. */
function extractTextSummary(
  content: Array<{ type?: string; text?: string }> | undefined,
): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
      const s = part.text.replace(/\s+/g, " ").trim();
      return s.length > 120 ? s.slice(0, 117) + "..." : s;
    }
  }
  return undefined;
}

/**
 * Markdown fallback parser for `list_collections`. Recognizes patterns like:
 *
 *   - **wiki**: 1234 documents, 5678 embeddings (updated: ...)
 *   - **x-feed** (987 docs)
 *   - wiki: 1234 documents
 *   - wiki
 *
 * Extracts the bolded or first-token name and the first integer that
 * looks like a doc count (followed by "doc..." or "document..." or "items").
 */
export function parseCollectionsMarkdown(text: string): McpCollectionInfo[] | undefined {
  const lines = text.split("\n");
  const out: McpCollectionInfo[] = [];
  // Match a leading bullet: "-", "*", "+", "•", or numbered "1."
  const bullet = /^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/;
  for (const line of lines) {
    const m = bullet.exec(line);
    if (!m) continue;
    const rest = m[1] ?? "";
    // Prefer **bold** as the name; otherwise take the first word/identifier
    // before a delimiter (`:`, `(`, `—`, `-`, etc.).
    const boldMatch = /^\*\*([^*]+)\*\*/.exec(rest);
    let name: string | undefined;
    if (boldMatch) {
      name = boldMatch[1]?.trim();
    } else {
      const tokenMatch = /^[`"']?([\w.\-/]+)[`"']?/.exec(rest);
      name = tokenMatch?.[1]?.trim();
    }
    if (!name) continue;
    const countMatch = /(\d[\d ,_]*)\s*(?:doc|document|item|entry|entries|rows?)/i.exec(rest);
    const documentCount = countMatch?.[1]
      ? parseInt(countMatch[1].replace(/[ ,_]/g, ""), 10)
      : undefined;
    out.push({
      name,
      ...(Number.isFinite(documentCount) ? { documentCount: documentCount as number } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Find critical-down servers in a status list. */
export function findCriticalDown(servers: McpServerStatus[]): McpServerStatus[] {
  return servers.filter((s) => s.critical && s.status === "down");
}

/**
 * Connector-side pre-flight: get current status for a bot (cached or fresh
 * depending on `mcpStatus.probeOnSend`) and emit a warning intent for any
 * critical-down server. Returns the critical-down list so callers can
 * inspect it (e.g. tag the response meta).
 *
 * Failures inside this helper never throw — they degrade silently so a
 * status-probe outage cannot block a real chat request.
 */
export async function preflightMcpForRequest(
  bot: BotConfig,
  onProgress?: (event: { type: "intent"; text: string }) => void,
): Promise<McpServerStatus[]> {
  try {
    const cfg = getStatusConfig(bot);
    // If probeOnSend is true, force a fresh probe; otherwise use cache (probes if missing/expired).
    const servers = await getMcpStatus(bot, { force: cfg.probeOnSend });
    const criticalDown = findCriticalDown(servers);
    for (const s of criticalDown) {
      const msg = `⚠️ ${s.displayName} er ikke tilgjengelig — svar kan være ufullstendig`;
      log.warn("Critical MCP {name} is down for bot {bot}: {error}", {
        botName: bot.name,
        name: s.name,
        error: s.errorMessage,
      });
      onProgress?.({ type: "intent", text: msg });
    }
    return criticalDown;
  } catch (e) {
    log.warn("MCP preflight failed for bot {bot}: {error}", {
      botName: bot.name,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}
