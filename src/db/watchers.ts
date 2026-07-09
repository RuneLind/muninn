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
  x: 86400000,      // 24 hours — daily digest
  anthropic: 7200000, // 2 hours — Atom feed polling (~12 feeds)
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
        AND (
          force_next_run = true
          OR last_run_at IS NULL
          OR last_run_at + (interval_ms || ' milliseconds')::interval <= now()
        )
      ORDER BY force_next_run DESC, last_run_at ASC NULLS FIRST
    `
    : await sql`
      SELECT * FROM watchers
      WHERE enabled = true
        AND (
          force_next_run = true
          OR last_run_at IS NULL
          OR last_run_at + (interval_ms || ' milliseconds')::interval <= now()
        )
      ORDER BY force_next_run DESC, last_run_at ASC NULLS FIRST
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
        last_notified_ids = ${sql.json(notifiedIds)},
        force_next_run = false
    WHERE id = ${id}
  `;
}

export async function forceRunWatcher(id: string): Promise<void> {
  const sql = getDb();
  await sql`UPDATE watchers SET force_next_run = true WHERE id = ${id}`;
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

export async function getWatcherById(id: string): Promise<Watcher | null> {
  const sql = getDb();
  const [row] = await sql`SELECT * FROM watchers WHERE id = ${id}`;
  return row ? mapRow(row) : null;
}

/**
 * The bot's `wiki-gardener` watcher row (oldest wins if somehow duplicated). The
 * manual backlog run needs its `id` — the `watcher_snapshots` offered-memory FK
 * is NOT NULL / ON DELETE CASCADE, so a missing row means the backlog feature is
 * unavailable for the bot.
 */
export async function getWikiGardenerWatcher(botName: string): Promise<Watcher | null> {
  const sql = getDb();
  const [row] = await sql`
    SELECT * FROM watchers
    WHERE bot_name = ${botName} AND type = 'wiki-gardener'
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return row ? mapRow(row) : null;
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

export async function updateWatcher(
  id: string,
  data: {
    name?: string;
    intervalMs?: number;
    enabled?: boolean;
    config?: Record<string, unknown>;
  },
): Promise<Watcher | null> {
  const sql = getDb();
  const updateObj: Record<string, unknown> = {};
  const cols: string[] = [];
  if (data.name !== undefined) { updateObj.name = data.name; cols.push("name"); }
  if (data.intervalMs !== undefined) {
    updateObj.interval_ms = data.intervalMs;
    cols.push("interval_ms");
    // Only reset last_run_at if the interval value is actually changing, so an unrelated
    // or no-op config edit doesn't silently shift the next fire time. (A previous version
    // reset unconditionally, which caused a daily hour-gated watcher to skip its fire day
    // when the setup script updated intervalMs to the same 24h value.)
    const [current] = await sql`SELECT interval_ms FROM watchers WHERE id = ${id}`;
    if (current && current.interval_ms !== data.intervalMs) {
      updateObj.last_run_at = new Date();
      cols.push("last_run_at");
    }
  }
  if (data.enabled !== undefined) { updateObj.enabled = data.enabled; cols.push("enabled"); }
  if (data.config !== undefined) { updateObj.config = data.config; cols.push("config"); }

  if (cols.length === 0) {
    const [row] = await sql`SELECT * FROM watchers WHERE id = ${id}`;
    return row ? mapRow(row) : null;
  }

  const [row] = await sql`
    UPDATE watchers SET ${sql(updateObj, ...cols)}
    WHERE id = ${id}
    RETURNING *
  `;
  return row ? mapRow(row) : null;
}

/**
 * Tier-2 snapshot accessors (Phase 3). The anthropic watcher stores its large
 * baseline SETs — the ~1753-URL llms.txt doc set + per-section blog slug sets —
 * here, one row per (watcher_id, key), so the per-run diff has something stable
 * to compare against. Kept out of last_notified_ids (400-cap, shared with
 * Tier-1 dedup) and config (updateWatcher overwrites the whole blob). JSONB is
 * returned already parsed by postgres.js, so callers get the array/object back.
 */
export async function getWatcherSnapshot(watcherId: string, key: string): Promise<unknown | null> {
  const sql = getDb();
  const [row] = await sql`
    SELECT value FROM watcher_snapshots WHERE watcher_id = ${watcherId} AND key = ${key}
  `;
  return row ? row.value : null;
}

export async function setWatcherSnapshot(watcherId: string, key: string, value: unknown): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO watcher_snapshots (watcher_id, key, value, updated_at)
    VALUES (${watcherId}, ${key}, ${sql.json(value as any)}, now())
    ON CONFLICT (watcher_id, key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = now()
  `;
}

function mapRow(r: Record<string, any>): Watcher {
  return {
    id: r.id,
    userId: r.user_id,
    botName: r.bot_name ?? "jarvis",
    name: r.name,
    type: r.type as WatcherType,
    config: r.config ?? {},
    intervalMs: r.interval_ms,
    enabled: r.enabled,
    lastRunAt: r.last_run_at ? new Date(r.last_run_at).getTime() : null,
    lastNotifiedIds: Array.isArray(r.last_notified_ids) ? r.last_notified_ids : [],
    forceNextRun: r.force_next_run ?? false,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  };
}
