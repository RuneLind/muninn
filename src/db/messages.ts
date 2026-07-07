import { getDb } from "./client.ts";
import type { ConversationMessage, Platform } from "../types.ts";

export interface SaveMessageParams {
  userId: string;
  botName: string;
  username?: string;
  role: "user" | "assistant" | "peer";
  content: string;
  costUsd?: number;
  durationMs?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Last turn's input tokens — actual context window usage */
  contextTokens?: number;
  /** Anthropic prompt-cache read tokens (subset of inputTokens) */
  cacheReadTokens?: number;
  /** Anthropic prompt-cache creation tokens (subset of inputTokens) */
  cacheCreationTokens?: number;
  source?: string;
  platform?: Platform;
  threadId?: string;
  /** Trace ID linking to the request's trace spans (tool call history) */
  traceId?: string;
  /** Hivemind broker peer ID — only set for role='peer' inbound messages. */
  fromPeerId?: string;
}

export async function saveMessage(msg: SaveMessageParams): Promise<string> {
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO messages (user_id, bot_name, username, role, content, cost_usd, duration_ms, model, input_tokens, output_tokens, context_tokens, cache_read_tokens, cache_creation_tokens, source, platform, thread_id, trace_id, from_peer_id)
    VALUES (${msg.userId}, ${msg.botName}, ${msg.username ?? null}, ${msg.role}, ${msg.content}, ${msg.costUsd ?? null}, ${msg.durationMs ?? null}, ${msg.model ?? null}, ${msg.inputTokens ?? null}, ${msg.outputTokens ?? null}, ${msg.contextTokens ?? null}, ${msg.cacheReadTokens ?? null}, ${msg.cacheCreationTokens ?? null}, ${msg.source ?? null}, ${msg.platform ?? null}, ${msg.threadId ?? null}, ${msg.traceId ?? null}, ${msg.fromPeerId ?? null})
    RETURNING id
  `;
  return row!.id;
}

/** Row identity needed to attribute feedback to an assistant message. */
export interface MessageOwner {
  id: string;
  userId: string;
  botName: string;
  platform: string | null;
}

/** Stamp the sent Telegram (chat_id, message_id) onto an assistant message row so
 *  an incoming message_reaction can be resolved back to it. Best-effort: a missing
 *  row (e.g. evicted) is a no-op. */
export async function setTelegramMessageId(
  messageId: string,
  chatId: number,
  telegramMessageId: number,
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE messages
    SET telegram_chat_id = ${chatId}, telegram_message_id = ${telegramMessageId}
    WHERE id = ${messageId}
  `;
}

/** Resolve a Telegram reaction target (chat_id, message_id) back to the assistant
 *  message it belongs to. Returns null when the reaction is on an untracked message
 *  (e.g. the user's own message, or a reply we never stamped). */
export async function getMessageByTelegramId(
  chatId: number,
  telegramMessageId: number,
): Promise<MessageOwner | null> {
  const sql = getDb();
  const [row] = await sql`
    SELECT id, user_id, bot_name, platform
    FROM messages
    WHERE telegram_chat_id = ${chatId} AND telegram_message_id = ${telegramMessageId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!row) return null;
  return { id: row.id, userId: row.user_id, botName: row.bot_name, platform: row.platform ?? null };
}

/** Look up a message by its DB id — the web feedback route derives (user_id,
 *  bot_name, platform) from the message row rather than trusting the client. */
export async function getMessageById(messageId: string): Promise<MessageOwner | null> {
  const sql = getDb();
  const [row] = await sql`
    SELECT id, user_id, bot_name, platform
    FROM messages
    WHERE id = ${messageId}
    LIMIT 1
  `;
  if (!row) return null;
  return { id: row.id, userId: row.user_id, botName: row.bot_name, platform: row.platform ?? null };
}

export async function getRecentMessages(
  userId: string,
  limit = 20,
  botName?: string,
  threadId?: string,
): Promise<ConversationMessage[]> {
  const sql = getDb();

  let rows;
  if (threadId) {
    if (!botName) {
      throw new Error("getRecentMessages: botName is required when threadId is provided");
    }
    // Thread-scoped: only include pre-migration messages (thread_id IS NULL) for the "main"
    // thread — other threads should only see their own messages.
    rows = await sql`
      SELECT id, user_id, username, role, content, cost_usd, duration_ms, model, input_tokens, output_tokens, created_at
      FROM messages
      WHERE user_id = ${userId} AND bot_name = ${botName}
        AND (
          thread_id = ${threadId}
          OR (thread_id IS NULL AND EXISTS (
            SELECT 1 FROM threads t WHERE t.id = ${threadId} AND t.name = 'main'
          ))
        )
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  } else if (botName) {
    rows = await sql`
      SELECT id, user_id, username, role, content, cost_usd, duration_ms, model, input_tokens, output_tokens, created_at
      FROM messages
      WHERE user_id = ${userId} AND bot_name = ${botName}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT id, user_id, username, role, content, cost_usd, duration_ms, model, input_tokens, output_tokens, created_at
      FROM messages
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }

  return rows
    .map((r) => ({
      id: r.id,
      role: r.role as "user" | "assistant" | "peer",
      text: r.content,
      timestamp: new Date(r.created_at).getTime(),
      userId: r.user_id,
      username: r.username ?? undefined,
      costUsd: r.cost_usd ?? undefined,
      durationMs: r.duration_ms ?? undefined,
      model: r.model ?? undefined,
    }))
    .reverse(); // chronological order
}

export interface SimConversationRow {
  userId: string;
  botName: string;
  platform: string;
  username: string | null;
}

export interface LastResponseMeta {
  inputTokens: number;
  outputTokens: number;
  contextTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd: number;
  model: string;
  durationMs: number;
}

/** Get token/cost data from the most recent assistant message for a user+bot (optionally scoped to a thread) */
export async function getLastResponseMeta(userId: string, botName: string, threadId?: string): Promise<LastResponseMeta | null> {
  const sql = getDb();
  const threadFilter = threadId ? sql`AND thread_id = ${threadId}` : sql``;
  const [row] = await sql`
    SELECT input_tokens, output_tokens, context_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, model, duration_ms
    FROM messages
    WHERE user_id = ${userId} AND bot_name = ${botName} AND role = 'assistant'
      AND input_tokens IS NOT NULL
      ${threadFilter}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!row) return null;
  return {
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    contextTokens: row.context_tokens ? Number(row.context_tokens) : undefined,
    cacheReadTokens: row.cache_read_tokens ? Number(row.cache_read_tokens) : undefined,
    cacheCreationTokens: row.cache_creation_tokens ? Number(row.cache_creation_tokens) : undefined,
    costUsd: Number(row.cost_usd ?? 0),
    model: row.model ?? "",
    durationMs: Number(row.duration_ms ?? 0),
  };
}

