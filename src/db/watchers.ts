import { getDb } from "./client.ts";
import type { Watcher, WatcherType } from "../types.ts";

interface SaveWatcherParams {
  userId: number;
  name: string;
  type: WatcherType;
  config?: Record<string, unknown>;
  intervalMs?: number;
}

export async function saveWatcher(params: SaveWatcherParams): Promise<string> {
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO watchers (user_id, name, type, config, interval_ms)
    VALUES (
      ${params.userId},
      ${params.name},
      ${params.type},
      ${JSON.stringify(params.config ?? {})},
      ${params.intervalMs ?? 300000}
    )
    RETURNING id
  `;
  return row!.id;
}

export async function getWatchersDueNow(): Promise<Watcher[]> {
  const sql = getDb();
  const rows = await sql`
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
        last_notified_ids = ${JSON.stringify(notifiedIds)}
    WHERE id = ${id}
  `;
}

export async function getAllWatchers(): Promise<Watcher[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM watchers
    ORDER BY enabled DESC, name
  `;
  return rows.map(mapRow);
}

export async function getWatchersForUser(userId: number): Promise<Watcher[]> {
  const sql = getDb();
  const rows = await sql`
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
    userId: Number(r.user_id),
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
