import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getLog } from "../logging.ts";
import type { HivemindBotClient } from "./client.ts";
import type { Namespace, Peer } from "./types.ts";
import { DEFAULT_ASK_PEER_TIMEOUT_SEC } from "./config.ts";
import { peekActiveTurn } from "./active-turn.ts";
import { setPendingPeer } from "./correlation.ts";

/** Tie any inbound reply from `to` back to the thread this outbound came from,
 *  so peer responses route into the originating chat thread instead of the
 *  default `peer:<ns>/<name>` bucket. No-op if no active turn (e.g. tool
 *  invoked from a context that didn't set one). */
function bindOutboundToOriginThread(botName: string, to: string): void {
  const originThread = peekActiveTurn(botName);
  if (originThread) setPendingPeer(botName, to, originThread);
}

const log = getLog("hivemind", "mcp-server");

export const HIVEMIND_MCP_PORT = 9180;

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}

/**
 * Tracks all `HivemindBotClient` instances for one bot (one per joined
 * namespace). Maintains a `peer_id → namespace` cache populated by every
 * `list_peers` response so the shim can route `ask_peer`/`send_to_peer`
 * through the correct WS without persona changes.
 */
export class BotClientRegistry {
  private clients = new Map<Namespace, HivemindBotClient>();
  /** peer_id → namespace owning that peer. Updated on every list_peers response. */
  private peerNamespace = new Map<string, Namespace>();

  add(namespace: Namespace, client: HivemindBotClient): void {
    this.clients.set(namespace, client);
  }

  get namespaces(): Namespace[] {
    return Array.from(this.clients.keys());
  }

  /**
   * List peers across all namespaces (or just one when filtered). Each
   * client's response is cached so subsequent `ask_peer` calls can find
   * the right WS for a given peer ID. Cache is rebuilt every call so
   * dead peer IDs from prior sessions don't accumulate.
   */
  async listPeers(scope: "namespace" | "machine", filter?: Namespace): Promise<Peer[]> {
    const single = filter ? this.clients.get(filter) : null;
    const targets = filter ? (single ? [single] : []) : Array.from(this.clients.values());
    if (targets.length === 0) return [];

    const results = await Promise.allSettled(targets.map((c) => c.listPeers(scope)));
    if (!filter) this.peerNamespace.clear();

    const merged: Peer[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < targets.length; i++) {
      const c = targets[i]!;
      const r = results[i]!;
      if (r.status === "rejected") {
        log.warn("listPeers failed in namespace {ns}: {error}", {
          botName: c.botName, ns: c.namespace,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
        continue;
      }
      for (const p of r.value) {
        this.peerNamespace.set(p.id, c.namespace);
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        merged.push(p);
      }
    }
    return merged;
  }

  /**
   * Pick the client that owns this peer ID. Cache hit when the bot called
   * `list_peers` first (the dominant flow). On miss falls back to the first
   * client and logs a warn — bot can recover by calling list_peers again.
   */
  pickClientFor(peerId: string): HivemindBotClient | null {
    const ns = this.peerNamespace.get(peerId);
    if (ns) {
      const c = this.clients.get(ns);
      if (c) return c;
    }
    const fallback = this.clients.values().next().value ?? null;
    if (fallback) {
      log.warn(
        "No cached namespace for peer {peerId} — falling back to {ns}. " +
          "Bot should call list_peers before ask_peer/send_to_peer.",
        { botName: fallback.botName, peerId, ns: fallback.namespace },
      );
    }
    return fallback;
  }
}

export class HivemindMcpServer {
  private httpServer: ReturnType<typeof Bun.serve> | null = null;
  private sessions = new Map<string, Session>();
  /** Map of bot name → registry of (namespace, client) pairs. */
  private bots = new Map<string, BotClientRegistry>();
  private port: number;

  constructor(port = HIVEMIND_MCP_PORT) {
    this.port = port;
  }

  get isRunning(): boolean {
    return this.httpServer !== null;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Register one client (one namespace) for a bot. May be called multiple
   *  times per bot — once per joined namespace. */
  registerBotClient(botName: string, namespace: Namespace, client: HivemindBotClient): void {
    let reg = this.bots.get(botName);
    if (!reg) {
      reg = new BotClientRegistry();
      this.bots.set(botName, reg);
    }
    reg.add(namespace, client);
    log.info("Registered bot {botName} namespace {ns} at /mcp/{botName}", { botName, ns: namespace });
  }

  unregisterBot(botName: string): void {
    this.bots.delete(botName);
  }

  start(): void {
    if (this.httpServer) return;
    this.httpServer = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      // ask_peer can block up to ~600s waiting for a peer reply. Bun's
      // default idle timeout (~10s) closes the MCP request mid-wait and the
      // bot sees "fetch failed". 255 is the maximum allowed value.
      idleTimeout: 255,
      fetch: (req) => this.handleHttp(req),
    });
    log.info("Hivemind MCP server started on :{port}", { port: this.port });
  }

  async stop(): Promise<void> {
    if (!this.httpServer) return;
    for (const [, session] of this.sessions) {
      try {
        await session.server.close();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
    this.httpServer.stop();
    this.httpServer = null;
    log.info("Hivemind MCP server stopped");
  }

  // ── HTTP routing ──────────────────────────────────────────

  private async handleHttp(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        bots: Array.from(this.bots.keys()),
        sessions: this.sessions.size,
      });
    }

    // Extract bot name from /mcp/<botName>
    const match = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (!match) {
      return new Response("Not found", { status: 404 });
    }
    const botName = decodeURIComponent(match[1]!);
    const registry = this.bots.get(botName);
    if (!registry) {
      return new Response(`Unknown bot: ${botName}`, { status: 404 });
    }

    const sessionId = req.headers.get("mcp-session-id");
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) return new Response("Session not found", { status: 404 });
      return session.transport.handleRequest(req);
    }

    if (req.method === "POST") {
      return this.handleNewSession(req, botName, registry);
    }
    return new Response("Bad request — missing session ID", { status: 400 });
  }

  private async handleNewSession(req: Request, botName: string, registry: BotClientRegistry): Promise<Response> {
    const server = createMcpServerForBot(botName, registry);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, server });
        log.info("New MCP session {id} for bot {bot}", { id: id.slice(0, 8), bot: botName });
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return transport.handleRequest(req);
  }
}

