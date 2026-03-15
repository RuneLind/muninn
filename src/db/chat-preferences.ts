import { getDb } from "./client.ts";

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
