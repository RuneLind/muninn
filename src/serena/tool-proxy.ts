import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  connectToServer,
  callTool,
  disconnectServer,
} from "../dashboard/mcp-client.ts";
import { getLog } from "../logging.ts";

const log = getLog("serena", "tool-proxy");

/** Default port for the tool proxy (one below first Serena instance) */
export const PROXY_PORT = 9120;

/** Special bot name used for proxy's own MCP client connections */
const PROXY_BOT = "__serena-proxy";

/** A tool discovered from a Serena instance */
interface CatalogEntry {
  name: string;
  description: string;
  /** Compact parameter description for search results */
  paramSummary: string;
  /** Full JSON Schema for reference */
  inputSchema: Record<string, unknown>;
  /** Which Serena servers expose this tool */
  servers: string[];
}

/** A session: one MCP transport + server pair */
interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}

/**
 * MCP proxy server that sits in front of all Serena instances.
 *
 * Exposes 2 tools instead of N×M (N instances × M tools per instance):
 * - search_tools: discover available tools by keyword
 * - call_tool: execute a tool on a specific server
 *
 * Uses stateful sessions — each MCP client gets its own session ID
 * and transport instance.
 */
export class SerenaToolProxy {
  private httpServer: ReturnType<typeof Bun.serve> | null = null;
  private catalog = new Map<string, CatalogEntry>();
  private port: number;
  /** Track which servers are connected */
  private connectedServers = new Set<string>();
  /** Active MCP sessions keyed by session ID */
  private sessions = new Map<string, Session>();

  constructor(port = PROXY_PORT) {
    this.port = port;
  }

  get isRunning(): boolean {
    return this.httpServer !== null;
  }

  get mcpUrl(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  get toolCount(): number {
    return this.catalog.size;
  }

  get serverCount(): number {
    return this.connectedServers.size;
  }

  /**
   * Start the proxy HTTP server.
   */
  async start(): Promise<void> {
    if (this.httpServer) return;

    this.httpServer = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      fetch: (req) => this.handleHttpRequest(req),
    });

