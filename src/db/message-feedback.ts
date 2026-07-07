import { getDb } from "./client.ts";

/** Where a feedback signal came from. */
export type FeedbackSource = "telegram_reaction" | "web";

export interface UpsertFeedbackParams {
  messageId: string;
  userId: string;
  botName?: string | null;
  platform?: string | null;
  source: FeedbackSource;
  /** +1 (positive) or -1 (negative). */
  value: 1 | -1;
  /** The raw emoji for a Telegram reaction; null for web. */
  raw?: string | null;
}

export interface MessageFeedbackRow {
  id: string;
  messageId: string;
  userId: string;
  botName: string | null;
  platform: string | null;
  source: FeedbackSource;
  value: number;
  raw: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Insert or update a feedback signal. Idempotent per (message_id, user_id, source):
 *  a repeat vote (e.g. 👍 then 👎) overwrites the prior value + raw emoji. */
export async function upsertFeedback(params: UpsertFeedbackParams): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO message_feedback (message_id, user_id, bot_name, platform, source, value, raw)
    VALUES (${params.messageId}, ${params.userId}, ${params.botName ?? null}, ${params.platform ?? null}, ${params.source}, ${params.value}, ${params.raw ?? null})
    ON CONFLICT (message_id, user_id, source)
    DO UPDATE SET
      value = EXCLUDED.value,
      raw = EXCLUDED.raw,
      bot_name = EXCLUDED.bot_name,
      platform = EXCLUDED.platform,
      updated_at = now()
  `;
}

/** Remove a feedback signal — used for reaction retraction (Telegram sends an
 *  empty new_reaction list) and for clearing a web 👍/👎. No-op if absent. */
export async function deleteFeedback(
  messageId: string,
  userId: string,
  source: FeedbackSource,
): Promise<void> {
  const sql = getDb();
  await sql`
    DELETE FROM message_feedback
    WHERE message_id = ${messageId} AND user_id = ${userId} AND source = ${source}
  `;
}

/** Read one user's feedback on a message for a given source (null if none). */
export async function getFeedback(
  messageId: string,
  userId: string,
  source: FeedbackSource,
): Promise<MessageFeedbackRow | null> {
  const sql = getDb();
  const [row] = await sql`
    SELECT id, message_id, user_id, bot_name, platform, source, value, raw, created_at, updated_at
    FROM message_feedback
    WHERE message_id = ${messageId} AND user_id = ${userId} AND source = ${source}
    LIMIT 1
  `;
  return row ? mapRow(row) : null;
}

/** All feedback rows for a message (any user/source). Useful for future analytics. */
export async function getFeedbackForMessage(messageId: string): Promise<MessageFeedbackRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, message_id, user_id, bot_name, platform, source, value, raw, created_at, updated_at
    FROM message_feedback
    WHERE message_id = ${messageId}
    ORDER BY created_at ASC
  `;
  return rows.map(mapRow);
}

function mapRow(row: Record<string, unknown>): MessageFeedbackRow {
  return {
    id: row.id as string,
    messageId: row.message_id as string,
    userId: row.user_id as string,
    botName: (row.bot_name as string) ?? null,
    platform: (row.platform as string) ?? null,
    source: row.source as FeedbackSource,
    value: Number(row.value),
    raw: (row.raw as string) ?? null,
    createdAt: new Date(row.created_at as string).getTime(),
    updatedAt: new Date(row.updated_at as string).getTime(),
  };
}
