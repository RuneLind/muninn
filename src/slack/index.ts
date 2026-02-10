import { App, Assistant } from "@slack/bolt";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { createSlackMessageHandler } from "./handler.ts";
import { RelevanceFilter } from "./relevance-filter.ts";

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
  // Key: "channel:threadTs", Value: { ts: last activity, origin: how thread started }
  interface TrackedThread { ts: number; origin: "mention" | "channel_listen"; }
  const activeThreads = new Map<string, TrackedThread>();
  const THREAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  function trackThread(channel: string, threadTs: string, origin: "mention" | "channel_listen" = "mention") {
    activeThreads.set(`${channel}:${threadTs}`, { ts: Date.now(), origin });
    // Prune old threads
    if (activeThreads.size > 500) {
      const cutoff = Date.now() - THREAD_TTL_MS;
      for (const [key, t] of activeThreads) {
        if (t.ts < cutoff) activeThreads.delete(key);
      }
    }
  }

  function getTrackedThread(channel: string, threadTs: string): TrackedThread | null {
    const key = `${channel}:${threadTs}`;
    const t = activeThreads.get(key);
    if (!t) return null;
    if (Date.now() - t.ts > THREAD_TTL_MS) {
      activeThreads.delete(key);
      return null;
    }
    activeThreads.set(key, { ...t, ts: Date.now() }); // refresh TTL
    return t;
  }

  const relevanceFilter = new RelevanceFilter(botConfig);
  const contextMessageCount = botConfig.channelListening?.contextMessages ?? 10;

  /** Fetch recent messages from a channel for context */
  async function fetchRecentMessages(client: WebClient, channel: string, limit: number): Promise<string[]> {
    try {
      const result = await client.conversations.history({ channel, limit });
      const messages = (result.messages ?? []).reverse(); // oldest first
      const lines: string[] = [];
      for (const msg of messages) {
        if (!msg.text || msg.bot_id) continue;
        const user = msg.user ? await resolveSlackUsername(app, msg.user) : "unknown";
        lines.push(`${user}: ${msg.text.slice(0, 300)}`);
      }
      return lines;
    } catch (err) {
      console.warn(`${tag} Failed to fetch recent messages for ${channel}:`, err);
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
      const username = await resolveSlackUsername(app, userId);

      console.log(`${tag} Assistant message from ${username} (${userId}): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

      await handleMessage({
        text,
        userId,
        username,
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
    const username = await resolveSlackUsername(app, userId);
    // Strip the bot mention tag(s) like <@U12345> from the text
    const rawText = event.text ?? "";
    const text = rawText.replaceAll(/<@[A-Z0-9]+>/g, "").trim();

    if (!text) return;

    // Activate channel for passive listening when bot is @mentioned
    if (botConfig.channelListening?.enabled) {
      relevanceFilter.activateChannel(event.channel);
      console.log(`${tag} Channel ${event.channel} activated for passive listening`);
    }

    // Reply in the thread where the mention happened
    const threadTs = event.thread_ts ?? event.ts;

    // Track this thread so follow-up messages don't need @mention
    trackThread(event.channel, threadTs);

    // Resolve channel name for context
    const channelInfo = await client.conversations.info({ channel: event.channel }).catch(() => null);
    const channelName = channelInfo?.channel?.name ? `#${channelInfo.channel.name}` : event.channel;

    console.log(`${tag} Channel mention from ${username} (${userId}) in ${channelName}: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

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
      username,
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
    const tracked = threadTs && channel ? getTrackedThread(channel, threadTs) : null;
    if (tracked) {
      const username = await resolveSlackUsername(app, userId);
      // Strip any bot mentions (user might still @mention out of habit)
      const cleanText = text.replaceAll(/<@[A-Z0-9]+>/g, "").trim();
      if (!cleanText) return;

      // Resolve channel name for context
      const channelInfo = await client.conversations.info({ channel }).catch(() => null);
      const channelName = channelInfo?.channel?.name ? `#${channelInfo.channel.name}` : channel;

      // Inherit platform from thread origin — channel_listen threads bypass auth
      const threadPlatform = tracked.origin === "channel_listen" ? "slack_channel_listen" : "slack_channel";

      console.log(`${tag} Thread follow-up from ${username} (${userId}) in ${channelName} (origin: ${tracked.origin}): "${cleanText.slice(0, 80)}${cleanText.length > 80 ? "..." : ""}"`);

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
        username,
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
        platform: threadPlatform,
      });

      return;
    }

    // Skip threaded messages that aren't tracked (e.g. assistant threads)
    if (threadTs) return;

    // Regular DM or standalone channel message
    const username = await resolveSlackUsername(app, userId);
    const messageTs = "ts" in message ? message.ts : "";

    console.log(`${tag} ${isDM ? "DM" : "Channel message"} from ${username} (${userId}): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

    if (isDM) {
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
        username,
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
    } else {
      // Standalone channel message — check relevance before responding
      if (!botConfig.channelListening?.enabled) {
        console.log(`${tag} Channel listening disabled, ignoring channel message`);
        return;
      }
      if (!relevanceFilter.isChannelActive(channel)) {
        console.log(`${tag} Channel ${channel} not active (bot needs to be @mentioned first), ignoring`);
        return;
      }

      const recentMessages = await fetchRecentMessages(client, channel, contextMessageCount);
      const relevance = await relevanceFilter.checkRelevance(text, username, channel, recentMessages);

      if (!relevance.relevant) {
        if (relevance.skippedReason) {
          console.log(`${tag} Skipped (${relevance.skippedReason}): "${text.slice(0, 60)}"`);
        }
        return;
      }

      console.log(`${tag} Relevant (${relevance.confidence}): "${text.slice(0, 60)}" — ${relevance.reason}`);
      relevanceFilter.recordResponse(channel);

      const threadTs = messageTs;
      trackThread(channel, threadTs, "channel_listen");

      // Resolve channel name for context
      const channelInfo = await client.conversations.info({ channel }).catch(() => null);
      const channelName = channelInfo?.channel?.name ? `#${channelInfo.channel.name}` : channel;

      try {
        await client.assistant.threads.setStatus({
          channel_id: channel,
          thread_ts: threadTs,
          status: "tenker...",
        });
      } catch { /* ignore */ }

      await handleMessage({
        text,
        userId,
        username,
        say: async (msg: string) => {
          await client.chat.postMessage({ channel, thread_ts: threadTs, text: msg });
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
        platform: "slack_channel_listen",
      });
    }
  });

  await app.start();
  console.log(`${tag} Slack app started in Socket Mode`);

  return app;
}
