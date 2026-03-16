import { getDb } from "./client.ts";

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

  const andBot = botName ? `AND bot_name = $1` : "";
  const whereBot = botName ? `WHERE bot_name = $1` : "";
  const params = botName ? [botName] : [];

  // Users table is the authority — LEFT JOIN to get counts from domain tables
  const rows = await sql.unsafe(`
    WITH user_msg_stats AS (
      SELECT user_id,
        count(*)::int AS message_count,
        max(created_at) AS last_msg_at,
        min(created_at) AS first_msg_at
      FROM messages
      WHERE role = 'user' ${andBot}
      GROUP BY user_id
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
      u.id AS user_id, u.username, u.platform,
      coalesce(ums.message_count, 0)::int AS message_count,
      coalesce(ums.last_msg_at, u.last_seen_at, u.created_at) AS last_active,
      coalesce(ums.first_msg_at, u.created_at) AS first_seen,
      coalesce(umem.cnt, 0)::int AS memory_count,
      coalesce(ut.cnt, 0)::int AS thread_count,
      coalesce(ug.cnt, 0)::int AS active_goal_count,
      coalesce(ust.cnt, 0)::int AS scheduled_task_count,
      coalesce(utok.total, 0)::bigint AS total_tokens
    FROM users u
    LEFT JOIN user_msg_stats ums ON ums.user_id = u.id
    LEFT JOIN user_memories umem ON umem.user_id = u.id
    LEFT JOIN user_threads ut ON ut.user_id = u.id
    LEFT JOIN user_goals ug ON ug.user_id = u.id
    LEFT JOIN user_tasks ust ON ust.user_id = u.id
    LEFT JOIN user_tokens utok ON utok.user_id = u.id
    WHERE u.is_active = true
    ${botName ? `AND EXISTS (SELECT 1 FROM threads t WHERE t.user_id = u.id AND t.bot_name = $1)` : ""}
    ORDER BY last_active DESC
  `, params);

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username ?? r.user_id,
    platform: r.platform ?? "web",
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
