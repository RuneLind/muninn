/**
 * "Is this database provisioned?" — the check the container entrypoint runs
 * BEFORE `db/migrate.ts`.
 *
 * Muninn's schema is not built by migrations. `db/init.sql` is the consolidated
 * schema and `db/migrate.ts --baseline` is what records the existing migrations
 * as applied; the migration runner only ever carries a database FORWARD. Point
 * it at an empty database and it happily applies migration 001 onwards onto
 * nothing, producing a half-schema that fails at the first table init.sql owns.
 *
 * **The predicate is `users`, not `schema_migrations`.** `schema_migrations` is
 * the tempting test and it is wrong twice over: `ensureMigrationsTable` is a
 * `CREATE TABLE IF NOT EXISTS`, so the runner CREATES the thing being tested —
 * which is also why this check must run as its own process, before the runner —
 * and after one failed attempt the table exists on a database that is still
 * empty, so the detector stops detecting exactly when it is needed. `users` is
 * init.sql's canonical identity table, has been there since the first schema,
 * and no migration creates it.
 *
 * Exit codes: 0 provisioned, 1 not provisioned (with the operator instruction),
 * 2 could not reach the database within the connect budget.
 *
 * Usage: `DATABASE_URL=… bun db/require-provisioned.ts`
 */
import postgres from "postgres";

/** How long to keep retrying a CONNECTION failure. Under docker-compose the app
 *  waits on a `service_healthy` postgres, and on nais the sidecar proxy is up
 *  before the container is scheduled — but both have a window where the socket
 *  is not answering yet, and a container that dies there is a crash-loop for a
 *  reason that resolves itself in two seconds. A refused CONNECTION is retried;
 *  an ANSWER of "no users table" is not, because that answer will not change. */
const CONNECT_BUDGET_MS = 30_000;
const RETRY_DELAY_MS = 1_000;

/**
 * Postgres error codes that will NOT resolve by waiting — the database does not
 * exist, or the credentials are wrong. Retrying those for the full budget turns
 * a config mistake into 30 seconds of silence before the message that names it,
 * on every restart of a crash-looping pod.
 */
const FATAL_PG_CODES = new Set([
  "3D000", // invalid_catalog_name — no such database
  "28P01", // invalid_password
  "28000", // invalid_authorization_specification
]);

const UNPROVISIONED_INSTRUCTION = [
  "",
  "  This database has no `users` table — it has never been provisioned.",
  "",
  "  Muninn's schema comes from db/init.sql, NOT from the migration runner:",
  "  db/migrate.ts only carries an existing schema forward. Running it against",
  "  an empty database would apply migrations onto nothing and leave a broken",
  "  half-schema.",
  "",
  "  Provision it once, against this DATABASE_URL:",
  "",
  "    psql \"$DATABASE_URL\" -f db/init.sql   # the consolidated schema",
  "    bun db/migrate.ts --baseline           # record those migrations as applied",
  "",
  "  Then restart this container; the entrypoint will run any pending migrations.",
  "",
].join("\n");

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set — cannot check whether the database is provisioned.");
    return 2;
  }

  const deadline = Date.now() + CONNECT_BUDGET_MS;
  let lastError = "";
  for (;;) {
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      // `to_regclass` answers NULL instead of throwing for an absent relation,
      // so "no such table" is a VALUE here rather than an error indistinguishable
      // from a connection fault.
      const [row] = await sql`SELECT to_regclass('public.users') IS NOT NULL AS provisioned`;
      if (row?.provisioned) return 0;
      console.error(UNPROVISIONED_INSTRUCTION);
      return 1;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string } | null)?.code;
      if (code && FATAL_PG_CODES.has(code)) {
        console.error(`Cannot use this database (${code}): ${lastError}`);
        return 2;
      }
      if (Date.now() >= deadline) {
        console.error(`Could not reach the database within ${CONNECT_BUDGET_MS / 1000}s: ${lastError}`);
        return 2;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    } finally {
      await sql.end().catch(() => {});
    }
  }
}

process.exit(await main());
