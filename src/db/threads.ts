import type postgres from "postgres";
import { getDb } from "./client.ts";

// postgres TransactionSql loses call signatures due to Omit — use Sql type instead
type Sql = postgres.Sql;

export interface Thread {
  id: string;
  userId: string;
  botName: string;
  name: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
}

function rowToThread(r: Record<string, unknown>): Thread {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    botName: r.bot_name as string,
    name: r.name as string,
    isActive: r.is_active as boolean,
    createdAt: new Date(r.created_at as string).getTime(),
    updatedAt: new Date(r.updated_at as string).getTime(),
    messageCount: r.message_count != null ? Number(r.message_count) : undefined,
  };
}

/** Get or create the "main" thread for a user+bot. Returns the thread id. */
export async function ensureDefaultThread(userId: string, botName: string): Promise<string> {
  const sql = getDb();

  // Upsert: insert main thread if it doesn't exist, activate if no other thread is active.
  // ON CONFLICT handles the race where two concurrent calls both try to create 'main'.
  const [row] = await sql`
    INSERT INTO threads (user_id, bot_name, name, is_active)
    VALUES (${userId}, ${botName}, 'main', true)
    ON CONFLICT (user_id, bot_name, name) DO UPDATE
      SET is_active = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM threads t2
          WHERE t2.user_id = ${userId} AND t2.bot_name = ${botName}
            AND t2.is_active = true AND t2.id != threads.id
        ) THEN true
        ELSE threads.is_active
      END
    RETURNING id
  `;
  return row!.id;
}

/** Get the active thread for a user+bot. Returns null if none. */
export async function getActiveThread(userId: string, botName: string): Promise<Thread | null> {
  const sql = getDb();
  const [row] = await sql`
    SELECT * FROM threads
    WHERE user_id = ${userId} AND bot_name = ${botName} AND is_active = true
  `;
  return row ? rowToThread(row) : null;
}

/** Get active thread id, creating the default "main" thread if needed. */
export async function getActiveThreadId(userId: string, botName: string): Promise<string> {
  const active = await getActiveThread(userId, botName);
  if (active) return active.id;
  return ensureDefaultThread(userId, botName);
}

/** Create a new thread without deactivating others. For web UI thread creation. */
export async function createThread(userId: string, botName: string, name: string): Promise<Thread> {
  const sql = getDb();
  const normalized = name.toLowerCase().trim();

  if (!normalized) {
    throw new Error("Thread name cannot be empty");
  }
  if (normalized.length > 50) {
    throw new Error("Thread name too long (max 50 characters)");
  }
  if (/[\n\r\t]/.test(normalized)) {
    throw new Error("Thread name cannot contain newlines or tabs");
  }

  const [row] = await sql`
    INSERT INTO threads (user_id, bot_name, name, is_active)
    VALUES (${userId}, ${botName}, ${normalized}, false)
    ON CONFLICT (user_id, bot_name, name) DO UPDATE SET updated_at = now()
    RETURNING *
  `;
  return rowToThread(row!);
}

/** Switch to a thread by name, creating it if it doesn't exist. Returns the thread. */
export async function switchThread(userId: string, botName: string, name: string): Promise<Thread> {
  const sql = getDb();
  const normalized = name.toLowerCase().trim();

  if (!normalized) {
    throw new Error("Thread name cannot be empty");
  }
  if (normalized.length > 50) {
    throw new Error("Thread name too long (max 50 characters)");
  }
  if (/[\n\r\t]/.test(normalized)) {
    throw new Error("Thread name cannot contain newlines or tabs");
  }

  return await sql.begin(async (_tx) => {
    const tx = _tx as unknown as Sql;

    // Deactivate current thread
    await tx`
      UPDATE threads SET is_active = false
      WHERE user_id = ${userId} AND bot_name = ${botName} AND is_active = true
    `;

    // Get or create the target thread
    const [existing] = await tx`
      SELECT * FROM threads
      WHERE user_id = ${userId} AND bot_name = ${botName} AND name = ${normalized}
    `;

    if (existing) {
      await tx`UPDATE threads SET is_active = true WHERE id = ${existing.id}`;
      return rowToThread({ ...existing, is_active: true });
    }

    // Create new thread
    const [row] = await tx`
      INSERT INTO threads (user_id, bot_name, name, is_active)
      VALUES (${userId}, ${botName}, ${normalized}, true)
      RETURNING *
    `;
    return rowToThread(row!);
  });
}

