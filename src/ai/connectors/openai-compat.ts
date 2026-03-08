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
          if (delta?.content) {
            resultText += delta.content;
            onProgress?.({ type: "text_delta", text: delta.content });
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
