import { getDb } from "./client.ts";

export interface DashboardStats {
  messagesToday: number;
  totalMessages: number;
  memoriesCount: number;
  activeGoalsCount: number;
  completedGoalsCount: number;
  scheduledTasksCount: number;
  totalTokens: number;
  tokensToday: number;
  watcherTokensToday: number;
  watcherTokensTotal: number;
  avgResponseMs: number;
  messagesByDay: { date: string; count: number }[];
  tokensByDay: { date: string; mainTokens: number; haikuTokens: number; watcherTokens: number }[];
}

export async function getDashboardStats(botName?: string): Promise<DashboardStats> {
  const sql = getDb();

  // For optional bot_name filtering, use parameterized query with $1
  const whereBot = botName ? "WHERE bot_name = $1" : "";
  const params = botName ? [botName] : [];

  const [counts] = await sql.unsafe(`
    WITH msg_stats AS (
      SELECT
        count(*) AS total_messages,
        count(*) FILTER (WHERE created_at >= CURRENT_DATE) AS messages_today,
        coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0) AS total_tokens,
        coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) FILTER (WHERE created_at >= CURRENT_DATE), 0) AS tokens_today,
        coalesce(avg(duration_ms) FILTER (WHERE role = 'assistant' AND duration_ms IS NOT NULL), 0) AS avg_response_ms
      FROM messages
      ${whereBot}
    ),
    haiku_stats AS (
      SELECT
        coalesce(sum(input_tokens + output_tokens), 0) AS haiku_total_tokens,
        coalesce(sum(input_tokens + output_tokens) FILTER (WHERE created_at >= CURRENT_DATE), 0) AS haiku_tokens_today,
        coalesce(sum(input_tokens + output_tokens) FILTER (WHERE source LIKE 'watcher-%'), 0) AS watcher_total_tokens,
        coalesce(sum(input_tokens + output_tokens) FILTER (WHERE source LIKE 'watcher-%' AND created_at >= CURRENT_DATE), 0) AS watcher_tokens_today
      FROM haiku_usage
      ${whereBot}
    ),
    mem_stats AS (
      SELECT count(*) AS memories_count FROM memories ${whereBot}
    ),
    goal_stats AS (
      SELECT
        count(*) FILTER (WHERE status = 'active') AS active_goals,
        count(*) FILTER (WHERE status = 'completed') AS completed_goals
      FROM goals
      ${whereBot}
    ),
    task_stats AS (
      SELECT count(*) FILTER (WHERE enabled = true) AS scheduled_tasks FROM scheduled_tasks ${whereBot}
    )
    SELECT
      msg_stats.*,
      haiku_stats.*,
      mem_stats.memories_count,
      goal_stats.active_goals,
      goal_stats.completed_goals,
      task_stats.scheduled_tasks
    FROM msg_stats, haiku_stats, mem_stats, goal_stats, task_stats
  `, params);

  const messagesByDay = botName
    ? await sql`
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS date,
        coalesce(count(m.id), 0)::int AS count
      FROM generate_series(CURRENT_DATE - interval '6 days', CURRENT_DATE, '1 day') AS d(day)
      LEFT JOIN messages m ON m.created_at::date = d.day AND m.bot_name = ${botName}
      GROUP BY d.day
      ORDER BY d.day
    `
    : await sql`
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS date,
        coalesce(count(m.id), 0)::int AS count
      FROM generate_series(CURRENT_DATE - interval '6 days', CURRENT_DATE, '1 day') AS d(day)
      LEFT JOIN messages m ON m.created_at::date = d.day
      GROUP BY d.day
      ORDER BY d.day
    `;

  const andBot = botName ? "AND bot_name = $1" : "";

  const tokensByDay = await sql.unsafe(`
    WITH days AS (
      SELECT d::date AS day FROM generate_series(CURRENT_DATE - interval '6 days', CURRENT_DATE, '1 day') AS d
    ),
    msg_tokens AS (
      SELECT created_at::date AS day, coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0)::int AS total
      FROM messages WHERE created_at >= CURRENT_DATE - interval '6 days' ${andBot}
      GROUP BY created_at::date
    ),
    haiku_tokens AS (
      SELECT created_at::date AS day,
        coalesce(sum(input_tokens + output_tokens), 0)::int AS total,
        coalesce(sum(input_tokens + output_tokens) FILTER (WHERE source LIKE 'watcher-%'), 0)::int AS watcher_total
      FROM haiku_usage WHERE created_at >= CURRENT_DATE - interval '6 days' ${andBot}
      GROUP BY created_at::date
    )
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS date,
      coalesce(mt.total, 0)::int AS main_tokens,
      coalesce(ht.total, 0)::int AS haiku_tokens,
      coalesce(ht.watcher_total, 0)::int AS watcher_tokens
    FROM days d
    LEFT JOIN msg_tokens mt ON mt.day = d.day
    LEFT JOIN haiku_tokens ht ON ht.day = d.day
    ORDER BY d.day
  `, params);

  return {
    messagesToday: Number(counts!.messages_today),
    totalMessages: Number(counts!.total_messages),
    memoriesCount: Number(counts!.memories_count),
    activeGoalsCount: Number(counts!.active_goals),
    completedGoalsCount: Number(counts!.completed_goals),
    scheduledTasksCount: Number(counts!.scheduled_tasks),
    totalTokens: Number(counts!.total_tokens) + Number(counts!.haiku_total_tokens),
    tokensToday: Number(counts!.tokens_today) + Number(counts!.haiku_tokens_today),
    watcherTokensToday: Number(counts!.watcher_tokens_today),
    watcherTokensTotal: Number(counts!.watcher_total_tokens),
    avgResponseMs: Number(counts!.avg_response_ms),
    messagesByDay: messagesByDay.map((r) => ({ date: r.date, count: Number(r.count) })),
    tokensByDay: tokensByDay.map((r) => ({ date: r.date, mainTokens: Number(r.main_tokens), haikuTokens: Number(r.haiku_tokens), watcherTokens: Number(r.watcher_tokens) })),
  };
}

