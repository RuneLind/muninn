import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { ClaudeExecResult } from "../executor.ts";
import type { StreamProgressCallback } from "../stream-parser.ts";
import { formatToolDisplayName } from "../stream-parser.ts";
import { callTool } from "../../dashboard/mcp-client.ts";
import { getLog } from "../../logging.ts";
import { doStreamRequest, type StreamResult } from "./openai-compat-stream.ts";
import { loadToolsForBot, type OpenAITool } from "./openai-compat-tools.ts";

const log = getLog("ai", "openai-compat");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const MAX_TOOL_TURNS = 10;

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

// ── Main entry point ─────────────────────────────────────────────

export async function executePrompt(
  prompt: string,
  config: Config,
  botConfig: BotConfig,
  systemPrompt?: string,
  onProgress?: StreamProgressCallback,
): Promise<ClaudeExecResult> {
  const wallStart = performance.now();
  const model = botConfig.model ?? config.claudeModel;
  const timeoutMs = botConfig.timeoutMs ?? config.claudeTimeoutMs;
  const baseUrl = botConfig.baseUrl;

  if (!baseUrl) {
    throw new Error(
      `openai-compat connector requires "baseUrl" in config.json for bot "${botConfig.name}"`,
    );
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(process.env.OPENAI_API_KEY
      ? { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
      : {}),
  };

  // For thinking models (Qwen3 etc.), max_tokens covers both thinking + answer.
  const maxTokens = botConfig.thinkingMaxTokens && botConfig.thinkingMaxTokens > 0
    ? botConfig.thinkingMaxTokens
    : 8192;

  // Load MCP tools for this bot (cached after first call)
  const { openaiTools, toolServerMap } = await loadToolsForBot(botConfig);

  // Build initial messages
  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  // Tracking
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalApiMs = 0;
  let reportedModel = model;
  let turnCount = 0;
  const trackedToolCalls: Array<{
    id: string;
    name: string;
    displayName: string;
    durationMs: number;
    startOffsetMs: number;
    input?: string;
  }> = [];

  // ── Agent loop: send → tool_calls? → execute → send again ──
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    turnCount++;

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
      ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
    };

    // Retry loop for empty responses from LM Studio
    let streamResult: StreamResult | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      streamResult = await doStreamRequest(
        url, headers, body, timeoutMs, model, botConfig, onProgress,
      );

      const hasContent = streamResult.resultText.trim() || streamResult.toolCalls.length > 0;
      if (hasContent || attempt === MAX_RETRIES) {
        if (attempt > 0 && hasContent) {
          log.info("Succeeded on attempt {attempt}", {
            botName: botConfig.name,
            attempt: attempt + 1,
          });
        }
        break;
      }

      log.warn(
        "Empty response from server (attempt {attempt}/{max}, retrying in {delay}ms)",
        {
          botName: botConfig.name,
          attempt: attempt + 1,
          max: MAX_RETRIES + 1,
          delay: RETRY_DELAY_MS,
        },
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    totalInputTokens += streamResult!.inputTokens;
    totalOutputTokens += streamResult!.outputTokens;
    totalApiMs += streamResult!.apiMs;
    if (streamResult!.reportedModel !== model) {
      reportedModel = streamResult!.reportedModel;
    }

    // No tool calls → we have the final answer
    if (streamResult!.toolCalls.length === 0) {
      const wallClockMs = performance.now() - wallStart;
      log.info(
        "Completed in {durationMs}ms ({turns} turns, model: {model}, in: {inputTokens}, out: {outputTokens})",
        {
          botName: botConfig.name,
          durationMs: Math.round(wallClockMs),
          turns: turnCount,
          model: reportedModel,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        },
      );

      return {
        result: streamResult!.resultText,
        costUsd: 0,
        durationMs: Math.round(wallClockMs),
        durationApiMs: Math.round(totalApiMs),
        wallClockMs,
        numTurns: turnCount,
        model: reportedModel,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        toolCalls: trackedToolCalls.length > 0 ? trackedToolCalls : undefined,
      };
    }

    // Model wants to call tools — add assistant message with tool_calls
    messages.push({
      role: "assistant",
      content: streamResult!.resultText || null,
      tool_calls: streamResult!.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Execute each tool call against MCP servers
    for (const tc of streamResult!.toolCalls) {
      const toolStart = performance.now();
      const displayName = formatToolDisplayName(tc.name);
      const inputPreview = tc.arguments.length > 500
        ? tc.arguments.slice(0, 500) + "…"
        : tc.arguments;

      onProgress?.({ type: "tool_start", name: tc.name, displayName, input: inputPreview });

      let toolResult: string;
      try {
        const serverName = toolServerMap.get(tc.name);
        if (!serverName) {
          toolResult = JSON.stringify({ error: `Unknown tool: ${tc.name}` });
          log.warn("Model called unknown tool {tool}", {
            botName: botConfig.name,
            tool: tc.name,
          });
        } else {
          const args = JSON.parse(tc.arguments);
          const result = await callTool(botConfig.name, serverName, tc.name, args);
          toolResult = typeof result === "string" ? result : JSON.stringify(result);
        }
      } catch (e) {
        toolResult = JSON.stringify({
          error: e instanceof Error ? e.message : String(e),
        });
        log.warn("Tool call {tool} failed: {error}", {
          botName: botConfig.name,
          tool: tc.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }

      const toolDurationMs = Math.round(performance.now() - toolStart);
      onProgress?.({ type: "tool_end", name: tc.name, displayName });

      trackedToolCalls.push({
        id: tc.id,
        name: tc.name,
        displayName,
        durationMs: toolDurationMs,
        startOffsetMs: Math.round(toolStart - wallStart),
        input: inputPreview,
      });

      // Add tool result to conversation
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: toolResult,
      });

      log.info("Tool {tool} completed in {ms}ms", {
        botName: botConfig.name,
        tool: tc.name,
        ms: toolDurationMs,
      });
    }
  }

  // Exceeded max turns — return what we have
  log.warn("Exceeded max tool turns ({max})", {
    botName: botConfig.name,
    max: MAX_TOOL_TURNS,
  });
  const wallClockMs = performance.now() - wallStart;
  return {
    result: "(Exceeded maximum tool call turns)",
    costUsd: 0,
    durationMs: Math.round(wallClockMs),
    durationApiMs: Math.round(totalApiMs),
    wallClockMs,
    numTurns: turnCount,
    model: reportedModel,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    toolCalls: trackedToolCalls.length > 0 ? trackedToolCalls : undefined,
  };
}
