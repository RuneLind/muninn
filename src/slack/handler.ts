import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Platform } from "../types.ts";
import type { UserIdentity } from "../types.ts";
import { processMessage } from "../core/message-processor.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { getRestrictedToolsForUser } from "../ai/tool-restrictions.ts";
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
}

export function createSlackMessageHandler(config: Config, botConfig: BotConfig) {
  return async ({ text: rawText, userId, username, userIdentity, say, setStatus, postToChannel, channelContext, recentChannelMessages, platform }: HandleSlackMessageParams) => {
    if (!rawText) return;

    // Convert Slack channel/user references to readable names
    // Slack sends <#C0ADMP9CYG7|heidrun-agent-testing> and <@U12345|username>
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
    });
  };
}