/** Build an MCP server scoped to a single bot's set of HivemindBotClients. */
function createMcpServerForBot(botName: string, registry: BotClientRegistry): McpServer {
  const server = new McpServer(
    { name: `muninn-hivemind-${botName}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const namespacesHint = registry.namespaces.join(", ");

  server.tool(
    "list_peers",
    "List other AI coding agents reachable via claude-hivemind. Use this first to find the peer ID before calling ask_peer or send_to_peer. " +
      'Default scope "namespace" returns peers in all namespaces this bot has joined; "machine" returns all peers on this computer. ' +
      `Pass an optional namespace to filter to one (joined namespaces: ${namespacesHint}).`,
    {
      scope: z
        .enum(["namespace", "machine"])
        .optional()
        .describe('"namespace" (default) or "machine"'),
      namespace: z
        .string()
        .optional()
        .describe(`Filter to one of the bot's joined namespaces (${namespacesHint}). Default: list across all of them.`),
    },
    async ({ scope, namespace }) => {
      try {
        const peers = await registry.listPeers(scope ?? "namespace", namespace);
        if (peers.length === 0) {
          const where = namespace ? `namespace=${namespace}` : `joined namespaces=${namespacesHint}`;
          return textResult(`No peers found (scope: ${scope ?? "namespace"}, ${where}).`);
        }
        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `Type: ${p.agent_type}`,
            `CWD: ${p.cwd}`,
            `Namespace: ${p.namespace}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.git_branch) parts.push(`Branch: ${p.git_branch}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Status: ${p.connected ? "connected" : "disconnected"}`);
          return parts.join("\n  ");
        });
        return textResult(`Found ${peers.length} peer(s):\n\n${lines.join("\n\n")}`);
      } catch (e) {
        return textResult(`Error listing peers: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    },
  );

  server.tool(
    "ask_peer",
    "Send a message to another AI coding agent and wait up to wait_seconds for a reply. " +
      "Use this for short Q&A while the peer is online and likely to respond quickly. " +
      "For long-running tasks (where the peer needs minutes to complete), use send_to_peer instead — " +
      "ask_peer will time out and return a hint.",
    {
      to: z.string().describe("Peer ID from list_peers"),
      message: z.string().describe("The message to send"),
      wait_seconds: z
        .number()
        .int()
        .positive()
        .max(240)
        .optional()
        .describe(`How long to wait for a reply (default ${DEFAULT_ASK_PEER_TIMEOUT_SEC}s, max 240s — bounded by the MCP HTTP idle timeout)`),
    },
    async ({ to, message, wait_seconds }) => {
      const client = registry.pickClientFor(to);
      if (!client) {
        return textResult("No hivemind client registered for this bot", true);
      }
      // ask_peer's blocking reply flows back as the tool result, but late
      // (post-timeout) and unsolicited follow-up replies still need correlation.
      bindOutboundToOriginThread(botName, to);
      const timeout = wait_seconds ?? DEFAULT_ASK_PEER_TIMEOUT_SEC;
      const reply = await client.askPeer(to, message, timeout);
      switch (reply.status) {
        case "ok":
          return textResult(reply.text);
        case "timeout":
          return textResult(`[timed out] ${reply.text}`);
        case "not_connected":
        case "send_failed":
          return textResult(reply.text, true);
      }
    },
  );

  server.tool(
    "send_to_peer",
    "Send a fire-and-forget message to another AI coding agent. Returns immediately. " +
      "Use this for long-running tasks (e.g. \"please rebuild the search index\") where you don't want to block. " +
      "The peer's reply, if any, will arrive asynchronously and may not be visible in this turn.",
    {
      to: z.string().describe("Peer ID from list_peers"),
      message: z.string().describe("The message to send"),
    },
    async ({ to, message }) => {
      const client = registry.pickClientFor(to);
      if (!client) {
        return textResult("No hivemind client registered for this bot", true);
      }
      bindOutboundToOriginThread(botName, to);
      const ok = client.sendMessage(to, message);
      if (!ok) return textResult("Failed to send — not connected to broker", true);
      return textResult(`Message sent to peer ${to}.`);
    },
  );

  return server;
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError && { isError: true }),
  };
}
