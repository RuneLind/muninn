import { getDb } from "./client.ts";
import type { Platform } from "../types.ts";

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  platform: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number | null;
}

/**
 * Ensure a user exists in the DB. Creates on first encounter, updates last_seen_at on every call.
 *
 * An existing username is only overwritten by a real value — not by an empty
 * string, the user's own id, or the `chat-user` placeholder that the chat layer
 * stamps onto a freshly-created (often peer-recreated) conversation shell. Without
 * that last guard a peer reply could recreate a user's conversation with the
 * placeholder name and the next typed message would clobber their real username.
 *
 * `lockUsername` is the structural backstop for the recurring "user renamed by a
 * hivemind peer" bug: when set, an already-established real username is NEVER
 * overwritten — only a placeholder (NULL/''/the id/'chat-user') is filled in.
 * Passive message turns on the **web** platform pass it (see message-processor),
 * so a transient label flowing through `conversation.username` (e.g. a peer's name
 * that leaked into the conversation shell) can't rename an established user. Names
 * on web are set explicitly via `addChatUser`, which leaves it false. Telegram /
 * Slack also leave it false because there the platform display name is
 * authoritative and should keep syncing.
 */
export async function ensureUser(params: {
  id: string;
  username: string;
  displayName?: string;
  platform: Platform | string;
  lockUsername?: boolean;
}): Promise<void> {
  const sql = getDb();
  const lock = params.lockUsername ?? false;
  await sql`
    INSERT INTO users (id, username, display_name, platform, last_seen_at)
    VALUES (${params.id}, ${params.username}, ${params.displayName ?? null}, ${params.platform}, now())
    ON CONFLICT (id) DO UPDATE SET
      username = CASE
        -- Incoming value is itself a placeholder → keep what we already have.
        WHEN EXCLUDED.username = ''
          OR EXCLUDED.username = users.id
          OR EXCLUDED.username = 'chat-user'
        THEN users.username
        -- Locked passive turn → never rename an already-established real name.
        WHEN ${lock}
          AND users.username IS NOT NULL
          AND users.username <> ''
          AND users.username <> users.id
          AND users.username <> 'chat-user'
        THEN users.username
        ELSE EXCLUDED.username
      END,
      display_name = COALESCE(EXCLUDED.display_name, users.display_name),
      last_seen_at = now()
  `;
}

export async function getUser(id: string): Promise<User | null> {
  const sql = getDb();
  const [row] = await sql`SELECT * FROM users WHERE id = ${id}`;
  return row ? mapRow(row) : null;
}

/**
 * Get users, optionally filtered by bot (via threads table).
 * Returns users who have at least one thread with the specified bot.
 */
export async function getUsers(botName?: string): Promise<User[]> {
  const sql = getDb();

  if (botName) {
    const rows = await sql`
      SELECT u.*
      FROM users u
      WHERE u.is_active = true
        AND EXISTS (SELECT 1 FROM threads t WHERE t.user_id = u.id AND t.bot_name = ${botName})
      ORDER BY u.last_seen_at DESC NULLS LAST
    `;
    return rows.map(mapRow);
  }

  const rows = await sql`
    SELECT * FROM users WHERE is_active = true ORDER BY last_seen_at DESC NULLS LAST
  `;
  return rows.map(mapRow);
}

export async function updateUser(
  id: string,
  updates: { username?: string; displayName?: string; isActive?: boolean },
): Promise<void> {
  const sql = getDb();
  const fields: string[] = [];
  const values: (string | boolean)[] = [];

  if (updates.username !== undefined) {
    fields.push("username");
    values.push(updates.username);
  }
  if (updates.displayName !== undefined) {
    fields.push("display_name");
    values.push(updates.displayName);
  }
  if (updates.isActive !== undefined) {
    fields.push("is_active");
    values.push(updates.isActive);
  }

  if (fields.length === 0) return;

  // Build dynamic update — postgres lib doesn't support dynamic column names,
  // so use unsafe with parameterized values
  const setClauses = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
  await sql.unsafe(
    `UPDATE users SET ${setClauses} WHERE id = $1`,
    [id, ...values],
  );
}

function mapRow(r: Record<string, unknown>): User {
  return {
    id: r.id as string,
    username: r.username as string,
    displayName: (r.display_name as string) ?? null,
    platform: r.platform as string,
    isActive: r.is_active as boolean,
    createdAt: new Date(r.created_at as string).getTime(),
    updatedAt: new Date(r.updated_at as string).getTime(),
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at as string).getTime() : null,
  };
}
