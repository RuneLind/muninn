import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { resolveSlackUser } from "./cache.ts";
import { getLog } from "../logging.ts";

const log = getLog("slack", "message-fetcher");

/** Fetch recent messages from a channel for context */
export async function fetchChannelMessages(app: App, client: WebClient, channel: string, botName: string, limit: number = 15): Promise<string[]> {
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
    log.warn("Failed to fetch channel messages for {channel}: {error}", { botName, channel, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** Fetch messages from a thread for context */
export async function fetchThreadMessages(app: App, client: WebClient, channel: string, threadTs: string, botName: string, limit: number = 15): Promise<string[]> {
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
    log.warn("Failed to fetch thread messages for {channel}:{threadTs}: {error}", { botName, channel, threadTs, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
