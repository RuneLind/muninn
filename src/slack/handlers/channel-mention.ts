import type { App } from "@slack/bolt";
import type { BotConfig } from "../../bots/config.ts";
import { type SlackMessageHandler, makeThreadCallbacks } from "./types.ts";
import { resolveSlackUser, makePostToChannel } from "../cache.ts";
import { fetchChannelMessages, fetchThreadMessages } from "../message-fetcher.ts";
import { getOrCreateSlackThread } from "../../db/threads.ts";
import { getLog } from "../../logging.ts";

const log = getLog("slack", "channel-mention");

/** Register the @mention handler on the Slack app */
export function registerChannelMentionHandler(
  app: App,
  botConfig: BotConfig,
  handleMessage: SlackMessageHandler,
  trackThread: (channel: string, threadTs: string) => void,
) {
  const bn = botConfig.name;

  app.event("app_mention", async ({ event, client }) => {
    const userId = event.user ?? "";
    if (!userId) return;
    const userInfo = await resolveSlackUser(app, userId);
    // Strip the bot mention tag(s) like <@U12345> from the text
    const rawText = event.text ?? "";
    const text = rawText.replaceAll(/<@[A-Z0-9]+>/g, "").trim();

    if (!text) return;

    // Reply in the thread where the mention happened
    const threadTs = event.thread_ts ?? event.ts;

    // Track this thread so follow-up messages don't need @mention
    trackThread(event.channel, threadTs);

    // Resolve channel name for context
    const channelInfo = await client.conversations.info({ channel: event.channel }).catch(() => null);
    const channelName = channelInfo?.channel?.name ? `#${channelInfo.channel.name}` : event.channel;

    log.info("Channel mention from {username} ({userId}) in {channel}: \"{preview}\"", { botName: bn, username: userInfo.name, userId, channel: channelName, preview: text.slice(0, 80) + (text.length > 80 ? "..." : "") });

    // Fetch recent messages for context
    const recentChannelMessages = event.thread_ts
      ? await fetchThreadMessages(app, client, event.channel, event.thread_ts, bn)
      : await fetchChannelMessages(app, client, event.channel, bn);

    // Resolve Muninn thread for conversation isolation
    const threadId = await getOrCreateSlackThread(userId, botConfig.name, event.channel, threadTs);

    const { say: threadSay, setStatus } = makeThreadCallbacks(client, event.channel, threadTs);

    // Show native Slack thinking indicator (same as Assistant DM experience)
    await setStatus("tenker...");

    await handleMessage({
      text,
      userId,
      username: userInfo.name,
      userIdentity: userInfo,
      say: threadSay,
      setStatus,
      postToChannel: makePostToChannel(client, botConfig.name),
      channelContext: channelName,
      recentChannelMessages,
      platform: "slack_channel",
      threadId,
    });
  });
}
