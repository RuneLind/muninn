import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { join } from "node:path";
import { resolveBotCwd } from "./mcp-config-utils.ts";
import { getLog } from "../logging.ts";

const log = getLog("ai", "mcp");

interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

interface ActiveConnection {
  client: Client;
  transport: Transport;
  tools: ToolInfo[];
  serverName: string;
  botName: string;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

const connections = new Map<string, ActiveConnection>();

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function connectionKey(bot: string, server: string): string {
  return `${bot}:${server}`;
}

export async function loadMcpConfig(botDir: string): Promise<McpConfig | null> {
  const configPath = join(botDir, ".mcp.json");
  const file = Bun.file(configPath);
  if (!(await file.exists())) return null;
  try {
    return JSON.parse(await file.text());
  } catch (e) {
    log.error("Failed to parse .mcp.json at {path}: {error}", {
      path: configPath,
      error: String(e),
    });
    return null;
  }
}

export async function connectToServer(
  botName: string,
  serverName: string,
  serverConfig: McpServerConfig,
  botDir?: string,
): Promise<{ tools: ToolInfo[]; serverInfo?: { name: string; version: string } }> {
  const key = connectionKey(botName, serverName);

  // Reuse existing connection
  const existing = connections.get(key);
  if (existing) {
    return { tools: existing.tools };
  }

  log.info("Connecting to MCP server {server} for bot {bot}", {
    botName,
    server: serverName,
    bot: botName,
  });

  const isRemote = serverConfig.type === "http" || serverConfig.type === "sse";
  let transport: Transport;

  if (isRemote) {
    if (!serverConfig.url) throw new Error(`MCP server ${serverName} has type ${serverConfig.type} but no url`);
    transport = new StreamableHTTPClientTransport(new URL(serverConfig.url));
  } else {
    if (!serverConfig.command) throw new Error(`MCP server ${serverName} has no command`);
    // botDir is optional in this caller (dashboard MCP debug) — fall back to cwd as-is when absent.
    const cwd = botDir ? resolveBotCwd(serverConfig.cwd, botDir) : serverConfig.cwd;
    transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args,
      env: {
        ...process.env,
        // Huginn MCP adapters embed a search trace when this is set. Non-Huginn
        // servers ignore unknown env vars, so it's safe to set unconditionally.
        HUGINN_TRACE_DEFAULT: "1",
        ...serverConfig.env,
      } as Record<string, string>,
      cwd,
      stderr: "pipe",
    });
  }

  const client = new Client(
    { name: "muninn-mcp-debug", version: "1.0.0" },
    { capabilities: {} },
  );

  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "MCP connect");

  const { tools: rawTools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, "MCP listTools");
  const tools: ToolInfo[] = rawTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));

  const serverVersion = client.getServerVersion();

  connections.set(key, { client, transport, tools, serverName, botName });

  log.info("Connected to {server} — {count} tools available", {
    botName,
    server: serverName,
    count: tools.length,
  });

  return {
    tools,
    serverInfo: serverVersion
      ? { name: serverVersion.name, version: serverVersion.version }
      : undefined,
  };
}

export async function callTool(
  botName: string,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const key = connectionKey(botName, serverName);
  const conn = connections.get(key);
  if (!conn) {
    throw new Error(`Not connected to ${serverName} for bot ${botName}`);
  }

  log.info("Calling tool {tool} on {server}", {
    botName,
    tool: toolName,
    server: serverName,
  });

  const result = await withTimeout(
    conn.client.callTool({ name: toolName, arguments: args }),
    CALL_TIMEOUT_MS,
    `Tool call ${toolName}`,
  );
  return result;
}

export async function disconnectServer(botName: string, serverName: string): Promise<void> {
  const key = connectionKey(botName, serverName);
  const conn = connections.get(key);
  if (!conn) return;

  log.info("Disconnecting from {server}", { botName, server: serverName });

  try {
    await conn.client.close();
  } catch (e) {
    log.warn("Error closing MCP client for {server}: {error}", {
      server: serverName,
      error: String(e),
    });
  }

  connections.delete(key);
}

export async function disconnectAll(): Promise<void> {
  for (const [key, conn] of connections) {
    try {
      await conn.client.close();
    } catch {
      // ignore cleanup errors
    }
    connections.delete(key);
  }
}
