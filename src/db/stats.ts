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
  const botFilter = botName ? "WHERE bot_name = $1" : "";
  const haikuBotFilter = botName ? "WHERE bot_name = $1" : "";
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
      ${botFilter}
    ),
    haiku_stats AS (
      SELECT
        coalesce(sum(input_tokens + output_tokens), 0) AS haiku_total_tokens,
        coalesce(sum(input_tokens + output_tokens) FILTER (WHERE created_at >= CURRENT_DATE), 0) AS haiku_tokens_today,
        coalesce(sum(input_tokens + output_tokens) FILTER (WHERE source LIKE 'watcher-%'), 0) AS watcher_total_tokens,
        coalesce(sum(input_tokens + output_tokens) FILTER (WHERE source LIKE 'watcher-%' AND created_at >= CURRENT_DATE), 0) AS watcher_tokens_today
      FROM haiku_usage
      ${haikuBotFilter}
    ),
    mem_stats AS (
      SELECT count(*) AS memories_count FROM memories ${botFilter}
    ),
    goal_stats AS (
      SELECT
        count(*) FILTER (WHERE status = 'active') AS active_goals,
        count(*) FILTER (WHERE status = 'completed') AS completed_goals
      FROM goals
      ${botFilter}
    ),
    task_stats AS (
      SELECT count(*) FILTER (WHERE enabled = true) AS scheduled_tasks FROM scheduled_tasks ${botFilter}
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

  const tokensByDay = botName
    ? await sql`
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS date,
        coalesce(sum(coalesce(m.input_tokens, 0) + coalesce(m.output_tokens, 0)), 0)::int AS main_tokens,
        coalesce((SELECT sum(input_tokens + output_tokens) FROM haiku_usage WHERE created_at::date = d.day AND bot_name = ${botName}), 0)::int AS haiku_tokens,
        coalesce((SELECT sum(input_tokens + output_tokens) FROM haiku_usage WHERE created_at::date = d.day AND bot_name = ${botName} AND source LIKE 'watcher-%'), 0)::int AS watcher_tokens
      FROM generate_series(CURRENT_DATE - interval '6 days', CURRENT_DATE, '1 day') AS d(day)
      LEFT JOIN messages m ON m.created_at::date = d.day AND m.bot_name = ${botName}
      GROUP BY d.day
      ORDER BY d.day
    `
    : await sql`
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS date,
        coalesce(sum(coalesce(m.input_tokens, 0) + coalesce(m.output_tokens, 0)), 0)::int AS main_tokens,
        coalesce((SELECT sum(input_tokens + output_tokens) FROM haiku_usage WHERE created_at::date = d.day), 0)::int AS haiku_tokens,
        coalesce((SELECT sum(input_tokens + output_tokens) FROM haiku_usage WHERE created_at::date = d.day AND source LIKE 'watcher-%'), 0)::int AS watcher_tokens
      FROM generate_series(CURRENT_DATE - interval '6 days', CURRENT_DATE, '1 day') AS d(day)
      LEFT JOIN messages m ON m.created_at::date = d.day
      GROUP BY d.day
      ORDER BY d.day
    `;

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

// --- Slack Analytics ---

export interface SlackUserStats {
  userId: string;
  username: string;
  messageCount: number;
  firstSeen: number;
  lastSeen: number;
  primaryPlatform: string;
  personalMemories: number;
  sharedMemories: number;
}

export interface SlackPlatformBreakdown {
  platform: string;
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
  const users = botName
    ? await sql`
      SELECT
        m.user_id,
        m.username,
        count(*)::int AS message_count,
        min(m.created_at) AS first_seen,
        max(m.created_at) AS last_seen,
        mode() WITHIN GROUP (ORDER BY m.platform) AS primary_platform,
        coalesce((SELECT count(*) FROM memories mem WHERE mem.source_message_id IN (SELECT id FROM messages WHERE user_id = m.user_id AND platform LIKE 'slack_%' AND bot_name = ${botName}) AND mem.scope = 'personal'), 0)::int AS personal_memories,
        coalesce((SELECT count(*) FROM memories mem WHERE mem.source_message_id IN (SELECT id FROM messages WHERE user_id = m.user_id AND platform LIKE 'slack_%' AND bot_name = ${botName}) AND mem.scope = 'shared'), 0)::int AS shared_memories
      FROM messages m
      WHERE m.platform LIKE 'slack_%' AND m.role = 'user' AND m.bot_name = ${botName}
      GROUP BY m.user_id, m.username
      ORDER BY message_count DESC
    `
    : await sql`
      SELECT
        m.user_id,
        m.username,
        count(*)::int AS message_count,
        min(m.created_at) AS first_seen,
        max(m.created_at) AS last_seen,
        mode() WITHIN GROUP (ORDER BY m.platform) AS primary_platform,
        coalesce((SELECT count(*) FROM memories mem WHERE mem.source_message_id IN (SELECT id FROM messages WHERE user_id = m.user_id AND platform LIKE 'slack_%') AND mem.scope = 'personal'), 0)::int AS personal_memories,
        coalesce((SELECT count(*) FROM memories mem WHERE mem.source_message_id IN (SELECT id FROM messages WHERE user_id = m.user_id AND platform LIKE 'slack_%') AND mem.scope = 'shared'), 0)::int AS shared_memories
      FROM messages m
      WHERE m.platform LIKE 'slack_%' AND m.role = 'user'
      GROUP BY m.user_id, m.username
      ORDER BY message_count DESC
    `;

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
      primaryPlatform: r.primary_platform,
      personalMemories: Number(r.personal_memories),
      sharedMemories: Number(r.shared_memories),
    })),
    platformBreakdown: breakdown.map((r) => ({
      platform: r.platform,
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
