import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { BotConfig } from "../../bots/config.ts";
import { type SlackMessageHandler, makeThreadCallbacks } from "./types.ts";
import { resolveSlackUser, makePostToChannel } from "../cache.ts";
import { fetchThreadMessages } from "../message-fetcher.ts";
import { getOrCreateSlackThread } from "../../db/threads.ts";
import { getLog } from "../../logging.ts";

const log = getLog("slack", "thread-follow-up");

/** Handle a follow-up message in a tracked channel thread.
 *  Returns true if the message was handled, false if it should fall through. */
export async function handleThreadFollowUp(
  app: App,
  client: WebClient,
  botConfig: BotConfig,
  handleMessage: SlackMessageHandler,
  isTrackedThread: (channel: string, threadTs: string) => boolean,
  userId: string,
  text: string,
  channel: string,
  threadTs: string,
): Promise<boolean> {
  if (!isTrackedThread(channel, threadTs)) return false;

  const bn = botConfig.name;
  const userInfo = await resolveSlackUser(app, userId);
  // Strip any bot mentions (user might still @mention out of habit)
  const cleanText = text.replaceAll(/<@[A-Z0-9]+>/g, "").trim();
  if (!cleanText) return true; // consumed but nothing to process

  // Resolve channel name for context
  const channelInfo = await client.conversations.info({ channel }).catch(() => null);
  const channelName = channelInfo?.channel?.name ? `#${channelInfo.channel.name}` : channel;

  // Fetch thread messages for context
  const recentChannelMessages = await fetchThreadMessages(app, client, channel, threadTs, bn);

  log.info("Thread follow-up from {username} ({userId}) in {channel}: \"{preview}\"", { botName: bn, username: userInfo.name, userId, channel: channelName, preview: cleanText.slice(0, 80) + (cleanText.length > 80 ? "..." : "") });

  // Resolve Muninn thread for conversation isolation (reuses same thread as the @mention)
  const muninnThreadId = await getOrCreateSlackThread(userId, botConfig.name, channel, threadTs);

  const { say: threadSay, setStatus } = makeThreadCallbacks(client, channel, threadTs);

  // Show native Slack thinking indicator
  await setStatus("tenker...");

  await handleMessage({
    text: cleanText,
    userId,
    username: userInfo.name,
    userIdentity: userInfo,
    say: threadSay,
    setStatus,
    postToChannel: makePostToChannel(client, botConfig.name),
    channelContext: channelName,
    recentChannelMessages,
    platform: "slack_channel",
    threadId: muninnThreadId,
  });

  return true;
}
