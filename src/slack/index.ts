import { App, Assistant } from "@slack/bolt";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { createSlackMessageHandler } from "./handler.ts";

import type { WebClient } from "@slack/web-api";
import type { UserIdentity } from "../types.ts";

const USER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const userInfoCache = new Map<string, { identity: UserIdentity; cachedAt: number }>();
const channelIdCache = new Map<string, string>();

async function resolveSlackUser(app: App, userId: string): Promise<UserIdentity> {
  const cached = userInfoCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < USER_CACHE_TTL_MS) return cached.identity;
  try {
    const result = await app.client.users.info({ user: userId });
    const profile = result.user?.profile;
    // Prefer real_name (full name like "Rune Lind") over display_name (often just a handle like "rli")
    const name =
      profile?.real_name?.trim() ||
      result.user?.real_name?.trim() ||
      profile?.display_name?.trim() ||
      result.user?.name?.trim() ||
      userId;
    const displayName = profile?.display_name?.trim() || undefined;
    const title = profile?.title?.trim() || undefined;
    console.debug(`[slack] Resolved user ${userId} → "${name}" (display_name="${displayName}", title="${title}")`);
    const info: UserIdentity = { name, displayName, title };
    userInfoCache.set(userId, { identity: info, cachedAt: Date.now() });
    return info;
  } catch (err) {
    console.warn(`[slack] Failed to resolve username for ${userId} — check users:read scope:`, err);
    return { name: userId };
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
    let cursor: string | undefined = undefined;
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
    console.log(`${tag} postToChannel: channel="${channel}" → resolved="${channelId}", message="${message.slice(0, 100)}..."`);
    const result = await client.chat.postMessage({ channel: channelId, text: message });
    console.log(`${tag} postToChannel: success, ts=${result.ts}, channel=${result.channel}`);
  };
}

