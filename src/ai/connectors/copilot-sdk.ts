import { CopilotClient, approveAll, type SessionEvent, type CustomAgentConfig } from "@github/copilot-sdk";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { ClaudeExecResult } from "../executor.ts";
import type { StreamProgressCallback } from "../stream-parser.ts";
import { formatToolDisplayName } from "../stream-parser.ts";
import { parseMcpConfig } from "./copilot-mcp.ts";
import { getLog } from "../../logging.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const log = getLog("ai", "copilot-sdk");

// Shared client — started once, stopped on process exit
let client: CopilotClient | null = null;
let clientStarting: Promise<void> | null = null;

async function getClient(): Promise<CopilotClient> {
  if (client) return client;

  if (!clientStarting) {
    clientStarting = (async () => {
      try {
        log.info("Starting Copilot SDK client");
        client = new CopilotClient({ logLevel: "warning" });
        await client.start();

        // Cleanup on process exit
        const cleanup = () => {
          client?.stop().catch(() => {});
          client = null;
          clientStarting = null;
        };
        process.on("beforeExit", cleanup);
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);

        log.info("Copilot SDK client started");
      } catch (e) {
        // Reset so next call can retry startup
        client = null;
        clientStarting = null;
        throw e;
      }
    })();
  }

  await clientStarting;
  return client!;
}

