import type { BotConfig } from "../../bots/config.ts";
import {
  loadMcpConfig,
  connectToServer,
  type ToolInfo,
} from "../../dashboard/mcp-client.ts";
import { getLog } from "../../logging.ts";

const log = getLog("ai", "openai-compat");

export interface OpenAITool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

// Cache: botName → { tools in OpenAI format, tool→server mapping }
const toolCache = new Map<
  string,
  { openaiTools: OpenAITool[]; toolServerMap: Map<string, string> }
>();

export async function loadToolsForBot(
  botConfig: BotConfig,
): Promise<{ openaiTools: OpenAITool[]; toolServerMap: Map<string, string> }> {
  const cached = toolCache.get(botConfig.name);
  if (cached) return cached;

  const mcpConfig = await loadMcpConfig(botConfig.dir);
  if (!mcpConfig?.mcpServers) {
    const empty = { openaiTools: [], toolServerMap: new Map<string, string>() };
    toolCache.set(botConfig.name, empty);
    return empty;
  }

  const openaiTools: OpenAITool[] = [];
  const toolServerMap = new Map<string, string>();

  let failedServers = 0;
  const serverEntries = Object.entries(mcpConfig.mcpServers);

  for (const [serverName, serverConfig] of serverEntries) {
    try {
      const { tools } = await connectToServer(botConfig.name, serverName, serverConfig);
      for (const tool of tools) {
        openaiTools.push(mcpToolToOpenAI(tool));
        toolServerMap.set(tool.name, serverName);
      }
      log.info("Loaded {count} tools from MCP server {server}", {
        botName: botConfig.name,
        count: tools.length,
        server: serverName,
      });
    } catch (e) {
      failedServers++;
      log.warn("Failed to connect to MCP server {server}: {error}", {
        botName: botConfig.name,
        server: serverName,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const result = { openaiTools, toolServerMap };
  // Only cache if all servers connected — failed servers may come online later
  if (failedServers === 0) {
    toolCache.set(botConfig.name, result);
  }
  return result;
}

function mcpToolToOpenAI(tool: ToolInfo): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}
