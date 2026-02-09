import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { executeClaudePrompt } from "../ai/executor.ts";
import { buildPrompt } from "../ai/prompt-builder.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { saveMessage } from "../db/messages.ts";
import { extractMemoryAsync } from "../memory/extractor.ts";
import { extractGoalAsync } from "../goals/detector.ts";
import { extractScheduleAsync } from "../scheduler/detector.ts";
import { formatSlackMrkdwn } from "./slack-format.ts";
import { Timing } from "../utils/timing.ts";
import { agentStatus } from "../dashboard/agent-status.ts";

interface SlackSay {
  (message: string): Promise<any>;
}

interface SlackSetStatus {
  (status: string): Promise<void>;
}

interface PostToChannel {
  (channel: string, message: string): Promise<void>;
}

interface HandleSlackMessageParams {
  text: string;
  userId: string;
  username: string;
  say: SlackSay;
  setStatus: SlackSetStatus;
  /** If provided, Claude can post messages to Slack channels via <slack-post> directives */
  postToChannel?: PostToChannel;
  /** Channel name/context for the current conversation (e.g. "#general") */
  channelContext?: string;
}

export function createSlackMessageHandler(config: Config, botConfig: BotConfig) {
  const tag = `[${botConfig.name}/slack]`;

  return async ({ text, userId, username, say, setStatus, postToChannel, channelContext }: HandleSlackMessageParams) => {
    if (!text) return;

    // Auth check
    if (botConfig.slackAllowedUserIds.length > 0 && !botConfig.slackAllowedUserIds.includes(userId)) {
      activityLog.push("error", `Unauthorized Slack access attempt from user ${userId} (@${username})`);
      await say("Unauthorized.");
      return;
    }

    const t = new Timing();

    activityLog.push("message_in", text, { userId, username, botName: botConfig.name });
    agentStatus.set("receiving", username);
    console.log(`${tag} Message from ${username}: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

    // Save user message to DB
    t.start("db_save_user");
    await saveMessage({ userId, botName: botConfig.name, username, role: "user", content: text });
    t.end("db_save_user");

    // Build context-aware prompt
    agentStatus.set("building_prompt", username);
    t.start("prompt_build");
    const { systemPrompt, userPrompt, meta: promptMeta } = await buildPrompt(userId, text, botConfig.persona, botConfig.name);
    t.end("prompt_build");

    // Append Slack channel posting capability to system prompt if available
    const fullSystemPrompt = postToChannel
      ? systemPrompt + SLACK_POST_CAPABILITY(channelContext)
      : systemPrompt;
    console.log(`${tag} Prompt built in ${Math.round(t.summary().prompt_build ?? 0)}ms (${promptMeta.messagesCount} msgs, ${promptMeta.memoriesCount} memories)`);

    await setStatus("Thinking...").catch(() => {});

    try {
      agentStatus.set("calling_claude", username);
      const effectiveModel = botConfig.model ?? config.claudeModel;
      const effectiveTimeout = botConfig.timeoutMs ?? config.claudeTimeoutMs;
      console.log(`${tag} Calling Claude (model: ${effectiveModel}, timeout: ${effectiveTimeout}ms)...`);
      t.start("claude");
      const result = await executeClaudePrompt(userPrompt, config, botConfig, fullSystemPrompt);
      t.end("claude");
      console.log(`${tag} Claude responded in ${Math.round(t.summary().claude ?? 0)}ms (${result.numTurns} turns)`);

      // Save assistant response to DB
      agentStatus.set("saving_response", username);
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
      });
      t.end("db_save_response");

      // Extract memories and goals async (don't block response)
      extractMemoryAsync(
        {
          userId,
          botName: botConfig.name,
          userMessage: text,
          assistantResponse: result.result,
          sourceMessageId: messageId,
        },
        config,
      );
      extractGoalAsync(
        {
          userId,
          botName: botConfig.name,
          userMessage: text,
          assistantResponse: result.result,
          sourceMessageId: messageId,
        },
        config,
      );
      extractScheduleAsync(
        {
          userId,
          botName: botConfig.name,
          userMessage: text,
          assistantResponse: result.result,
        },
        config,
      );

      // Extract and execute channel post directives
      let responseText = result.result;
      if (postToChannel) {
        const { cleanText, posts } = extractChannelPosts(responseText);
        for (const post of posts) {
          try {
            console.log(`${tag} Posting to channel ${post.channel}: "${post.message.slice(0, 80)}..."`);
            await postToChannel(post.channel, formatSlackMrkdwn(post.message));
            activityLog.push("slack_channel_post", post.message, {
              userId, username, botName: botConfig.name,
              metadata: { channel: post.channel },
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`${tag} Failed to post to ${post.channel}: ${errMsg}`);
          }
        }
        responseText = cleanText;
      }

      // Convert to Slack mrkdwn
      const mrkdwn = formatSlackMrkdwn(responseText);

      agentStatus.set("sending_slack", username);
      t.start("slack_send");
      if (mrkdwn.trim()) {
        await say(mrkdwn);
      }
      t.end("slack_send");

      // Push activity with timing metadata
      activityLog.push("message_out", result.result, {
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

      agentStatus.set("idle");

      // Console timing breakdown
      const s = t.summary();
      console.log(
        `${tag} Request timing breakdown:\n` +
          `  prompt_build:   ${pad(s.prompt_build)}  (${promptMeta.messagesCount} msgs, ${promptMeta.memoriesCount} memories)\n` +
          `  claude:        ${pad(s.claude)}  (startup/mcp: ${Math.round(result.startupMs)}ms, api: ${Math.round(result.durationApiMs)}ms, ${result.numTurns} turns)\n` +
          `  db_save:        ${pad((s.db_save_user ?? 0) + (s.db_save_response ?? 0))}\n` +
          `  format+send:    ${pad(s.slack_send)}\n` +
          `  ─────────────────────\n` +
          `  total:         ${pad(t.totalMs())}`,
      );
    } catch (error) {
      agentStatus.set("idle");

      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`${tag} Request failed: ${errorMessage}`);
      activityLog.push("error", errorMessage, { userId, username, botName: botConfig.name });
      await say(`Something went wrong: ${errorMessage}`);
    }
  };
}

function pad(ms: number | undefined): string {
  return `${Math.round(ms ?? 0)}ms`.padEnd(7);
}

/** System prompt addition that tells Claude it can post to Slack channels */
function SLACK_POST_CAPABILITY(channelContext?: string): string {
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

/** Parse <slack-post channel="#name">content</slack-post> from Claude's response */
function extractChannelPosts(text: string): { cleanText: string; posts: ChannelPost[] } {
  const posts: ChannelPost[] = [];
  const cleanText = text.replace(
    /<slack-post\s+channel="([^"]+)">([\s\S]*?)<\/slack-post>/g,
    (_match, channel: string, message: string) => {
      posts.push({ channel: channel.trim(), message: message.trim() });
      return "";
    },
  ).trim();
  return { cleanText, posts };
}
