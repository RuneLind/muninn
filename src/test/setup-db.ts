import { beforeAll, afterAll, beforeEach } from "bun:test";
import { initDb, getDb } from "../db/client.ts";

const TEST_DATABASE_URL = "postgresql://javrvis:javrvis@127.0.0.1:5434/javrvis_test";

const ALL_TABLES = [
  "haiku_usage",
  "watchers",
  "scheduled_tasks",
  "goals",
  "memories",
  "activity_log",
  "messages",
  "user_settings",
];

let dbInitialized = false;

export function setupTestDb() {
  beforeAll(async () => {
    if (!dbInitialized) {
      initDb({ databaseUrl: TEST_DATABASE_URL } as any);
      dbInitialized = true;
    }
    // Suppress NOTICE messages (e.g. from TRUNCATE CASCADE)
    await getDb().unsafe("SET client_min_messages = WARNING");
  });

  afterAll(async () => {
    // Don't close — other test files may still use the same connection
  });

  beforeEach(async () => {
    const sql = getDb();
    await sql.unsafe(`TRUNCATE TABLE ${ALL_TABLES.join(", ")} CASCADE`);
  });
}
