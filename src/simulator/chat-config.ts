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

/** Clear cached config (for testing or hot-reload). */
export function clearChatConfigCache(): void {
  cached = undefined;
}
