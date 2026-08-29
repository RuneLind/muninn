/**
 * The provisioning applier, against a real database.
 *
 * Every case here needs Postgres — the whole point of `db/provision.ts` is
 * applying 881 lines of DDL as the app user, and nothing about that is provable
 * against a mock. It builds and drops its OWN database rather than reusing
 * `muninn_test`, because "apply init.sql to an empty database" and "the suite's
 * shared schema" are the same tables; the guard below is what keeps a typo from
 * pointing `DROP DATABASE` at either of the two real ones.
 *
 * ⚠️ **This file needs MORE than `bun run db:setup:test` provides.** That script
 * builds `muninn_test`; this one connects to the `muninn` database as an admin
 * and runs `CREATE DATABASE` / `DROP DATABASE` / `CREATE ROLE`. CI has both (the
 * `pgvector/pgvector:pg17` service declares `POSTGRES_DB: muninn` and its role
 * is superuser), and so does `bun run db:up`. A container built by hand without
 * a `muninn` database, or with a role lacking `CREATEDB`/`CREATEROLE`, fails
 * here with a connection or privilege error rather than with the documented
 * setup step — hence this paragraph.
 */
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import postgres from "postgres";
import { TEST_DATABASE_URL } from "../src/test/test-db-url.ts";
import { provisionDatabase, ProvisionPrivilegeError } from "./provision.ts";
import { DatabaseUrlError, runMigrations } from "./migrate.ts";

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
  if (scratchPath !== `/${SCRATCH_DB}`) {
    throw new Error(`refusing to run: the scratch database URL resolved to ${scratchPath}`);
  }
}

/** `fileURLToPath`, never `.pathname` — a checkout under a path with a space
 *  (or any percent-encodable byte) comes back encoded and the spawn fails. The
 *  same reason `src/db/require-provisioned.test.ts` gives. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Drive the CLI as a PROCESS. Half of what this PR ships is an exit code and
 *  an operator instruction on stderr, and neither exists in-process. */
async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "db/provision.ts", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
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
    // What the note SAYS is the "already-provisioned note" pair below; this
    // case is about the write, and the two were entangled until a review
    // pointed out that the baseline remedy was being printed at healthy
    // databases as though it were a diagnosis.

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
    // 3D000 is in FATAL_PG_CODES, so this must not sit through the connect
    // budget. Below bun's own 5s per-test timeout ON PURPOSE: at 10_000 the
    // harness timeout fired first, so removing FATAL_PG_CODES failed the case
    // by timing out rather than by this assertion — green-looking evidence for
    // a property nothing was actually checking.
    expect(Date.now() - started).toBeLessThan(3_000);
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

describe("provisionDatabase — states that are neither empty nor provisioned", () => {
  /** A stray table and no `users`: exactly what a `psql -f db/init.sql` that
   *  died mid-file leaves behind (psql without `-1` is not atomic), which is
   *  the remedy this applier replaces. So it is the likeliest partial state
   *  there is, not a hypothetical. */
  async function seedPartial() {
    await withScratch((sql) => sql.unsafe(`CREATE TABLE memories (id int)`));
  }

  test("refuses a partially applied schema by NAME, not with a driver stack trace", async () => {
    await seedPartial();
    let thrown: unknown;
    try {
      await provisionDatabase(SCRATCH_URL);
    } catch (err) {
      thrown = err;
    }
    // The whole contract of this script is a one-line answer in a container
    // log. A raw `PostgresError: relation "memories" already exists` with a
    // node_modules stack is the failure mode it exists to remove.
    // Asserted by NAME rather than by importing the class: this test has to be
    // runnable — and red — against the version that had no such class, which is
    // the only evidence that it pins the diagnosis rather than describing it.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("ProvisionStateError");
    expect(String(thrown)).toContain("memories");
  });

  test("a failed apply leaves the partial schema exactly as it was", async () => {
    await seedPartial();
    await provisionDatabase(SCRATCH_URL).catch(() => {});
    const [row] = await withScratch(
      (sql) => sql`
        SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'
      `,
    );
    expect(row?.n).toBe(1);
  });

  test("--dry-run does NOT predict success for a run that cannot succeed", async () => {
    await seedPartial();
    const result = await provisionDatabase(SCRATCH_URL, { dryRun: true });
    // The bug this pins: the only predicate was `users`, so a dry run answered
    // "would provision" for every non-empty-but-unprovisioned database — i.e.
    // it reported green for the one state guaranteed to fail.
    expect(result.status).not.toBe("would-provision");
    expect(result.notes.join("\n")).toContain("not empty");
  });
});