// --- User Overview (detail panel) ---

export interface UserOverview {
  messagesByDay: { date: string; count: number }[];
  tokensByDay: { date: string; tokens: number }[];
  avgResponseMs: number;
  modelDistribution: { model: string; count: number }[];
  recentActivity: {
    id: string;
    type: string;
    text: string;
    timestamp: number;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
  }[];
}

export async function getUserOverview(userId: string, botName?: string): Promise<UserOverview> {
  const sql = getDb();

  const andBot = botName ? "AND bot_name = $2" : "";
  const params: (string | number)[] = [userId];
  if (botName) params.push(botName);

  const [messagesByDay, tokensByDay, [avgRow], modelDist, recentActivity] = await Promise.all([
    // 14-day messages by day
    sql.unsafe(`
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS date,
        coalesce(count(m.id), 0)::int AS count
      FROM generate_series(CURRENT_DATE - interval '13 days', CURRENT_DATE, '1 day') AS d(day)
      LEFT JOIN messages m ON m.created_at::date = d.day AND m.user_id = $1 ${andBot}
      GROUP BY d.day
      ORDER BY d.day
    `, params),
    // 14-day tokens by day (assistant messages only)
    sql.unsafe(`
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS date,
        coalesce(sum(coalesce(m.input_tokens, 0) + coalesce(m.output_tokens, 0)), 0)::int AS tokens
      FROM generate_series(CURRENT_DATE - interval '13 days', CURRENT_DATE, '1 day') AS d(day)
      LEFT JOIN messages m ON m.created_at::date = d.day AND m.user_id = $1 AND m.role = 'assistant' ${andBot}
      GROUP BY d.day
      ORDER BY d.day
    `, params),
    // Avg response time
    sql.unsafe(`
      SELECT coalesce(avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0) AS avg_ms
      FROM messages
      WHERE user_id = $1 AND role = 'assistant' ${andBot}
    `, params),
    // Model distribution (last 30 days)
    sql.unsafe(`
      SELECT coalesce(model, 'unknown') AS model, count(*)::int AS count
      FROM messages
      WHERE user_id = $1 AND role = 'assistant' AND model IS NOT NULL
        AND created_at >= CURRENT_DATE - interval '30 days' ${andBot}
      GROUP BY model
      ORDER BY count DESC
    `, params),
    // Recent activity from activity_log
    sql.unsafe(`
      SELECT id, type, text, created_at, duration_ms, metadata
      FROM activity_log
      WHERE user_id = $1 ${andBot}
      ORDER BY created_at DESC
      LIMIT 20
    `, params),
  ]);

  return {
    messagesByDay: messagesByDay.map((r) => ({ date: r.date, count: Number(r.count) })),
    tokensByDay: tokensByDay.map((r) => ({ date: r.date, tokens: Number(r.tokens) })),
    avgResponseMs: Number(avgRow!.avg_ms),
    modelDistribution: modelDist.map((r) => ({ model: r.model, count: Number(r.count) })),
    recentActivity: recentActivity.map((r) => {
      const meta = r.metadata as Record<string, unknown> | null;
      return {
        id: r.id,
        type: r.type,
        text: r.text,
        timestamp: new Date(r.created_at).getTime(),
        durationMs: r.duration_ms ?? undefined,
        inputTokens: meta?.inputTokens as number | undefined,
        outputTokens: meta?.outputTokens as number | undefined,
        model: meta?.model as string | undefined,
      };
    }),
  };
}

