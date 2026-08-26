import { beforeAll, afterAll, beforeEach } from "bun:test";
import { initDb, getDb } from "../db/client.ts";
import { TEST_DATABASE_URL } from "./test-db-url.ts";



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
  // Before `users`: it carries an FK to it. TRUNCATE … CASCADE would reach it
  // anyway, but naming it keeps the list an honest inventory of what a test run
  // must not accumulate — an Entra identity row surviving between cases would
  // make "a second login provisions nothing" pass without provisioning ever
  // having worked.
  "user_identities",
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