/** Get message count for a specific thread. */
export async function getThreadMessageCount(threadId: string): Promise<number> {
  const sql = getDb();
  const [row] = await sql`SELECT COUNT(*)::int AS cnt FROM messages WHERE thread_id = ${threadId}`;
  return row?.cnt ?? 0;
}

/** List all threads for a user+bot, with message counts. */
export async function listThreads(userId: string, botName: string): Promise<Thread[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT t.*, COALESCE(m.cnt, 0) AS message_count
    FROM threads t
    LEFT JOIN (
      SELECT thread_id, COUNT(*) AS cnt
      FROM messages
      WHERE thread_id IS NOT NULL
      GROUP BY thread_id
    ) m ON m.thread_id = t.id
    WHERE t.user_id = ${userId} AND t.bot_name = ${botName}
    ORDER BY t.updated_at DESC
  `;
  return rows.map(rowToThread);
}

/** Get or create a thread for a Slack channel thread. Returns the thread id.
 *  Thread name format: `slack:{channel}:{threadTs}` — always inactive (no topic switching). */
export async function getOrCreateSlackThread(
  userId: string, botName: string, channel: string, threadTs: string,
): Promise<string> {
  const name = `slack:${channel}:${threadTs}`;
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO threads (user_id, bot_name, name, is_active)
    VALUES (${userId}, ${botName}, ${name}, false)
    ON CONFLICT (user_id, bot_name, name) DO UPDATE SET updated_at = now()
    RETURNING id
  `;
  return row!.id;
}

/** Get all threads for a bot (or all bots), with message counts and username from latest message. */
export async function getAllThreadsForBot(botName?: string): Promise<(Thread & { username?: string })[]> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT t.*,
        COALESCE(mc.cnt, 0) AS message_count,
        lu.username
      FROM threads t
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS cnt FROM messages
        WHERE thread_id = t.id
           OR (thread_id IS NULL AND t.name = 'main' AND messages.user_id = t.user_id AND messages.bot_name = t.bot_name)
      ) mc ON true
      LEFT JOIN LATERAL (
        SELECT username FROM messages
        WHERE (thread_id = t.id OR (thread_id IS NULL AND t.name = 'main' AND messages.user_id = t.user_id AND messages.bot_name = t.bot_name))
          AND username IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      ) lu ON true
      WHERE t.bot_name = ${botName}
      ORDER BY t.updated_at DESC
      LIMIT 200
    `
    : await sql`
      SELECT t.*,
        COALESCE(mc.cnt, 0) AS message_count,
        lu.username
      FROM threads t
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS cnt FROM messages
        WHERE thread_id = t.id
           OR (thread_id IS NULL AND t.name = 'main' AND messages.user_id = t.user_id AND messages.bot_name = t.bot_name)
      ) mc ON true
      LEFT JOIN LATERAL (
        SELECT username FROM messages
        WHERE (thread_id = t.id OR (thread_id IS NULL AND t.name = 'main' AND messages.user_id = t.user_id AND messages.bot_name = t.bot_name))
          AND username IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      ) lu ON true
      ORDER BY t.updated_at DESC
      LIMIT 200
    `;
  return rows.map((r) => ({
    ...rowToThread(r),
    username: (r.username as string) ?? undefined,
  }));
}

/** Delete a thread (archive — messages remain but thread is removed). */
export async function deleteThread(userId: string, botName: string, name: string): Promise<boolean> {
  const sql = getDb();
  const normalized = name.toLowerCase().trim();

  if (normalized === "main") {
    return false; // Cannot delete the default thread
  }

  return await sql.begin(async (_tx) => {
    const tx = _tx as unknown as Sql;

    // Find the thread
    const [target] = await tx`
      SELECT id, is_active FROM threads
      WHERE user_id = ${userId} AND bot_name = ${botName} AND name = ${normalized}
    `;

    if (!target) return false;

    // FK has ON DELETE SET NULL — messages are automatically orphaned
    await tx`DELETE FROM threads WHERE id = ${target.id}`;

    // If deleted thread was active, activate main thread within the same transaction
    if (target.is_active) {
      await tx`
        INSERT INTO threads (user_id, bot_name, name, is_active)
        VALUES (${userId}, ${botName}, 'main', true)
        ON CONFLICT (user_id, bot_name, name) DO UPDATE
          SET is_active = true
        RETURNING id
      `;
    }

    return true;
  });
}
