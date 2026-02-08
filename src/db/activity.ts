import { getDb } from "./client.ts";
import type { ActivityEvent, ActivityEventType, TimingMetadata } from "../types.ts";

interface SaveActivityParams {
  type: ActivityEventType;
  userId?: number;
  username?: string;
  botName?: string;
  text: string;
  durationMs?: number;
  costUsd?: number;
  metadata?: TimingMetadata;
}

export async function saveActivity(params: SaveActivityParams): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO activity_log (type, user_id, bot_name, username, text, duration_ms, cost_usd, metadata)
    VALUES (${params.type}, ${params.userId ?? null}, ${params.botName ?? null}, ${params.username ?? null}, ${params.text}, ${params.durationMs ?? null}, ${params.costUsd ?? null}, ${params.metadata ? JSON.stringify(params.metadata) : null})
  `;
}

export async function getRecentActivity(limit = 50, botName?: string): Promise<ActivityEvent[]> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT id, type, user_id, bot_name, username, text, duration_ms, cost_usd, metadata, created_at
      FROM activity_log
      WHERE bot_name = ${botName}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
    : await sql`
      SELECT id, type, user_id, bot_name, username, text, duration_ms, cost_usd, metadata, created_at
      FROM activity_log
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

  return rows
    .map((r) => ({
      id: r.id,
      type: r.type as ActivityEventType,
      timestamp: new Date(r.created_at).getTime(),
      userId: r.user_id ? Number(r.user_id) : undefined,
      username: r.username ?? undefined,
      botName: r.bot_name ?? undefined,
      text: r.text,
      durationMs: r.duration_ms ?? undefined,
      costUsd: r.cost_usd ? Number(r.cost_usd) : undefined,
      metadata: r.metadata ?? undefined,
    }))
    .reverse(); // chronological order
}
