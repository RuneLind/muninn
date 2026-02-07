import { getDb } from "./client.ts";
import type { Memory } from "../types.ts";

interface SaveMemoryParams {
  userId: number;
  content: string;
  summary: string;
  tags: string[];
  sourceMessageId?: string;
  embedding?: number[] | null;
}

export async function saveMemory(params: SaveMemoryParams): Promise<string> {
  const sql = getDb();

  if (params.embedding) {
    const embeddingStr = `[${params.embedding.join(",")}]`;
    const [row] = await sql.unsafe(
      `INSERT INTO memories (user_id, content, summary, tags, source_message_id, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::vector)
       RETURNING id`,
      [
        params.userId,
        params.content,
        params.summary,
        params.tags,
        params.sourceMessageId ?? null,
        embeddingStr,
      ],
    );
    return row!.id;
  }

  const [row] = await sql`
    INSERT INTO memories (user_id, content, summary, tags, source_message_id)
    VALUES (${params.userId}, ${params.content}, ${params.summary}, ${params.tags}, ${params.sourceMessageId ?? null})
    RETURNING id
  `;
  return row!.id;
}

export async function searchMemories(
  userId: number,
  query: string,
  limit = 5,
): Promise<Memory[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, user_id, content, summary, tags, created_at,
           ts_rank(search_vector, plainto_tsquery('english', ${query})) AS rank
    FROM memories
    WHERE user_id = ${userId}
      AND search_vector @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: r.id,
    userId: Number(r.user_id),
    content: r.content,
    summary: r.summary,
    tags: r.tags,
    createdAt: new Date(r.created_at).getTime(),
  }));
}

export async function searchMemoriesHybrid(
  userId: number,
  query: string,
  embedding: number[] | null,
  limit = 5,
): Promise<Memory[]> {
  if (!embedding) {
    return searchMemories(userId, query, limit);
  }

  const sql = getDb();
  const embeddingStr = `[${embedding.join(",")}]`;

  // Reciprocal Rank Fusion: combine FTS + vector rankings
  const rows = await sql.unsafe(
    `WITH fts AS (
      SELECT id, user_id, content, summary, tags, created_at,
             ROW_NUMBER() OVER (ORDER BY ts_rank(search_vector, plainto_tsquery('english', $2)) DESC) AS rank
      FROM memories
      WHERE user_id = $1
        AND search_vector @@ plainto_tsquery('english', $2)
      LIMIT 20
    ),
    vec AS (
      SELECT id, user_id, content, summary, tags, created_at,
             ROW_NUMBER() OVER (ORDER BY embedding <=> $3::vector) AS rank
      FROM memories
      WHERE user_id = $1
        AND embedding IS NOT NULL
      LIMIT 20
    )
    SELECT
      COALESCE(f.id, v.id) AS id,
      COALESCE(f.user_id, v.user_id) AS user_id,
      COALESCE(f.content, v.content) AS content,
      COALESCE(f.summary, v.summary) AS summary,
      COALESCE(f.tags, v.tags) AS tags,
      COALESCE(f.created_at, v.created_at) AS created_at,
      COALESCE(1.0 / (60 + f.rank), 0) + COALESCE(1.0 / (60 + v.rank), 0) AS rrf_score
    FROM fts f
    FULL OUTER JOIN vec v ON f.id = v.id
    ORDER BY rrf_score DESC
    LIMIT $4`,
    [userId, query, embeddingStr, limit],
  );

  return rows.map((r: any) => ({
    id: r.id,
    userId: Number(r.user_id),
    content: r.content,
    summary: r.summary,
    tags: r.tags,
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

export async function getRecentMemories(limit = 20): Promise<Memory[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, user_id, content, summary, tags, created_at
    FROM memories
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    userId: Number(r.user_id),
    content: r.content,
    summary: r.summary,
    tags: r.tags,
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
