import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { ClaudeExecResult } from "../executor.ts";
import type { StreamProgressCallback } from "../stream-parser.ts";
import { formatToolDisplayName } from "../stream-parser.ts";
import {
  loadMcpConfig,
  connectToServer,
  callTool,
  type ToolInfo,
} from "../../dashboard/mcp-client.ts";
import { getLog } from "../../logging.ts";

const log = getLog("ai", "openai-compat");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const MAX_TOOL_TURNS = 10;

// Cache: botName → { tools in OpenAI format, tool→server mapping }
const toolCache = new Map<
  string,
  { openaiTools: OpenAITool[]; toolServerMap: Map<string, string> }
>();

interface OpenAITool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

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
        durationApiMs: Math.round(wallClockMs),
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
    durationApiMs: Math.round(wallClockMs),
    wallClockMs,
    numTurns: turnCount,
    model: reportedModel,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    toolCalls: trackedToolCalls.length > 0 ? trackedToolCalls : undefined,
  };
}

// ── MCP tool loading ─────────────────────────────────────────────

async function loadToolsForBot(
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

  for (const [serverName, serverConfig] of Object.entries(mcpConfig.mcpServers)) {
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
      log.warn("Failed to connect to MCP server {server}: {error}", {
        botName: botConfig.name,
        server: serverName,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const result = { openaiTools, toolServerMap };
  toolCache.set(botConfig.name, result);
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

// ── SSE streaming request ────────────────────────────────────────

interface StreamResult {
  resultText: string;
  toolCalls: ParsedToolCall[];
  inputTokens: number;
  outputTokens: number;
  reportedModel: string;
  apiMs: number;
}

async function doStreamRequest(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
  model: string,
  botConfig: BotConfig,
  onProgress?: StreamProgressCallback,
): Promise<StreamResult> {
  const apiStart = performance.now();

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => {
    log.error("OpenAI-compat request timed out after {timeoutMs}ms", {
      botName: botConfig.name,
      timeoutMs,
    });
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutTimer);
    if (controller.signal.aborted) {
      throw new Error(`OpenAI-compat request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }

  if (!response.ok) {
    clearTimeout(timeoutTimer);
    const errorBody = await response.text();
    throw new Error(
      `OpenAI-compat API error ${response.status}: ${errorBody.slice(0, 500)}`,
    );
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let rawText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let reportedModel = model;

  // Track <think> blocks (Qwen3 thinking tokens in content)
  let insideThink = false;

  // Track tool calls from the model
  const pendingToolCalls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of event.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          if (chunk.model) reportedModel = chunk.model;

          const delta = chunk.choices?.[0]?.delta;

          // Text content — handle <think> blocks from Qwen3
          if (delta?.content) {
            rawText += delta.content;

            if (!insideThink) {
              if (delta.content.includes("<think>")) {
                insideThink = true;
                const before = delta.content.split("<think>")[0];
                if (before) onProgress?.({ type: "text_delta", text: before });
              } else {
                onProgress?.({ type: "text_delta", text: delta.content });
              }
            }
            if (insideThink && delta.content.includes("</think>")) {
              insideThink = false;
              const after = delta.content.split("</think>").pop()!;
              if (after) onProgress?.({ type: "text_delta", text: after });
            }
          }

          // Reasoning tokens via dedicated field (Ollama: "reasoning", others: "reasoning_content")
          const reasoning = delta?.reasoning ?? delta?.reasoning_content;
          if (reasoning) {
            log.debug("Thinking: {text}", {
              botName: botConfig.name,
              text: reasoning.slice(0, 200),
            });
          }

          // Tool calls from the model
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (tc.function?.name || tc.id) {
                const existing = pendingToolCalls.get(idx);
                pendingToolCalls.set(idx, {
                  id: tc.id ?? existing?.id ?? `call_${idx}`,
                  name: tc.function?.name ?? existing?.name ?? "",
                  arguments: (existing?.arguments ?? "") + (tc.function?.arguments ?? ""),
                });
              } else if (tc.function?.arguments) {
                const existing = pendingToolCalls.get(idx);
                if (existing) {
                  existing.arguments += tc.function.arguments;
                }
              }
            }
          }

          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? 0;
            outputTokens = chunk.usage.completion_tokens ?? 0;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
    clearTimeout(timeoutTimer);
  }

  const resultText = stripThinkBlocks(rawText);
  const toolCalls: ParsedToolCall[] = Array.from(pendingToolCalls.values())
    .filter((tc) => tc.name);

  const apiMs = performance.now() - apiStart;

  log.info(
    "Stream completed in {durationMs}ms (model: {model}, in: {inputTokens}, out: {outputTokens}, tools: {toolCount})",
    {
      botName: botConfig.name,
      durationMs: Math.round(apiMs),
      model: reportedModel,
      inputTokens,
      outputTokens,
      toolCount: toolCalls.length,
    },
  );

  return { resultText, toolCalls, inputTokens, outputTokens, reportedModel, apiMs };
}

// ── Helpers ──────────────────────────────────────────────────────

function stripThinkBlocks(text: string): string {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!stripped) {
    return text.replace(/<\/?think>/g, "").trim();
  }
  return stripped;
}
