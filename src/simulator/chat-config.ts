import { ensureUser } from "../db/users.ts";
import { ensureDefaultThread } from "../db/threads.ts";
import { getDb } from "../db/client.ts";
import { getLog } from "../logging.ts";

const log = getLog("simulator", "chat-config");

export interface ChatUser {
  id: string;
  name: string;
  bot: string;
}

export interface ChatConfig {
  users: ChatUser[];
}

/** Load chat users from the DB, optionally filtered by bot. */
export async function loadChatConfig(botName?: string): Promise<ChatConfig | null> {
  const sql = getDb();

  const rows = await sql`
    SELECT DISTINCT u.id, u.username, t.bot_name
    FROM users u
    JOIN threads t ON t.user_id = u.id
    WHERE u.is_active = true
    ${botName ? sql`AND t.bot_name = ${botName}` : sql``}
    ORDER BY u.username
  `;

  if (rows.length === 0) return null;

  const chatUsers: ChatUser[] = rows.map((r) => ({
    id: r.id as string,
    name: r.username as string,
    bot: r.bot_name as string,
  }));

  return { users: chatUsers };
}

/** Add a user via the DB (replaces the old file-based approach). */
export async function addChatUser(user: ChatUser): Promise<void> {
  await ensureUser({
    id: user.id,
    username: user.name,
    platform: "web",
  });
  await ensureDefaultThread(user.id, user.bot);
  log.info("Added chat user {id} for bot {bot}", { id: user.id, bot: user.bot });
}

/**
 * One-time migration: import users from chat.config.json into the DB,
 * then rename the file so it's not re-imported.
 */
export async function migrateChatConfigFile(): Promise<number> {
  const file = Bun.file("chat.config.json");
  if (!(await file.exists())) return 0;

  try {
    const raw = await file.json();
    if (!raw?.users || !Array.isArray(raw.users) || raw.users.length === 0) {
      return 0;
    }

    const users: ChatUser[] = raw.users.filter(
      (u: unknown) =>
        typeof u === "object" &&
        u !== null &&
        typeof (u as ChatUser).id === "string" &&
        typeof (u as ChatUser).name === "string" &&
        typeof (u as ChatUser).bot === "string",
    );

    let imported = 0;
    for (const user of users) {
      await ensureUser({ id: user.id, username: user.name, platform: "web" });
      await ensureDefaultThread(user.id, user.bot);
      imported++;
    }

    // Rename file so we don't re-import
    const fs = await import("node:fs/promises");
    await fs.rename("chat.config.json", ".chat.config.json.migrated");
    log.info("Migrated {count} users from chat.config.json to DB", { count: imported });
    return imported;
  } catch (err) {
    log.warn("Failed to migrate chat.config.json: {error}", { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

