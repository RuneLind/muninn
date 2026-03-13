import type { BotConfig } from "../../bots/config.ts";
import type { StreamProgressCallback } from "../stream-parser.ts";
import { getLog } from "../../logging.ts";

const log = getLog("ai", "openai-compat");

interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamResult {
  resultText: string;
  toolCalls: ParsedToolCall[];
  inputTokens: number;
  outputTokens: number;
  reportedModel: string;
  apiMs: number;
}

export async function doStreamRequest(
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
  // Accumulate reasoning text for inclusion in result
  let reasoningText = "";
  let reasoningStreamStarted = false;
  let reasoningEnded = false;

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
                // When visible content arrives after dedicated reasoning, add separator
                if (reasoningStreamStarted && !reasoningEnded && delta.content.trim()) {
                  reasoningEnded = true;
                  onProgress?.({ type: "text_delta", text: "\n\n---\n\n" });
                }
                onProgress?.({ type: "text_delta", text: delta.content });
              }
            }
            if (insideThink && delta.content.includes("</think>")) {
              insideThink = false;
              const after = delta.content.split("</think>").pop()!;
              if (after) {
                // Separator when transitioning from <think> to visible content after reasoning
                if (reasoningStreamStarted && !reasoningEnded) {
                  reasoningEnded = true;
                  onProgress?.({ type: "text_delta", text: "\n\n---\n\n" });
                }
                onProgress?.({ type: "text_delta", text: after });
              }
            }
          }

          // Reasoning tokens via dedicated field (Ollama: "reasoning", others: "reasoning_content")
          const reasoning = delta?.reasoning ?? delta?.reasoning_content;
          if (reasoning) {
            reasoningText += reasoning;
            // Stream thinking text in real-time so user sees the model's thought process
            if (!reasoningStreamStarted) {
              reasoningStreamStarted = true;
              onProgress?.({ type: "text_delta", text: "*Thinking...*\n\n" });
            }
            onProgress?.({ type: "text_delta", text: reasoning });
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

  let resultText = stripThinkBlocks(rawText);

  // Prepend reasoning as a blockquote — works on all platforms (web, Telegram, Slack)
  if (reasoningText.trim() && resultText.trim()) {
    const thinkingQuoted = reasoningText.trim().split("\n").join("\n> ");
    resultText = `> **Thinking**\n> ${thinkingQuoted}\n\n${resultText}`;
  } else if (reasoningText.trim() && !resultText.trim()) {
    // Model only produced reasoning, no answer — show the thinking as the response
    resultText = reasoningText.trim();
  }

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

export function stripThinkBlocks(text: string): string {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!stripped) {
    return text.replace(/<\/?think>/g, "").trim();
  }
  return stripped;
}
