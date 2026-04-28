import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Platform } from "../types.ts";
import { resolveConnector } from "../ai/connector.ts";
import { buildPrompt } from "../ai/prompt-builder.ts";
import type { UserIdentity } from "../types.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { saveMessage } from "../db/messages.ts";
import { Tracer } from "../tracing/index.ts";
import { agentStatus, setConnectorInfo, getConnectorLabel } from "../dashboard/agent-status.ts";
import { savePromptSnapshot } from "../db/prompt-snapshots.ts";
import { getToolStatus } from "../ai/tool-status.ts";
import { ensureUser } from "../db/users.ts";
import { getLog } from "../logging.ts";

import { buildProgressCallback } from "./progress-callbacks.ts";
import { runExtractionPipelines } from "./metadata-extractor.ts";
import { slackPostCapability, handleChannelPosts, formatAndSend } from "./response-handler.ts";

// Re-export extractChannelPosts so existing consumers don't break
export { extractChannelPosts } from "./response-handler.ts";

const log = getLog("core", "processor");

export interface ProcessMessageParams {
  text: string;
  userId: string;
  username: string;
  /** Enriched user identity (e.g. from Slack profile). If omitted, username is used. */
  userIdentity?: string | UserIdentity;
  platform: Platform;
  botConfig: BotConfig;
  config: Config;
  /** Send formatted response to the user */
  say: (message: string) => Promise<void>;
  /** Show typing/thinking status (Slack setStatus, etc.) */
  setStatus?: (status: string) => Promise<void>;
  /** Post a message to a named channel (Slack cross-channel posting) */
  postToChannel?: (channel: string, message: string) => Promise<void>;
  /** Channel name/context for the current conversation */
  channelContext?: string;
  /** Recent messages from the channel/thread for context */
  recentChannelMessages?: string[];
  /** Thread ID for conversation isolation */
  threadId?: string;
  /** Callback for streaming text deltas (web chat only). Called with null to clear streaming state (e.g. when tool calls start). */
  onTextDelta?: (delta: string | null) => void;
  /** Callback for AI intent updates (what the model plans to do) */
  onIntent?: (text: string) => void;
  /** Callback for tool status updates (appended as separate lines, not replaced) */
  onToolStatus?: (text: string) => void;
  /** External tracer — if provided, processMessage uses it instead of creating a new one.
   *  The caller is responsible for calling tracer.finish() after processMessage returns. */
  tracer?: Tracer;
  /** When true, skip the inbound `saveMessage(role='user')` write. Caller must
   *  guarantee the triggering message is already persisted (under any role) so
   *  that prompt-builder's history dedup still finds it. */
  skipUserSave?: boolean;
}

export interface ProcessMessageResult {
  responseText: string;
  traceId: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  numTurns: number;
  /** Last turn's input tokens — actual context window usage (vs cumulative inputTokens) */
  contextTokens?: number;
  toolCalls?: { name: string; displayName: string; durationMs: number }[];
}

/**
 * Core message processing pipeline shared by all platforms.
 *
 * Handles: activity log, agent status, tracing, DB saves, prompt building,
 * Claude execution, metadata extraction (memory/goals/schedule),
 * platform-specific formatting, and calling say() with the response.
 */
