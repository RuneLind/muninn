/**
 * "Which database is this CLI talking to?" — one answer for both db/ scripts.
 *
 * nais injects the Postgres credentials under a per-instance PREFIX, so the
 * platform hands the pod `DB_URL` rather than `DATABASE_URL` (the manifest asks
 * for it with `envVarPrefix: DB`). `scripts/docker-entrypoint.sh` exports one
 * from the other before it runs anything — but the entrypoint is exactly what a
 * `kubectl debug --copy-to=… -- bun db/migrate.ts --baseline`, a naisjob with
 * its own `command:`, or a `docker run --entrypoint` REPLACES, and those are the
 * remedies our own refusals name. A script that only reads `DATABASE_URL` then
 * silently falls through to its dev default and migrates a laptop.
 *
 * `DATABASE_URL` still wins: docker-compose sets it directly, and a shell that
 * exports it means it. Both reads are `||`, so a set-but-EMPTY value falls
 * through — for `DATABASE_URL=""` that is a deliberate change from the old
 * `??` (which passed `""` to postgres() as a connection string): an empty
 * adoption would turn "no database configured" into a parse error several
 * layers down, and for `db/migrate.ts` it now means the dev default instead.
 */

/** The resolved URL, or `undefined` when neither variable carries one. Callers
 *  decide what an absent URL means: `db/migrate.ts` falls back to its dev
 *  default, `db/require-provisioned.ts` refuses. */
export function resolveCliDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.DATABASE_URL || env.DB_URL || undefined;
}

/** The names this resolution reads, for an error message that has to tell an
 *  operator which variable to set. */
export const DATABASE_URL_ENV_NAMES = "DATABASE_URL (or DB_URL, the nais envVarPrefix form)";
