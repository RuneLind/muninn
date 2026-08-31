import { test, expect, describe, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { TEST_DATABASE_URL } from "../test/test-db-url.ts";

/**
 * `db/migrate.ts` — which database its CLI entry actually talks to.
 *
 * The runner's dev default (`…@127.0.0.1:5435/muninn`) is reachable on a
 * developer machine and on CI alike, so "does it fall back?" cannot be answered
 * from the process's own output — a `--status` against the wrong database looks
 * exactly like a `--status` against the right one. The discriminator is the
 * SCRATCH database: `--status` calls `ensureMigrationsTable`, so a run that
 * really targeted it leaves a `schema_migrations` table behind, and a run that
 * fell through to the default leaves it untouched.
 *
 * Driven as a PROCESS because the resolution lives in the `import.meta.main`
 * block; `runMigrations` takes the URL as an argument and never sees an env var.
 */
/**
 * Each case SPAWNS `bun db/migrate.ts --status` and opens Postgres connections,
 * so bun's 5s per-test default is not a budget these can live inside on a loaded
 * machine. Measured on this repo's CI runner: two consecutive failures at
 * 5000.04ms and 5001.04ms — a timeout, not an assertion, and green on every
 * re-run and on every developer machine, i.e. the local-green/CI-red shape.
 *
 * Set in the FILE rather than as a `--timeout` flag in package.json, for the
 * same reason `db/provision.test.ts` does it: running `bun test <this file>`
 * directly is how these cases get iterated on, and a flag in the script does not
 * travel with them.
 */
setDefaultTimeout(30_000);

const SCRATCH_DB = "muninn_dburl_test";

/** Swap the database NAME, keeping any `?sslmode=` tail — the same helper (and
 *  the same reason for its shape) as `require-provisioned.test.ts`. */
function withDatabase(url: string, name: string): string {
  return url.replace(/\/[^/?#]*(?=(\?|#|$))/, `/${name}`);
}

const ADMIN_URL = withDatabase(TEST_DATABASE_URL, "muninn");
const SCRATCH_URL = withDatabase(TEST_DATABASE_URL, SCRATCH_DB);
/** A database name nothing creates — pointed at from the variable that must
 *  NOT win, so adopting it would be a visible connection failure. */
const NOWHERE_URL = withDatabase(TEST_DATABASE_URL, "muninn_dburl_test_nowhere");
/** `fileURLToPath`, never `.pathname` — a checkout under a path with a space
 *  comes back percent-encoded and the spawn fails. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

async function admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try { return await fn(sql); } finally { await sql.end(); }
}

/** Bun auto-loads `.env`, which on a developer machine carries a real
 *  DATABASE_URL — an explicit empty string is what beats the dotenv line (the
 *  `src/test/ambient-env.ts` rule). Same for DB_URL, so a machine that happens
 *  to export one cannot decide the outcome. */
async function migrateStatus(env: { DATABASE_URL?: string; DB_URL?: string }): Promise<number> {
  const proc = Bun.spawn(["bun", "db/migrate.ts", "--status"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: "", DB_URL: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  return await proc.exited;
}

/** Did the run just reach into the scratch database? */
async function scratchTouched(): Promise<boolean> {
  const sql = postgres(SCRATCH_URL, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS touched`;
    return Boolean(row?.touched);
  } finally {
    await sql.end();
  }
}

async function resetScratch(): Promise<void> {
  await admin(async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  });
}

beforeAll(resetScratch);

afterAll(async () => {
  await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`));
});

describe("db/migrate.ts database URL resolution", () => {
  test("adopts DB_URL when DATABASE_URL is unset", async () => {
    // The defect this pins: nais hands the pod DB_URL (envVarPrefix: DB) and
    // `scripts/docker-entrypoint.sh` exports DATABASE_URL from it — but every
    // remedy this repo prints for a pod (`kubectl debug … -- bun db/migrate.ts
    // --baseline`, a naisjob with its own `command:`) REPLACES that entrypoint.
    // On a pod (DATABASE_URL genuinely absent) the old read fell through to
    // the dev default and migrated whatever answers on 127.0.0.1:5435. In THIS
    // harness DATABASE_URL is blanked to "", which the old `??` kept as a
    // connection string — either way the run never reached SCRATCH_URL, which
    // is what the scratchTouched() assertion pins.
    expect(await migrateStatus({ DB_URL: SCRATCH_URL })).toBe(0);
    expect(await scratchTouched()).toBe(true);
  });

  test("DATABASE_URL wins over DB_URL", async () => {
    // docker-compose sets DATABASE_URL directly and must beat an inherited
    // DB_URL. DB_URL names a database that does not exist, so an adoption here
    // is a non-zero exit rather than a silent pass.
    await resetScratch();
    expect(await migrateStatus({ DATABASE_URL: SCRATCH_URL, DB_URL: NOWHERE_URL })).toBe(0);
    expect(await scratchTouched()).toBe(true);
  });
});
