import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import postgres from "postgres";
import { TEST_DATABASE_URL } from "../test/test-db-url.ts";

/**
 * `db/require-provisioned.ts` — the container entrypoint's refusal to migrate
 * into an empty database.
 *
 * Driven as a PROCESS, because that is what it is: the whole contract is an
 * exit code plus an operator instruction on stderr, and the thing it protects
 * against (`ensureMigrationsTable` creating the very table a naive detector
 * would test for) only exists across process boundaries.
 *
 * The scratch database is created and dropped here rather than reusing
 * `muninn_test`, which is provisioned by construction — an "is it empty?" test
 * needs an actually-empty database.
 */
const SCRATCH_DB = "muninn_unprovisioned_test";
const ADMIN_URL = new URL(TEST_DATABASE_URL).toString().replace(/\/[^/]*$/, "/muninn");
const SCRATCH_URL = new URL(TEST_DATABASE_URL).toString().replace(/\/[^/]*$/, `/${SCRATCH_DB}`);

async function admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try { return await fn(sql); } finally { await sql.end(); }
}

async function runCheck(databaseUrl: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", "db/require-provisioned.ts"], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

beforeAll(async () => {
  await admin(async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  });
});

afterAll(async () => {
  await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`));
});

describe("db/require-provisioned.ts", () => {
  test("an empty database exits non-zero with the init.sql + baseline instruction", async () => {
    const { code, stderr } = await runCheck(SCRATCH_URL);
    expect(code).toBe(1);
    // A boot refusal is read once, in a container log. It has to carry the fix,
    // not a raw SQL error.
    expect(stderr).toContain("users");
    expect(stderr).toContain("db/init.sql");
    expect(stderr).toContain("--baseline");
  });

  test("a `schema_migrations` table alone does NOT satisfy it", async () => {
    // The predicate this file exists to pin. `ensureMigrationsTable` is a
    // CREATE TABLE IF NOT EXISTS, so after one failed attempt the tempting
    // detector reports "provisioned" for a database that is still empty — i.e.
    // it stops detecting exactly when it is needed.
    const scratch = postgres(SCRATCH_URL, { max: 1, onnotice: () => {} });
    try {
      await scratch`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    } finally {
      await scratch.end();
    }
    expect((await runCheck(SCRATCH_URL)).code).toBe(1);
  });

  test("the provisioned test database passes", async () => {
    const { code } = await runCheck(TEST_DATABASE_URL);
    expect(code).toBe(0);
  });

  test("an unset DATABASE_URL is its own exit code, not a crash", async () => {
    const proc = Bun.spawn(["bun", "db/require-provisioned.ts"], {
      cwd: new URL("../..", import.meta.url).pathname,
      // Bun auto-loads `.env`, which on a developer machine carries a real
      // DATABASE_URL — an explicit empty string is what beats the dotenv line
      // (the `src/test/ambient-env.ts` rule).
      env: { ...process.env, DATABASE_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(stderr).toContain("DATABASE_URL");
  });
});
