import { App, Assistant } from "@slack/bolt";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { createSlackMessageHandler } from "./handler.ts";

import type { WebClient } from "@slack/web-api";
import type { UserIdentity } from "../types.ts";
import { getActiveThreadId, getOrCreateSlackThread } from "../db/threads.ts";
import { getLog } from "../logging.ts";

const log = getLog("bot", "slack");

const USER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CHANNEL_CACHE_SIZE = 500;
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
    log.debug("Resolved user {userId} → \"{name}\" (display_name=\"{displayName}\", title=\"{title}\")", { userId, name, displayName, title });
    const info: UserIdentity = { name, displayName, title };
    userInfoCache.set(userId, { identity: info, cachedAt: Date.now() });
    return info;
  } catch (err) {
    log.warn("Failed to resolve username for {userId} — check users:read scope: {error}", { userId, error: err instanceof Error ? err.message : String(err) });
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
        if (ch.id && ch.name && channelIdCache.size < MAX_CHANNEL_CACHE_SIZE) channelIdCache.set(ch.name, ch.id);
        if (ch.name === name && ch.id) {
          channelIdCache.set(ch.name, ch.id); // Always cache the resolved channel
          return ch.id;
        }
      }
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch { /* fall through */ }

  // Fallback: try using the name directly — Slack sometimes accepts it
  return name;
}

/** Create a postToChannel function bound to a Slack client */
function makePostToChannel(client: WebClient, botName: string) {
  return async (channel: string, message: string) => {
    const channelId = await resolveChannelId(client, channel);
    log.info("postToChannel: channel=\"{channel}\" → resolved=\"{channelId}\", message=\"{preview}\"", { botName, channel, channelId, preview: message.slice(0, 100) });
    const result = await client.chat.postMessage({ channel: channelId, text: message });
    log.info("postToChannel: success, ts={ts}, channel={ch}", { botName, ts: result.ts, ch: result.channel });
  };
}

export async function createSlackApp(config: Config, botConfig: BotConfig): Promise<App> {
  const bn = botConfig.name;

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
      log.warn("Failed to fetch channel messages for {channel}: {error}", { botName: bn, channel, error: err instanceof Error ? err.message : String(err) });
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
      log.warn("Failed to fetch thread messages for {channel}:{threadTs}: {error}", { botName: bn, channel, threadTs, error: err instanceof Error ? err.message : String(err) });
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
    threadStarted: async ({ event, say, setSuggestedPrompts }) => {
      const threadEvent = event as { assistant_thread?: { user_id?: string } };
      const startUserId = threadEvent.assistant_thread?.user_id;
      const userName = startUserId
        ? (await resolveSlackUser(app, startUserId)).name
        : undefined;
      const greeting = userName
        ? `Hi ${userName}! How can I help you?`
        : `Hi! How can I help you?`;
      await say(greeting);
      await setSuggestedPrompts({
        prompts: [
          { title: "What can you help me with?", message: "What can you help me with?" },
          { title: "Search for recent Jira issues about authentication", message: "Search for recent Jira issues about authentication" },
          { title: "Summarize the project architecture", message: "Summarize the project architecture" }
        ],
      });
    },

    userMessage: async ({ message, say, setStatus }) => {
      const text = "text" in message ? (message.text ?? "") : "";
      const userId = "user" in message ? (message.user ?? "unknown") : "unknown";

      // Show thinking indicator immediately (before resolving user, building prompt, etc.)
      await setStatus("Tenker...").catch(() => {});

      const userInfo = await resolveSlackUser(app, userId);

      log.info("Assistant message from {username} ({userId}): \"{preview}\"", { botName: bn, username: userInfo.name, userId, preview: text.slice(0, 80) + (text.length > 80 ? "..." : "") });

      const threadId = await getActiveThreadId(userId, botConfig.name);

      await handleMessage({
        text,
        userId,
        username: userInfo.name,
        userIdentity: userInfo,
        say: async (msg: string) => { await say(msg); },
        setStatus: async (status: string) => { await setStatus(status); },
        postToChannel: makePostToChannel(app.client, botConfig.name),
        platform: "slack_assistant",
        threadId,
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

    log.info("Channel mention from {username} ({userId}) in {channel}: \"{preview}\"", { botName: bn, username: userInfo.name, userId, channel: channelName, preview: text.slice(0, 80) + (text.length > 80 ? "..." : "") });

    // Fetch recent messages for context
    const recentChannelMessages = event.thread_ts
      ? await fetchThreadMessages(client, event.channel, event.thread_ts)
      : await fetchChannelMessages(client, event.channel);

    // Resolve Muninn thread for conversation isolation
    const threadId = await getOrCreateSlackThread(userId, botConfig.name, event.channel, threadTs);

    // Show native Slack thinking indicator (same as Assistant DM experience)
    try {
      await client.assistant.threads.setStatus({
        channel_id: event.channel,
        thread_ts: threadTs,
        status: "tenker...",
      });
    } catch (err) {
      log.warn("assistant.threads.setStatus not available: {error}", { botName: bn, error: err instanceof Error ? err.message : String(err) });
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
      postToChannel: makePostToChannel(client, botConfig.name),
      channelContext: channelName,
      recentChannelMessages,
      platform: "slack_channel",
      threadId,
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

      log.info("Thread follow-up from {username} ({userId}) in {channel}: \"{preview}\"", { botName: bn, username: userInfo.name, userId, channel: channelName, preview: cleanText.slice(0, 80) + (cleanText.length > 80 ? "..." : "") });

      // Resolve Muninn thread for conversation isolation (reuses same thread as the @mention)
      const muninnThreadId = await getOrCreateSlackThread(userId, botConfig.name, channel, threadTs);

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
        postToChannel: makePostToChannel(client, botConfig.name),
        channelContext: channelName,
        recentChannelMessages,
        platform: "slack_channel",
        threadId: muninnThreadId,
      });

      return;
    }

    // Skip all non-DM messages that aren't in a tracked thread (no passive channel listening)
    if (!isDM) return;

    // Skip threaded DMs that aren't tracked
    if (threadTs) return;

    const userInfo = await resolveSlackUser(app, userId);
    log.info("DM from {username} ({userId}): \"{preview}\"", { botName: bn, username: userInfo.name, userId, preview: text.slice(0, 80) + (text.length > 80 ? "..." : "") });

    const dmThreadId = await getActiveThreadId(userId, botConfig.name);

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
  });

  await app.start();
  log.info("Slack app started in Socket Mode", { botName: bn });

  return app;
}
