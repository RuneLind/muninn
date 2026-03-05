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

let cached: ChatConfig | null | undefined;

/** Load chat.config.json from project root. Returns null if missing/empty/invalid. */
export async function loadChatConfig(): Promise<ChatConfig | null> {
  if (cached !== undefined) return cached;

  try {
    const file = Bun.file("chat.config.json");
    if (!(await file.exists())) {
      cached = null;
      return null;
    }
    const raw = await file.json();
    if (!raw?.users || !Array.isArray(raw.users) || raw.users.length === 0) {
      cached = null;
      return null;
    }
    // Validate entries
    const users: ChatUser[] = raw.users.filter(
      (u: unknown) =>
        typeof u === "object" &&
        u !== null &&
        typeof (u as ChatUser).id === "string" &&
        typeof (u as ChatUser).name === "string" &&
        typeof (u as ChatUser).bot === "string",
    );
    if (users.length === 0) {
      cached = null;
      return null;
    }
    cached = { users };
    log.info("Loaded chat config with {count} user-bot bindings", { count: users.length });
    return cached;
  } catch (err) {
    log.warn("Failed to load chat.config.json: {error}", { error: err instanceof Error ? err.message : String(err) });
    cached = null;
    return null;
  }
}

/** Add a user to chat.config.json (creates file if needed). Updates cache. */
export async function addChatUser(user: ChatUser): Promise<void> {
  // Force re-read from disk to get latest state
  cached = undefined;
  const current = await loadChatConfig();
  const users = [...(current?.users ?? [])];

  // Replace existing entry for same bot+id, or add new
  const existing = users.findIndex((u) => u.bot === user.bot && u.id === user.id);
  if (existing >= 0) {
    users[existing] = user;
  } else {
    users.push(user);
  }

  const config: ChatConfig = { users };
  await Bun.write("chat.config.json", JSON.stringify(config, null, 2) + "\n");
  cached = config;
  log.info("Updated chat.config.json: added user {id} for bot {bot}", { id: user.id, bot: user.bot });
}

/** Clear cached config (for testing or hot-reload). */
export function clearChatConfigCache(): void {
  cached = undefined;
}
