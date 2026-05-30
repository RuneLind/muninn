import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { UserIdentity } from "../types.ts";
import { getLog } from "../logging.ts";

const log = getLog("slack", "cache");

const USER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — don't re-paginate a missing channel every call
const MAX_CHANNEL_CACHE_SIZE = 500;
const MAX_USER_CACHE_SIZE = 500;
const userInfoCache = new Map<string, { identity: UserIdentity; cachedAt: number }>();
// `null` = negative cache entry (name confirmed not found this window) to avoid
// re-paginating conversations.list on every miss.
const channelIdCache = new Map<string, { id: string | null; cachedAt: number }>();

/** Evict the least-recently-used entry while the Map is at/over its cap.
 *  Map iteration is insertion-order, so the first key is the oldest; re-`set`ting
 *  a key on access (LRU touch) keeps hot entries at the tail. */
function pruneToSize<K, V>(cache: Map<K, V>, max: number): void {
  while (cache.size >= max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export async function resolveSlackUser(app: App, userId: string): Promise<UserIdentity> {
  const cached = userInfoCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < USER_CACHE_TTL_MS) {
    userInfoCache.delete(userId);
    userInfoCache.set(userId, cached); // LRU touch — keep hot entries at the tail
    return cached.identity;
  }
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
    pruneToSize(userInfoCache, MAX_USER_CACHE_SIZE);
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
  if (cached && Date.now() - cached.cachedAt < (cached.id === null ? NEGATIVE_CACHE_TTL_MS : USER_CACHE_TTL_MS)) {
    channelIdCache.delete(name); // LRU touch
    channelIdCache.set(name, cached);
    // Positive hit → cached id; negative hit → fall back to the raw name (as before).
    return cached.id ?? name;
  }

  // If it looks like an ID already (starts with C/G), use directly
  if (/^[CG][A-Z0-9]+$/.test(name)) return name;

  try {
    let cursor: string | undefined = undefined;
    do {
      const result = await client.conversations.list({ limit: 200, cursor, types: "public_channel,private_channel" });
      for (const ch of result.channels ?? []) {
        if (ch.id && ch.name) {
          pruneToSize(channelIdCache, MAX_CHANNEL_CACHE_SIZE);
          channelIdCache.set(ch.name, { id: ch.id, cachedAt: Date.now() });
        }
        if (ch.name === name && ch.id) return ch.id;
      }
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    // Negative cache: the full pagination didn't find it. Avoid re-paginating
    // on every subsequent call within the negative-cache window.
    pruneToSize(channelIdCache, MAX_CHANNEL_CACHE_SIZE);
    channelIdCache.set(name, { id: null, cachedAt: Date.now() });
  } catch { /* fall through — don't negative-cache on API error */ }

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
