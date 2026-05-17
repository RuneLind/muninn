import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  BetaContentBlock,
  BetaTextBlock,
  BetaToolUseBlock,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { ClaudeExecResult } from "../executor.ts";
import {
  abbreviateInput,
  formatToolDisplayName,
  isReportIntentTool,
  extractIntentText,
  type StreamProgressCallback,
} from "../stream-parser.ts";
import { truncateOutput } from "../truncate-output.ts";
import { processMcpToolResult } from "../huginn-trace-pointer.ts";
import { hasHaikuDirectAuth } from "../haiku-direct.ts";
import type { ToolCall } from "../../types.ts";
import { parseMcpConfig } from "./claude-sdk-mcp.ts";
import { preflightMcpForRequest } from "../mcp-status.ts";
import { getLog } from "../../logging.ts";

const log = getLog("ai", "claude-sdk");

interface PendingTool {
  name: string;
  startMs: number;
  input?: string;
}

/**
 * Auth check — the Agent SDK reads ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN
 * from process.env directly (same surface as `haiku-direct.ts`). Throw early so
 * a misconfigured bot fails with a clear message instead of cryptic SDK errors.
 */
export function assertHaveAuth(): void {
  if (hasHaikuDirectAuth()) return;
  throw new Error(
    "claude-sdk: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set — " +
      "run `claude setup-token` or set ANTHROPIC_API_KEY",
  );
}

export async function executePrompt(
  prompt: string,
  config: Config,
  botConfig: BotConfig,
  systemPrompt?: string,
  onProgress?: StreamProgressCallback,
): Promise<ClaudeExecResult> {
  assertHaveAuth();
  const wallStart = performance.now();

  const model = botConfig.model ?? config.claudeModel;
  const timeoutMs = botConfig.timeoutMs ?? config.claudeTimeoutMs;

  const mcpServers = parseMcpConfig(botConfig.dir);
  const hasMcp = Object.keys(mcpServers).length > 0;

  if (hasMcp) {
    await preflightMcpForRequest(botConfig, onProgress);
  }

  const toolCalls: ToolCall[] = [];
  const pendingTools = new Map<string, PendingTool>();

  let resultText = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let lastTurnInputTokens = 0;
  let reportedModel = model;
  let numTurns = 1;
  let durationMs = 0;
  let durationApiMs = 0;
  let costUsd = 0;

  const abortController = new AbortController();
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    log.error("Claude Agent SDK timed out after {timeoutMs}ms", {
      botName: botConfig.name,
      timeoutMs,
    });
    abortController.abort();
  }, timeoutMs);

  const options: Options = {
    abortController,
    cwd: botConfig.dir,
    model,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...(systemPrompt
      ? { systemPrompt }
      : { systemPrompt: { type: "preset", preset: "claude_code" } }),
    settingSources: [],
    ...(hasMcp ? { mcpServers } : {}),
    ...(botConfig.excludedTools?.length ? { disallowedTools: botConfig.excludedTools } : {}),
  };

  const q = query({ prompt, options });

  try {
    for await (const event of q as AsyncGenerator<SDKMessage, void>) {
      handleEvent(event);
    }
  } catch (err) {
    clearTimeout(timeoutTimer);
    if (timedOut) {
      throw new Error(`Claude Agent SDK timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  clearTimeout(timeoutTimer);

  const wallClockMs = performance.now() - wallStart;

  return {
    result: resultText,
    costUsd,
    durationMs: durationMs || Math.round(wallClockMs),
    durationApiMs: durationApiMs || Math.round(wallClockMs),
    wallClockMs,
    numTurns,
    model: reportedModel,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    contextTokens: lastTurnInputTokens || undefined,
    cacheReadTokens: totalCacheReadTokens || undefined,
    cacheCreationTokens: totalCacheCreationTokens || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };

  function handleEvent(event: SDKMessage): void {
    if (event.type === "system" && event.subtype === "init") {
      if (event.model) reportedModel = event.model;
      return;
    }

    if (event.type === "assistant") {
      const msg = event.message;
      if (msg.model) reportedModel = msg.model;
      const usage = msg.usage;
      if (usage) {
        lastTurnInputTokens =
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0);
        onProgress?.({
          type: "usage_progress",
          inputTokens: lastTurnInputTokens,
          outputTokens: totalOutputTokens + (usage.output_tokens ?? 0),
          model: reportedModel,
        });
      }

      const content = msg.content as BetaContentBlock[] | undefined;
      if (!Array.isArray(content)) return;

      let hasToolUse = false;
      for (const block of content) {
        if (block.type === "text") {
          // Last assistant text block is the final answer; intermediate ones
          // get overwritten when the next turn produces text after tool calls.
          resultText = (block as BetaTextBlock).text;
        } else if (block.type === "tool_use") {
          const t = block as BetaToolUseBlock;
          hasToolUse = true;
          const displayName = formatToolDisplayName(t.name);
          const input = abbreviateInput(t.input);
          pendingTools.set(t.id, { name: t.name, startMs: performance.now(), input });
          if (isReportIntentTool(t.name)) {
            const intentText = extractIntentText(t.input);
            if (intentText) onProgress?.({ type: "intent", text: intentText });
          }
          onProgress?.({ type: "tool_start", name: t.name, displayName, input });
        }
      }

      if (!hasToolUse && resultText) {
        onProgress?.({ type: "text" });
      }
      return;
    }

    if (event.type === "user") {
      const content = event.message?.content as BetaToolResultBlockParam[] | string | undefined;
      if (!Array.isArray(content)) return;

      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const pending = pendingTools.get(block.tool_use_id);
        if (!pending) continue;
        const endMs = performance.now();
        const displayName = formatToolDisplayName(pending.name);

        const rawPayload = block.is_error
          ? { error: block.content ?? "tool execution failed" }
          : block.content;
        const processed = processMcpToolResult(rawPayload);
        const truncated = truncateOutput(processed.cleanedText);

        toolCalls.push({
          id: block.tool_use_id,
          name: pending.name,
          displayName,
          durationMs: Math.round(endMs - pending.startMs),
          startOffsetMs: Math.round(pending.startMs - wallStart),
          input: pending.input,
          output: truncated,
          searchTrace: processed.searchTrace,
          searchTracePointer: processed.searchTracePointer,
          searchTraceFetch: processed.searchTraceFetch,
        });
        pendingTools.delete(block.tool_use_id);
        onProgress?.({
          type: "tool_end",
          name: pending.name,
          displayName,
          outputSize: truncated ? truncated.length : undefined,
        });
      }
      return;
    }

    if (event.type === "result") {
      if (event.subtype === "success") {
        if (typeof event.result === "string") resultText = event.result;
      } else {
        // SDKResultError exposes `errors: string[]` — join for a single
        // throwable message, fall back to the subtype tag if empty.
        const errs = event.errors;
        const msg = errs && errs.length > 0 ? errs.join("; ") : event.subtype;
        throw new Error(`Claude Agent SDK error: ${msg}`);
      }
      numTurns = event.num_turns ?? numTurns;
      durationMs = event.duration_ms ?? 0;
      durationApiMs = event.duration_api_ms ?? 0;
      costUsd = event.total_cost_usd ?? 0;
      const usage = event.usage;
      if (usage) {
        totalCacheReadTokens = usage.cache_read_input_tokens ?? 0;
        totalCacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
        totalInputTokens =
          (usage.input_tokens ?? 0) + totalCacheCreationTokens + totalCacheReadTokens;
        totalOutputTokens = usage.output_tokens ?? 0;
      }
      return;
    }
  }
}
