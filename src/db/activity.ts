import { getDb } from "./client.ts";
import type { ActivityEvent, ActivityEventType, TimingMetadata } from "../types.ts";

interface SaveActivityParams {
  type: ActivityEventType;
  userId?: string;
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
    .map(mapActivityRow)
    .reverse(); // chronological order
}

export async function getActivityForJob(
  jobId: string,
  jobName: string,
  limit = 30,
): Promise<ActivityEvent[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, type, user_id, bot_name, username, text, duration_ms, cost_usd, metadata, created_at
    FROM activity_log
    WHERE metadata->>'watcherId' = ${jobId}
       OR metadata->>'watcherName' = ${jobName}
       OR (type = 'system' AND text ILIKE ${"%" + jobName + "%"})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map(mapActivityRow).reverse();
}

function mapActivityRow(r: Record<string, unknown>): ActivityEvent {
  return {
    id: r.id as string,
    type: r.type as ActivityEventType,
    timestamp: new Date(r.created_at as string).getTime(),
    userId: (r.user_id as string) ?? undefined,
    username: (r.username as string) ?? undefined,
    botName: (r.bot_name as string) ?? undefined,
    text: r.text as string,
    durationMs: (r.duration_ms as number) ?? undefined,
    costUsd: r.cost_usd ? Number(r.cost_usd) : undefined,
    metadata: (r.metadata as Record<string, unknown>) ?? undefined,
  };
}
