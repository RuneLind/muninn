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
 * **There is a SECOND unready state, and it is the one the compose production
 * path lands in:** `init.sql` creates `schema_migrations` EMPTY, so a database
 * provisioned that way and never baselined has every table and no recorded
 * migration. The runner then computes "001 onwards are pending" and dies inside
 * 006 with `column "bot_name" of relation "messages" already exists` — under
 * `restart: unless-stopped`, a crash-loop reporting a raw PostgresError about a
 * database that is fine and needs one command. So `users` present + no recorded
 * migration is refused too, with the BASELINE half of the instruction.
 *
 * Deliberately NOT auto-baselined: a schema laid down by an OLDER `init.sql`
 * would be recorded as carrying migrations it has never seen, and the next real
 * migration would apply onto columns that do not exist. Which command to run is
 * the operator's call; naming it is ours.
 *
 * Exit codes: 0 ready, 1 not ready (with the operator instruction), 2 could not
 * reach the database within the connect budget.
 *
 * Usage: `DATABASE_URL=… bun db/require-provisioned.ts` (or `DB_URL=…`, nais's
 * envVarPrefix form — see ./database-url.ts; this script is normally run BY the
 * entrypoint, which exports one from the other, but it is also runnable by hand
 * from a pod where the entrypoint never ran).
 */
import { resolveCliDatabaseUrl, DATABASE_URL_ENV_NAMES } from "./database-url.ts";
import { openPostgres } from "./postgres-connection.ts";

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
  "  ONE command does both halves — apply db/init.sql, then record the shipped",
  "  migrations as applied — against the database this container resolved (from",
  "  DATABASE_URL, or nais's DB_URL when only that is set):",
  "",
  "    bun db/provision.ts --yes        # or: bun run db:provision -- --yes",
  "",
  "  `--yes` confirms the target: this applies 881 lines of DDL, and a bare",
  "  invocation in a checkout would resolve whatever `.env` names. Run it once",
  "  without the flag to see which database it resolved.",
  "",
  "  It needs no psql: the image carries bun, db/ and the postgres driver. But",
  "  NOT via `exec`: this container exits on the refusal you are reading, so",
  "  there is no running process to exec into. Pick whichever ONE of these",
  "  matches where you are:",
  "",
  "  · from a shell that has the same database URL and a checkout:",
  "",
  "      bun db/provision.ts --yes",
  "",
  "  · or a one-off container from this image (the --entrypoint override is",
  "    required, or this same refusal runs first):",
  "",
  "      docker compose run --rm --entrypoint bun app db/provision.ts --yes",
  "",
  "  · or, on Kubernetes, ad-hoc off the Deployment's own pod spec — the copy",
  "    inherits its env, its secret mounts and its sidecars, and db/provision.ts",
  "    reads nais's DB_URL itself:",
  "",
  "      kubectl debug deploy/<app> --copy-to=<app>-provision --container=<app> \\",
  "        --profile=general -- bun db/provision.ts --yes",
  "",
  "    (--profile=general is what kubectl wants; without it it warns that the",
  "    legacy profile is deprecated. Delete the copied pod afterwards.)",
  "",
  "  · or a one-off Job from the same image carrying the same env and secrets",
  "    (nais: a naisjob) — but it MUST set its own command, or the image's",
  "    default entrypoint re-runs the refusal you are reading first.",
  "",
  "  On a MANAGED instance the app user may not create an extension, and",
  "  db/init.sql opens with `CREATE EXTENSION IF NOT EXISTS vector`. Have an",
  "  elevated role run `CREATE EXTENSION vector` once first; init.sql's own",
  "  IF NOT EXISTS then short-circuits before the privilege check, so the app",
  "  user applies the rest. db/provision.ts says so if it hits that wall.",
  "",
  "  (psql -f db/init.sql still works from a machine that has psql AND can reach",
  "  this database — but a private-IP Cloud SQL instance has no such machine,",
  "  which is why the line above is the one this refusal leads with.)",
  "",
  "  Then restart this container; the entrypoint will run any pending migrations.",
  "",
].join("\n");

