/**
 * init.sql drift guard.
 *
 * Muninn has two ways a database schema comes into existence:
 *   - fresh deploy:    db/init.sql is applied, then migrations are baselined
 *                      (marked applied WITHOUT running) — so init.sql is the
 *                      whole truth.
 *   - upgraded deploy: an older DB has db/migrations/ applied incrementally.
 *
 * These two paths MUST converge on the same schema. They only do so if every
 * schema change lands in BOTH init.sql and a migration. This test enforces that
 * invariant by building the schema both ways into throwaway databases and
 * diffing them structurally (columns + indexes + constraints + triggers +
 * functions + extensions; see introspectSchema for exactly what is compared).
 *
 * Why a frozen base instead of "replay from empty": the original supabase
 * migrations 00001-00005 were consolidated into init.sql and deleted, so
 * db/migrations/ starts at 006 and its files ALTER pre-existing tables. They
 * can't run against an empty DB — they need db/migration-replay-base.sql (a
 * frozen snapshot of init.sql just before 006) to apply on top of.
 *
 * Excluded from the diff:
 *   - schema_migrations: bookkeeping table; identical DDL both ways, only its
 *     rows differ (init.sql path: empty; replay path: one row per migration).
 *   - benchmark_*: created by migrations 030-034 but intentionally NOT in
 *     init.sql (experimental tooling; fresh deploys don't carry it).
 *
 * Runs in the db group (`bun run test:db`, needs `bun run db:up`). Skips
 * cleanly when Postgres isn't reachable so it never reds CI on a machine
 * without Docker.
 */
import { test, expect, afterAll } from "bun:test";
import postgres from "postgres";
import { join } from "node:path";
import { runMigrations } from "../../db/migrate.ts";

const ADMIN_URL = "postgresql://muninn:muninn@127.0.0.1:5435/muninn";
const SERVER_URL = ADMIN_URL.replace(/\/[^/]+$/, ""); // strip the db name
const DB_DIR = join(import.meta.dir, "../../db");

// Suffix with the pid so concurrent test processes (CI sharding, two dev
// terminals) don't race on CREATE/DROP of the same database names.
const DB_INITSQL = `muninn_drift_initsql_${process.pid}`;
const DB_MIGRATE = `muninn_drift_migrate_${process.pid}`;

const urlFor = (db: string) => `${SERVER_URL}/${db}`;

async function isPostgresReachable(): Promise<boolean> {
  const sql = postgres(ADMIN_URL, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function recreateDatabases() {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    // DROP/CREATE DATABASE can't run inside a transaction.
    for (const db of [DB_INITSQL, DB_MIGRATE]) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${db}`);
      await admin.unsafe(`CREATE DATABASE ${db}`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function dropDatabases() {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    for (const db of [DB_INITSQL, DB_MIGRATE]) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${db}`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function applySqlFile(url: string, file: string) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(await Bun.file(join(DB_DIR, file)).text());
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * One sorted, order-independent line per schema object. Comparing these as sets
 * sidesteps the OID/creation-order noise a `pg_dump --schema-only` text diff
 * would produce between an all-at-once init.sql and incremental migrations.
 *
 * Covers columns (via `format_type`, so it sees the pgvector `vector(384)`
 * typmod and `varchar(n)`/`numeric(p,s)` precision that information_schema
 * hides), indexes, constraints, triggers, user-defined functions (the trigger
 * function bodies are load-bearing — e.g. memories_search_vector_update), and
 * extensions. Extension-owned functions (pgvector's) are excluded so only
 * muninn's own functions are diffed.
 */
async function introspectSchema(url: string): Promise<string[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const lines: string[] = [];
  // schema_migrations: bookkeeping, identical DDL both ways (only rows differ).
  // benchmark_*: created by migrations 030-034 but intentionally absent from
  // init.sql (experimental tooling fresh deploys don't carry).
  const skip = (table: string) => table === "schema_migrations" || table.startsWith("benchmark_");
  try {
    const cols = await sql`
      SELECT c.relname AS table_name, a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS col_type,
             a.attnotnull AS not_null,
             pg_get_expr(d.adbin, d.adrelid) AS default_expr
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attname`;
    for (const c of cols) {
      if (skip(c.table_name)) continue;
      lines.push(
        `COL ${c.table_name}.${c.column_name} type=${c.col_type} ` +
          `notnull=${c.not_null} default=${c.default_expr}`,
      );
    }

    const idx = await sql`
      SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY indexname`;
    for (const i of idx) {
      if (skip(i.tablename)) continue;
      lines.push(`IDX ${i.indexname}: ${i.indexdef}`);
    }

    const cons = await sql`
      SELECT rel.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = 'public'
      ORDER BY rel.relname, con.conname`;
    for (const c of cons) {
      if (skip(c.table_name)) continue;
      lines.push(`CON ${c.table_name}.${c.conname}: ${c.def}`);
    }

    const trg = await sql`
      SELECT rel.relname AS table_name, t.tgname, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class rel ON rel.oid = t.tgrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = 'public' AND NOT t.tgisinternal
      ORDER BY rel.relname, t.tgname`;
    for (const t of trg) {
      if (skip(t.table_name)) continue;
      lines.push(`TRG ${t.table_name}.${t.tgname}: ${t.def}`);
    }

    const fns = await sql`
      SELECT p.proname, pg_get_functiondef(p.oid) AS def
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      ORDER BY p.proname, p.oid`;
    for (const f of fns) lines.push(`FN ${f.proname}: ${f.def}`);

    const ext = await sql`SELECT extname FROM pg_extension ORDER BY extname`;
    for (const e of ext) lines.push(`EXT ${e.extname}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  return lines.sort();
}

const reachable = await isPostgresReachable();

afterAll(async () => {
  if (reachable) await dropDatabases();
});

test.skipIf(!reachable)(
  "init.sql schema matches a full migration replay (no drift)",
  async () => {
    await recreateDatabases();

    // Path 1 — fresh deploy: init.sql is the whole schema.
    await applySqlFile(urlFor(DB_INITSQL), "init.sql");

    // Path 2 — upgraded deploy: frozen pre-006 base, then replay 006+.
    await applySqlFile(urlFor(DB_MIGRATE), "migration-replay-base.sql");
    await runMigrations(urlFor(DB_MIGRATE), { quiet: true });

    const fromInit = await introspectSchema(urlFor(DB_INITSQL));
    const fromMigrations = await introspectSchema(urlFor(DB_MIGRATE));

    const initSet = new Set(fromInit);
    const migrateSet = new Set(fromMigrations);
    const onlyInInit = fromInit.filter((l) => !migrateSet.has(l));
    const onlyInMigrations = fromMigrations.filter((l) => !initSet.has(l));

    // A bespoke message (rather than expect().toEqual on the two arrays) so a
    // failure names exactly which objects drifted and in which direction.
    if (onlyInInit.length || onlyInMigrations.length) {
      throw new Error(
        [
          "Schema drift detected between db/init.sql and db/migrations/.",
          "Every schema change must land in BOTH init.sql and a migration.",
          "",
          `In init.sql but missing from the migration replay (${onlyInInit.length}):`,
          ...onlyInInit.map((l) => `  - ${l}`),
          "",
          `Produced by migrations but missing from init.sql (${onlyInMigrations.length}):`,
          ...onlyInMigrations.map((l) => `  + ${l}`),
        ].join("\n"),
      );
    }

    expect(onlyInInit.length + onlyInMigrations.length).toBe(0);
  },
  120_000,
);
