import { getDb } from "./client.ts";
import type { ConversationMessage, Platform } from "../types.ts";

export interface SaveMessageParams {
  userId: string;
  botName: string;
  username?: string;
  role: "user" | "assistant";
  content: string;
  costUsd?: number;
  durationMs?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  source?: string;
  platform?: Platform;
  threadId?: string;
}

export async function saveMessage(msg: SaveMessageParams): Promise<string> {
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO messages (user_id, bot_name, username, role, content, cost_usd, duration_ms, model, input_tokens, output_tokens, source, platform, thread_id)
    VALUES (${msg.userId}, ${msg.botName}, ${msg.username ?? null}, ${msg.role}, ${msg.content}, ${msg.costUsd ?? null}, ${msg.durationMs ?? null}, ${msg.model ?? null}, ${msg.inputTokens ?? null}, ${msg.outputTokens ?? null}, ${msg.source ?? null}, ${msg.platform ?? null}, ${msg.threadId ?? null})
    RETURNING id
  `;
  return row!.id;
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
    // Thread-scoped: only include pre-migration messages (thread_id IS NULL) for the "main"
    // thread — other threads should only see their own messages.
    rows = await sql`
      SELECT id, user_id, username, role, content, cost_usd, duration_ms, model, input_tokens, output_tokens, created_at
      FROM messages
      WHERE user_id = ${userId} AND bot_name = ${botName!}
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
      role: r.role as "user" | "assistant",
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

export interface AlertMessage {
  id: string;
  source: string;
  content: string;
  timestamp: number;
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