const UNBASELINED_INSTRUCTION = [
  "",
  "  This database HAS the schema (`users` exists) but `schema_migrations` records",
  "  nothing — it was provisioned from db/init.sql and never baselined.",
  "",
  "  db/init.sql creates `schema_migrations` empty, so the migration runner would",
  "  read \"everything is pending\" and re-apply migrations onto tables that already",
  "  carry them — it fails inside 006 with",
  "  `column \"bot_name\" of relation \"messages\" already exists`, which under a",
  "  restart policy is a crash-loop about a database that is in fact fine.",
  "",
  "  Record the shipped migrations as applied, against the database this",
  "  container resolved (from DATABASE_URL, or nais's DB_URL). This",
  "  image ships bun and db/, so no psql and no checkout are needed — but this",
  "  container EXITS on the refusal you are reading, so there is nothing to",
  "  `exec` into. Pick whichever ONE of these matches where you are:",
  "",
  "  · from a shell that has the same database URL (DATABASE_URL or DB_URL)",
  "    and a checkout:",
  "",
  "      bun db/migrate.ts --baseline         # or: bun run db:migrate:baseline",
  "",
  "  · or a one-off container from this image (the --entrypoint override is",
  "    required, or this same refusal runs first):",
  "",
  "      docker compose run --rm --entrypoint bun app db/migrate.ts --baseline",
  "",
  "  · or, on Kubernetes, ad-hoc off the Deployment's own pod spec — the copy",
  "    inherits its env and secrets, and db/migrate.ts reads nais's DB_URL",
  "    itself:",
  "",
  "      kubectl debug deploy/<app> --copy-to=<app>-baseline --container=<app> \\",
  "        --profile=general -- bun db/migrate.ts --baseline",
  "",
  "    (--profile=general is what kubectl wants; without it it warns that the",
  "    legacy profile is deprecated. Delete the copied pod afterwards.)",
  "",
  "  · or a one-off Job from the same image carrying the same env and secrets",
  "    (nais: a naisjob) — but it MUST set its own command, or the image's",
  "    default entrypoint re-runs the refusal you are reading first.",
  "",
  "  Then restart this container; the entrypoint will run any pending migrations.",
  "  (Not done automatically: a schema laid down by an OLDER init.sql would be",
  "  recorded as carrying migrations it never saw.)",
  "",
].join("\n");

async function main(): Promise<number> {
  const databaseUrl = resolveCliDatabaseUrl();
  if (!databaseUrl) {
    console.error(
      `${DATABASE_URL_ENV_NAMES} is not set — cannot check whether the database is provisioned.`,
    );
    return 2;
  }

  const deadline = Date.now() + CONNECT_BUDGET_MS;
  let lastError = "";
  for (;;) {
    // INSIDE the try, and that placement is the point. `openPostgres` throws on
    // a URL whose TLS material it cannot use — a wrong secret mount, an
    // `sslmode` typo. Constructed outside, that throw escapes `main()` as an
    // uncaught rejection, which exits 1 — this script's code for "the database
    // is empty, run init.sql". An operator (and anything reading the code)
    // would then chase a schema problem over a certificate path, with a stack
    // trace instead of the one-line diagnosis this script exists to print.
    // A configuration error is a 2: "could not use this database".
    let sql: ReturnType<typeof openPostgres>["sql"];
    try {
      ({ sql } = openPostgres(databaseUrl, { max: 1, onnotice: () => {} }));
    } catch (err) {
      console.error(
        `Cannot use this database URL: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 2;
    }
    try {
      // `to_regclass` answers NULL instead of throwing for an absent relation,
      // so "no such table" is a VALUE here rather than an error indistinguishable
      // from a connection fault.
      const [row] = await sql`
        SELECT to_regclass('public.users') IS NOT NULL AS provisioned,
               to_regclass('public.schema_migrations') IS NOT NULL AS tracked
      `;
      if (!row?.provisioned) {
        console.error(UNPROVISIONED_INSTRUCTION);
        return 1;
      }
      // The count is a SECOND statement on purpose: Postgres parses a whole
      // statement before running it, so a `CASE … ELSE (SELECT count(*) FROM
      // schema_migrations)` would fail to parse on the very database where the
      // table is missing.
      const recorded = row.tracked
        ? Number((await sql`SELECT count(*)::int AS n FROM schema_migrations`)[0]?.n ?? 0)
        : 0;
      if (recorded === 0) {
        console.error(UNBASELINED_INSTRUCTION);
        return 1;
      }
      return 0;
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

// `process.exitCode` + a natural exit, never `process.exit(code)`: the whole
// contract of this script is an instruction on stderr, and an immediate exit can
// truncate a pending write when stderr is a PIPE — which is exactly what it is
// under `docker logs`, a compose collector and the test that drives it.
process.exitCode = await main();
