import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { ClaudeExecResult } from "../executor.ts";
import type { StreamProgressCallback } from "../stream-parser.ts";
import { getLog } from "../../logging.ts";

const log = getLog("ai", "openai-compat");

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

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => {
    log.error("OpenAI-compat request timed out after {timeoutMs}ms", {
      botName: botConfig.name,
      timeoutMs,
    });
    controller.abort();
  }, timeoutMs);

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.OPENAI_API_KEY
          ? { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
          : {}),
      },
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
  let resultText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let reportedModel = model;

  // Track tool calls the model tries to make (we can't execute them, but capture the output)
  const pendingToolCalls = new Map<
    number,
    { name: string; arguments: string }
  >();
  let hasToolCalls = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events (delimited by double newlines)
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

          if (chunk.model) {
            reportedModel = chunk.model;
          }

          const delta = chunk.choices?.[0]?.delta;

          // Regular text content
          if (delta?.content) {
            resultText += delta.content;
            onProgress?.({ type: "text_delta", text: delta.content });
          }

          // Qwen3 thinking/reasoning tokens (logged but not included in response)
          if (delta?.reasoning_content) {
            log.debug("Thinking: {text}", {
              botName: botConfig.name,
              text: delta.reasoning_content.slice(0, 200),
            });
          }

          // Tool calls — model wants to call functions but we can't execute them.
          // Capture the generated text so the response isn't empty.
          if (delta?.tool_calls) {
            hasToolCalls = true;
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (tc.function?.name) {
                pendingToolCalls.set(idx, {
                  name: tc.function.name,
                  arguments: tc.function.arguments ?? "",
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

  // If the model generated tool calls instead of text, extract the content
  // so the response isn't empty
  if (hasToolCalls && !resultText.trim()) {
    log.warn(
      "Model generated {count} tool call(s) instead of text — extracting content",
      { botName: botConfig.name, count: pendingToolCalls.size },
    );
    resultText = extractToolCallText(pendingToolCalls);
  }

  const wallClockMs = performance.now() - wallStart;

  log.info(
    "Completed in {durationMs}ms (model: {model}, in: {inputTokens}, out: {outputTokens})",
    {
      botName: botConfig.name,
      durationMs: Math.round(wallClockMs),
      model: reportedModel,
      inputTokens,
      outputTokens,
    },
  );

  return {
    result: resultText,
    costUsd: 0,
    durationMs: Math.round(wallClockMs),
    durationApiMs: Math.round(wallClockMs),
    wallClockMs,
    numTurns: 1,
    model: reportedModel,
    inputTokens,
    outputTokens,
  };
}

/**
 * When the model generates tool_calls instead of text content,
 * extract the arguments as readable text so the response isn't empty.
 * Many local models will generate tool calls even without explicit tool definitions.
 */
function extractToolCallText(
  toolCalls: Map<number, { name: string; arguments: string }>,
): string {
  const parts: string[] = [];
  for (const [, tc] of toolCalls) {
    // Try to extract meaningful text from the arguments JSON
    try {
      const args = JSON.parse(tc.arguments);
      // Common patterns: { content: "..." }, { text: "..." }, { message: "..." }
      const text = args.content ?? args.text ?? args.message ?? args.response;
      if (typeof text === "string") {
        parts.push(text);
        continue;
      }
    } catch {
      // Not valid JSON — use raw arguments if they look like text
      if (tc.arguments && !tc.arguments.startsWith("{")) {
        parts.push(tc.arguments);
        continue;
      }
    }
    // Fallback: show function name + args for debugging
    parts.push(`[tool_call: ${tc.name}(${tc.arguments})]`);
  }
  return parts.join("\n\n");
}
