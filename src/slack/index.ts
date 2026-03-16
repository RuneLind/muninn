import { App } from "@slack/bolt";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { createSlackMessageHandler } from "./handler.ts";
import { createAssistantHandler } from "./handlers/assistant-dm.ts";
import { registerChannelMentionHandler } from "./handlers/channel-mention.ts";
import { handleThreadFollowUp } from "./handlers/thread-follow-up.ts";
import { handleDirectMessage } from "./handlers/direct-message.ts";
import { createThreadTracker } from "./thread-tracker.ts";
import { getLog } from "../logging.ts";

const log = getLog("bot", "slack");

export async function createSlackApp(config: Config, botConfig: BotConfig): Promise<App> {
  const bn = botConfig.name;

  const { trackThread, isTrackedThread } = createThreadTracker();

  const app = new App({
    token: botConfig.slackBotToken!,
    appToken: botConfig.slackAppToken!,
    socketMode: true,
  });

  const handleMessage = createSlackMessageHandler(config, botConfig);

  // 1. Assistant DM handler (Slack sidebar)
  const assistant = createAssistantHandler(app, botConfig, handleMessage);
  app.assistant(assistant);

  // 2. @mention handler in channels
  registerChannelMentionHandler(app, botConfig, handleMessage, trackThread);

  // 3. Handle DMs and follow-up messages in tracked threads
  app.message(async ({ message, say, client }) => {
    // Skip bot messages
    if ("bot_id" in message && message.bot_id) return;
    if ("subtype" in message && message.subtype) return;

    const text = "text" in message ? (message.text ?? "") : "";
    const userId = "user" in message ? (message.user ?? "unknown") : "unknown";
    const channel = "channel" in message ? message.channel : "";
    const threadTs = "thread_ts" in message ? (message.thread_ts as string) : "";
    const isDM = channel.startsWith("D");

    if (!text) return;

    // Check if this is a follow-up in a tracked channel thread
    if (threadTs && channel) {
      const handled = await handleThreadFollowUp(
        app, client, botConfig, handleMessage, isTrackedThread,
        userId, text, channel, threadTs,
      );
      if (handled) return;
    }

    // Skip all non-DM messages that aren't in a tracked thread (no passive channel listening)
    if (!isDM) return;

    // Skip threaded DMs that aren't tracked
    if (threadTs) return;

    // 4. Regular DM handler
    await handleDirectMessage(app, client, botConfig, handleMessage, say, userId, text, channel);
  });

  await app.start();
  log.info("Slack app started in Socket Mode", { botName: bn });

  return app;
}
