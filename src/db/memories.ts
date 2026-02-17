import { getDb } from "./client.ts";
import type { Memory, MemoryScope } from "../types.ts";

interface SaveMemoryParams {
  userId: string;
  botName: string;
  content: string;
  summary: string;
  tags: string[];
  sourceMessageId?: string;
  embedding?: number[] | null;
  scope?: MemoryScope;
}

export async function saveMemory(params: SaveMemoryParams): Promise<string> {
  const sql = getDb();

  const scope = params.scope ?? 'personal';

  if (params.embedding) {
    const embeddingStr = `[${params.embedding.join(",")}]`;
    const [row] = await sql.unsafe(
      `INSERT INTO memories (user_id, bot_name, content, summary, tags, source_message_id, embedding, scope)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)
       RETURNING id`,
      [
        params.userId,
        params.botName,
        params.content,
        params.summary,
        params.tags,
        params.sourceMessageId ?? null,
        embeddingStr,
        scope,
      ],
    );
    return row!.id;
  }

  const [row] = await sql`
    INSERT INTO memories (user_id, bot_name, content, summary, tags, source_message_id, scope)
    VALUES (${params.userId}, ${params.botName}, ${params.content}, ${params.summary}, ${params.tags}, ${params.sourceMessageId ?? null}, ${scope})
    RETURNING id
  `;
  return row!.id;
}

export async function searchMemories(
  userId: string,
  query: string,
  limit = 5,
  botName?: string,
): Promise<Memory[]> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT id, user_id, content, summary, tags, scope, created_at,
             ts_rank(search_vector, plainto_tsquery('english', ${query})) AS rank
      FROM memories
      WHERE bot_name = ${botName}
        AND ((scope = 'personal' AND user_id = ${userId}) OR scope = 'shared')
        AND search_vector @@ plainto_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT ${limit}
    `
    : await sql`
      SELECT id, user_id, content, summary, tags, scope, created_at,
             ts_rank(search_vector, plainto_tsquery('english', ${query})) AS rank
      FROM memories
      WHERE user_id = ${userId}
        AND search_vector @@ plainto_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT ${limit}
    `;

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    content: r.content,
    summary: r.summary,
    tags: r.tags,
    scope: r.scope,
    createdAt: new Date(r.created_at).getTime(),
  }));
}

export async function searchMemoriesHybrid(
  userId: string,
  query: string,
  embedding: number[] | null,
  limit = 5,
  botName?: string,
): Promise<Memory[]> {
  if (!embedding) {
    return searchMemories(userId, query, limit, botName);
  }

  const sql = getDb();
  const embeddingStr = `[${embedding.join(",")}]`;

  // Reciprocal Rank Fusion: combine FTS + vector rankings
  // When botName is provided, include both personal (for this user) and shared memories
  const scopeFilter = botName
    ? `bot_name = $5 AND ((scope = 'personal' AND user_id = $1) OR scope = 'shared')`
    : `user_id = $1`;
  const params = botName
    ? [userId, query, embeddingStr, limit, botName]
    : [userId, query, embeddingStr, limit];

  const rows = await sql.unsafe(
    `WITH fts AS (
      SELECT id, user_id, content, summary, tags, scope, created_at,
             ROW_NUMBER() OVER (ORDER BY ts_rank(search_vector, plainto_tsquery('english', $2)) DESC) AS rank
      FROM memories
      WHERE ${scopeFilter}
        AND search_vector @@ plainto_tsquery('english', $2)
      LIMIT 20
    ),
    vec AS (
      SELECT id, user_id, content, summary, tags, scope, created_at,
             ROW_NUMBER() OVER (ORDER BY embedding <=> $3::vector) AS rank
      FROM memories
      WHERE ${scopeFilter}
        AND embedding IS NOT NULL
      LIMIT 20
    )
    SELECT
      COALESCE(f.id, v.id) AS id,
      COALESCE(f.user_id, v.user_id) AS user_id,
      COALESCE(f.content, v.content) AS content,
      COALESCE(f.summary, v.summary) AS summary,
      COALESCE(f.tags, v.tags) AS tags,
      COALESCE(f.scope, v.scope) AS scope,
      COALESCE(f.created_at, v.created_at) AS created_at,
      COALESCE(1.0 / (60 + f.rank), 0) + COALESCE(1.0 / (60 + v.rank), 0) AS rrf_score
    FROM fts f
    FULL OUTER JOIN vec v ON f.id = v.id
    ORDER BY rrf_score DESC
    LIMIT $4`,
    params,
  );

  return rows.map((r: any) => ({
    id: r.id,
    userId: r.user_id,
    content: r.content,
    summary: r.summary,
    tags: r.tags,
    scope: r.scope,
    createdAt: new Date(r.created_at).getTime(),
    similarity: Number(r.rrf_score),
  }));
}

export async function updateMemoryEmbedding(
  id: string,
  embedding: number[],
): Promise<void> {
  const sql = getDb();
  const embeddingStr = `[${embedding.join(",")}]`;
  await sql.unsafe(
    `UPDATE memories SET embedding = $1::vector WHERE id = $2`,
    [embeddingStr, id],
  );
}

export async function getRecentMemories(limit = 20, botName?: string): Promise<Memory[]> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT id, user_id, content, summary, tags, scope, created_at
      FROM memories
      WHERE bot_name = ${botName}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
    : await sql`
      SELECT id, user_id, content, summary, tags, scope, created_at
      FROM memories
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    content: r.content,
    summary: r.summary,
    tags: r.tags,
    scope: r.scope,
    createdAt: new Date(r.created_at).getTime(),
  }));
}

