/**
 * The provisioning applier, against a real database.
 *
 * Every case here needs Postgres — the whole point of `db/provision.ts` is
 * applying 881 lines of DDL as the app user, and nothing about that is provable
 * against a mock. It builds and drops its OWN database rather than reusing
 * `muninn_test`, because "apply init.sql to an empty database" and "the suite's
 * shared schema" are the same tables; the guard below is what keeps a typo from
 * pointing `DROP DATABASE` at either of the two real ones.
 */
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import postgres from "postgres";
import { TEST_DATABASE_URL } from "../src/test/test-db-url.ts";
import { provisionDatabase, ProvisionPrivilegeError } from "./provision.ts";
import { DatabaseUrlError } from "./migrate.ts";

/** A database this file owns outright. Derived from the shared test URL so the
 *  host, port and credentials stay in ONE place (see test-db-url.ts), with only
 *  the name replaced. */
const SCRATCH_DB = "muninn_provision_test";
const SCRATCH_URL = new URL(TEST_DATABASE_URL).toString().replace(/\/[^/]*$/, `/${SCRATCH_DB}`);
const ADMIN_URL = new URL(TEST_DATABASE_URL).toString().replace(/\/[^/]*$/, "/muninn");

// The guard, not decoration: this file runs DROP DATABASE, and the fallible
// part is the DERIVATION above, not the constant. A regex that stopped matching
// would leave SCRATCH_URL still naming `muninn_test` while SCRATCH_DB still read
// correctly, and the suite would drop the shared database on someone's laptop —
// silently, once. So assert that the URL and the name agree, and that neither
// real database is what came out.
{
  const scratchPath = new URL(SCRATCH_URL).pathname;
  const forbidden = new Set(["/muninn", "/muninn_test"]);
  if (scratchPath !== `/${SCRATCH_DB}` || forbidden.has(scratchPath)) {
    throw new Error(`refusing to run: the scratch database URL resolved to ${scratchPath}`);
  }
}

async function withAdmin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

async function withScratch<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(SCRATCH_URL, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** A genuinely empty database — dropped and recreated, not truncated, since
 *  what is under test is what happens to a database with NO schema at all. */
async function resetScratch() {
  await withAdmin(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  });
}

beforeEach(resetScratch);

afterAll(async () => {
  await withAdmin((admin) => admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
});

describe("provisionDatabase", () => {
  test("lays down the schema and records the shipped migrations", async () => {
    const result = await provisionDatabase(SCRATCH_URL);
    expect(result.status).toBe("provisioned");

    const [state] = await withScratch(
      (sql) => sql`
        SELECT to_regclass('public.users') IS NOT NULL AS users,
               to_regclass('public.memories') IS NOT NULL AS memories,
               (SELECT count(*)::int FROM schema_migrations) AS recorded
      `,
    );
    expect(state?.users).toBe(true);
    expect(state?.memories).toBe(true);
    // The exact predicate `db/require-provisioned.ts` refuses on: a schema with
    // NO recorded migration is the "provisioned but never baselined" state that
    // crash-loops the pod inside migration 006. Provisioning must not leave the
    // database in it.
    expect(state?.recorded).toBeGreaterThan(0);
  });

  test("refuses a database that already has a schema, and writes nothing", async () => {
    await provisionDatabase(SCRATCH_URL);
    const before = await withScratch(
      (sql) => sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );

    const result = await provisionDatabase(SCRATCH_URL);
    expect(result.status).toBe("already-provisioned");
    expect(result.notes.join("\n")).toContain("--baseline");

    const after = await withScratch(
      (sql) => sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  test("--dry-run reports what it would do and leaves the database empty", async () => {
    const result = await provisionDatabase(SCRATCH_URL, { dryRun: true });
    expect(result.status).toBe("would-provision");

    const [state] = await withScratch(
      (sql) => sql`SELECT to_regclass('public.users') IS NOT NULL AS users`,
    );
    expect(state?.users).toBe(false);
  });

  test("refuses a database that does not exist, rather than waiting out the connect budget", async () => {
    const missing = new URL(TEST_DATABASE_URL).toString().replace(/\/[^/]*$/, "/muninn_no_such_db");
    const started = Date.now();
    await expect(provisionDatabase(missing)).rejects.toBeInstanceOf(DatabaseUrlError);
    // 3D000 is in FATAL_PG_CODES, so this must not sit through the 30s budget.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("the assumption provision.ts rests on", () => {
  test("a multi-statement sql.unsafe is ONE implicit transaction — a later failure rolls the earlier statements back", async () => {
    // This is the property that makes "the whole file lands or none of it does"
    // true, and it is a property of postgres.js's protocol choice
    // (`simple: args.length === 0`) rather than of anything in this repo. Pinned
    // here so a postgres.js upgrade that moved `unsafe` to the extended protocol
    // — which cannot carry multiple statements in one transaction — fails this
    // case instead of silently leaving half-built schemas in production.
    await withScratch(async (sql) => {
      // An explicit catch, not `expect(…).rejects`: a postgres.js `Query` is a
      // LAZY thenable that only runs when something subscribes to it, and
      // handing one to bun 1.3.10's `.rejects` hangs the test file forever
      // (measured — no output, no timeout, the process spinning). The same
      // statement under a plain try/catch resolves in milliseconds.
      let thrown: unknown;
      try {
        await sql.unsafe(`CREATE TABLE prov_atomic (i int); SELECT 1 / 0;`);
      } catch (err) {
        thrown = err;
      }
      // Named, so this cannot pass on a failure to CONNECT — which would leave
      // `prov_atomic` absent for the wrong reason and the assertion below green.
      expect(String(thrown)).toContain("division by zero");

      const [row] = await sql`SELECT to_regclass('public.prov_atomic') IS NOT NULL AS present`;
      expect(row?.present).toBe(false);
    });
  });
});

describe("ProvisionPrivilegeError", () => {
  test("carries the Postgres message verbatim rather than a guess about the grant", () => {
    const err = new ProvisionPrivilegeError('permission denied for schema public');
    expect(err.pgMessage).toBe("permission denied for schema public");
    expect(err.message).toBe("permission denied for schema public");
  });
});