/**
 * Get distinct chat conversations from the DB, ordered by most recent activity.
 * Returns unique (user_id, bot_name, platform) tuples, limited to the 100 most
 * recently active conversations to avoid slow page loads with many users.
 *
 * The conversation's display `username` is the CANONICAL one from the `users`
 * table — NOT the latest message's `username`. A hivemind autorespond turn saves
 * its assistant message stamped with the peer's name (e.g. `claude-hivemind`); if
 * we hydrated the conversation from that label, the next human turn would persist
 * it back over the owner's real username via `ensureUser`, "renaming" the user in
 * the sidebar. Reading the canonical name keeps `conversation.username` tied to
 * the owner. Falls back to the latest message's label only for the rare case of a
 * message with no matching `users` row.
 */
export async function getSimConversations(): Promise<SimConversationRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT sub.user_id, sub.bot_name, sub.platform,
      COALESCE(NULLIF(u.username, ''), sub.username) AS username
    FROM (
      SELECT DISTINCT ON (user_id, bot_name, platform)
        user_id, bot_name, platform, username, created_at
      FROM messages
      WHERE platform IS NOT NULL
      ORDER BY user_id, bot_name, platform, created_at DESC
    ) sub
    LEFT JOIN users u ON u.id = sub.user_id
    ORDER BY sub.created_at DESC
    LIMIT 100
  `;
  return rows.map((r) => ({
    userId: r.user_id,
    botName: r.bot_name,
    platform: r.platform,
    username: r.username,
  }));
}

/**
 * Get recent messages for a specific chat conversation.
 */
export async function getSimMessages(
  userId: string,
  botName: string,
  platform: string,
  limit = 50,
  threadId?: string,
  allPlatforms?: boolean,
): Promise<{ id: string; role: string; content: string; createdAt: number; threadId: string | null; traceId: string | null; fromPeerId: string | null; model: string | null }[]> {
  const sql = getDb();

  const platformFilter = allPlatforms ? sql`` : sql`AND platform = ${platform}`;
  const threadFilter = threadId
    ? sql`AND (
        thread_id = ${threadId}
        OR (thread_id IS NULL AND EXISTS (
          SELECT 1 FROM threads t WHERE t.id = ${threadId} AND t.name = 'main'
        ))
      )`
    : sql``;

  const rows = await sql`
    SELECT id, role, content, created_at, thread_id, trace_id, from_peer_id, model
    FROM messages
    WHERE user_id = ${userId}
      AND bot_name = ${botName}
      ${platformFilter}
      ${threadFilter}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows
    .map((r) => ({
      id: r.id,
      role: r.role as string,
      content: r.content as string,
      createdAt: new Date(r.created_at).getTime(),
      threadId: (r.thread_id as string) ?? null,
      traceId: (r.trace_id as string) ?? null,
      fromPeerId: (r.from_peer_id as string) ?? null,
      model: (r.model as string) ?? null,
    }))
    .reverse();
}

export interface AlertMessage {
  id: string;
  source: string;
  content: string;
  timestamp: number;
}

/** Most-recent broker peer-id in a thread — recipient for `>` text-prefix replies. */
export async function getMostRecentPeerIdForThread(threadId: string): Promise<string | null> {
  const sql = getDb();
  const [row] = await sql`
    SELECT from_peer_id FROM messages
    WHERE thread_id = ${threadId} AND from_peer_id IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return (row?.from_peer_id as string) ?? null;
}

/** Count messages with a given role in a thread within the last N hours.
 *  Used by the hivemind loop guard for rolling-hour autorespond turn caps. */
export async function countMessagesByRoleInWindow(
  threadId: string,
  role: "user" | "assistant" | "peer",
  hours: number,
): Promise<number> {
  const sql = getDb();
  const [row] = await sql`
    SELECT COUNT(*)::int AS count
    FROM messages
    WHERE thread_id = ${threadId}
      AND role = ${role}
      AND created_at > now() - make_interval(hours => ${hours})
  `;
  return Number(row?.count ?? 0);
}

export async function getRecentAlerts(
  userId: string,
  botName: string,
  hours = 24,
  limit = 10,
): Promise<AlertMessage[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, source, content, created_at
    FROM messages
    WHERE user_id = ${userId}
      AND bot_name = ${botName}
      AND source IS NOT NULL
      AND created_at > now() - make_interval(hours => ${hours})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows
    .map((r) => ({
      id: r.id,
      source: r.source,
      content: r.content,
      timestamp: new Date(r.created_at).getTime(),
    }))
    .reverse(); // chronological order
}
