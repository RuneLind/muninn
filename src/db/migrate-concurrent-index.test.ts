import { afterAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { TEST_DATABASE_URL } from "../test/test-db-url.ts";
import { runMigrations } from "../../db/migrate.ts";

/**
 * A `CREATE INDEX CONCURRENTLY` that fails part-way (killed job, cancel,
 * deadlock, a unique violation) leaves an INVALID index behind under its name.
 * A re-run's `IF NOT EXISTS` then skips it and records the migration, and the
 * index stays unusable for good. Migration 083 (`idx_traces_created`, the
 * retention delete's batch index) is the case driven here, with a real failed
 * build: a UNIQUE concurrent build over duplicate keys.
 */
const sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
afterAll(async () => {
  await sql`DELETE FROM traces WHERE name = 'migrate-concurrent-index-test'`;
  await sql.end();
});

async function indexState(name: string): Promise<{ valid: boolean; unique: boolean } | null> {
  const [row] = await sql`
    SELECT i.indisvalid AS valid, i.indisunique AS unique FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ${name} AND n.nspname = current_schema()`;
  return row ? { valid: row.valid, unique: row.unique } : null;
}

describe("db/migrate.ts: a CONCURRENTLY migration over an invalid index", () => {
  test("a re-run repairs the invalid index left by a failed build, then records the migration", async () => {
    await sql`DROP INDEX IF EXISTS idx_traces_created`;
    await sql`
      INSERT INTO traces (trace_id, name, created_at)
      SELECT gen_random_uuid(), 'migrate-concurrent-index-test', '2020-01-01T00:00:00Z' FROM generate_series(1, 2)`;
    // Fails on the duplicate key AFTER the catalog entry exists: an invalid index under 083's name.
    // `.then` first: bun's `expect(…).rejects` on a postgres.js query spins (measured: 100% CPU, never settles).
    const failed = await sql.unsafe("CREATE UNIQUE INDEX CONCURRENTLY idx_traces_created ON traces (created_at)").then(
      () => null,
      (e: Error) => e.message,
    );
    expect(failed).toContain("could not create unique index");
    expect(await indexState("idx_traces_created")).toEqual({ valid: false, unique: true });
    await sql`DELETE FROM schema_migrations WHERE version = '083'`;

    await runMigrations(TEST_DATABASE_URL, { quiet: true });

    expect(await indexState("idx_traces_created"), "083's own index, valid").toEqual({ valid: true, unique: false });
    const [recorded] = await sql`SELECT count(*)::int AS n FROM schema_migrations WHERE version = '083'`;
    expect(recorded!.n).toBe(1);
  });
});
