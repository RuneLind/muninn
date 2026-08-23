import { beforeAll, afterAll, beforeEach } from "bun:test";
import { initDb, getDb } from "../db/client.ts";

const TEST_DATABASE_URL = "postgresql://muninn:muninn@127.0.0.1:5435/muninn_test";

const ALL_TABLES = [
  "wiki_proposals",
  "research_citations",
  "search_signals",
  "traces",
  "haiku_usage",
  "summary_candidates",
  "x_link_amplifiers",
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
  "source_draft_attempts",
  // Left out until 2026-08-23, so archive rows accumulated across every run
  // (225 by then) — invisible to the id-scoped assertions, but it makes any
  // whole-listing property (does a limit of N cut anything?) depend on how often
  // the suite has been run.
  "jira_drafts",
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
