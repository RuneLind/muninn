import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Platform } from "../types.ts";
import { resolveConnector } from "../ai/connector.ts";
import type { UserIdentity } from "../types.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { saveMessage } from "../db/messages.ts";
import { Tracer } from "../tracing/index.ts";
import { agentStatus, setConnectorInfo, getConnectorLabel } from "../dashboard/agent-status.ts";
import { ensureUser } from "../db/users.ts";
import { getLog } from "../logging.ts";

import { buildProgressCallback } from "./progress-callbacks.ts";
import { runExtractionPipelines } from "./metadata-extractor.ts";
import { handleChannelPosts, formatAndSend } from "./response-handler.ts";
import { assemblePrompt } from "./prompt-assembly.ts";
import { attachToolSpans } from "./tool-spans.ts";
import { logRequestTiming } from "./timing-log.ts";
import { handleProcessError } from "./process-error.ts";

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
  /** When true, skip async memory/goal/schedule extraction pipelines. Used by
   *  the web chat "Skip extractions" testing toggle to avoid polluting personal
   *  memory/goals/schedules during dev iteration. */
  skipExtractions?: boolean;
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

  const { fullSystemPrompt, userPrompt, meta: promptMeta } = await assemblePrompt({
    text, userId, username, userIdentity, threadId, botConfig,
    postToChannel, channelContext, recentChannelMessages,
    tracer: t, logProps: props,
  });

  if (setStatus) await setStatus("Thinking...").catch(() => {});

  try {
    agentStatus.set("calling_claude", username);
    agentStatus.updatePhase("calling_claude");
    setConnectorInfo(botConfig, config.claudeModel);
    const connectorType = botConfig.connector ?? "claude-cli";
    const connectorLabel = getConnectorLabel(connectorType);
    const effectiveModel = botConfig.model ?? config.claudeModel;
    const effectiveTimeout = botConfig.timeoutMs ?? config.claudeTimeoutMs;
    log.info("Calling {connector} (model: {model}, timeout: {timeout}ms)...", { ...props, connector: connectorLabel, model: effectiveModel, timeout: effectiveTimeout });
    t.start("claude", { connector: connectorType, requestedModel: effectiveModel });
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

    await attachToolSpans(t, result.toolCalls, !!config.tracingCaptureToolOutputs);

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

    // Skip extractions for research/analysis flows (Jira task analysis etc.) —
    // those are machine-generated prompts, not personal conversations.
    const isResearch = text.includes("<!-- research:");
    if (!isResearch && !params.skipExtractions) {
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

    logRequestTiming({ tracer: t, result, promptMeta, logProps: props });

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
    await handleProcessError({
      error,
      tracer: t,
      externalTracer,
      platform,
      say,
      userId,
      username,
      botName: botConfig.name,
      logProps: props,
    });
    return undefined;
  }
}
