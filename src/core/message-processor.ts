import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Platform } from "../types.ts";
import { executeClaudePrompt } from "../ai/executor.ts";
import { buildPrompt } from "../ai/prompt-builder.ts";
import type { UserIdentity } from "../types.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { saveMessage } from "../db/messages.ts";
import { extractMemoryAsync } from "../memory/extractor.ts";
import { extractGoalAsync } from "../goals/detector.ts";
import { extractScheduleAsync } from "../scheduler/detector.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { splitMessage } from "../utils/split-message.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { Tracer } from "../tracing/index.ts";
import { agentStatus, createProgressCallback } from "../dashboard/agent-status.ts";
import { savePromptSnapshot } from "../db/prompt-snapshots.ts";
import { getLog } from "../logging.ts";

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
}

export interface ProcessMessageResult {
  responseText: string;
  traceId: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
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
    onTextDelta,
  } = params;

  const isTelegram = platform.startsWith("telegram");
  const t = new Tracer(`${platform}_message`, { botName: botConfig.name, userId, username, platform });
  const props = { botName: botConfig.name, userId, username, platform };

  activityLog.push("message_in", text, { userId, username, botName: botConfig.name });
  agentStatus.set("receiving", username);
  const requestId = agentStatus.startRequest(botConfig.name, "receiving", username);
  log.info("Message from {username}: \"{preview}\"", { ...props, preview: text.slice(0, 80) + (text.length > 80 ? "..." : "") });

  // Save user message to DB
  t.start("db_save_user");
  await saveMessage({ userId, botName: botConfig.name, username, role: "user", content: text, platform, threadId });
  t.end("db_save_user");

  // Build context-aware prompt
  agentStatus.set("building_prompt", username);
  agentStatus.updatePhase("building_prompt");
  t.start("prompt_build");
  const { systemPrompt, userPrompt, meta: promptMeta } = await buildPrompt({
    userId, currentMessage: text, persona: botConfig.persona, botName: botConfig.name,
    restrictedTools: botConfig.restrictedTools, userIdentity: userIdentity ?? username,
    knowledgeCollections: botConfig.knowledgeCollections, threadId,
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
    const effectiveModel = botConfig.model ?? config.claudeModel;
    const effectiveTimeout = botConfig.timeoutMs ?? config.claudeTimeoutMs;
    log.info("Calling Claude (model: {model}, timeout: {timeout}ms)...", { ...props, model: effectiveModel, timeout: effectiveTimeout });
    t.start("claude");
    const baseProgress = createProgressCallback("calling_claude", username);
    const progressCallback = onTextDelta
      ? (event: import("../ai/stream-parser.ts").StreamProgressEvent) => {
          if (event.type === "text_delta") {
            onTextDelta(event.text);
          } else {
            // Clear streaming bubble when tools start (text was intermediate)
            if (event.type === "tool_start") onTextDelta(null);
            baseProgress(event);
          }
        }
      : baseProgress;
    const result = await executeClaudePrompt(userPrompt, config, botConfig, fullSystemPrompt, progressCallback);
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
      for (const tool of result.toolCalls) {
        t.addChildSpan("claude", tool.displayName, tool.durationMs, {
          toolId: tool.id,
          toolName: tool.name,
          input: tool.input,
        }, tool.startOffsetMs);
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
      platform,
      threadId,
    });
    t.end("db_save_response");

    // Extract memories, goals, and schedules async (fire-and-forget)
    const traceCtx = t.context;
    extractMemoryAsync(
      { userId, botName: botConfig.name, botDir: botConfig.dir, userMessage: text, assistantResponse: result.result, sourceMessageId: messageId },
      config,
      traceCtx,
    );
    extractGoalAsync(
      { userId, botName: botConfig.name, botDir: botConfig.dir, userMessage: text, assistantResponse: result.result, sourceMessageId: messageId, platform },
      config,
      traceCtx,
    );
    extractScheduleAsync(
      { userId, botName: botConfig.name, botDir: botConfig.dir, userMessage: text, assistantResponse: result.result, platform },
      config,
      traceCtx,
    );

    // Handle Slack channel post directives
    let responseText = result.result;
    if (postToChannel) {
      const { cleanText, posts } = extractChannelPosts(responseText);
      if (posts.length > 0) {
        log.info("extractChannelPosts: found {count} post(s), cleanText length={len}", { ...props, count: posts.length, len: cleanText.length });
      }
      if (posts.length === 0 && responseText.includes("<slack-post")) {
        log.warn("Response contains \"<slack-post\" but no posts were extracted!", props);
      }
      const failedPosts: string[] = [];
      for (const post of posts) {
        try {
          log.info("Posting to channel {channel}: \"{preview}\"", { ...props, channel: post.channel, preview: post.message.slice(0, 80) });
          await postToChannel(post.channel, formatSlackMrkdwn(post.message));
          activityLog.push("slack_channel_post", post.message, {
            userId, username, botName: botConfig.name,
            metadata: { channel: post.channel },
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error("Failed to post to {channel}: {error}", { ...props, channel: post.channel, error: errMsg });
          failedPosts.push(`${post.channel}: ${errMsg}`);
        }
      }
      responseText = cleanText;
      if (failedPosts.length > 0) {
        responseText += `\n\n_Klarte ikke poste til kanal:_\n${failedPosts.map(f => `• ${f}`).join("\n")}`;
      }
    }

    // Format and send based on platform
    const sendPhase = isTelegram ? "sending_telegram" : "sending_slack";
    agentStatus.set(sendPhase, username);
    agentStatus.updatePhase(sendPhase);
    t.start("send");

    if (isTelegram) {
      const html = formatTelegramHtml(responseText);
      const footer = `\n\n<i>\u23F1 ${t.formatTelegram({
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        startupMs: result.startupMs,
        apiMs: result.durationApiMs,
      })}</i>`;
      const total = html.length + footer.length;
      if (total <= 4096) {
        await say(html + footer);
      } else {
        // Split HTML reserving space for footer in last chunk
        const chunks = splitMessage(html, 4096 - footer.length);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = i === chunks.length - 1 ? chunks[i]! + footer : chunks[i]!;
          await say(chunk);
        }
      }
    } else {
      const mrkdwn = formatSlackMrkdwn(responseText);
      if (mrkdwn.trim()) await say(mrkdwn);
    }

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
    t.finish("ok", { inputTokens: result.inputTokens, outputTokens: result.outputTokens });

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
    };
  } catch (error) {
    agentStatus.clearRequest();
    agentStatus.set("idle");
    t.error(error instanceof Error ? error : String(error));

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

/** System prompt addition that tells Claude it can post to Slack channels */
function slackPostCapability(channelContext?: string): string {
  const channelInfo = channelContext
    ? `\nThe current conversation is happening in ${channelContext}.`
    : "";
  return `

## Slack Channel Posting
You can post messages directly to Slack channels using this directive in your response:${channelInfo}

<slack-post channel="#channel-name">
Your message here (supports full Slack mrkdwn formatting)
</slack-post>

Rules:
- Use the channel name with # prefix (e.g. #general, #random, #tech-talk)
- The directive will be extracted from your response and posted as a top-level message in the channel
- Any text outside <slack-post> tags will be sent as your normal reply in the current conversation
- You can include multiple <slack-post> directives for different channels
- Only use this when the user explicitly asks you to post something in a channel`;
}

interface ChannelPost {
  channel: string;
  message: string;
}

/** Parse <slack-post channel="#name">content</slack-post> from Claude's response.
 *  Also handles incomplete tags (missing closing tag, e.g. from interrupted responses). */
export function extractChannelPosts(text: string): { cleanText: string; posts: ChannelPost[] } {
  const posts: ChannelPost[] = [];
  // First pass: complete tags
  let cleanText = text.replace(
    /<slack-post\s+channel="([^"]+)">([\s\S]*?)<\/slack-post>/g,
    (_match, channel: string, message: string) => {
      posts.push({ channel: channel.trim(), message: message.trim() });
      return "";
    },
  );
  // Second pass: incomplete tags (no closing tag — use rest of text as message)
  cleanText = cleanText.replace(
    /<slack-post\s+channel="([^"]+)">([\s\S]*)$/g,
    (_match, channel: string, message: string) => {
      const trimmed = message.trim();
      if (trimmed) {
        posts.push({ channel: channel.trim(), message: trimmed });
      }
      return "";
    },
  );
  return { cleanText: cleanText.trim(), posts };
}
