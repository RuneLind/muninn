import { CopilotClient, approveAll, type SessionEvent } from "@github/copilot-sdk";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { ClaudeExecResult } from "../executor.ts";
import type { StreamProgressCallback } from "../stream-parser.ts";
import { formatToolDisplayName } from "../stream-parser.ts";
import { parseMcpConfig } from "./copilot-mcp.ts";
import { getLog } from "../../logging.ts";

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
    const response = await Promise.race([
      session.sendAndWait({ prompt }),
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
