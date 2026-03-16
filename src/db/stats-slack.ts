import { getDb } from "./client.ts";
import type { Platform } from "../types.ts";

export interface SlackUserStats {
  userId: string;
  username: string;
  messageCount: number;
  firstSeen: number;
  lastSeen: number;
  primaryPlatform: Platform;
  personalMemories: number;
  sharedMemories: number;
}

export interface SlackPlatformBreakdown {
  platform: Platform;
  messages: number;
  users: number;
}

export interface SlackDailyActivity {
  date: string;
  slack_dm: number;
  slack_channel: number;
  slack_assistant: number;
}

export interface SlackAnalytics {
  totalMessages: number;
  uniqueUsers: number;
  totalPersonalMemories: number;
  totalSharedMemories: number;
  users: SlackUserStats[];
  platformBreakdown: SlackPlatformBreakdown[];
  dailyActivity: SlackDailyActivity[];
}

export async function getSlackAnalytics(botName?: string): Promise<SlackAnalytics> {
  const sql = getDb();

  // Users with message counts, first/last seen, primary platform
  const andBot = botName ? `AND bot_name = $1` : "";
  const params = botName ? [botName] : [];

  const users = await sql.unsafe(`
    WITH slack_msgs AS (
      SELECT id, user_id FROM messages
      WHERE platform LIKE 'slack_%' ${andBot}
    ),
    slack_mem_counts AS (
      SELECT sm.user_id,
        count(*) FILTER (WHERE mem.scope = 'personal') AS personal,
        count(*) FILTER (WHERE mem.scope = 'shared') AS shared
      FROM slack_msgs sm
      JOIN memories mem ON mem.source_message_id = sm.id
      GROUP BY sm.user_id
    ),
    slack_users AS (
      SELECT
        m.user_id, m.username,
        count(*)::int AS message_count,
        min(m.created_at) AS first_seen,
        max(m.created_at) AS last_seen,
        mode() WITHIN GROUP (ORDER BY m.platform) AS primary_platform
      FROM messages m
      WHERE m.platform LIKE 'slack_%' AND m.role = 'user' ${andBot}
      GROUP BY m.user_id, m.username
    )
    SELECT
      su.user_id, su.username, su.message_count, su.first_seen, su.last_seen, su.primary_platform,
      coalesce(smc.personal, 0)::int AS personal_memories,
      coalesce(smc.shared, 0)::int AS shared_memories
    FROM slack_users su
    LEFT JOIN slack_mem_counts smc USING (user_id)
    ORDER BY su.message_count DESC
  `, params);

  // Platform breakdown
  const breakdown = botName
    ? await sql`
      SELECT
        platform,
        count(*)::int AS messages,
        count(DISTINCT user_id)::int AS users
      FROM messages
      WHERE platform LIKE 'slack_%' AND bot_name = ${botName}
      GROUP BY platform
      ORDER BY messages DESC
    `
    : await sql`
      SELECT
        platform,
        count(*)::int AS messages,
        count(DISTINCT user_id)::int AS users
      FROM messages
      WHERE platform LIKE 'slack_%'
      GROUP BY platform
      ORDER BY messages DESC
    `;

  // 7-day daily breakdown by platform type
  const daily = botName
    ? await sql`
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS date,
        coalesce(count(m.id) FILTER (WHERE m.platform = 'slack_dm'), 0)::int AS slack_dm,
        coalesce(count(m.id) FILTER (WHERE m.platform = 'slack_channel'), 0)::int AS slack_channel,
        coalesce(count(m.id) FILTER (WHERE m.platform = 'slack_assistant'), 0)::int AS slack_assistant
      FROM generate_series(CURRENT_DATE - interval '6 days', CURRENT_DATE, '1 day') AS d(day)
      LEFT JOIN messages m ON m.created_at::date = d.day AND m.platform LIKE 'slack_%' AND m.bot_name = ${botName}
      GROUP BY d.day
      ORDER BY d.day
    `
    : await sql`
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS date,
        coalesce(count(m.id) FILTER (WHERE m.platform = 'slack_dm'), 0)::int AS slack_dm,
        coalesce(count(m.id) FILTER (WHERE m.platform = 'slack_channel'), 0)::int AS slack_channel,
        coalesce(count(m.id) FILTER (WHERE m.platform = 'slack_assistant'), 0)::int AS slack_assistant
      FROM generate_series(CURRENT_DATE - interval '6 days', CURRENT_DATE, '1 day') AS d(day)
      LEFT JOIN messages m ON m.created_at::date = d.day AND m.platform LIKE 'slack_%'
      GROUP BY d.day
      ORDER BY d.day
    `;

  // Summary totals
  const totalMessages = breakdown.reduce((sum, r) => sum + Number(r.messages), 0);
  const totalPersonalMemories = users.reduce((sum, r) => sum + Number(r.personal_memories), 0);
  const totalSharedMemories = users.reduce((sum, r) => sum + Number(r.shared_memories), 0);

  return {
    totalMessages,
    uniqueUsers: users.length,
    totalPersonalMemories,
    totalSharedMemories,
    users: users.map((r) => ({
      userId: r.user_id,
      username: r.username ?? r.user_id,
      messageCount: Number(r.message_count),
      firstSeen: new Date(r.first_seen).getTime(),
      lastSeen: new Date(r.last_seen).getTime(),
      primaryPlatform: r.primary_platform as Platform,
      personalMemories: Number(r.personal_memories),
      sharedMemories: Number(r.shared_memories),
    })),
    platformBreakdown: breakdown.map((r) => ({
      platform: r.platform as Platform,
      messages: Number(r.messages),
      users: Number(r.users),
    })),
    dailyActivity: daily.map((r) => ({
      date: r.date,
      slack_dm: Number(r.slack_dm),
      slack_channel: Number(r.slack_channel),
      slack_assistant: Number(r.slack_assistant),
    })),
  };
}
