import { getDb } from "./client.ts";
import { getLog } from "../logging.ts";

const log = getLog("db", "role-overrides");

/**
 * DB-backed overrides for the process-wide role assignments that are otherwise
 * env-only. The key is the env-var name the override supersedes:
 *   - SUMMARIZER_BOT / RESEARCH_BOT — value is a bot name
 *   - HAIKU_BACKEND — value is a Haiku backend ("cli" | "anthropic" | "copilot")
 *
 * These overrides are HOT: the resolvers (resolveSummarizerBot /
 * resolveResearchBot in bots/config.ts, resolveBackendWithReason in
 * ai/haiku-direct.ts) are SYNC and run on hot paths, so they cannot await a DB
 * read per call. Instead they consult the in-memory snapshot below, which
 * `loadRoleOverrides()` primes at startup and every write refreshes. The
 * override beats the matching env var at resolution time.
 */
export type RoleKey = "SUMMARIZER_BOT" | "RESEARCH_BOT" | "HAIKU_BACKEND";

export const ROLE_KEYS: readonly RoleKey[] = ["SUMMARIZER_BOT", "RESEARCH_BOT", "HAIKU_BACKEND"];

export function isRoleKey(value: string): value is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(value);
}

/** In-memory snapshot. Empty until `loadRoleOverrides()` runs — before that the
 *  resolvers behave exactly as they did pre-PR (env/default only). */
const snapshot = new Map<RoleKey, string>();

/** Sync read of the snapshot — safe to call from the sync resolvers. */
export function getRoleOverride(role: RoleKey): string | undefined {
  return snapshot.get(role);
}

/** Snapshot as a plain record (for the /models overview + edit route). */
export function getAllRoleOverrides(): Partial<Record<RoleKey, string>> {
  return Object.fromEntries(snapshot) as Partial<Record<RoleKey, string>>;
}

/** Prime the snapshot from the DB. Called once after DB init in src/index.ts.
 *  Degrades to an empty snapshot (env/default resolution) if the table can't be
 *  read, so a fresh DB missing the migration never takes bots offline. */
export async function loadRoleOverrides(): Promise<void> {
  try {
    const sql = getDb();
    const rows = await sql`SELECT role, value FROM role_overrides`;
    snapshot.clear();
    for (const row of rows) {
      const role = row.role as string;
      if (isRoleKey(role)) snapshot.set(role, row.value as string);
    }
    log.info("Loaded {count} role override(s)", { count: snapshot.size });
  } catch (err) {
    log.warn("Failed to load role overrides — falling back to env/default: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Upsert an override + refresh the snapshot (so the change is hot). */
export async function setRoleOverride(role: RoleKey, value: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO role_overrides (role, value)
    VALUES (${role}, ${value})
    ON CONFLICT (role) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = now()
  `;
  snapshot.set(role, value);
}

/** Delete an override + refresh the snapshot (fall back to env/default). */
export async function clearRoleOverride(role: RoleKey): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM role_overrides WHERE role = ${role}`;
  snapshot.delete(role);
}

/** Test-only: reset the in-memory snapshot without touching the DB. */
export function _resetSnapshotForTests(entries?: Partial<Record<RoleKey, string>>): void {
  snapshot.clear();
  for (const [k, v] of Object.entries(entries ?? {})) {
    if (isRoleKey(k) && typeof v === "string") snapshot.set(k, v);
  }
}
