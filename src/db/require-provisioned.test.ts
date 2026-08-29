import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { fileURLToPath } from "node:url";
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

/** Swap the database NAME, keeping everything else — a `?sslmode=` query
 *  string included, which a `.pathname` round-trip would have to re-attach and
 *  which the old `/[^/]*$/` form ate. */
function withDatabase(url: string, name: string): string {
  return url.replace(/\/[^/?#]*(?=(\?|#|$))/, `/${name}`);
}

const ADMIN_URL = withDatabase(TEST_DATABASE_URL, "muninn");
const SCRATCH_URL = withDatabase(TEST_DATABASE_URL, SCRATCH_DB);
/** `fileURLToPath`, never `.pathname` — a checkout under a path with a space
 *  (or any percent-encodable byte) comes back encoded and the spawn fails. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

async function admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try { return await fn(sql); } finally { await sql.end(); }
}

async function runCheck(databaseUrl: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", "db/require-provisioned.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

/** A fresh scratch database, empty. */
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

describe("db/require-provisioned.ts", () => {
  test("an empty database exits non-zero and names a remedy runnable FROM THIS IMAGE", async () => {
    const { code, stderr } = await runCheck(SCRATCH_URL);
    expect(code).toBe(1);
    // A boot refusal is read once, in a container log. It has to carry the fix,
    // not a raw SQL error.
    expect(stderr).toContain("users");
    expect(stderr).toContain("db/init.sql");

    // The load-bearing half, and the reason this assertion changed. The
    // refusal used to lead with `psql -f db/init.sql` and then admit psql is
    // not in the image — "run it from a machine that has it and can reach this
    // database". For a private-IP Cloud SQL instance whose app credentials live
    // only in the pod there IS no such machine, so the one command this refusal
    // printed was unrunnable exactly where it is printed. It must lead with the
    // applier, which the image can run.
    expect(stderr).toContain("db/provision.ts");
    const leadsWithProvision = stderr.indexOf("db/provision.ts") < stderr.indexOf("psql");
    expect(leadsWithProvision).toBe(true);
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
      // (the `src/test/ambient-env.ts` rule). DB_URL is blanked for the same
      // reason: it is a second source this script now reads, and a machine that
      // happens to export one must not turn "not set" into a live check.
      env: { ...process.env, DATABASE_URL: "", DB_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(stderr).toContain("DATABASE_URL");
    expect(stderr).toContain("DB_URL");
  });

  test("DB_URL is adopted when DATABASE_URL is unset", async () => {
    // The same hole `db/migrate.ts` had: nais hands the pod DB_URL and the
    // entrypoint exports DATABASE_URL from it, but this script is also run by
    // hand from a pod where that entrypoint never ran. Reading only
    // DATABASE_URL made it answer "not set" (exit 2) with the credentials right
    // there — so the check that guards the migration would be skipped by
    // whoever worked around it.
    // Its OWN empty database. An earlier case in this file leaves a lone
    // `schema_migrations` behind, and since the predicate became the whole
    // table set that is a DIFFERENT refusal with different words — so a case
    // about URL RESOLUTION was reading an assertion about schema state, and
    // passed or failed on test order.
    await resetScratch();
    const proc = Bun.spawn(["bun", "db/require-provisioned.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: "", DB_URL: SCRATCH_URL },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    // It really reached the scratch database: exit 1 is the REFUSAL (this
    // database has never been provisioned), not the exit 2 of an unresolved URL.
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain("never been provisioned");
  });
});

/**
 * PROVISIONED BUT NOT BASELINED — the second half of the same question, and the
 * one the compose production path actually lands in.
 *
 * `db/init.sql` creates `schema_migrations` EMPTY. A database provisioned that
 * way and never baselined has every table and no recorded migration, so the
 * runner computes "001 onwards are pending" and dies inside 006 with
 * `column "bot_name" of relation "messages" already exists` — under
 * `restart: unless-stopped` that is a crash-loop reporting a raw PostgresError
 * about a database that is fine and needs one command.
 *
 * Deliberately NOT auto-baselined: a schema laid down by an OLDER init.sql would
 * then be recorded as carrying migrations it has never seen, and the next real
 * migration would apply onto columns that do not exist.
 */
describe("db/require-provisioned.ts — provisioned but not baselined", () => {
  beforeAll(async () => {
    await resetScratch();
    const schema = await Bun.file(`${REPO_ROOT}/db/init.sql`).text();
    const sql = postgres(SCRATCH_URL, { max: 1, onnotice: () => {} });
    // One simple-protocol call: init.sql is exactly what an operator pipes into
    // psql, statements and all.
    try { await sql.unsafe(schema); } finally { await sql.end(); }
  });

  async function baseline(): Promise<number> {
    const proc = Bun.spawn(["bun", "db/migrate.ts", "--baseline"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: SCRATCH_URL },
      stdout: "pipe",
      stderr: "pipe",
    });
    return await proc.exited;
  }

  test("refuses, and the instruction is the BASELINE half — not init.sql again", async () => {
    const { code, stderr } = await runCheck(SCRATCH_URL);
    expect(code).toBe(1);
    expect(stderr).toContain("--baseline");
    // The distinguishing assertion: this database HAS the schema, so telling
    // the operator to apply init.sql would be telling them to do the one thing
    // that is already done.
    expect(stderr).not.toContain("-f db/init.sql");
    expect(stderr).toContain("schema_migrations");
  });

  test("after `db/migrate.ts --baseline` it passes, and migrate is a clean no-op", async () => {
    expect(await baseline()).toBe(0);
    expect((await runCheck(SCRATCH_URL)).code).toBe(0);
    // The whole point of the refusal: the very next thing the entrypoint runs
    // must not be the 006 crash.
    const migrate = Bun.spawn(["bun", "db/migrate.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: SCRATCH_URL },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(migrate.stderr).text();
    expect(`${await migrate.exited} ${stderr}`).toBe("0 ");
  });
});