export interface MemoryUserSummary {
  userId: string;
  username: string | null;
  personalCount: number;
  sharedCount: number;
  totalCount: number;
  recentTags: string[];
  lastMemoryAt: number;
}

/** Get memory counts grouped by user, with scope breakdown and recent tags. */
export async function getMemoriesByUser(botName?: string): Promise<MemoryUserSummary[]> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT
        m.user_id,
        (SELECT username FROM messages WHERE user_id = m.user_id AND username IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS username,
        COUNT(*) FILTER (WHERE m.scope = 'personal')::int AS personal_count,
        COUNT(*) FILTER (WHERE m.scope = 'shared')::int AS shared_count,
        COUNT(*)::int AS total_count,
        MAX(m.created_at) AS last_memory_at,
        (SELECT array_agg(DISTINCT tag ORDER BY tag) FROM (
          SELECT unnest(m2.tags) AS tag FROM memories m2
          WHERE m2.user_id = m.user_id AND m2.bot_name = ${botName}
          ORDER BY m2.created_at DESC LIMIT 10
        ) sub) AS recent_tags
      FROM memories m
      WHERE m.bot_name = ${botName}
      GROUP BY m.user_id
      ORDER BY last_memory_at DESC
      LIMIT 100
    `
    : await sql`
      SELECT
        m.user_id,
        (SELECT username FROM messages WHERE user_id = m.user_id AND username IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS username,
        COUNT(*) FILTER (WHERE m.scope = 'personal')::int AS personal_count,
        COUNT(*) FILTER (WHERE m.scope = 'shared')::int AS shared_count,
        COUNT(*)::int AS total_count,
        MAX(m.created_at) AS last_memory_at,
        (SELECT array_agg(DISTINCT tag ORDER BY tag) FROM (
          SELECT unnest(m2.tags) AS tag FROM memories m2
          WHERE m2.user_id = m.user_id
          ORDER BY m2.created_at DESC LIMIT 10
        ) sub) AS recent_tags
      FROM memories m
      GROUP BY m.user_id
      ORDER BY last_memory_at DESC
      LIMIT 100
    `;
  return rows.map((r) => ({
    userId: r.user_id as string,
    username: (r.username as string) ?? null,
    personalCount: Number(r.personal_count),
    sharedCount: Number(r.shared_count),
    totalCount: Number(r.total_count),
    recentTags: (r.recent_tags as string[]) ?? [],
    lastMemoryAt: new Date(r.last_memory_at as string).getTime(),
  }));
}

/** Get memories for a specific user, optionally filtered by bot. */
export async function getMemoriesForUser(userId: string, limit = 20, botName?: string): Promise<Memory[]> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT id, user_id, content, summary, tags, scope, created_at
      FROM memories
      WHERE user_id = ${userId} AND bot_name = ${botName}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
    : await sql`
      SELECT id, user_id, content, summary, tags, scope, created_at
      FROM memories
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    content: r.content,
    summary: r.summary,
    tags: r.tags,
    scope: r.scope,
    createdAt: new Date(r.created_at).getTime(),
  }));
}

