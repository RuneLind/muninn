import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { ClaudeExecResult } from "../executor.ts";
import type { StreamProgressCallback } from "../stream-parser.ts";
import { abbreviateInput, formatToolDisplayName, isReportIntentTool, extractIntentText } from "../stream-parser.ts";
import type { ToolCall } from "../../types.ts";
import { recordToolSpan } from "./tool-span.ts";
import { callTool } from "../mcp-tool-caller.ts";
import { preflightMcpForRequest } from "../mcp-status.ts";
import { getLog } from "../../logging.ts";
import { doStreamRequest, type StreamResult } from "./openai-compat-stream.ts";
import { loadToolsForBot, type OpenAITool } from "./openai-compat-tools.ts";
import { optionalEnvInt } from "../../config.ts";

const log = getLog("ai", "openai-compat");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const DEFAULT_MAX_TOOL_TURNS = 50;

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

  // Pre-flight: warn if a *critical* MCP server is down (cached probe).
  await preflightMcpForRequest(botConfig, onProgress);

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
  let lastTurnInputTokens = 0;
  let totalApiMs = 0;
  let reportedModel = model;
  let turnCount = 0;
  const trackedToolCalls: ToolCall[] = [];
  const maxToolTurns = optionalEnvInt("OPENAI_COMPAT_MAX_TOOL_TURNS", DEFAULT_MAX_TOOL_TURNS);

  // ── Agent loop: send → tool_calls? → execute → send again ──
  for (let turn = 0; turn < maxToolTurns; turn++) {
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

    lastTurnInputTokens = streamResult!.inputTokens;
    totalInputTokens += lastTurnInputTokens;
    totalOutputTokens += streamResult!.outputTokens;
    totalApiMs += streamResult!.apiMs;
    if (streamResult!.reportedModel !== model) {
      reportedModel = streamResult!.reportedModel;
    }
    onProgress?.({
      type: "usage_progress",
      inputTokens: lastTurnInputTokens,
      outputTokens: totalOutputTokens,
      model: reportedModel || undefined,
    });

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
        contextTokens: lastTurnInputTokens || undefined,
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
      // Align input abbreviation with the SDK connectors: parse the model's raw
      // arguments string into the object form the SDKs pass, then run the shared
      // `abbreviateInput` (stream-parser.ts — the tool-timing seam). Falls back
      // to the raw string on unparseable args (essentially never — the tool
      // executor JSON-parses the same string below).
      const input = abbreviateInput(safeParseArgs(tc.arguments));

      // Surface report_intent calls as inline intent bubbles in chat, in
      // addition to keeping them as a regular tool span in the waterfall.
      if (isReportIntentTool(tc.name)) {
        const intentText = extractIntentText(tc.arguments);
        if (intentText) onProgress?.({ type: "intent", text: intentText });
      }
      onProgress?.({ type: "tool_start", name: tc.name, displayName, input });

      let rawResult: unknown;
      try {
        const serverName = toolServerMap.get(tc.name);
        if (!serverName) {
          rawResult = { error: `Unknown tool: ${tc.name}` };
          log.warn("Model called unknown tool {tool}", {
            botName: botConfig.name,
            tool: tc.name,
          });
        } else {
          const args = JSON.parse(tc.arguments);
          rawResult = await callTool(botConfig.name, serverName, tc.name, args);
        }
      } catch (e) {
        rawResult = { error: e instanceof Error ? e.message : String(e) };
        log.warn("Tool call {tool} failed: {error}", {
          botName: botConfig.name,
          tool: tc.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }

      // Shared completion tail — same span shape + tool_end event as the SDK
      // connectors. `cleanedText` loops back into messages.push below (feeding
      // the inner payload, not the full envelope, saves thousands of tokens per
      // tool call on small-context local models like qwen3).
      const { toolCall, toolEndEvent, cleanedText } = recordToolSpan({
        id: tc.id,
        name: tc.name,
        input,
        rawResult,
        startMs: toolStart,
        endMs: performance.now(),
        wallStart,
      });
      const toolDurationMs = toolCall.durationMs;

      onProgress?.(toolEndEvent);
      trackedToolCalls.push(toolCall);

      // Add tool result to conversation
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: cleanedText,
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
    max: maxToolTurns,
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
    contextTokens: lastTurnInputTokens || undefined,
    toolCalls: trackedToolCalls.length > 0 ? trackedToolCalls : undefined,
  };
}

/**
 * Parse a model's raw tool-arguments JSON string into the object form the SDK
 * connectors hand to `abbreviateInput`. Returns the raw string unchanged if it
 * is not valid JSON, so abbreviation still produces *something* on the rare
 * malformed-args path (the tool executor JSON-parses the same string, so a real
 * tool call practically never reaches here with unparseable args).
 */
function safeParseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
