import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { TEST_DATABASE_URL } from "../test/test-db-url.ts";
import { runMigrations } from "../../db/migrate.ts";

/**
 * A `CREATE INDEX CONCURRENTLY` that fails part-way (killed job, cancel,
 * deadlock, a unique violation) leaves an INVALID index behind. A re-run's
 * `IF NOT EXISTS` skips it and records the migration, and the index stays
 * unusable for good. The runner therefore drops every invalid index in the
 * current schema before a CONCURRENTLY migration and records nothing while one
 * remains after it. Failed builds here are real: a UNIQUE concurrent build over
 * duplicate keys. Probe migrations live in a temp dir (`migrationsDir`) under
 * versions 9xx, removed with their indexes after each test.
 */
const sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
const OTHER_SCHEMA = "migrate_concurrent_other";
const dirs: string[] = [];

afterEach(async () => {
  await sql`DELETE FROM schema_migrations WHERE version LIKE '9%'`;
  await sql`DROP INDEX IF EXISTS idx_probe_name`;
  await sql`DROP INDEX IF EXISTS idx_probe_invalid`;
  // The unnamed probe index gets a Postgres-chosen name: drop every index on (name, started_at).
  const unnamed = await sql`
    SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'traces'::regclass AND pg_get_indexdef(i.indexrelid) LIKE '%(name, started_at)%'`;
  for (const { relname } of unnamed) await sql`DROP INDEX IF EXISTS ${sql(relname)}`;
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${OTHER_SCHEMA} CASCADE`);
  // A failed pre-drop case must not leave 083's index invalid for the files after this one.
  if ((await indexState("idx_traces_created"))?.valid === false) await sql`DROP INDEX idx_traces_created`;
  await sql`CREATE INDEX IF NOT EXISTS idx_traces_created ON traces (created_at)`;
  await sql`DELETE FROM traces WHERE name = 'migrate-concurrent-index-test'`;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(async () => {
  await sql.end();
});

/** A migrations dir holding exactly `files`. */
function probeDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "muninn-migrate-probe-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

async function indexState(name: string, schema = "public"): Promise<{ valid: boolean; unique: boolean } | null> {
  const [row] = await sql`
    SELECT i.indisvalid AS valid, i.indisunique AS unique FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ${name} AND n.nspname = ${schema}`;
  return row ? { valid: row.valid, unique: row.unique } : null;
}

async function recorded(version: string): Promise<number> {
  const [row] = await sql`SELECT count(*)::int AS n FROM schema_migrations WHERE version = ${version}`;
  return row!.n;
}

/** Leave an INVALID unique index `name` on `table`(created_at) via a real failed concurrent build. */
async function failedUniqueBuild(name: string, table: string): Promise<void> {
  await sql.unsafe(`
    INSERT INTO ${table} (trace_id, name, created_at)
    SELECT gen_random_uuid(), 'migrate-concurrent-index-test', '2020-01-01T00:00:00Z' FROM generate_series(1, 2)`);
  // `.then` first: bun's `expect(…).rejects` on a postgres.js query spins (measured: 100% CPU, never settles).
  const failed = await sql
    .unsafe(`CREATE UNIQUE INDEX CONCURRENTLY ${name} ON ${table} (created_at)`)
    .then(() => null, (e: Error) => e.message);
  expect(failed).toContain("could not create unique index");
}

describe("db/migrate.ts: CONCURRENTLY migrations and invalid indexes", () => {
  test("pre-drop: the invalid index a failed build left under 083's name is dropped and 083 rebuilds it valid", async () => {
    await sql`DROP INDEX IF EXISTS idx_traces_created`;
    await failedUniqueBuild("idx_traces_created", "traces");
    expect(await indexState("idx_traces_created")).toEqual({ valid: false, unique: true });
    await sql`DELETE FROM schema_migrations WHERE version = '083'`;

    await runMigrations(TEST_DATABASE_URL, { quiet: true });

    expect(await indexState("idx_traces_created"), "083's own index, valid").toEqual({ valid: true, unique: false });
    expect(await recorded("083")).toBe(1);
  });

  test("an unnamed concurrent index applies and is recorded once, without a duplicate on a re-run", async () => {
    const dir = probeDir({ "901-unnamed-index.sql": "CREATE INDEX CONCURRENTLY ON traces (name, started_at);\n" });
    await runMigrations(TEST_DATABASE_URL, { quiet: true, migrationsDir: dir });
    await runMigrations(TEST_DATABASE_URL, { quiet: true, migrationsDir: dir });
    expect(await recorded("901")).toBe(1);
    const built = await sql`
      SELECT i.indisvalid AS valid FROM pg_index i
      WHERE i.indrelid = 'traces'::regclass AND pg_get_indexdef(i.indexrelid) LIKE '%(name, started_at)%'`;
    expect(built.map((r) => r.valid)).toEqual([true]);
  });

  test("post-check: an invalid index left after the file ran fails the migration and records nothing", async () => {
    await sql`CREATE INDEX idx_probe_invalid ON traces (name)`;
    // Runs bare (the word CONCURRENTLY is in the file) and invalidates an index AFTER the pre-drop.
    const dir = probeDir({
      "902-leaves-invalid.sql":
        "-- CONCURRENTLY\nUPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_probe_invalid'::regclass;\n",
    });
    const error = await runMigrations(TEST_DATABASE_URL, { quiet: true, migrationsDir: dir }).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(error).toContain("idx_probe_invalid");
    expect(await recorded("902")).toBe(0);
  });

  test("an invalid index in ANOTHER schema is left alone", async () => {
    await sql.unsafe(`CREATE SCHEMA ${OTHER_SCHEMA}`);
    await sql.unsafe(`CREATE TABLE ${OTHER_SCHEMA}.traces (trace_id UUID, name TEXT, created_at TIMESTAMPTZ)`);
    await failedUniqueBuild("idx_probe_other", `${OTHER_SCHEMA}.traces`);
    const dir = probeDir({ "903-named-index.sql": "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_probe_name ON traces (name);\n" });

    await runMigrations(TEST_DATABASE_URL, { quiet: true, migrationsDir: dir });

    expect(await indexState("idx_probe_other", OTHER_SCHEMA), "not this run's schema").toEqual({ valid: false, unique: true });
    expect(await indexState("idx_probe_name")).toEqual({ valid: true, unique: false });
    expect(await recorded("903")).toBe(1);
  });
});
