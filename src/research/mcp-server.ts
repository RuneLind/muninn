import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getLog } from "../logging.ts";
import {
  researchKnowledge,
  formatResearchResultText,
  type ResearchKnowledgeResult,
} from "../ai/research-knowledge.ts";
import type { ConnectorType } from "../bots/config.ts";
import type { HaikuBackend } from "../ai/haiku-direct.ts";
import { persistThreadCitations } from "./thread-citations.ts";

const log = getLog("research", "mcp-server");

export const RESEARCH_MCP_PORT = 9190;

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}

interface BotEntry {
  botName: string;
  knowledgeApiUrl: string;
  /** Resolved once at registration from the bot's .mcp.json KNOWLEDGE_COLLECTIONS.
   *  `undefined` means "search all collections huginn knows about". */
  defaultCollections?: string[];
  /** Bot's main AI connector — drives the connector-derived Haiku default. */
  connector?: ConnectorType;
  /** Per-bot override from `BotConfig.haikuBackend`. */
  haikuBackend?: HaikuBackend;
}

const TOOL_DESCRIPTION =
  "Decomposes a multi-part or comparison question into focused sub-questions, runs a parallel `search_knowledge` for each, and returns the merged + deduped results. " +
  "Use this instead of `search_knowledge` when the question has multiple distinct parts, asks for a comparison, or chains facts across topics. " +
  "For simple single-topic lookups, prefer `search_knowledge` — it skips the decomposition Haiku call and is faster.";

export class ResearchMcpServer {
  private httpServer: ReturnType<typeof Bun.serve> | null = null;
  private sessions = new Map<string, Session>();
  private bots = new Map<string, BotEntry>();
  private port: number;

  constructor(port = RESEARCH_MCP_PORT) {
    this.port = port;
  }

  get isRunning(): boolean {
    return this.httpServer !== null;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  registerBot(entry: BotEntry): void {
    this.bots.set(entry.botName, entry);
    log.info("Registered bot {botName} at /mcp/{botName}", { botName: entry.botName });
  }

  unregisterBot(botName: string): void {
    this.bots.delete(botName);
  }

  start(): void {
    if (this.httpServer) return;
    this.httpServer = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      // Decompose Haiku call + 4 parallel searches can take ~30s on a slow path;
      // 120s gives generous headroom.
      idleTimeout: 120,
      fetch: (req) => this.handleHttp(req),
    });
    log.info("Research MCP server started on :{port}", { port: this.port });
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
    log.info("Research MCP server stopped");
  }

  private async handleHttp(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        bots: Array.from(this.bots.keys()),
        sessions: this.sessions.size,
      });
    }

    const match = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (!match) {
      return new Response("Not found", { status: 404 });
    }
    const botName = decodeURIComponent(match[1]!);
    const entry = this.bots.get(botName);
    if (!entry) {
      return new Response(`Unknown bot: ${botName}`, { status: 404 });
    }

    const sessionId = req.headers.get("mcp-session-id");
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) return new Response("Session not found", { status: 404 });
      return session.transport.handleRequest(req);
    }

    if (req.method === "POST") {
      return this.handleNewSession(req, entry);
    }
    return new Response("Bad request — missing session ID", { status: 400 });
  }

  private async handleNewSession(req: Request, entry: BotEntry): Promise<Response> {
    const server = createMcpServerForBot(entry);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, server });
        log.info("New MCP session {id} for bot {bot}", { id: id.slice(0, 8), bot: entry.botName });
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

/**
 * Persist what THIS tool call retrieved, against the thread it was called from.
 *
 * The write lives on the tool's own success path rather than in a consumer
 * because this is the only place the DECODED hits exist. Everything about the
 * shaping and the failure policy is in `thread-citations.ts`, which the
 * huginn-`knowledge` tool-result path shares.
 *
 * **This is the OUT-OF-BAND caller, and that is why the resolution has a
 * fallback at all.** A tool call arrives here as an HTTP request to this
 * server's own `Bun.serve` listener, made by the model's subprocess — a fresh
 * async context with no link to the turn that provoked it, so
 * `currentActiveTurn()` is null here by construction and the per-bot stack is
 * all there is. `resolveTurnThread` therefore uses it only while it is
 * unambiguous and drops the row otherwise. Closing that last gap means giving
 * each turn its own MCP endpoint (a per-turn URL the session resolves at
 * `handleHttp`, before the bot is consulted) and rewriting the bot's `.mcp.json`
 * per turn — a real change to how every connector is launched, not a fix that
 * belongs beside the write.
 */
function persistToolCallCitations(
  botName: string,
  question: string,
  result: ResearchKnowledgeResult,
): void {
  persistThreadCitations({
    botName,
    question,
    // MUNINN's `research_knowledge` root span (it adopts the caller's trace id
    // when there is a parent context), NOT huginn's — those live on
    // `subSearches[].traceId`. The column is a UUID and this one is ours.
    traceId: result.traceId,
    hits: result.results.map((hit) => ({
      docId: hit.id,
      collection: hit.collection,
      url: hit.url ?? null,
      title: hit.title ?? null,
      relevance: hit.relevance,
    })),
  });
}

function createMcpServerForBot(entry: BotEntry): McpServer {
  const server = new McpServer(
    { name: `muninn-research-${entry.botName}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.tool(
    "research_knowledge",
    TOOL_DESCRIPTION,
    {
      question: z.string().describe("The user question to research. Multi-part or comparison questions get decomposed automatically."),
      collections: z
        .array(z.string())
        .optional()
        .describe("Optional knowledge collections to scope the search. Omit to search all collections this bot has access to."),
      limit: z
        .number()
        .int()
        .positive()
        .max(20)
        .optional()
        .describe("Per-sub-question result limit (default: huginn's default)."),
    },
    async ({ question, collections, limit }) => {
      try {
        const effectiveCollections = collections && collections.length > 0
          ? collections
          : entry.defaultCollections;

        const result = await researchKnowledge({
          question,
          collections: effectiveCollections,
          limit,
          botName: entry.botName,
          knowledgeApiUrl: entry.knowledgeApiUrl,
          connector: entry.connector,
          haikuBackend: entry.haikuBackend,
        });

        persistToolCallCitations(entry.botName, question, result);

        return {
          content: [{ type: "text" as const, text: formatResearchResultText(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("research_knowledge failed botName={botName} error={error}", { botName: entry.botName, error: message });
        return {
          content: [{ type: "text" as const, text: `research_knowledge failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

export const researchMcpServer = new ResearchMcpServer();