export async function processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult | undefined> {
  const {
    text, userId, username, userIdentity, platform, botConfig, config,
    say, setStatus, postToChannel, channelContext, recentChannelMessages, threadId,
    onTextDelta, onIntent, onToolStatus,
  } = params;

  const isTelegram = platform.startsWith("telegram");
  const externalTracer = !!params.tracer;
  const t = params.tracer ?? new Tracer(`${platform}_message`, { botName: botConfig.name, userId, username, platform });
  const props = { botName: botConfig.name, userId, username, platform };

  // Ensure user exists in DB (creates on first encounter, updates last_seen_at)
  const displayName = typeof userIdentity === "object" ? userIdentity.displayName : undefined;
  ensureUser({ id: userId, username: username || userId, displayName, platform }).catch((err) => {
    log.warn("Failed to ensure user: {error}", { ...props, error: err instanceof Error ? err.message : String(err) });
  });

  activityLog.push("message_in", text, { userId, username, botName: botConfig.name });
  agentStatus.set("receiving", username);
  const requestId = agentStatus.startRequest(botConfig.name, "receiving", username);
  log.info("Message from {username}: \"{preview}\"", { ...props, preview: text.slice(0, 80) + (text.length > 80 ? "..." : "") });

  // Save user message to DB (skipped for autorespond — caller has already saved as role='peer')
  if (!params.skipUserSave) {
    t.start("db_save_user");
    await saveMessage({ userId, botName: botConfig.name, username, role: "user", content: text, platform, threadId });
    t.end("db_save_user");
  }

  // Build context-aware prompt
  agentStatus.set("building_prompt", username);
  agentStatus.updatePhase("building_prompt");
  t.start("prompt_build");
  const { systemPrompt, userPrompt, meta: promptMeta } = await buildPrompt({
    userId, currentMessage: text, persona: botConfig.persona, botName: botConfig.name,
    restrictedTools: botConfig.restrictedTools, userIdentity: userIdentity ?? username, threadId,
  });
  t.end("prompt_build", promptMeta);

  // Append Slack-specific system prompt additions
  let fullSystemPrompt = systemPrompt;
  if (postToChannel) {
    fullSystemPrompt += slackPostCapability(channelContext);
  }
  if (recentChannelMessages && recentChannelMessages.length > 0) {
    fullSystemPrompt += `\n\n## Channel Context\nRecent messages in the channel/thread (for context):\n${recentChannelMessages.join("\n")}`;
  }

  savePromptSnapshot({ traceId: t.traceId, systemPrompt: fullSystemPrompt, userPrompt }).catch(() => {});
  log.info("Prompt built in {ms}ms ({msgCount} msgs, {memCount} memories)", { ...props, ms: Math.round(t.summary().prompt_build ?? 0), msgCount: promptMeta.messagesCount, memCount: promptMeta.memoriesCount });

  if (setStatus) await setStatus("Thinking...").catch(() => {});

  try {
    agentStatus.set("calling_claude", username);
    agentStatus.updatePhase("calling_claude");
    setConnectorInfo(botConfig, config.claudeModel);
    const connectorLabel = getConnectorLabel(botConfig.connector ?? "claude-cli");
    const effectiveModel = botConfig.model ?? config.claudeModel;
    const effectiveTimeout = botConfig.timeoutMs ?? config.claudeTimeoutMs;
    log.info("Calling {connector} (model: {model}, timeout: {timeout}ms)...", { ...props, connector: connectorLabel, model: effectiveModel, timeout: effectiveTimeout });
    t.start("claude");
    const progressCallback = buildProgressCallback(
      { onTextDelta, onIntent, onToolStatus, setStatus },
      username,
    );
    const result = await resolveConnector(botConfig)(userPrompt, config, botConfig, fullSystemPrompt, progressCallback);
    const toolCount = result.toolCalls?.length ?? 0;
    t.end("claude", {
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      numTurns: result.numTurns,
      startupMs: result.startupMs,
      apiMs: result.durationApiMs,
      costUsd: result.costUsd,
      toolCount,
    });

    // Create child spans for each tool call (positioned at their actual execution time)
    if (result.toolCalls) {
      const captureOutputs = config.tracingCaptureToolOutputs;
      for (const tool of result.toolCalls) {
        const attrs: Record<string, unknown> = {
          toolId: tool.id,
          toolName: tool.name,
          input: tool.input,
          statusText: getToolStatus(tool.name, tool.input),
        };
        if (captureOutputs && tool.output !== undefined) {
          attrs.output = tool.output;
        }
        t.addChildSpan("claude", tool.displayName, tool.durationMs, attrs, tool.startOffsetMs);
      }
    }

    const toolInfo = toolCount > 0 ? `, ${toolCount} tools: ${result.toolCalls!.map(tc => tc.displayName).join(", ")}` : "";
    log.info("Claude responded in {ms}ms ({numTurns} turns{toolInfo})", { ...props, ms: Math.round(t.summary().claude ?? 0), numTurns: result.numTurns, toolInfo });

    // Save assistant response to DB
    agentStatus.set("saving_response", username);
    agentStatus.updatePhase("saving_response");
    t.start("db_save_response");
    const messageId = await saveMessage({
      userId,
      botName: botConfig.name,
      username,
      role: "assistant",
      content: result.result,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      contextTokens: result.contextTokens,
      platform,
      threadId,
      traceId: t.traceId,
    });
    t.end("db_save_response");

    // Extract memories, goals, and schedules async (fire-and-forget)
    // Skip for research/analysis flows (e.g. Jira task analysis) — these are
    // machine-generated prompts, not personal conversations worth extracting from.
    const isResearch = text.includes("<!-- research:");
    if (!isResearch) {
      runExtractionPipelines(
        {
          userId, botName: botConfig.name, botDir: botConfig.dir,
          userMessage: text, assistantResponse: result.result,
          sourceMessageId: messageId, platform,
        },
        config,
        t.context,
      );
    }

    // Handle Slack channel post directives
    let responseText = result.result;
    if (postToChannel) {
      responseText = await handleChannelPosts(responseText, {
        postToChannel,
        botName: botConfig.name,
        userId,
        username,
      });
    }

    // Format and send based on platform
    const sendPhase = isTelegram ? "sending_telegram" : "sending_slack";
    agentStatus.set(sendPhase, username);
    agentStatus.updatePhase(sendPhase);
    t.start("send");

    await formatAndSend({
      responseText,
      platform,
      say,
      tracer: t,
      tokenStats: {
        inputTokens: result.inputTokens,
        contextTokens: result.contextTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        startupMs: result.startupMs,
        apiMs: result.durationApiMs,
        contextWindow: botConfig.contextWindow,
      },
    });

    t.end("send");

    // Push activity with timing metadata
    activityLog.push("message_out", responseText, {
      userId,
      username,
      botName: botConfig.name,
      durationMs: Math.round(t.totalMs()),
      costUsd: result.costUsd,
      metadata: {
        totalMs: t.totalMs(),
        startupMs: result.startupMs,
        apiMs: result.durationApiMs,
        promptBuildMs: t.summary().prompt_build ?? 0,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: result.model,
        numTurns: result.numTurns,
      },
    });

    agentStatus.completeRequest(requestId, {
      traceId: t.traceId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      numTurns: result.numTurns,
      toolCount,
    });
    agentStatus.set("idle");
    if (!externalTracer) {
      t.finish("ok", { inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    }

    // Timing breakdown
    const s = t.summary();
    log.info(
      "Request timing breakdown:\n" +
        `  prompt_build:   ${pad(s.prompt_build)}  (db: ${Math.round(promptMeta.dbHistoryMs)}ms, embed: ${Math.round(promptMeta.embeddingMs)}ms, search: ${Math.round(promptMeta.memorySearchMs)}ms | ${promptMeta.messagesCount} msgs, ${promptMeta.memoriesCount} memories)\n` +
        `  claude:        ${pad(s.claude)}  (startup/mcp: ${Math.round(result.startupMs ?? 0)}ms, api: ${Math.round(result.durationApiMs)}ms, ${result.numTurns} turns, ${fmtTokens(result.inputTokens)} in / ${fmtTokens(result.outputTokens)} out)\n` +
        `  db_save:        ${pad((s.db_save_user ?? 0) + (s.db_save_response ?? 0))}\n` +
        `  format+send:    ${pad(s.send)}\n` +
        `  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n` +
        `  total:         ${pad(t.totalMs())}  ($${(result.costUsd ?? 0).toFixed(4)})`,
      props,
    );

    return {
      responseText,
      traceId: t.traceId,
      durationMs: Math.round(t.totalMs()),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      model: result.model,
      numTurns: result.numTurns,
      contextTokens: result.contextTokens,
      toolCalls: result.toolCalls?.map((tc) => ({ name: tc.name, displayName: tc.displayName, durationMs: tc.durationMs })),
    };
  } catch (error) {
    agentStatus.clearRequest();
    agentStatus.set("idle");
    if (!externalTracer) {
      t.error(error instanceof Error ? error : String(error));
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const s = t.summary();
    const elapsed = Math.round(t.totalMs());
    const lastPhase = Object.entries(s)
      .filter(([, v]) => v != null)
      .map(([k]) => k)
      .pop() ?? "unknown";
    log.error(
      "Request failed after {elapsed}ms (last completed phase: {lastPhase})\n" +
        `  Error: ${errorMessage}\n` +
        `  Phases: ${Object.entries(s).map(([k, v]) => `${k}=${Math.round(v ?? 0)}ms`).join(", ")}`,
      { ...props, elapsed, lastPhase },
    );
    activityLog.push("error", errorMessage, { userId, username, botName: botConfig.name });
    if (isTelegram) {
      const escaped = errorMessage.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      await say(`Something went wrong: ${escaped}`).catch(() => {});
    } else {
      await say(`Something went wrong: ${errorMessage}`).catch(() => {});
    }
    return undefined;
  }
}

function pad(ms: number | undefined): string {
  return `${Math.round(ms ?? 0)}ms`.padEnd(7);
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