describe("provisionDatabase — the already-provisioned note", () => {
  test("does NOT prescribe --baseline on a database that IS baselined", async () => {
    await provisionDatabase(SCRATCH_URL);
    const result = await provisionDatabase(SCRATCH_URL);
    expect(result.status).toBe("already-provisioned");
    // Printed unconditionally, this is the wrong instruction presented as the
    // diagnosis: `require-provisioned.ts` goes to some length to distinguish
    // "provisioned" from "provisioned but never baselined", and echoing the
    // baseline remedy at a healthy database collapses the two back together.
    expect(result.notes.join("\n")).not.toContain("--baseline");
  });

  test("DOES prescribe --baseline when the schema is there and nothing is recorded", async () => {
    await provisionDatabase(SCRATCH_URL);
    await withScratch((sql) => sql`DELETE FROM schema_migrations`);
    const result = await provisionDatabase(SCRATCH_URL);
    expect(result.status).toBe("already-provisioned");
    // What the note SAYS is the "already-provisioned note" pair below; this
    // case is about the write, and the two were entangled until a review
    // pointed out that the baseline remedy was being printed at healthy
    // databases as though it were a diagnosis.
  });
});

describe("db/init.sql stays applicable in one transaction", () => {
  test("carries no statement that breaks out of an implicit transaction block", async () => {
    // The atomicity pin above proves postgres.js uses the simple protocol. This
    // one proves the OTHER half of the same claim — that db/init.sql is a file
    // the simple protocol can carry. `db/migrate.ts` already special-cases
    // `CREATE INDEX CONCURRENTLY` for migrations, so the construct is reached
    // for in this repo; the day it lands in init.sql, `sql.unsafe` fails with
    // "cannot run inside a transaction block" and the README, CLAUDE.md and the
    // refusal text in require-provisioned.ts all become wrong at once.
    const initSql = await Bun.file(new URL("./init.sql", import.meta.url)).text();
    // Comments stripped first: init.sql explains itself, and a `--` line saying
    // the word would fail this for the wrong reason.
    const code = initSql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    for (const forbidden of [
      /\bCONCURRENTLY\b/i,
      /^\s*(COMMIT|ROLLBACK|START\s+TRANSACTION)\b/im,
      /\bVACUUM\b/i,
      /\bCREATE\s+DATABASE\b/i,
      /\bALTER\s+SYSTEM\b/i,
    ]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});

describe("db/provision.ts — the CLI contract", () => {
  test("an empty database provisions and exits 0", async () => {
    const { code, stdout } = await runCli(["--yes"], { DATABASE_URL: SCRATCH_URL });
    expect(code).toBe(0);
    // Host and database, never credentials — the only line naming what is
    // about to be written, on a path that bypasses the entrypoint's own echo.
    expect(stdout).toContain(SCRATCH_DB);
  });

  test("a second run exits 1 — 'already provisioned' is not success", async () => {
    await runCli(["--yes"], { DATABASE_URL: SCRATCH_URL });
    const { code } = await runCli(["--yes"], { DATABASE_URL: SCRATCH_URL });
    // Deliberately not 0: someone ran this expecting a schema to be laid down
    // and none was, so a script chaining on it must stop.
    expect(code).toBe(1);
  });

  test("REFUSES to write without --yes, and names the database it would have written to", async () => {
    const { code, stderr } = await runCli([], { DATABASE_URL: SCRATCH_URL });
    expect(code).toBe(2);
    expect(stderr).toContain("--yes");
    expect(stderr).toContain(SCRATCH_DB);
    // And it really did not write: the confirmation is a gate, not a warning.
    const [row] = await withScratch(
      (sql) => sql`SELECT to_regclass('public.users') IS NOT NULL AS users`,
    );
    expect(row?.users).toBe(false);
  });

  test("the refusal is what stands between a bare invocation and the developer's OWN database", async () => {
    // The hazard in one case. Bun auto-loads `.env`, which on a developer
    // machine carries a real DATABASE_URL — so a bare `bun db/provision.ts`
    // resolves a live database with nothing typed and nothing exported, and
    // before --yes existed it applied 881 lines of DDL to whatever that named.
    // `.env` is in `.dockerignore`, so this hazard is a laptop one, which is
    // exactly where an unattended agent runs the command.
    const { code, stderr } = await runCli([], {});
    expect(code).toBe(2);
    expect(stderr).toContain("--yes");
  });

  test("--dry-run needs no --yes: it is the form that cannot write", async () => {
    const { code } = await runCli(["--dry-run"], { DATABASE_URL: SCRATCH_URL });
    expect(code).toBe(0);
  });

  test("REFUSES an unrecognised argument instead of silently provisioning", async () => {
    // `--dryrun`, `--dry_run`, `-n` all used to fall through to a real run: the
    // flag was read with `argv.includes`, and anything unmatched was ignored.
    // For the one command in this repo whose purpose is applying a schema, a
    // typo in the safety valve must not BE the unsafe path.
    const { code, stderr } = await runCli(["--yes", "--dryrun"], { DATABASE_URL: SCRATCH_URL });
    expect(code).toBe(2);
    expect(stderr).toContain("--dryrun");
    const [row] = await withScratch(
      (sql) => sql`SELECT to_regclass('public.users') IS NOT NULL AS users`,
    );
    expect(row?.users).toBe(false);
  });

  test("an unset DATABASE_URL is its own exit code, not a crash", async () => {
    // An explicit empty string, never a delete: Bun's dotenv fills only names
    // that are ABSENT, so unsetting is what makes `.env` win (the
    // `src/test/ambient-env.ts` rule).
    const { code, stderr } = await runCli(["--yes"], { DATABASE_URL: "", DB_URL: "" });
    expect(code).toBe(2);
    expect(stderr).toContain("DATABASE_URL");
    expect(stderr).toContain("DB_URL");
  });

  test("DB_URL is adopted when DATABASE_URL is unset — the nais envVarPrefix form", async () => {
    // `kubectl debug --copy-to … -- bun db/provision.ts` REPLACES the entrypoint
    // that exports DATABASE_URL from DB_URL, so this is the shape the pod
    // actually presents.
    const { code } = await runCli(["--yes"], { DATABASE_URL: "", DB_URL: SCRATCH_URL });
    expect(code).toBe(0);
  });
});

describe("a baseline that fails partway", () => {
  test("records all the shipped migrations or none of them", async () => {
    // Why this matters more than it looks. `require-provisioned.ts` refuses
    // only on `recorded === 0`, so a PARTIAL baseline PASSES it — and the
    // entrypoint then runs the migration runner, which applies everything after
    // the last recorded version onto a schema that already has it, dying with
    // `column "bot_name" of relation "messages" already exists` under a restart
    // policy. That is the exact crash-loop `require-provisioned.ts` exists to
    // prevent, reachable through a state its predicate cannot see.
    await provisionDatabase(SCRATCH_URL);

    // Read from disk rather than pinned to a number: a new migration must not
    // turn this into a test that rejects a version nothing inserts, which would
    // pass for the wrong reason (nothing fails ⇒ nothing partial).
    const versions = (await readdir(new URL("./migrations/", import.meta.url)))
      .filter((f) => /^\d{3}-/.test(f) && !f.includes(".test."))
      .map((f) => f.slice(0, 3))
      .sort();
    const lastVersion = versions.at(-1)!;
    expect(versions.length).toBeGreaterThan(1);

    await withScratch(async (sql) => {
      await sql`DELETE FROM schema_migrations`;
      // Reject the LAST version, so the failure lands after every other insert
      // has succeeded — which is what makes "partial" and "none" distinguishable.
      await sql.unsafe(
        `ALTER TABLE schema_migrations ADD CONSTRAINT refuse_last CHECK (version <> '${lastVersion}')`,
      );
    });

    await runMigrations(SCRATCH_URL, { baseline: true, quiet: true }).catch(() => {});

    const [after] = await withScratch(
      (sql) => sql`SELECT count(*)::int AS n FROM schema_migrations`,
    );
    expect(after?.n).toBe(0);
  });
});

describe("the privilege wall on a managed instance", () => {
  /** A role that is NOT superuser, which is what the nais app user is. Cluster-
   *  wide, so it is dropped and recreated rather than assumed absent. */
  const ROLE = "muninn_provision_test_appuser";
  const ROLE_PASSWORD = "provision-test-only";
  const roleUrl = () =>
    SCRATCH_URL.replace("//muninn:muninn@", `//${ROLE}:${ROLE_PASSWORD}@`);

  beforeEach(async () => {
    await withAdmin(async (sql) => {
      await sql.unsafe(`DROP ROLE IF EXISTS ${ROLE}`);
      await sql.unsafe(
        `CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
      );
    });
    // On Postgres 15+ CREATE on schema `public` is no longer granted to PUBLIC,
    // so without this the role fails on `CREATE TABLE` and the case would prove
    // the wrong wall.
    await withScratch((sql) => sql.unsafe(`GRANT CREATE, USAGE ON SCHEMA public TO ${ROLE}`));
  });

  afterAll(async () => {
    // The database FIRST. A successful provisioning run leaves this role owning
    // ~44 objects, and `DROP ROLE` refuses while any exist (2BP01) — the
    // file-level afterAll drops the database too, but hook ordering between two
    // `afterAll`s is not a contract to lean on.
    await withAdmin(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      await sql.unsafe(`DROP ROLE IF EXISTS ${ROLE}`);
    });
  });

  test("names CREATE EXTENSION as the wall, with the Postgres message verbatim", async () => {
    // The real path, not a constructed error object. A test that only asserts
    // `new ProvisionPrivilegeError(x).pgMessage === x` stays green when the
    // whole `42501` catch is deleted — which is the branch that matters, since
    // it is the one an operator meets on a managed instance.
    let thrown: unknown;
    try {
      await provisionDatabase(roleUrl());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProvisionPrivilegeError);
    expect(String(thrown)).toContain("extension");
  });

  test("the CLI answers it with exit 1 and BOTH remedies, not a driver stack", async () => {
    const { code, stderr } = await runCli(["--yes"], { DATABASE_URL: roleUrl() });
    expect(code).toBe(1);
    // The elevated one-liner, and the other cause of 42501 — a role that does
    // not own the database on Postgres 15+. Which one applies is decided by the
    // verbatim Postgres message between them.
    expect(stderr).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(stderr).toContain("permission denied for schema public");
    expect(stderr).not.toContain("node_modules");
  });

  test("and once an elevated role has created the extension, the app user applies the rest", async () => {
    // The claim CLAUDE.md, the README and require-provisioned.ts's refusal all
    // make: `IF NOT EXISTS` short-circuits BEFORE the privilege check. Asserted
    // end to end rather than quoted.
    await withScratch((sql) => sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`));
    const result = await provisionDatabase(roleUrl());
    expect(result.status).toBe("provisioned");
  });
});
