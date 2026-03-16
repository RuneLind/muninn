import type { WebClient } from "@slack/web-api";
import type { App } from "@slack/bolt";
import type { BotConfig } from "../../bots/config.ts";
import type { SlackMessageHandler } from "./types.ts";
import { resolveSlackUser, makePostToChannel } from "../cache.ts";
import { getActiveThreadId } from "../../db/threads.ts";
import { getLog } from "../../logging.ts";

const log = getLog("slack", "direct-message");

/** Handle a regular DM (not through the Assistant sidebar) */
export async function handleDirectMessage(
  app: App,
  client: WebClient,
  botConfig: BotConfig,
  handleMessage: SlackMessageHandler,
  say: (msg: string) => Promise<any>,
  userId: string,
  text: string,
  channel: string,
): Promise<void> {
  const bn = botConfig.name;
  const userInfo = await resolveSlackUser(app, userId);
  log.info("DM from {username} ({userId}): \"{preview}\"", { botName: bn, username: userInfo.name, userId, preview: text.slice(0, 80) + (text.length > 80 ? "..." : "") });

  const dmThreadId = await getActiveThreadId(userId, botConfig.name);

  // Post a "Thinking..." message, then update it with the real response
  let thinkingTs: string | undefined;
  try {
    const thinkingMsg = await client.chat.postMessage({
      channel,
      text: "_Tenker..._",
    });
    thinkingTs = thinkingMsg.ts ?? undefined;
  } catch { /* ignore */ }

  await handleMessage({
    text,
    userId,
    username: userInfo.name,
    userIdentity: userInfo,
    say: async (msg: string) => {
      if (thinkingTs) {
        // Replace the thinking message with the actual response
        await client.chat.update({ channel, ts: thinkingTs, text: msg });
        thinkingTs = undefined;
      } else {
        await say(msg);
      }
    },
    setStatus: async (status: string) => {
      if (thinkingTs && status) {
        await client.chat.update({ channel, ts: thinkingTs, text: `_${status}_` }).catch(() => {});
      }
    },
    postToChannel: makePostToChannel(client, botConfig.name),
    platform: "slack_dm",
    threadId: dmThreadId,
  });

  // If no response was sent, clean up the thinking message
  if (thinkingTs) {
    try { await client.chat.delete({ channel, ts: thinkingTs }); } catch { /* ignore */ }
  }
}
