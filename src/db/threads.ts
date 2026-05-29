import type postgres from "postgres";
import { getDb } from "./client.ts";

// postgres TransactionSql loses call signatures due to Omit — use Sql type instead
type Sql = postgres.Sql;

export interface Thread {
  id: string;
  userId: string;
  botName: string;
  name: string;
  description?: string;
  connectorId?: string;
  isActive: boolean;
  autoRespondPaused: boolean;
  /** Free-form text shown in the chat pause pill; null when not paused. */
  pauseReason?: string;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
  /** Joined from connectors table */
  connectorName?: string;
  connectorType?: string;
  connectorModel?: string;
}

function rowToThread(r: Record<string, unknown>): Thread {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    botName: r.bot_name as string,
    name: r.name as string,
    description: (r.description as string) ?? undefined,
    connectorId: (r.connector_id as string) ?? undefined,
    isActive: r.is_active as boolean,
    autoRespondPaused: (r.auto_respond_paused as boolean) ?? false,
    pauseReason: (r.pause_reason as string) ?? undefined,
    createdAt: new Date(r.created_at as string).getTime(),
    updatedAt: new Date(r.updated_at as string).getTime(),
    messageCount: r.message_count != null ? Number(r.message_count) : undefined,
    connectorName: (r.connector_name as string) ?? undefined,
    connectorType: (r.connector_type as string) ?? undefined,
    connectorModel: (r.connector_model as string) ?? undefined,
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

/** Get a single thread by ID (with connector info). */
export async function getThreadById(threadId: string): Promise<Thread | null> {
  const sql = getDb();
  const [row] = await sql`
    SELECT t.*, c.name AS connector_name, c.connector_type, c.model AS connector_model
    FROM threads t
    LEFT JOIN connectors c ON c.id = t.connector_id
    WHERE t.id = ${threadId}
  `;
  return row ? rowToThread(row) : null;
}

/** Update a thread's connector_id. Pass null to clear. Returns false if thread not found. */
export async function updateThreadConnector(threadId: string, connectorId: string | null): Promise<boolean> {
  const sql = getDb();
  const result = await sql`UPDATE threads SET connector_id = ${connectorId} WHERE id = ${threadId}`;
  return result.count > 0;
}

/**
 * Set the hivemind autorespond pause flag on a thread. When `paused=false`,
 * pause_reason is cleared. When `paused=true`, the optional reason is stored
 * (e.g. "20-turn/hour cap") so the chat header pill can render the cause.
 */
export async function setThreadAutoRespondPaused(
  threadId: string,
  paused: boolean,
  reason?: string | null,
): Promise<boolean> {
  const sql = getDb();
  const nextReason = paused ? (reason ?? null) : null;
  const result = await sql`
    UPDATE threads
    SET auto_respond_paused = ${paused},
        pause_reason = ${nextReason}
    WHERE id = ${threadId}
  `;
  return result.count > 0;
}

/** Check if a thread with the given name exists for a user+bot. */
export async function findThreadByName(userId: string, botName: string, name: string): Promise<Thread | null> {
  const sql = getDb();
  const normalized = name.toLowerCase().trim();
  const [row] = await sql`
    SELECT * FROM threads
    WHERE user_id = ${userId} AND bot_name = ${botName} AND name = ${normalized}
  `;
  return row ? rowToThread(row) : null;
}

/** Create a new thread without deactivating others. For web UI thread creation. */
export async function createThread(userId: string, botName: string, name: string, description?: string, connectorId?: string): Promise<Thread> {
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

  const desc = description?.trim() || null;
  const cId = connectorId || null;
  const [row] = await sql`
    INSERT INTO threads (user_id, bot_name, name, description, connector_id, is_active)
    VALUES (${userId}, ${botName}, ${normalized}, ${desc}, ${cId}, false)
    ON CONFLICT (user_id, bot_name, name) DO UPDATE SET
      updated_at = now(),
      description = COALESCE(EXCLUDED.description, threads.description),
      connector_id = COALESCE(EXCLUDED.connector_id, threads.connector_id)
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

/** List all threads for a user+bot, with message counts and last-message activity time.
 *  Messages with NULL thread_id (e.g. from watchers/scheduled tasks) are excluded from
 *  activity calculations so they don't inflate the "main" thread's last-activity time. */
export async function listThreads(userId: string, botName: string): Promise<Thread[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT t.*,
      COALESCE(m.cnt, 0) AS message_count,
      m.last_activity,
      c.name AS connector_name,
      c.connector_type,
      c.model AS connector_model
    FROM threads t
    LEFT JOIN connectors c ON c.id = t.connector_id
    LEFT JOIN (
      SELECT
        thread_id AS tid,
        COUNT(*) AS cnt,
        MAX(created_at) AS last_activity
      FROM messages
      WHERE user_id = ${userId} AND bot_name = ${botName}
        AND thread_id IS NOT NULL
      GROUP BY thread_id
    ) m ON m.tid = t.id
    WHERE t.user_id = ${userId} AND t.bot_name = ${botName}
    ORDER BY COALESCE(m.last_activity, t.created_at) DESC
  `;
  return rows.map((r) => ({
    ...rowToThread(r),
    updatedAt: new Date((r.last_activity ?? r.created_at) as string).getTime(),
  }));
}

/**
 * Upsert an always-inactive system thread (Slack channel threads, hivemind
 * peer threads). SELECT-first to avoid a no-op UPDATE+WAL write on the common
 * case where the thread already exists; falls back to a race-safe INSERT for
 * first-time creation.
 */
async function upsertInactiveThread(userId: string, botName: string, name: string): Promise<Thread> {
  const sql = getDb();
  const [existing] = await sql`
    SELECT * FROM threads
    WHERE user_id = ${userId} AND bot_name = ${botName} AND name = ${name}
  `;
  if (existing) return rowToThread(existing);
  const [row] = await sql`
    INSERT INTO threads (user_id, bot_name, name, is_active)
    VALUES (${userId}, ${botName}, ${name}, false)
    ON CONFLICT (user_id, bot_name, name) DO UPDATE SET updated_at = now()
    RETURNING *
  `;
  return rowToThread(row!);
}

/** Thread name format: `slack:{channel}:{threadTs}` — always inactive. */
export async function getOrCreateSlackThread(
  userId: string, botName: string, channel: string, threadTs: string,
): Promise<string> {
  const thread = await upsertInactiveThread(userId, botName, `slack:${channel}:${threadTs}`);
  return thread.id;
}

/**
 * Hivemind peer thread. Name uses cwd basename rather than the broker's
 * `from_id` UUID so the same conversation lands in the same thread across
 * peer reconnects.
 */
export async function getOrCreatePeerThread(
  userId: string, botName: string, peerName: string,
): Promise<Thread> {
  return upsertInactiveThread(userId, botName, `peer:${peerName}`);
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

/** Cascade-delete a thread's memories → messages → thread row within a tx, then
 *  re-activate the "main" thread if the deleted one was active. The FK from
 *  memories → messages has no ON DELETE cascade, so the order matters. */
async function cascadeDeleteThread(
  tx: Sql,
  threadId: string,
  userId: string,
  botName: string,
  wasActive: boolean,
): Promise<void> {
  // Cascade: memories → messages → thread
  await tx`
    DELETE FROM memories
    WHERE source_message_id IN (SELECT id FROM messages WHERE thread_id = ${threadId})
  `;
  await tx`DELETE FROM messages WHERE thread_id = ${threadId}`;
  await tx`DELETE FROM threads WHERE id = ${threadId}`;

  // If deleted thread was active, activate main thread within the same transaction
  if (wasActive) {
    await tx`
      INSERT INTO threads (user_id, bot_name, name, is_active)
      VALUES (${userId}, ${botName}, 'main', true)
      ON CONFLICT (user_id, bot_name, name) DO UPDATE
        SET is_active = true
    `;
  }
}

/** Delete a thread by name, including its messages and associated memories.
 *  Cannot delete the "main" thread. If the deleted thread was active, switches to main. */
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

    await cascadeDeleteThread(tx, target.id as string, userId, botName, target.is_active as boolean);

    return true;
  });
}

/** Delete a thread by ID, including its messages and associated memories.
 *  Returns the deleted thread info, or null if not found / is main. */
export async function deleteThreadById(threadId: string): Promise<Thread | null> {
  const sql = getDb();

  return await sql.begin(async (_tx) => {
    const tx = _tx as unknown as Sql;

    const [target] = await tx`
      SELECT * FROM threads WHERE id = ${threadId}
    `;

    if (!target) return null;
    if ((target.name as string) === "main") return null;

    const thread = rowToThread(target);

    await cascadeDeleteThread(tx, threadId, thread.userId, thread.botName, target.is_active as boolean);

    return thread;
  });
}
