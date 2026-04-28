import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getLog } from "../logging.ts";
import type { HivemindBotClient } from "./client.ts";
import { DEFAULT_ASK_PEER_TIMEOUT_SEC } from "./config.ts";

const log = getLog("hivemind", "mcp-server");

export const HIVEMIND_MCP_PORT = 9180;

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}

export class HivemindMcpServer {
  private httpServer: ReturnType<typeof Bun.serve> | null = null;
  private sessions = new Map<string, Session>();
  /** Map of bot name → client. Used to route tool calls to the right peer. */
  private clients = new Map<string, HivemindBotClient>();
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

  registerBot(botName: string, client: HivemindBotClient): void {
    this.clients.set(botName, client);
    log.info("Registered bot {botName} at /mcp/{botName}", { botName });
  }

  unregisterBot(botName: string): void {
    this.clients.delete(botName);
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
        bots: Array.from(this.clients.keys()),
        sessions: this.sessions.size,
      });
    }

    // Extract bot name from /mcp/<botName>
    const match = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (!match) {
      return new Response("Not found", { status: 404 });
    }
    const botName = decodeURIComponent(match[1]!);
    const client = this.clients.get(botName);
    if (!client) {
      return new Response(`Unknown bot: ${botName}`, { status: 404 });
    }

    const sessionId = req.headers.get("mcp-session-id");
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) return new Response("Session not found", { status: 404 });
      return session.transport.handleRequest(req);
    }

    if (req.method === "POST") {
      return this.handleNewSession(req, client);
    }
    return new Response("Bad request — missing session ID", { status: 400 });
  }

  private async handleNewSession(req: Request, client: HivemindBotClient): Promise<Response> {
    const server = createMcpServerForBot(client);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, server });
        log.info("New MCP session {id} for bot {bot}", { id: id.slice(0, 8), bot: client.botName });
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

/** Build an MCP server scoped to a single bot's HivemindBotClient. */
function createMcpServerForBot(client: HivemindBotClient): McpServer {
  const server = new McpServer(
    { name: `muninn-hivemind-${client.botName}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.tool(
    "list_peers",
    "List other AI coding agents reachable via claude-hivemind. Use this first to find the peer ID before calling ask_peer or send_to_peer. " +
      'Default scope "namespace" returns peers in your project group; "machine" returns all peers on this computer.',
    {
      scope: z
        .enum(["namespace", "machine"])
        .optional()
        .describe('"namespace" (default) or "machine"'),
    },
    async ({ scope }) => {
      try {
        const peers = await client.listPeers(scope ?? "namespace");
        if (peers.length === 0) {
          return textResult(`No peers found (scope: ${scope ?? "namespace"}, namespace: ${client.namespace}).`);
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