// --- Users Summary ---

export interface UserSummary {
  userId: string;
  username: string;
  platform: string;
  messageCount: number;
  memoryCount: number;
  threadCount: number;
  lastActive: number;
  firstSeen: number;
  activeGoalCount: number;
  scheduledTaskCount: number;
  totalTokens: number;
}

export async function getUsersSummary(botName?: string): Promise<UserSummary[]> {
  const sql = getDb();

  const whereBot = botName ? `WHERE bot_name = $1` : "";
  const andBot = botName ? `AND bot_name = $1` : "";
  const params = botName ? [botName] : [];

  const rows = await sql.unsafe(`
    WITH user_msgs AS (
      SELECT
        m.user_id, m.username,
        mode() WITHIN GROUP (ORDER BY m.platform) AS platform,
        count(DISTINCT m.id)::int AS message_count,
        max(m.created_at) AS last_active,
        min(m.created_at) AS first_seen
      FROM messages m
      WHERE m.role = 'user' ${andBot}
      GROUP BY m.user_id, m.username
    ),
    user_memories AS (
      SELECT user_id, count(*)::int AS cnt FROM memories ${whereBot} GROUP BY user_id
    ),
    user_threads AS (
      SELECT user_id, count(*)::int AS cnt FROM threads ${whereBot} GROUP BY user_id
    ),
    user_goals AS (
      SELECT user_id, count(*)::int AS cnt FROM goals WHERE status = 'active' ${andBot} GROUP BY user_id
    ),
    user_tasks AS (
      SELECT user_id, count(*)::int AS cnt FROM scheduled_tasks WHERE enabled = true ${andBot} GROUP BY user_id
    ),
    user_tokens AS (
      SELECT user_id, coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0)::bigint AS total
      FROM messages WHERE role = 'assistant' ${andBot} GROUP BY user_id
    )
    SELECT
      um.user_id, um.username, um.platform, um.message_count, um.last_active, um.first_seen,
      coalesce(umem.cnt, 0)::int AS memory_count,
      coalesce(ut.cnt, 0)::int AS thread_count,
      coalesce(ug.cnt, 0)::int AS active_goal_count,
      coalesce(ust.cnt, 0)::int AS scheduled_task_count,
      coalesce(utok.total, 0)::bigint AS total_tokens
    FROM user_msgs um
    LEFT JOIN user_memories umem USING (user_id)
    LEFT JOIN user_threads ut USING (user_id)
    LEFT JOIN user_goals ug USING (user_id)
    LEFT JOIN user_tasks ust USING (user_id)
    LEFT JOIN user_tokens utok USING (user_id)
    ORDER BY um.last_active DESC
  `, params);

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username ?? r.user_id,
    platform: r.platform ?? "telegram",
    messageCount: Number(r.message_count),
    memoryCount: Number(r.memory_count),
    threadCount: Number(r.thread_count),
    lastActive: new Date(r.last_active).getTime(),
    firstSeen: new Date(r.first_seen).getTime(),
    activeGoalCount: Number(r.active_goal_count),
    scheduledTaskCount: Number(r.scheduled_task_count),
    totalTokens: Number(r.total_tokens),
  }));
}

// --- Slack Analytics ---

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

import type { Platform } from "../types.ts";

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
