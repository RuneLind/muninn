import { getDb } from "./client.ts";
import { pinnedLocalUserId } from "../auth/policy.ts";

export interface ChatPreferences {
  userId: string;
  botName: string;
  preferredConnectorId: string | null;
}

export async function getChatPreferences(userId: string, botName: string): Promise<ChatPreferences> {
  const sql = getDb();
  const [row] = await sql`
    SELECT preferred_connector_id FROM chat_preferences
    WHERE user_id = ${userId} AND bot_name = ${botName}
  `;
  return {
    userId,
    botName,
    preferredConnectorId: (row?.preferred_connector_id as string) ?? null,
  };
}

export async function setPreferredConnector(userId: string, botName: string, connectorId: string | null): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO chat_preferences (user_id, bot_name, preferred_connector_id)
    VALUES (${userId}, ${botName}, ${connectorId})
    ON CONFLICT (user_id, bot_name) DO UPDATE SET
      preferred_connector_id = EXCLUDED.preferred_connector_id
  `;
}

// Bot-level default user (single source of truth for plugin + chat page)
export async function getBotDefaultUser(botName: string): Promise<string | null> {
  const sql = getDb();
  const [row] = await sql`
    SELECT user_id FROM bot_default_user WHERE bot_name = ${botName}
  `;
  const stored = (row?.user_id as string) ?? null;
  if (stored) return stored;
  // A stored value always wins. The fallback only covers the case PR C
  // created: on a `local` instance the chat page hides its user dropdown, and
  // that dropdown was this field's ONLY writer — so a fresh authenticating
  // instance has nothing here and six readers degrade with no log line. See
  // `pinnedLocalUserId` for why the answer is server-side rather than a client
  // write. Null in every other mode.
  return pinnedLocalUserId();
}

export async function setBotDefaultUser(botName: string, userId: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO bot_default_user (bot_name, user_id)
    VALUES (${botName}, ${userId})
    ON CONFLICT (bot_name) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      updated_at = now()
  `;
}
