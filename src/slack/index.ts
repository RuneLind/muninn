import { App, Assistant } from "@slack/bolt";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { createSlackMessageHandler } from "./handler.ts";

import type { WebClient } from "@slack/web-api";

const userNameCache = new Map<string, string>();
const channelIdCache = new Map<string, string>();

async function resolveSlackUsername(app: App, userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  try {
    const result = await app.client.users.info({ user: userId });
    const name = result.user?.profile?.display_name
      || result.user?.real_name || result.user?.name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

/** Resolve "#channel-name" to a channel ID, or pass through if already an ID */
async function resolveChannelId(client: WebClient, channelName: string): Promise<string> {
  const name = channelName.replace(/^#/, "");
  const cached = channelIdCache.get(name);
  if (cached) return cached;

  // If it looks like an ID already (starts with C/G), use directly
  if (/^[CG][A-Z0-9]+$/.test(name)) return name;

  try {
    let cursor: string | undefined;
    do {
      const result = await client.conversations.list({ limit: 200, cursor, types: "public_channel,private_channel" });
      for (const ch of result.channels ?? []) {
        if (ch.id && ch.name) channelIdCache.set(ch.name, ch.id);
        if (ch.name === name && ch.id) return ch.id;
      }
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch { /* fall through */ }

  // Fallback: try using the name directly — Slack sometimes accepts it
  return name;
}

/** Create a postToChannel function bound to a Slack client */
function makePostToChannel(client: WebClient, tag: string) {
  return async (channel: string, message: string) => {
    const channelId = await resolveChannelId(client, channel);
    await client.chat.postMessage({ channel: channelId, text: message });
    console.log(`${tag} Posted to channel ${channel} (${channelId})`);
  };
}

export async function createSlackApp(config: Config, botConfig: BotConfig): Promise<App> {
  const tag = `[${botConfig.name}/slack]`;

  // Track threads where the bot has been @mentioned — auto-respond without re-tagging
  // Key: "channel:threadTs", Value: last activity timestamp (for cleanup)
  const activeThreads = new Map<string, number>();
  const THREAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  function trackThread(channel: string, threadTs: string) {
    activeThreads.set(`${channel}:${threadTs}`, Date.now());
    // Prune old threads
    if (activeThreads.size > 500) {
      const cutoff = Date.now() - THREAD_TTL_MS;
      for (const [key, ts] of activeThreads) {
        if (ts < cutoff) activeThreads.delete(key);
      }
    }
  }

  function isTrackedThread(channel: string, threadTs: string): boolean {
    const key = `${channel}:${threadTs}`;
    const ts = activeThreads.get(key);
    if (!ts) return false;
    if (Date.now() - ts > THREAD_TTL_MS) {
      activeThreads.delete(key);
      return false;
    }
    activeThreads.set(key, Date.now()); // refresh TTL
    return true;
  }

  const app = new App({
    token: botConfig.slackBotToken!,
    appToken: botConfig.slackAppToken!,
    socketMode: true,
  });

  const handleMessage = createSlackMessageHandler(config, botConfig);

  const assistant = new Assistant({
    threadStarted: async ({ say, setSuggestedPrompts }) => {
      await say(`Hi! I'm ${botConfig.name}. How can I help you?`);
      await setSuggestedPrompts({
        prompts: [
          { title: "What can you do?", message: "What can you help me with?" },
          { title: "Status", message: "Give me a quick status update" },
        ],
      });
    },

    userMessage: async ({ message, say, setStatus }) => {
      const text = "text" in message ? (message.text ?? "") : "";
      const userId = "user" in message ? (message.user ?? "unknown") : "unknown";
      const username = await resolveSlackUsername(app, userId);

      console.log(`${tag} Assistant message from ${username} (${userId}): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

      await handleMessage({
        text,
        userId,
        username,
        say: async (msg: string) => { await say(msg); },
        setStatus: async (status: string) => { await setStatus(status); },
      });
    },
  });

  app.assistant(assistant);

  // Handle @mentions in channels — reply in a thread and start tracking it
  app.event("app_mention", async ({ event, client }) => {
    const userId = event.user;
    const username = await resolveSlackUsername(app, userId);
    // Strip the bot mention tag(s) like <@U12345> from the text
    const rawText = event.text ?? "";
    const text = rawText.replace(/<@[A-Z0-9]+>/g, "").trim();

    if (!text) return;

    // Reply in the thread where the mention happened
    const threadTs = event.thread_ts ?? event.ts;

    // Track this thread so follow-up messages don't need @mention
    trackThread(event.channel, threadTs);

    // Resolve channel name for context
    const channelInfo = await client.conversations.info({ channel: event.channel }).catch(() => null);
    const channelName = channelInfo?.channel?.name ? `#${channelInfo.channel.name}` : event.channel;

    console.log(`${tag} Channel mention from ${username} (${userId}) in ${channelName}: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

    await handleMessage({
      text,
      userId,
      username,
      say: async (msg: string) => {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: msg,
        });
      },
      setStatus: async (_status: string) => {},
      postToChannel: makePostToChannel(client, tag),
      channelContext: channelName,
    });
  });

  // Handle DMs and follow-up messages in tracked threads
  app.message(async ({ message, say, client }) => {
    // Skip bot messages
    if ("bot_id" in message && message.bot_id) return;
    if ("subtype" in message && message.subtype) return;

    const text = "text" in message ? (message.text ?? "") : "";
    const userId = "user" in message ? (message.user ?? "unknown") : "unknown";
    const channel = "channel" in message ? (message.channel as string) : "";
    const threadTs = "thread_ts" in message ? (message.thread_ts as string) : "";

    if (!text) return;

    // Check if this is a follow-up in a tracked channel thread
    if (threadTs && channel && isTrackedThread(channel, threadTs)) {
      const username = await resolveSlackUsername(app, userId);
      // Strip any bot mentions (user might still @mention out of habit)
      const cleanText = text.replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!cleanText) return;

      // Resolve channel name for context
      const channelInfo = await client.conversations.info({ channel }).catch(() => null);
      const channelName = channelInfo?.channel?.name ? `#${channelInfo.channel.name}` : channel;

      console.log(`${tag} Thread follow-up from ${username} (${userId}) in ${channelName}: "${cleanText.slice(0, 80)}${cleanText.length > 80 ? "..." : ""}"`);

      await handleMessage({
        text: cleanText,
        userId,
        username,
        say: async (msg: string) => {
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: msg,
          });
        },
        setStatus: async (_status: string) => {},
        postToChannel: makePostToChannel(client, tag),
        channelContext: channelName,
      });
      return;
    }

    // Skip threaded messages that aren't tracked (e.g. assistant threads)
    if (threadTs) return;

    // Regular DM
    const username = await resolveSlackUsername(app, userId);

    console.log(`${tag} DM from ${username} (${userId}): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

    await handleMessage({
      text,
      userId,
      username,
      say: async (msg: string) => { await say(msg); },
      setStatus: async (_status: string) => {},
      postToChannel: makePostToChannel(client, tag),
    });
  });

  await app.start();
  console.log(`${tag} Slack app started in Socket Mode`);

  return app;
}
