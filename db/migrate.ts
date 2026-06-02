/**
 * Simple Flyway-style migration runner.
 *
 * Tracks applied migrations in a `schema_migrations` table and runs pending
 * .sql and .ts files from db/migrations/ in numeric order.
 *
 * On a fresh database (created from init.sql), use --baseline to mark all
 * existing migrations as applied without running them — init.sql already
 * contains the consolidated schema.
 *
 * TS migrations must export: migrate(sql: postgres.Sql): Promise<void>
 *
 * Usage:
 *   bun db/migrate.ts                  # Run pending migrations
 *   bun db/migrate.ts --baseline       # Mark all as applied (fresh DB from init.sql)
 *   bun db/migrate.ts --status         # Show migration status
 *   bun db/migrate.ts --dry-run        # Show what would run without running
 *   DATABASE_URL=... bun db/migrate.ts # Custom database URL
 */
import postgres from "postgres";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

const DRY_RUN = process.argv.includes("--dry-run");
const STATUS = process.argv.includes("--status");
const BASELINE = process.argv.includes("--baseline");

interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  ext: string;
}

async function ensureMigrationsTable(sql: postgres.Sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

async function getAppliedMigrations(sql: postgres.Sql): Promise<Set<string>> {
  const rows = await sql`SELECT version FROM schema_migrations ORDER BY version`;
  return new Set(rows.map((r) => r.version));
}

async function discoverMigrations(): Promise<MigrationFile[]> {
  const files = await readdir(MIGRATIONS_DIR);
  const migrations = files
    .filter((f) => /^\d{3}-/.test(f) && !f.includes(".test."))
    .filter((f) => f.endsWith(".sql") || f.endsWith(".ts"))
    .sort()
    .map((f) => {
      const match = f.match(/^(\d{3})-(.+)\.(sql|ts)$/);
      if (!match) throw new Error(`Unexpected migration filename: ${f}`);
      return { version: match[1]!, name: match[2]!, filename: f, ext: match[3]! };
    });

  // Check for duplicate version numbers
  const seen = new Map<string, string>();
  for (const m of migrations) {
    const existing = seen.get(m.version);
    if (existing) {
      throw new Error(`Duplicate migration version ${m.version}: ${existing} and ${m.filename}`);
    }
    seen.set(m.version, m.filename);
  }

  return migrations;
}

async function runMigration(sql: postgres.Sql, migration: MigrationFile) {
  const filepath = join(MIGRATIONS_DIR, migration.filename);

  if (migration.ext === "sql") {
    const content = await Bun.file(filepath).text();
    await sql.unsafe(content);
  } else {
    const mod = await import(filepath);
    if (typeof mod.migrate !== "function") {
      throw new Error(
        `TS migration ${migration.filename} must export a migrate(sql: postgres.Sql) function`,
      );
    }
    await mod.migrate(sql);
  }
}

export async function runMigrations(
  databaseUrl: string,
  opts?: { baseline?: boolean; quiet?: boolean },
) {
  // `quiet` silences progress chatter for programmatic callers (e.g. the drift
  // test); the CLI path below leaves it off. Errors throw regardless.
  const say: (...args: unknown[]) => void = opts?.quiet ? () => {} : console.log;
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await ensureMigrationsTable(sql);
    const applied = await getAppliedMigrations(sql);
    const all = await discoverMigrations();
    const pending = all.filter((m) => !applied.has(m.version));

    if (opts?.baseline) {
      if (pending.length === 0) {
        say("All migrations already recorded — nothing to baseline.");
        return;
      }
      say(`Baselining ${pending.length} migration(s):\n`);
      for (const m of pending) {
        await sql`INSERT INTO schema_migrations (version, name) VALUES (${m.version}, ${m.name})`;
        say(`  ✓ ${m.filename} (recorded)`);
      }
      say("\nDone. All migrations marked as applied.");
      return;
    }

    if (pending.length === 0) {
      say("No pending migrations.");
      return;
    }

    say(`${pending.length} pending migration(s):\n`);
    for (const m of pending) {
      say(`  → ${m.filename}`);
      // CREATE INDEX CONCURRENTLY can't run inside a transaction block, so a
      // migration that uses it runs bare; every other migration is wrapped so a
      // partial failure can't leave the DB half-migrated. (016 is the only such
      // migration today — it predates the wrapper, so without this a fresh full
      // replay, like the drift test, would fail on it.)
      const concurrent =
        m.ext === "sql" &&
        /\bCONCURRENTLY\b/i.test(await Bun.file(join(MIGRATIONS_DIR, m.filename)).text());
      if (concurrent) {
        await runMigration(sql, m);
        await sql`INSERT INTO schema_migrations (version, name) VALUES (${m.version}, ${m.name})`;
      } else {
        await sql.begin(async (tx) => {
          const txSql = tx as unknown as postgres.Sql;
          await runMigration(txSql, m);
          await txSql`INSERT INTO schema_migrations (version, name) VALUES (${m.version}, ${m.name})`;
        });
      }
      say(`    applied`);
    }
    say(`\nDone. Applied ${pending.length} migration(s).`);
  } finally {
    await sql.end();
  }
}

// --- CLI entrypoint ---
if (import.meta.main) {
  const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://muninn:muninn@127.0.0.1:5435/muninn";

  if (STATUS) {
    const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    await ensureMigrationsTable(sql);
    const applied = await getAppliedMigrations(sql);
    const all = await discoverMigrations();

    console.log("Migration status:\n");
    for (const m of all) {
      const status = applied.has(m.version) ? "applied" : "pending";
      console.log(`  ${m.version} ${m.filename.padEnd(50)} ${status}`);
    }
    const pending = all.filter((m) => !applied.has(m.version));
    console.log(`\n${applied.size} applied, ${pending.length} pending`);
    await sql.end();
  } else if (DRY_RUN) {
    const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    await ensureMigrationsTable(sql);
    const applied = await getAppliedMigrations(sql);
    const all = await discoverMigrations();
    const pending = all.filter((m) => !applied.has(m.version));

    if (pending.length === 0) {
      console.log("No pending migrations.");
    } else {
      console.log(`${pending.length} pending migration(s) (dry run):\n`);
      for (const m of pending) {
        console.log(`  → ${m.filename}`);
      }
    }
    await sql.end();
  } else {
    await runMigrations(DATABASE_URL, { baseline: BASELINE }).catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
  }
}
