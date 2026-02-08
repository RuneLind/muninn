import { getDb } from "./client.ts";
import type { ConversationMessage } from "../types.ts";

interface SaveMessageParams {
  userId: number;
  botName: string;
  username?: string;
  role: "user" | "assistant";
  content: string;
  costUsd?: number;
  durationMs?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export async function saveMessage(msg: SaveMessageParams): Promise<string> {
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO messages (user_id, bot_name, username, role, content, cost_usd, duration_ms, model, input_tokens, output_tokens)
    VALUES (${msg.userId}, ${msg.botName}, ${msg.username ?? null}, ${msg.role}, ${msg.content}, ${msg.costUsd ?? null}, ${msg.durationMs ?? null}, ${msg.model ?? null}, ${msg.inputTokens ?? null}, ${msg.outputTokens ?? null})
    RETURNING id
  `;
  return row!.id;
}

export async function getRecentMessages(
  userId: number,
  limit = 20,
  botName?: string,
): Promise<ConversationMessage[]> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT id, user_id, username, role, content, cost_usd, duration_ms, model, input_tokens, output_tokens, created_at
      FROM messages
      WHERE user_id = ${userId} AND bot_name = ${botName}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
    : await sql`
      SELECT id, user_id, username, role, content, cost_usd, duration_ms, model, input_tokens, output_tokens, created_at
      FROM messages
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

  return rows
    .map((r) => ({
      id: r.id,
      role: r.role as "user" | "assistant",
      text: r.content,
      timestamp: new Date(r.created_at).getTime(),
      userId: Number(r.user_id),
      username: r.username ?? undefined,
      costUsd: r.cost_usd ?? undefined,
      durationMs: r.duration_ms ?? undefined,
      model: r.model ?? undefined,
    }))
    .reverse(); // chronological order
}
