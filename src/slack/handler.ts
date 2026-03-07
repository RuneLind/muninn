import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Platform } from "../types.ts";
import type { UserIdentity } from "../types.ts";
import { processMessage } from "../core/message-processor.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { getRestrictedToolsForUser } from "../ai/tool-restrictions.ts";
import {
  handleTopicCommand,
  handleTopicsCommand,
  handleDelTopicCommand,
} from "../core/topic-commands.ts";
import { getLog } from "../logging.ts";

const log = getLog("bot", "slack");

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
  /** Enriched user identity from Slack profile (name, display name, title) */
  userIdentity?: UserIdentity;
  say: SlackSay;
  setStatus: SlackSetStatus;
  /** If provided, Claude can post messages to Slack channels via <slack-post> directives */
  postToChannel?: PostToChannel;
  /** Channel name/context for the current conversation (e.g. "#general") */
  channelContext?: string;
  /** Recent messages from the channel/thread for context (when responding to @mentions) */
  recentChannelMessages?: string[];
  /** Platform identifier for analytics (e.g. 'slack_dm', 'slack_channel', 'slack_assistant') */
  platform?: Platform;
  /** Thread ID for conversation isolation (resolved by caller) */
  threadId?: string;
}

export function createSlackMessageHandler(config: Config, botConfig: BotConfig) {
  return async ({ text: rawText, userId, username, userIdentity, say, setStatus, postToChannel, channelContext, recentChannelMessages, platform, threadId }: HandleSlackMessageParams) => {
    if (!rawText) return;

    // Convert Slack channel/user references to readable names
    // Slack sends <#C0ADMP9CYG7|channel-name> and <@U12345|username>
    const text = rawText
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
      .replace(/<#([A-Z0-9]+)>/g, "#$1");

    // Auth check
    if (botConfig.slackAllowedUserIds.length > 0 &&
        !botConfig.slackAllowedUserIds.includes(userId)) {
      activityLog.push("error", `Unauthorized Slack access attempt from user ${userId} (@${username})`);
      await say("Unauthorized.");
      return;
    }

    // Intercept topic commands in DMs (same UX as Telegram /topic, /topics, /deltopic)
    if (platform === "slack_dm" || platform === "slack_assistant") {
      const handled = await handleSlackTopicCommand(text, userId, botConfig.name, say);
      if (handled) return;
    }

    // Log tool restrictions for debugging
    if (botConfig.restrictedTools) {
      const denied = getRestrictedToolsForUser(userId, botConfig.restrictedTools);
      if (denied.length > 0) {
        log.info("User {username} ({userId}) has restricted tools: {tools}", { botName: botConfig.name, username, userId, tools: denied.map((d) => d.name).join(", ") });
      }
    }

    await processMessage({
      text,
      userId,
      username,
      userIdentity,
      platform: platform ?? "slack_unknown",
      botConfig,
      config,
      say,
      setStatus,
      postToChannel,
      channelContext,
      recentChannelMessages,
      threadId,
    });
  };
}

/** Check if message is a topic command and handle it. Returns true if consumed.
 *  Matches both `/topic` and `topic` (without slash) since Slack intercepts
 *  slash commands before they reach the bot in regular DMs. */
async function handleSlackTopicCommand(
  text: string, userId: string, botName: string, say: SlackSay,
): Promise<boolean> {
  const trimmed = text.trim();
  const reply = async (msg: string) => { await say(msg); };

  // Normalize: strip leading "/" so both "/topic" and "topic" work
  const cmd = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;

  if (cmd === "topic") {
    await handleTopicCommand(userId, botName, "", reply);
    return true;
  }
  if (cmd === "topics") {
    await handleTopicsCommand(userId, botName, reply);
    return true;
  }
  if (cmd === "deltopic") {
    await handleDelTopicCommand(userId, botName, "", reply);
    return true;
  }
  if (cmd.startsWith("topic ") && !cmd.startsWith("topics")) {
    await handleTopicCommand(userId, botName, cmd.slice("topic ".length).trim(), reply);
    return true;
  }
  if (cmd.startsWith("deltopic ")) {
    await handleDelTopicCommand(userId, botName, cmd.slice("deltopic ".length).trim(), reply);
    return true;
  }

  return false;
}