export async function getMemoriesWithoutEmbeddings(): Promise<
  { id: string; summary: string }[]
> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, summary FROM memories WHERE embedding IS NULL
  `;
  return rows.map((r) => ({ id: r.id, summary: r.summary }));
}

// --- Dashboard search (all users, all bots) ---

export interface DashboardSearchResult {
  id: string;
  userId: string;
  username: string | null;
  botName: string;
  content: string;
  summary: string;
  tags: string[];
  scope: MemoryScope;
  createdAt: number;
  similarity: number;
}

interface DashboardSearchOptions {
  query: string;
  embedding: number[] | null;
  mode: "hybrid" | "semantic" | "text";
  limit?: number;
  botName?: string;
  scope?: MemoryScope;
}

/** Search all memories across all users/bots for the dashboard. */
export async function dashboardSearchMemories(
  opts: DashboardSearchOptions,
): Promise<DashboardSearchResult[]> {
  const sql = getDb();
  const limit = opts.limit ?? 25;

  if (opts.mode === "text" || !opts.embedding) {
    return dashboardSearchText(opts.query, limit, opts.botName, opts.scope);
  }

  if (opts.mode === "semantic") {
    return dashboardSearchSemantic(opts.embedding, limit, opts.botName, opts.scope);
  }

  // Hybrid: RRF of FTS + vector
  return dashboardSearchHybrid(opts.query, opts.embedding, limit, opts.botName, opts.scope);
}

async function dashboardSearchText(
  query: string,
  limit: number,
  botName?: string,
  scope?: MemoryScope,
): Promise<DashboardSearchResult[]> {
  const sql = getDb();
  const conditions: string[] = [`search_vector @@ plainto_tsquery('english', $1)`];
  const params: any[] = [query];
  let paramIdx = 2;

  if (botName) {
    conditions.push(`m.bot_name = $${paramIdx}`);
    params.push(botName);
    paramIdx++;
  }
  if (scope) {
    conditions.push(`m.scope = $${paramIdx}`);
    params.push(scope);
    paramIdx++;
  }

  params.push(limit);
  const limitParam = `$${paramIdx}`;

  const where = conditions.join(" AND ");
  const rows = await sql.unsafe(
    `SELECT m.id, m.user_id, m.bot_name, m.content, m.summary, m.tags, m.scope, m.created_at,
            ts_rank(m.search_vector, plainto_tsquery('english', $1)) AS similarity,
            (SELECT msg.username FROM messages msg WHERE msg.user_id = m.user_id AND msg.username IS NOT NULL ORDER BY msg.created_at DESC LIMIT 1) AS username
     FROM memories m
     WHERE ${where}
     ORDER BY similarity DESC
     LIMIT ${limitParam}`,
    params,
  );

  return rows.map(mapDashboardRow);
}

async function dashboardSearchSemantic(
  embedding: number[],
  limit: number,
  botName?: string,
  scope?: MemoryScope,
): Promise<DashboardSearchResult[]> {
  const sql = getDb();
  const embeddingStr = `[${embedding.join(",")}]`;
  const conditions: string[] = ["m.embedding IS NOT NULL"];
  const params: any[] = [embeddingStr];
  let paramIdx = 2;

  if (botName) {
    conditions.push(`m.bot_name = $${paramIdx}`);
    params.push(botName);
    paramIdx++;
  }
  if (scope) {
    conditions.push(`m.scope = $${paramIdx}`);
    params.push(scope);
    paramIdx++;
  }

  params.push(limit);
  const limitParam = `$${paramIdx}`;

  const where = conditions.join(" AND ");
  const rows = await sql.unsafe(
    `SELECT m.id, m.user_id, m.bot_name, m.content, m.summary, m.tags, m.scope, m.created_at,
            1 - (m.embedding <=> $1::vector) AS similarity,
            (SELECT msg.username FROM messages msg WHERE msg.user_id = m.user_id AND msg.username IS NOT NULL ORDER BY msg.created_at DESC LIMIT 1) AS username
     FROM memories m
     WHERE ${where}
     ORDER BY m.embedding <=> $1::vector
     LIMIT ${limitParam}`,
    params,
  );

  return rows.map(mapDashboardRow);
}

async function dashboardSearchHybrid(
  query: string,
  embedding: number[],
  limit: number,
  botName?: string,
  scope?: MemoryScope,
): Promise<DashboardSearchResult[]> {
  const sql = getDb();
  const embeddingStr = `[${embedding.join(",")}]`;
  const conditions: string[] = [];
  const params: any[] = [query, embeddingStr];
  let paramIdx = 3;

  if (botName) {
    conditions.push(`m.bot_name = $${paramIdx}`);
    params.push(botName);
    paramIdx++;
  }
  if (scope) {
    conditions.push(`m.scope = $${paramIdx}`);
    params.push(scope);
    paramIdx++;
  }

  params.push(limit);
  const limitParam = `$${paramIdx}`;

  const ftsWhere = [`m.search_vector @@ plainto_tsquery('english', $1)`, ...conditions].join(" AND ");
  const vecWhere = ["m.embedding IS NOT NULL", ...conditions].join(" AND ");

  const rows = await sql.unsafe(
    `WITH fts AS (
      SELECT m.id, m.user_id, m.bot_name, m.content, m.summary, m.tags, m.scope, m.created_at,
             ROW_NUMBER() OVER (ORDER BY ts_rank(m.search_vector, plainto_tsquery('english', $1)) DESC) AS rank
      FROM memories m
      WHERE ${ftsWhere}
      LIMIT 30
    ),
    vec AS (
      SELECT m.id, m.user_id, m.bot_name, m.content, m.summary, m.tags, m.scope, m.created_at,
             ROW_NUMBER() OVER (ORDER BY m.embedding <=> $2::vector) AS rank
      FROM memories m
      WHERE ${vecWhere}
      LIMIT 30
    )
    SELECT
      COALESCE(f.id, v.id) AS id,
      COALESCE(f.user_id, v.user_id) AS user_id,
      COALESCE(f.bot_name, v.bot_name) AS bot_name,
      COALESCE(f.content, v.content) AS content,
      COALESCE(f.summary, v.summary) AS summary,
      COALESCE(f.tags, v.tags) AS tags,
      COALESCE(f.scope, v.scope) AS scope,
      COALESCE(f.created_at, v.created_at) AS created_at,
      COALESCE(1.0 / (60 + f.rank), 0) + COALESCE(1.0 / (60 + v.rank), 0) AS rrf_score,
      (SELECT msg.username FROM messages msg WHERE msg.user_id = COALESCE(f.user_id, v.user_id) AND msg.username IS NOT NULL ORDER BY msg.created_at DESC LIMIT 1) AS username
    FROM fts f
    FULL OUTER JOIN vec v ON f.id = v.id
    ORDER BY rrf_score DESC
    LIMIT ${limitParam}`,
    params,
  );

  return rows.map((r: any) => ({
    ...mapDashboardRow(r),
    similarity: Number(r.rrf_score),
  }));
}

function mapDashboardRow(r: any): DashboardSearchResult {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username ?? null,
    botName: r.bot_name,
    content: r.content,
    summary: r.summary,
    tags: r.tags,
    scope: r.scope,
    createdAt: new Date(r.created_at).getTime(),
    similarity: Number(r.similarity ?? 0),
  };
}

/** Get aggregate stats for the search dashboard. */
export async function getSearchStats(botName?: string): Promise<{
  totalMemories: number;
  withEmbeddings: number;
  uniqueUsers: number;
  uniqueTags: number;
}> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(embedding)::int AS with_embeddings,
        COUNT(DISTINCT user_id)::int AS unique_users,
        (SELECT COUNT(DISTINCT tag)::int FROM (SELECT unnest(tags) AS tag FROM memories WHERE bot_name = ${botName}) sub) AS unique_tags
      FROM memories
      WHERE bot_name = ${botName}
    `
    : await sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(embedding)::int AS with_embeddings,
        COUNT(DISTINCT user_id)::int AS unique_users,
        (SELECT COUNT(DISTINCT tag)::int FROM (SELECT unnest(tags) AS tag FROM memories) sub) AS unique_tags
      FROM memories
    `;

  const row = rows[0]!;
  return {
    totalMemories: Number(row.total),
    withEmbeddings: Number(row.with_embeddings),
    uniqueUsers: Number(row.unique_users),
    uniqueTags: Number(row.unique_tags),
  };
}
