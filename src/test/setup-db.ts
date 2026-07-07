import { beforeAll, afterAll, beforeEach } from "bun:test";
import { initDb, getDb } from "../db/client.ts";

const TEST_DATABASE_URL = "postgresql://muninn:muninn@127.0.0.1:5435/muninn_test";

const ALL_TABLES = [
  "research_citations",
  "search_signals",
  "traces",
  "haiku_usage",
  "summary_candidates",
  "watchers",
  "scheduled_tasks",
  "goals",
  "memories",
  "activity_log",
  "messages",
  "chat_preferences",
  "interest_profiles",
  "threads",
  "connectors",
  "user_settings",
  "users",
  "bot_default_user",
  "peer_thread_correlation",
  "peer_correlation_tokens",
  "dev_run_handoffs",
  "dev_runs",
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
