import { getDb } from "./client.ts";
import type { Watcher, WatcherType } from "../types.ts";

interface SaveWatcherParams {
  userId: string;
  botName: string;
  name: string;
  type: WatcherType;
  config?: Record<string, string | number | boolean | null>;
  intervalMs?: number;
}

const DEFAULT_INTERVALS: Record<string, number> = {
  news: 3600000,    // 1 hour — news changes slower
};
const DEFAULT_INTERVAL_MS = 300000; // 5 minutes

export async function saveWatcher(params: SaveWatcherParams): Promise<string> {
  const sql = getDb();
  const intervalMs = params.intervalMs ?? DEFAULT_INTERVALS[params.type] ?? DEFAULT_INTERVAL_MS;
  const [row] = await sql`
    INSERT INTO watchers (user_id, bot_name, name, type, config, interval_ms)
    VALUES (
      ${params.userId},
      ${params.botName},
      ${params.name},
      ${params.type},
      ${sql.json(params.config ?? {})},
      ${intervalMs}
    )
    RETURNING id
  `;
  return row!.id;
}

export async function getWatchersDueNow(botName?: string): Promise<Watcher[]> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT * FROM watchers
      WHERE bot_name = ${botName} AND enabled = true
        AND (last_run_at IS NULL OR last_run_at + (interval_ms || ' milliseconds')::interval <= now())
      ORDER BY last_run_at ASC NULLS FIRST
    `
    : await sql`
      SELECT * FROM watchers
      WHERE enabled = true
        AND (last_run_at IS NULL OR last_run_at + (interval_ms || ' milliseconds')::interval <= now())
      ORDER BY last_run_at ASC NULLS FIRST
    `;
  return rows.map(mapRow);
}

export async function updateWatcherLastRun(
  id: string,
  notifiedIds: string[],
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE watchers
    SET last_run_at = now(),
        last_notified_ids = ${sql.json(notifiedIds)}
    WHERE id = ${id}
  `;
}

export async function getAllWatchers(botName?: string): Promise<Watcher[]> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT * FROM watchers
      WHERE bot_name = ${botName}
      ORDER BY enabled DESC, name
    `
    : await sql`
      SELECT * FROM watchers
      ORDER BY enabled DESC, name
    `;
  return rows.map(mapRow);
}

export async function getWatchersForUser(userId: string, botName?: string): Promise<Watcher[]> {
  const sql = getDb();
  const rows = botName
    ? await sql`
      SELECT * FROM watchers
      WHERE user_id = ${userId} AND bot_name = ${botName}
      ORDER BY enabled DESC, name
    `
    : await sql`
      SELECT * FROM watchers
      WHERE user_id = ${userId}
      ORDER BY enabled DESC, name
    `;
  return rows.map(mapRow);
}

export async function deleteWatcher(id: string): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM watchers WHERE id = ${id}`;
}

export async function toggleWatcher(
  id: string,
  enabled: boolean,
): Promise<void> {
  const sql = getDb();
  await sql`UPDATE watchers SET enabled = ${enabled} WHERE id = ${id}`;
}

function mapRow(r: Record<string, any>): Watcher {
  return {
    id: r.id,
    userId: r.user_id,
    botName: r.bot_name ?? "jarvis",
    name: r.name,
    type: r.type as WatcherType,
    config: typeof r.config === "string" ? JSON.parse(r.config) : r.config ?? {},
    intervalMs: r.interval_ms,
    enabled: r.enabled,
    lastRunAt: r.last_run_at ? new Date(r.last_run_at).getTime() : null,
    lastNotifiedIds: Array.isArray(r.last_notified_ids) ? r.last_notified_ids : [],
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  };
}
