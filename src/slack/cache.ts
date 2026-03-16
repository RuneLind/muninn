import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { UserIdentity } from "../types.ts";
import { getLog } from "../logging.ts";

const log = getLog("slack", "cache");

const USER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CHANNEL_CACHE_SIZE = 500;
const userInfoCache = new Map<string, { identity: UserIdentity; cachedAt: number }>();
const channelIdCache = new Map<string, string>();

export async function resolveSlackUser(app: App, userId: string): Promise<UserIdentity> {
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
export async function resolveChannelId(client: WebClient, channelName: string): Promise<string> {
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
export function makePostToChannel(client: WebClient, botName: string) {
  return async (channel: string, message: string) => {
    const channelId = await resolveChannelId(client, channel);
    log.info("postToChannel: channel=\"{channel}\" → resolved=\"{channelId}\", message=\"{preview}\"", { botName, channel, channelId, preview: message.slice(0, 100) });
    const result = await client.chat.postMessage({ channel: channelId, text: message });
    log.info("postToChannel: success, ts={ts}, channel={ch}", { botName, ts: result.ts, ch: result.channel });
  };
}
