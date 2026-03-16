import type { Platform } from "../types.ts";
import type { Tracer } from "../tracing/index.ts";
import type { BotConfig } from "../bots/config.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { splitMessage } from "../utils/split-message.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { getLog } from "../logging.ts";

const log = getLog("core", "response-handler");

// ── Slack channel post extraction ──────────────────────────────────────────

interface ChannelPost {
  channel: string;
  message: string;
}

/** System prompt addition that tells Claude it can post to Slack channels */
export function slackPostCapability(channelContext?: string): string {
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

// ── Slack channel posting ──────────────────────────────────────────────────

export interface ChannelPostContext {
  postToChannel: (channel: string, message: string) => Promise<void>;
  botName: string;
  userId: string;
  username: string;
}

/**
 * Extract <slack-post> directives from a response, post each to the target
 * channel, and return the cleaned response text (with directives removed).
 */
export async function handleChannelPosts(
  responseText: string,
  ctx: ChannelPostContext,
): Promise<string> {
  const props = { botName: ctx.botName, userId: ctx.userId, username: ctx.username };
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
      await ctx.postToChannel(post.channel, formatSlackMrkdwn(post.message));
      activityLog.push("slack_channel_post", post.message, {
        userId: ctx.userId, username: ctx.username, botName: ctx.botName,
        metadata: { channel: post.channel },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Failed to post to {channel}: {error}", { ...props, channel: post.channel, error: errMsg });
      failedPosts.push(`${post.channel}: ${errMsg}`);
    }
  }
  let result = cleanText;
  if (failedPosts.length > 0) {
    result += `\n\n_Klarte ikke poste til kanal:_\n${failedPosts.map(f => `• ${f}`).join("\n")}`;
  }
  return result;
}

// ── Platform-specific formatting & sending ─────────────────────────────────

export interface SendResponseParams {
  responseText: string;
  platform: Platform;
  say: (message: string) => Promise<void>;
  tracer: Tracer;
  /** Token stats for the Telegram footer */
  tokenStats?: {
    inputTokens: number;
    contextTokens?: number;
    outputTokens: number;
    costUsd: number;
    startupMs?: number;
    apiMs: number;
    contextWindow?: number;
  };
}

/**
 * Format a response for the target platform and send it via say().
 * Handles Telegram HTML + footer + message splitting, web HTML, and Slack mrkdwn.
 */
export async function formatAndSend(params: SendResponseParams): Promise<void> {
  const { responseText, platform, say, tracer, tokenStats } = params;
  const isTelegram = platform.startsWith("telegram");

  if (isTelegram) {
    const html = formatTelegramHtml(responseText);
    const footer = `\n\n<i>\u23F1 ${tracer.formatTelegram({
      inputTokens: tokenStats?.contextTokens ?? tokenStats?.inputTokens ?? 0,
      outputTokens: tokenStats?.outputTokens ?? 0,
      costUsd: tokenStats?.costUsd ?? 0,
      startupMs: tokenStats?.startupMs,
      apiMs: tokenStats?.apiMs ?? 0,
      contextWindow: tokenStats?.contextWindow,
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
  } else if (platform === "web") {
    const html = formatWebHtml(responseText);
    if (html.trim()) await say(html);
  } else {
    const mrkdwn = formatSlackMrkdwn(responseText);
    if (mrkdwn.trim()) await say(mrkdwn);
  }
}
