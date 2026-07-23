/**
 * Set up the wiki-committer watcher row (daily wiki-subtree commit sweeper).
 *
 * Creates ONE daily `wiki-committer` watcher for the jarvis bot. Each run, on the
 * wiki repo's default branch, it commits any uncommitted wiki-subtree changes
 * (manual edits, crashed gardener runs, writes skipped while off the default
 * branch) via `commitWikiChange` under a `[sweep] …` subject — quiet when clean.
 *
 * Config choices:
 *  - `interval_ms` daily (24h) — a 1-day staleness floor. Combined with
 *    `config.hour: 7`, `getDueWatchers`/`isScheduledTimeDue` fire it once per day
 *    at/after 07:00 Oslo; a missed window (muninn down) still fires the next day
 *    (interval + hour gate both re-open). Same shape as the anthropic Daily row.
 *  - `config.hour: 7` — an early daytime fire, well clear of the gardener (hour
 *    10) and linter (hour 11) so the wiki watchers don't fire in the same tick.
 *  - `config.timeoutMs: 300000` (5 min) — a sweep is fast (git status + commit +
 *    a non-blocking push); the runner's net is max(120s, timeoutMs + 30s).
 *
 * Idempotent: if a `wiki-committer` watcher already exists for the owner, it is
 * SKIPPED (never re-clobber a hand-tuned row).
 *
 * Owner: OWNER_USER_ID / OWNER_BOT_NAME env override; otherwise bot_name defaults
 * to "jarvis" and the user_id is copied from an existing watcher for that bot
 * (else any watcher).
 *
 * Usage:
 *   bun scripts/setup-wiki-committer.ts            # dry-run — prints the plan
 *   bun scripts/setup-wiki-committer.ts --apply    # writes to the DB
 */
import postgres from "postgres";
import { loadConfig } from "../src/config.ts";

const apply = process.argv.includes("--apply");

const NAME = "Wiki Committer";
const DAILY_INTERVAL_MS = 86_400_000; // 24h — a 1-day staleness floor
const committerConfig = {
  hour: 7, // early daytime; clear of the gardener (10) and linter (11) slots
  timeoutMs: 300_000, // 5 min — a sweep is fast (git status + commit + push)
};

const config = loadConfig();
const sql = postgres(config.databaseUrl, { max: 1 });

async function main() {
  const botName = process.env.OWNER_BOT_NAME ?? "jarvis";

  let userId = process.env.OWNER_USER_ID;
  if (!userId) {
    const [forBot] = await sql<{ user_id: string }[]>`
      SELECT user_id FROM watchers WHERE bot_name = ${botName} ORDER BY created_at ASC LIMIT 1
    `;
    const [anyRow] = forBot
      ? [forBot]
      : await sql<{ user_id: string }[]>`
          SELECT user_id FROM watchers ORDER BY created_at ASC LIMIT 1
        `;
    userId = anyRow?.user_id;
  }

  if (!userId) {
    console.error(
      "No existing watcher to copy owner from. Create one first (e.g. /watch in " +
        "Telegram), or set OWNER_USER_ID and OWNER_BOT_NAME.",
    );
    process.exit(1);
  }

  const existing = await sql<{ id: string }[]>`
    SELECT id FROM watchers
    WHERE user_id = ${userId} AND bot_name = ${botName} AND type = 'wiki-committer'
    ORDER BY created_at ASC
  `;

  console.log("Owner:", `${userId}/${botName}`);
  console.log("Existing wiki-committer watchers:", existing.length);
  console.log();
  console.log("Plan:");
  if (existing.length > 0) {
    console.log(`  1. SKIP '${NAME}' (already exists — not re-clobbering its config)`);
  } else {
    console.log(`  1. INSERT '${NAME}' type=wiki-committer interval=24h`);
    console.log(`     config: ${JSON.stringify(committerConfig)}`);
  }
  console.log();

  if (!apply) {
    console.log("Dry run — pass --apply to write to the DB.");
    return;
  }

  if (existing.length > 0) {
    console.log(`  • '${NAME}' already exists — skipped.`);
    return;
  }

  const [row] = await sql`
    INSERT INTO watchers (user_id, bot_name, name, type, config, interval_ms)
    VALUES (${userId}, ${botName}, ${NAME}, 'wiki-committer', ${sql.json(committerConfig as any)}, ${DAILY_INTERVAL_MS})
    RETURNING id
  `;
  console.log(`  ✓ Created '${NAME}' (id=${row!.id})`);
  console.log();
  console.log("Done. The row is immediately due (last_run_at NULL); forceNextRun a first");
  console.log("supervised run from the dashboard Automation panel, or wait for the daily fire.");
}

main()
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  })
  .finally(() => sql.end());