export async function executePrompt(
  prompt: string,
  config: Config,
  botConfig: BotConfig,
  systemPrompt?: string,
  onProgress?: StreamProgressCallback,
): Promise<ClaudeExecResult> {
  const wallStart = performance.now();
  const cl = await getClient();

  const model = botConfig.model ?? config.claudeModel;
  const timeoutMs = botConfig.timeoutMs ?? config.claudeTimeoutMs;

  // Parse .mcp.json for this bot
  const mcpServers = parseMcpConfig(botConfig.dir);
  const hasMcp = Object.keys(mcpServers).length > 0;

  // Build custom subagents (e.g. verify-code for grep/diff verification)
  const customAgents = buildCustomAgents(botConfig);

  // Create session per request (system prompt is dynamic — memories, goals, history change per message)
  const session = await cl.createSession({
    model,
    streaming: true,
    workingDirectory: botConfig.dir,
    systemMessage: systemPrompt
      ? { mode: "replace", content: systemPrompt }
      : undefined,
    onPermissionRequest: approveAll,
    ...(hasMcp ? { mcpServers } : {}),
    ...(customAgents.length > 0 ? { customAgents } : {}),
  });

  // Track tool calls for waterfall
  const toolCalls: Array<{
    id: string;
    name: string;
    displayName: string;
    durationMs: number;
    startOffsetMs: number;
    input?: string;
  }> = [];
  const pendingTools = new Map<string, { name: string; startMs: number; input?: string }>();

  // Track usage from assistant.usage events
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let reportedModel = model;
  let turnCount = 0;

  // Wire up streaming events
  const unsubscribe = session.on((event: SessionEvent) => {
    switch (event.type) {
      case "assistant.message_delta":
        onProgress?.({ type: "text_delta", text: event.data.deltaContent });
        break;

      case "assistant.turn_start":
        turnCount++;
        break;

      case "assistant.intent":
        onProgress?.({ type: "intent", text: event.data.intent });
        break;

      case "tool.execution_start": {
        const name = event.data.toolName;
        // Emit intent event from report_intent tool (in addition to waterfall entry)
        if (name === "report_intent") {
          const intentText = extractIntentText(event.data.arguments);
          if (intentText) onProgress?.({ type: "intent", text: intentText });
        }
        const displayName = formatToolDisplayName(name);
        const startMs = performance.now();
        const input = abbreviateInput(event.data.arguments);
        pendingTools.set(event.data.toolCallId, { name, startMs, input });
        onProgress?.({ type: "tool_start", name, displayName, input });
        break;
      }

      case "tool.execution_complete": {
        const pending = pendingTools.get(event.data.toolCallId);
        if (pending) {
          const endMs = performance.now();
          const displayName = formatToolDisplayName(pending.name);
          toolCalls.push({
            id: event.data.toolCallId,
            name: pending.name,
            displayName,
            durationMs: Math.round(endMs - pending.startMs),
            startOffsetMs: Math.round(pending.startMs - wallStart),
            input: pending.input,
          });
          pendingTools.delete(event.data.toolCallId);
          onProgress?.({ type: "tool_end", name: pending.name, displayName });
        }
        break;
      }

      case "assistant.usage":
        totalInputTokens += event.data.inputTokens ?? 0;
        totalOutputTokens += event.data.outputTokens ?? 0;
        if (event.data.model) reportedModel = event.data.model;
        break;

      case "subagent.started":
        log.info("Subagent started: {agent} ({description})", {
          botName: botConfig.name,
          agent: event.data.agentDisplayName,
          description: event.data.agentDescription,
        });
        onProgress?.({ type: "intent", text: `🔍 ${event.data.agentDisplayName}: ${event.data.agentDescription}` });
        // Track as a tool call for waterfall
        pendingTools.set(event.data.toolCallId, {
          name: `Agent:${event.data.agentName}`,
          startMs: performance.now(),
          input: event.data.agentDescription,
        });
        break;

      case "subagent.completed": {
        const pendingSub = pendingTools.get(event.data.toolCallId);
        if (pendingSub) {
          const endMs = performance.now();
          toolCalls.push({
            id: event.data.toolCallId,
            name: pendingSub.name,
            displayName: event.data.agentDisplayName,
            durationMs: Math.round(endMs - pendingSub.startMs),
            startOffsetMs: Math.round(pendingSub.startMs - wallStart),
            input: pendingSub.input,
          });
          pendingTools.delete(event.data.toolCallId);
        }
        log.info("Subagent completed: {agent}", {
          botName: botConfig.name,
          agent: event.data.agentDisplayName,
        });
        break;
      }

      case "subagent.failed":
        log.error("Subagent failed: {agent} — {error}", {
          botName: botConfig.name,
          agent: event.data.agentDisplayName,
          error: event.data.error,
        });
        pendingTools.delete(event.data.toolCallId);
        break;
    }
  });

  // Send with timeout
  let timeoutTimer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      log.error("Copilot SDK timed out after {timeoutMs}ms", { botName: botConfig.name, timeoutMs });
      session.abort().catch(() => {});
      reject(new Error(`Copilot SDK timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    // SDK timeout is longer so our manual timeout fires first (with session.abort + error).
    // The SDK timeout is a safety net for internal cleanup if our timeout somehow fails.
    const response = await Promise.race([
      session.sendAndWait({ prompt }, timeoutMs + 5000),
      timeoutPromise,
    ]);
    clearTimeout(timeoutTimer!);

    const wallClockMs = performance.now() - wallStart;
    const content = response?.data?.content ?? "";

    return {
      result: content,
      costUsd: 0, // Copilot SDK doesn't report cost (subscription model)
      durationMs: Math.round(wallClockMs),
      durationApiMs: Math.round(wallClockMs),
      wallClockMs,
      numTurns: Math.max(1, turnCount),
      model: reportedModel,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  } catch (error) {
    clearTimeout(timeoutTimer!);
    throw error;
  } finally {
    unsubscribe();
    session.destroy().catch((e) => {
      log.warn("Failed to destroy Copilot SDK session: {error}", { error: String(e) });
    });
  }
}

/**
 * Build custom subagents from the bot's serena config.
 * Creates a "verify-code" agent with grep/diff/read tools for verifying
 * claims that Serena alone can't verify (reference-following, file diffing).
 */
function buildCustomAgents(botConfig: BotConfig): CustomAgentConfig[] {
  const configPath = join(botConfig.dir, "config.json");
  let projectPaths = "";
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    if (Array.isArray(raw.serena)) {
      projectPaths = raw.serena
        .filter((s: { projectPath?: string; displayName?: string }) => s.projectPath && s.displayName)
        .map((s: { displayName: string; projectPath: string }) => `- **${s.displayName}**: \`${s.projectPath}\``)
        .join("\n");
    }
  } catch {
    // No config.json or no serena entries
  }

  if (!projectPaths) return [];

  return [{
    name: "verify-code",
    displayName: "Code Verifier",
    description: "Verify claims about code by grepping for usages, diffing files, and following reference chains. Use this when you need to confirm that a function is actually called from a specific context, compare similar files for differences, or trace call chains.",
    prompt: `You are a code verification agent. Your job is to verify specific claims about code using grep, diff, and file reading. You complement Serena-based code navigation with low-level verification tools.

Available codebases:
${projectPaths}

## Approach
1. **Follow references** — grep for all usages to verify a function is actually called from the claimed context
2. **Diff similar files** — compare files side-by-side to find differences (use \`diff\` or read both and compare)
3. **Verify call chains** — trace actual import/call chains, don't assume from function names alone
4. **Check for inconsistencies** — look for subtle text differences between similar constructs

## Rules
- Use absolute paths
- Be concise — report verified facts, not process descriptions
- If a claim is wrong, state what is actually true
- Use Grep and Bash tools for searching across codebases
- Read files to verify specific details`,
    mcpServers: {}, // No MCP tools — use built-in tools only (Bash, Grep, Read, Glob)
  }];
}

function extractIntentText(args: unknown): string | undefined {
  if (args == null || typeof args !== "object") return undefined;
  const obj = args as Record<string, unknown>;
  // report_intent typically has an "intent" or "description" field
  const text = obj.intent ?? obj.description ?? obj.text;
  return typeof text === "string" ? text : undefined;
}

function abbreviateInput(args: unknown): string | undefined {
  if (args == null) return undefined;
  const json = JSON.stringify(args);
  return json.length > 500 ? json.slice(0, 500) + "…" : json;
}
