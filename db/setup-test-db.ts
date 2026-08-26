/**
 * Creates and initializes the test database (muninn_test).
 *
 * - Creates the database if it doesn't exist
 * - Drops and recreates the public schema (clean slate)
 * - Applies init.sql (full consolidated schema)
 * - Baselines all migrations in schema_migrations
 *
 * Usage:
 *   bun db/setup-test-db.ts
 *   bun run db:setup:test
 */
import postgres from "postgres";
import { join } from "node:path";
import { runMigrations } from "./migrate.ts";
import { TEST_DATABASE_URL } from "../src/test/test-db-url.ts";

// The ONE spelling of the test database, shared with `src/test/setup-db.ts` and
// with the e2e specs that read rows back out of it. This file composed its own,
// which is exactly what that constant exists to prevent: a divergence here
// points `DROP SCHEMA public CASCADE` at whichever database the string names.
const TEST_URL = TEST_DATABASE_URL;
const TEST_DB = new URL(TEST_URL).pathname.replace(/^\//, "");
const ADMIN_URL = new URL(TEST_URL).toString().replace(/\/[^/]*$/, "/muninn");

async function setupTestDb() {
  // Connect to default DB to create the test DB
  const admin = postgres(ADMIN_URL, { max: 1 });

  try {
    const exists = await admin`
      SELECT 1 FROM pg_database WHERE datname = ${TEST_DB}
    `;
    if (exists.length === 0) {
      // CREATE DATABASE can't run inside a transaction
      await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
      console.log(`Created database ${TEST_DB}`);
    }
  } finally {
    await admin.end();
  }

  // Connect to test DB and apply schema
  const test = postgres(TEST_URL, { max: 1 });
  try {
    // Clean slate — drop and recreate public schema
    await test.unsafe(`DROP SCHEMA public CASCADE`);
    await test.unsafe(`CREATE SCHEMA public`);

    // Apply full schema
    const initSql = await Bun.file(join(import.meta.dir, "init.sql")).text();
    await test.unsafe(initSql);
    console.log(`Applied init.sql to ${TEST_DB}`);
  } finally {
    await test.end();
  }

  // Baseline all migrations (init.sql already has everything)
  await runMigrations(TEST_URL, { baseline: true });

  console.log(`Test database ${TEST_DB} is ready.`);
}

await setupTestDb().catch((err) => {
  console.error("Test DB setup failed:", err);
  process.exit(1);
});
