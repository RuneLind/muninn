import { getDb } from "./client.ts";
import type { Goal, GoalStatus, Platform } from "../types.ts";

interface SaveGoalParams {
  userId: string;
  botName: string;
  title: string;
  description?: string | null;
  deadline?: Date | null;
  tags?: string[];
  sourceMessageId?: string | null;
  platform?: Platform;
}

export async function saveGoal(params: SaveGoalParams): Promise<string> {
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO goals (user_id, bot_name, title, description, deadline, tags, source_message_id, platform)
    VALUES (
      ${params.userId},
      ${params.botName},
      ${params.title},
      ${params.description ?? null},
      ${params.deadline ?? null},
      ${params.tags ?? []},
      ${params.sourceMessageId ?? null},
      ${params.platform ?? "telegram"}
    )
    RETURNING id
  `;
  return row!.id;
}

export async function getActiveGoals(userId: string, botName?: string): Promise<Goal[]> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT * FROM goals
      WHERE user_id = ${userId} AND bot_name = ${botName} AND status = 'active'
      ORDER BY deadline ASC NULLS LAST, created_at DESC
    `
    : await sql`
      SELECT * FROM goals
      WHERE user_id = ${userId} AND status = 'active'
      ORDER BY deadline ASC NULLS LAST, created_at DESC
    `;
  return rows.map(mapRow);
}

export async function getGoalById(id: string): Promise<Goal | null> {
  const sql = getDb();
  const rows = await sql`SELECT * FROM goals WHERE id = ${id}`;
  return rows.length > 0 ? mapRow(rows[0]!) : null;
}

export async function updateGoalStatus(
  id: string,
  status: GoalStatus,
): Promise<void> {
  const sql = getDb();
  await sql`UPDATE goals SET status = ${status} WHERE id = ${id}`;
}

export async function updateGoalCheckedAt(id: string): Promise<void> {
  const sql = getDb();
  await sql`UPDATE goals SET last_checked_at = now() WHERE id = ${id}`;
}

export async function updateGoalReminderSentAt(id: string): Promise<void> {
  const sql = getDb();
  await sql`UPDATE goals SET reminder_sent_at = now() WHERE id = ${id}`;
}

export async function getGoalsNeedingReminder(
  hoursAhead: number,
  botName?: string,
): Promise<Goal[]> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT * FROM goals
      WHERE status = 'active' AND bot_name = ${botName}
        AND (platform = 'telegram' OR platform IS NULL)
        AND deadline IS NOT NULL
        AND deadline <= now() + ${hoursAhead + " hours"}::interval
        AND deadline > now()
        AND (reminder_sent_at IS NULL OR reminder_sent_at < now() - interval '12 hours')
      ORDER BY deadline ASC
    `
    : await sql`
      SELECT * FROM goals
      WHERE status = 'active'
        AND (platform = 'telegram' OR platform IS NULL)
        AND deadline IS NOT NULL
        AND deadline <= now() + ${hoursAhead + " hours"}::interval
        AND deadline > now()
        AND (reminder_sent_at IS NULL OR reminder_sent_at < now() - interval '12 hours')
      ORDER BY deadline ASC
    `;
  return rows.map(mapRow);
}

export async function getGoalsNeedingCheckin(
  daysSinceCheckin: number,
  botName?: string,
): Promise<Goal[]> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT * FROM goals
      WHERE status = 'active' AND bot_name = ${botName}
        AND (platform = 'telegram' OR platform IS NULL)
        AND (last_checked_at IS NULL OR last_checked_at < now() - ${daysSinceCheckin + " days"}::interval)
      ORDER BY last_checked_at ASC NULLS FIRST
      LIMIT 5
    `
    : await sql`
      SELECT * FROM goals
      WHERE status = 'active'
        AND (platform = 'telegram' OR platform IS NULL)
        AND (last_checked_at IS NULL OR last_checked_at < now() - ${daysSinceCheckin + " days"}::interval)
      ORDER BY last_checked_at ASC NULLS FIRST
      LIMIT 5
    `;
  return rows.map(mapRow);
}

export async function getAllGoals(botName?: string): Promise<Goal[]> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT * FROM goals
      WHERE bot_name = ${botName}
        AND NOT (status IN ('completed', 'cancelled') AND updated_at < now() - interval '7 days')
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
        deadline ASC NULLS LAST,
        created_at DESC
    `
    : await sql`
      SELECT * FROM goals
      WHERE NOT (status IN ('completed', 'cancelled') AND updated_at < now() - interval '7 days')
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
        deadline ASC NULLS LAST,
        created_at DESC
    `;
  return rows.map(mapRow);
}

function mapRow(r: Record<string, any>): Goal {
  return {
    id: r.id,
    userId: r.user_id,
    botName: r.bot_name ?? "jarvis",
    title: r.title,
    description: r.description ?? null,
    status: r.status as GoalStatus,
    deadline: r.deadline ? new Date(r.deadline).getTime() : null,
    tags: r.tags ?? [],
    sourceMessageId: r.source_message_id ?? null,
    platform: (r.platform ?? "telegram") as Platform,
    lastCheckedAt: r.last_checked_at
      ? new Date(r.last_checked_at).getTime()
      : null,
    reminderSentAt: r.reminder_sent_at
      ? new Date(r.reminder_sent_at).getTime()
      : null,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  };
}
