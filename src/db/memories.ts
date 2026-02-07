import { getDb } from "./client.ts";
import type { Memory } from "../types.ts";

interface SaveMemoryParams {
  userId: number;
  content: string;
  summary: string;
  tags: string[];
  sourceMessageId?: string;
}

export async function saveMemory(params: SaveMemoryParams): Promise<string> {
  const sql = getDb();
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
