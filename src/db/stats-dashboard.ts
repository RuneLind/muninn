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