export async function createSlackApp(config: Config, botConfig: BotConfig): Promise<App> {
  const tag = `[${botConfig.name}/slack]`;

  // Track threads where the bot has responded — auto-respond without re-tagging
  // Key: "channel:threadTs", Value: last activity timestamp
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

  /** Fetch recent messages from a channel for context */
  async function fetchChannelMessages(client: WebClient, channel: string, limit: number = 15): Promise<string[]> {
    try {
      const result = await client.conversations.history({ channel, limit });
      const messages = (result.messages ?? []).reverse(); // oldest first
      const lines: string[] = [];
      for (const msg of messages) {
        if (!msg.text || msg.bot_id) continue;
        const userInfo = msg.user ? await resolveSlackUser(app, msg.user) : null;
        lines.push(`${userInfo?.name ?? "unknown"}: ${msg.text.slice(0, 300)}`);
      }
      return lines;
    } catch (err) {
      console.warn(`${tag} Failed to fetch channel messages for ${channel}:`, err);
      return [];
    }
  }

  /** Fetch messages from a thread for context */
  async function fetchThreadMessages(client: WebClient, channel: string, threadTs: string, limit: number = 15): Promise<string[]> {
    try {
      const result = await client.conversations.replies({ channel, ts: threadTs, limit });
      const messages = result.messages ?? [];
      const lines: string[] = [];
      for (const msg of messages) {
        if (!msg.text || msg.bot_id) continue;
        const userInfo = msg.user ? await resolveSlackUser(app, msg.user) : null;
        lines.push(`${userInfo?.name ?? "unknown"}: ${msg.text.slice(0, 300)}`);
      }
      return lines;
    } catch (err) {
      console.warn(`${tag} Failed to fetch thread messages for ${channel}:${threadTs}:`, err);
      return [];
    }
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
      const userInfo = await resolveSlackUser(app, userId);

      console.log(`${tag} Assistant message from ${userInfo.name} (${userId}): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

      await handleMessage({
        text,
        userId,
        username: userInfo.name,
        userIdentity: userInfo,
        say: async (msg: string) => { await say(msg); },
        setStatus: async (status: string) => { await setStatus(status); },
        postToChannel: makePostToChannel(app.client, tag),
        platform: "slack_assistant",
      });
    },
  });

  app.assistant(assistant);

  // Handle @mentions in channels — reply in a thread and start tracking it
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

    console.log(`${tag} Channel mention from ${userInfo.name} (${userId}) in ${channelName}: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

    // Fetch recent messages for context
    const recentChannelMessages = event.thread_ts
      ? await fetchThreadMessages(client, event.channel, event.thread_ts)
      : await fetchChannelMessages(client, event.channel);

    // Show native Slack thinking indicator (same as Assistant DM experience)
    try {
      await client.assistant.threads.setStatus({
        channel_id: event.channel,
        thread_ts: threadTs,
        status: "tenker...",
      });
    } catch (err) {
      console.log(`${tag} assistant.threads.setStatus not available:`, err);
    }

    await handleMessage({
      text,
      userId,
      username: userInfo.name,
      userIdentity: userInfo,
      say: async (msg: string) => {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: msg,
        });
      },
      setStatus: async (status: string) => {
        try {
          await client.assistant.threads.setStatus({
            channel_id: event.channel,
            thread_ts: threadTs,
            status,
          });
        } catch { /* ignore */ }
      },
      postToChannel: makePostToChannel(client, tag),
      channelContext: channelName,
      recentChannelMessages,
      platform: "slack_channel",
    });
  });

  // Handle DMs and follow-up messages in tracked threads
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
    if (threadTs && channel && isTrackedThread(channel, threadTs)) {
      const userInfo = await resolveSlackUser(app, userId);
      // Strip any bot mentions (user might still @mention out of habit)
      const cleanText = text.replaceAll(/<@[A-Z0-9]+>/g, "").trim();
      if (!cleanText) return;

      // Resolve channel name for context
      const channelInfo = await client.conversations.info({ channel }).catch(() => null);
      const channelName = channelInfo?.channel?.name ? `#${channelInfo.channel.name}` : channel;

      // Fetch thread messages for context
      const recentChannelMessages = await fetchThreadMessages(client, channel, threadTs);

      console.log(`${tag} Thread follow-up from ${userInfo.name} (${userId}) in ${channelName}: "${cleanText.slice(0, 80)}${cleanText.length > 80 ? "..." : ""}"`);

      // Show native Slack thinking indicator
      try {
        await client.assistant.threads.setStatus({
          channel_id: channel,
          thread_ts: threadTs,
          status: "tenker...",
        });
      } catch { /* ignore — not all threads support assistant status */ }

      await handleMessage({
        text: cleanText,
        userId,
        username: userInfo.name,
        userIdentity: userInfo,
        say: async (msg: string) => {
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: msg,
          });
        },
        setStatus: async (status: string) => {
          try {
            await client.assistant.threads.setStatus({
              channel_id: channel,
              thread_ts: threadTs,
              status,
            });
          } catch { /* ignore */ }
        },
        postToChannel: makePostToChannel(client, tag),
        channelContext: channelName,
        recentChannelMessages,
        platform: "slack_channel",
      });

      return;
    }

    // Skip all non-DM messages that aren't in a tracked thread (no passive channel listening)
    if (!isDM) return;

    // Skip threaded DMs that aren't tracked
    if (threadTs) return;

    const userInfo = await resolveSlackUser(app, userId);
    console.log(`${tag} DM from ${userInfo.name} (${userId}): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

    {
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
        setStatus: async (_status: string) => {},
        postToChannel: makePostToChannel(client, tag),
        platform: "slack_dm",
      });

      // If no response was sent, clean up the thinking message
      if (thinkingTs) {
        try { await client.chat.delete({ channel, ts: thinkingTs }); } catch { /* ignore */ }
      }
    }
  });

  await app.start();
  console.log(`${tag} Slack app started in Socket Mode`);

  return app;
}