    log.info("Tool proxy started on port {port}", { port: this.port });
  }

  /**
   * Stop the proxy and disconnect from all Serena instances.
   */
  async stop(): Promise<void> {
    if (!this.httpServer) return;

    // Disconnect from all Serena instances
    for (const serverName of this.connectedServers) {
      try {
        await disconnectServer(PROXY_BOT, serverName);
      } catch {
        // ignore cleanup errors
      }
    }
    this.connectedServers.clear();
    this.catalog.clear();

    // Close all sessions
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

    log.info("Tool proxy stopped");
  }

  /**
   * Refresh the tool catalog by connecting to all given Serena instances.
   * Called by SerenaManager when instances start/stop.
   */
  async refreshCatalog(
    runningInstances: Array<{ name: string; mcpUrl: string }>,
  ): Promise<void> {
    const newCatalog = new Map<string, CatalogEntry>();
    const newConnected = new Set<string>();

    // Disconnect servers that are no longer running
    for (const serverName of this.connectedServers) {
      if (!runningInstances.some((i) => i.name === serverName)) {
        try {
          await disconnectServer(PROXY_BOT, serverName);
        } catch {
          // ignore
        }
      }
    }

    // Connect to each running instance and discover tools
    for (const inst of runningInstances) {
      try {
        const { tools } = await connectToServer(PROXY_BOT, inst.name, {
          type: "http",
          url: inst.mcpUrl,
        });

        newConnected.add(inst.name);

        for (const tool of tools) {
          const existing = newCatalog.get(tool.name);
          if (existing) {
            // Same tool on multiple servers — just add the server name
            existing.servers.push(inst.name);
          } else {
            newCatalog.set(tool.name, {
              name: tool.name,
              description: tool.description ?? "",
              paramSummary: summarizeParams(tool.inputSchema),
              inputSchema: tool.inputSchema,
              servers: [inst.name],
            });
          }
        }

        log.info("Discovered {count} tools from {server}", {
          count: tools.length,
          server: inst.name,
        });
      } catch (e) {
        log.warn("Failed to discover tools from {server}: {error}", {
          server: inst.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    this.catalog = newCatalog;
    this.connectedServers = newConnected;

    log.info("Tool catalog refreshed: {tools} unique tools across {servers} servers", {
      tools: this.catalog.size,
      servers: this.connectedServers.size,
    });
  }

  // ── HTTP request routing ──────────────────────────────────────

  private async handleHttpRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        tools: this.catalog.size,
        servers: this.connectedServers.size,
        sessions: this.sessions.size,
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    // Route by session ID
    const sessionId = req.headers.get("mcp-session-id");

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return new Response("Session not found", { status: 404 });
      }
      return session.transport.handleRequest(req);
    }

    // No session ID — this should be an initialization request (POST)
    if (req.method === "POST") {
      return this.handleNewSession(req);
    }

    return new Response("Bad request — missing session ID", { status: 400 });
  }

  private async handleNewSession(req: Request): Promise<Response> {
    // Declare server before transport so the onsessioninitialized closure
    // doesn't depend on temporal dead zone timing.
    let server: McpServer;

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, server });
        log.info("New MCP session {session}", { session: id.slice(0, 8) });
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
        log.info("MCP session closed {session}", { session: id.slice(0, 8) });
      },
    });

    // Clean up session when transport closes (client disconnect, etc.)
    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
      }
    };

    server = this.createMcpServer();
    await server.connect(transport);

    return transport.handleRequest(req);
  }

  // ── MCP Server setup ─────────────────────────────────────────

  private createMcpServer(): McpServer {
    const server = new McpServer(
      { name: "serena-tool-proxy", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    server.tool(
      "search_tools",
      "Search for available code analysis tools across all connected Serena code servers. " +
        "Returns tool names, descriptions, parameters, and which servers they're available on. " +
        "Call this first to discover what tools are available, then use call_tool to execute them.",
      { query: z.string().describe("Search query — matches tool names and descriptions (regex supported)") },
      async ({ query }) => this.handleSearchTools(query),
    );

    server.tool(
      "call_tool",
      "Execute a code analysis tool on a specific Serena server. " +
        "Use search_tools first to discover available tools and their parameters.",
      {
        server: z.string().describe("Server name (e.g. serena-api, serena-web, serena-eessi)"),
        tool: z.string().describe("Tool name (e.g. find_symbol, search_for_pattern)"),
        arguments: z.record(z.string(), z.unknown()).describe("Tool arguments as key-value pairs"),
      },
      async ({ server, tool, arguments: args }) => this.handleCallTool(server, tool, args),
    );

    return server;
  }

  private async handleSearchTools(query: string): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    if (this.catalog.size === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No tools available. No Serena code analysis servers are currently running. " +
            "Start them from the Muninn dashboard (/serena).",
        }],
      };
    }

    // Match tools by regex on name + description
    let matches: CatalogEntry[];
    try {
      const re = new RegExp(query, "i");
      matches = Array.from(this.catalog.values()).filter(
        (entry) => re.test(entry.name) || re.test(entry.description),
      );
    } catch {
      // Invalid regex — fall back to substring match
      const q = query.toLowerCase();
      matches = Array.from(this.catalog.values()).filter(
        (entry) =>
          entry.name.toLowerCase().includes(q) ||
          entry.description.toLowerCase().includes(q),
      );
    }

    if (matches.length === 0) {
      // Return all tools as a fallback
      matches = Array.from(this.catalog.values());
    }

    const lines = matches.map((entry) => {
      const servers = entry.servers.join(", ");
      return `**${entry.name}** — ${entry.description}\n  servers: ${servers}\n  params: ${entry.paramSummary}`;
    });

    const header = `Found ${matches.length} tool(s). Use call_tool to execute any of them.\n\n`;
    return {
      content: [{ type: "text" as const, text: header + lines.join("\n\n") }],
    };
  }

  private async handleCallTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    // Validate server is connected
    if (!this.connectedServers.has(serverName)) {
      const available = Array.from(this.connectedServers).join(", ");
      return {
        content: [{
          type: "text" as const,
          text: `Server "${serverName}" is not connected. Available servers: ${available || "none"}`,
        }],
        isError: true,
      };
    }

    // Validate tool exists on this server
    const entry = this.catalog.get(toolName);
    if (!entry) {
      return {
        content: [{
          type: "text" as const,
          text: `Unknown tool "${toolName}". Use search_tools to discover available tools.`,
        }],
        isError: true,
      };
    }
    if (!entry.servers.includes(serverName)) {
      return {
        content: [{
          type: "text" as const,
          text: `Tool "${toolName}" is not available on "${serverName}". Available on: ${entry.servers.join(", ")}`,
        }],
        isError: true,
      };
    }

    try {
      const result = await callTool(PROXY_BOT, serverName, toolName, args) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      // Extract text from MCP CallToolResult to avoid double-wrapping
      const text = result?.content?.map((c) => c.text ?? "").join("\n") || JSON.stringify(result, null, 2);
      return {
        content: [{ type: "text" as const, text }],
        ...(result?.isError && { isError: true }),
      };
    } catch (e) {
      return {
        content: [{
          type: "text" as const,
          text: `Tool call failed: ${e instanceof Error ? e.message : String(e)}`,
        }],
        isError: true,
      };
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────

/** Summarize a JSON Schema's properties into a compact one-liner */
function summarizeParams(schema: Record<string, unknown>): string {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return "none";

  const required = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );

  return Object.entries(props)
    .map(([name, prop]) => {
      const type = prop.type ?? "any";
      const req = required.has(name) ? "required" : "optional";
      const enumVals = Array.isArray(prop.enum) ? `: ${prop.enum.join("|")}` : "";
      return `${name} (${type}, ${req}${enumVals})`;
    })
    .join(", ");
}

/** Singleton proxy instance */
export const serenaToolProxy = new SerenaToolProxy();
