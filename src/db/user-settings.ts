import { getDb } from "./client.ts";
import type { UserSettings } from "../types.ts";

const DEFAULT_SETTINGS: Omit<UserSettings, "userId"> = {
  quietStart: null,
  quietEnd: null,
  timezone: "Europe/Oslo",
};

export async function getUserSettings(userId: string): Promise<UserSettings> {
  const sql = getDb();
  const [row] = await sql`
    SELECT * FROM user_settings WHERE user_id = ${userId}
  `;
  if (!row) {
    return { userId, ...DEFAULT_SETTINGS };
  }
  return mapRow(row);
}

export async function upsertUserSettings(
  userId: string,
  settings: { quietStart?: number | null; quietEnd?: number | null; timezone?: string },
): Promise<void> {
  const sql = getDb();
  const quietStart = settings.quietStart ?? null;
  const quietEnd = settings.quietEnd ?? null;
  const timezone = settings.timezone ?? "Europe/Oslo";
  await sql`
    INSERT INTO user_settings (user_id, quiet_start, quiet_end, timezone)
    VALUES (${userId}, ${quietStart}, ${quietEnd}, ${timezone})
    ON CONFLICT (user_id) DO UPDATE SET
      quiet_start = EXCLUDED.quiet_start,
      quiet_end = EXCLUDED.quiet_end,
      timezone = EXCLUDED.timezone
  `;
}

function mapRow(r: Record<string, any>): UserSettings {
  return {
    userId: r.user_id,
    quietStart: r.quiet_start ?? null,
    quietEnd: r.quiet_end ?? null,
    timezone: r.timezone,
  };
}
