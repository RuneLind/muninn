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
import { peekActiveTurn } from "../hivemind/active-turn.ts";
import {
  insertResearchCitations,
  type ResearchCitationInsert,
} from "../db/research-citations.ts";

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
 * **Why here and not in a trace.** `research_citations` is written today only by
 * `/research` ask; the chat's tool call writes nothing, and the trace's tool-span
 * outputs are truncated to a `_truncated` head — so after a refinement discussion
 * the hits the conversation actually saw are unrecoverable. That is precisely the
 * signal the Jira composer's thread-sourced draft is built on, which is why the
 * write lives on the tool's own success path rather than in a consumer.
 *
 * `cited` is written FALSE for every row and derived later (the assistant's reply
 * does not exist yet at this point, and there are no `[n]` markers on this path
 * anyway — a chat turn names its sources in prose).
 *
 * **`peekActiveTurn` is per-BOT, not per-user.** Two people chatting the same bot
 * concurrently can have one turn's hits attributed to the other's thread (the
 * LIFO stack's documented race). Accepted for v1: the consequence is a Jira draft
 * seeded with a neighbouring conversation's sources, all of which are visible and
 * toggleable on the page. A per-MCP-session thread binding (`?turn=<token>`) is
 * the fix if this bot ever carries real concurrent traffic.
 *
 * Fire-and-forget in every direction: a DB failure must never turn a successful
 * retrieval into a failed tool result.
 */
function persistThreadCitations(botName: string, question: string, result: ResearchKnowledgeResult): void {
  const rows = threadCitationRows(botName, question, result, peekActiveTurn(botName));
  if (rows.length === 0) return;
  void insertResearchCitations(rows).catch((err) => {
    log.warn("Failed to persist thread citations botName={botName} error={error}", {
      botName,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** The row shaping, split out so it is testable without a DB or a live turn. */
export function threadCitationRows(
  botName: string,
  question: string,
  result: ResearchKnowledgeResult,
  threadId: string | null,
): ResearchCitationInsert[] {
  if (!threadId) return [];
  return result.results.map((hit) => ({
    botName,
    threadId,
    // `result.traceId` is the MUNINN-side `research_knowledge` root span (it
    // adopts the caller's trace id when there is a parent context), NOT huginn's
    // — the huginn ids live on `subSearches[].traceId`. The column is a UUID and
    // this one is ours, so it is safe to store.
    traceId: result.traceId,
    question,
    docId: hit.id,
    collection: hit.collection,
    url: hit.url ?? null,
    title: hit.title ?? null,
    relevance: hit.relevance,
    cited: false,
  }));
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

        persistThreadCitations(entry.botName, question, result);

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
