/**
 * Seed the Anthropic Tier-1 feed watcher (PR-M1 / Phase 1).
 *
 * Reuses the owner (user_id, bot_name) from an existing watcher row so the new
 * row lands under the same Telegram user + bot as the others — resolves Open Q #5
 * by precedent (all current watchers are jarvis/<user>). Override with
 * OWNER_USER_ID / OWNER_BOT_NAME if needed.
 *
 * Idempotent: skips if an 'anthropic' watcher with the same name already exists
 * for that owner. A fresh row has last_run_at IS NULL → immediately due; its first
 * run records a silent cold-start baseline (no Telegram), and only subsequent new
 * entries alert.
 *
 * Usage:
 *   bun scripts/setup-anthropic-watchers.ts             # dry-run — prints the plan
 *   bun scripts/setup-anthropic-watchers.ts --apply     # writes to the DB
 */
import postgres from "postgres";
import { loadConfig } from "../src/config.ts";
import { DEFAULT_ANTHROPIC_FEEDS } from "../src/watchers/anthropic.ts";

const apply = process.argv.includes("--apply");
const NAME = "Anthropic Updates";
const INTERVAL_MS = 7_200_000; // 2h — matches DEFAULT_INTERVALS.anthropic

const config = loadConfig();
const sql = postgres(config.databaseUrl, { max: 1 });

async function main() {
  // Reuse the owner of any existing watcher (all are jarvis/<user> today).
  const [owner] = await sql<{ user_id: string; bot_name: string }[]>`
    SELECT user_id, bot_name FROM watchers
    ORDER BY created_at ASC
    LIMIT 1
  `;
  const userId = process.env.OWNER_USER_ID ?? owner?.user_id;
  const botName = process.env.OWNER_BOT_NAME ?? owner?.bot_name;
  if (!userId || !botName) {
    console.error(
      "No existing watcher to copy owner from. Create one first (e.g. /watch x in " +
        "Telegram), or set OWNER_USER_ID and OWNER_BOT_NAME.",
    );
    process.exit(1);
  }

  const watcherConfig = { feeds: [...DEFAULT_ANTHROPIC_FEEDS] };

  const existing = await sql<{ id: string }[]>`
    SELECT id FROM watchers
    WHERE user_id = ${userId} AND bot_name = ${botName}
      AND type = 'anthropic' AND name = ${NAME}
  `;

  console.log("Owner:", `${userId}/${botName}`);
  console.log("Feeds:", watcherConfig.feeds.length);
  console.log();

  if (existing.length) {
    console.log(`'${NAME}' already exists (id=${existing[0]!.id.slice(0, 8)}). Nothing to do.`);
    return;
  }

  console.log(`Plan: INSERT '${NAME}' type=anthropic interval=2h enabled=true`);
  console.log(`  config: ${JSON.stringify(watcherConfig)}`);
  console.log();

  if (!apply) {
    console.log("Dry run — pass --apply to write to the DB.");
    return;
  }

  const [row] = await sql`
    INSERT INTO watchers (user_id, bot_name, name, type, config, interval_ms)
    VALUES (
      ${userId}, ${botName}, ${NAME}, 'anthropic',
      ${sql.json(watcherConfig as any)}, ${INTERVAL_MS}
    )
    RETURNING id
  `;
  console.log(`  ✓ Created '${NAME}' (id=${row!.id})`);
  console.log();
  console.log("First scheduler tick will record a silent baseline (no alert). New");
  console.log("entries from then on will alert via Telegram.");
}

main()
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  })
  .finally(() => sql.end());
