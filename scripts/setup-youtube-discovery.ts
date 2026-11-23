/**
 * Set up the youtube-discovery watcher row (plan muninn-youtube-discovery, PR 3).
 *
 * Creates ONE weekly `youtube-discovery` watcher. Each run takes the last 7
 * days' YouTube summaries (at most `maxSeeds`), searches YouTube from each one
 * on its own, and stores each search as a shelf on /summaries/discover. It sends
 * no alert of its own; its failures go to source health (three bad weeks
 * escalate).
 *
 * Config choices:
 *  - `interval_ms` weekly (7 days). With `config.hour: 12` it fires once a week
 *    at/after 12:00 Oslo.
 *  - `config.hour: 12` — clear of the overnight quiet-hours window (22–08) and of
 *    the wiki watchers' morning slots (9, 10, 11). It shares the tick with the X
 *    Daily and Anthropic Daily rows (also hour 12); watchers run concurrently.
 *  - `config.timeoutMs: 300000` (5 min) — a healthy run took 11–14 s (4 live
 *    traces, 2026-11-14: one queries call, 3–5 yt-dlp searches, one rank call), so
 *    five seeds fit with room for slow model calls. The checker keeps a run-wide
 *    deadline of min(net, tick) − 30 s and starts no seed with under 60 s left;
 *    the runner's net is max(120s, timeoutMs + 30s).
 *  - `config.maxSeeds: 5` — the seed bar's cap; 1–10 accepted.
 *
 * The row's bot decides which Haiku backend the two model calls run on.
 *
 * Idempotent: if a `youtube-discovery` watcher already exists for the owner, it
 * is SKIPPED (never re-clobber a hand-tuned row).
 *
 * Owner: OWNER_USER_ID / OWNER_BOT_NAME env override; otherwise bot_name defaults
 * to "jarvis" and the user_id is copied from an existing watcher for that bot
 * (else any watcher).
 *
 * Usage:
 *   bun scripts/setup-youtube-discovery.ts            # dry-run — prints the plan
 *   bun scripts/setup-youtube-discovery.ts --apply    # writes to the DB
 */
import { openPostgres } from "../db/postgres-connection.ts";
import { loadConfig } from "../src/config.ts";

const apply = process.argv.includes("--apply");

const NAME = "YouTube Discovery";
const WEEKLY_INTERVAL_MS = 604_800_000; // 7 days
const watcherConfig = {
  hour: 12, // clear of quiet hours (22–08) and the wiki watchers (9, 10, 11)
  timeoutMs: 300_000, // 5 min — five seeds
  maxSeeds: 5,
};

const config = loadConfig();
const { sql } = openPostgres(config.databaseUrl, { max: 1 });

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
    WHERE user_id = ${userId} AND bot_name = ${botName} AND type = 'youtube-discovery'
    ORDER BY created_at ASC
  `;

  console.log("Owner:", `${userId}/${botName}`);
  console.log("Existing youtube-discovery watchers:", existing.length);
  console.log();
  console.log("Plan:");
  if (existing.length > 0) {
    console.log(`  1. SKIP '${NAME}' (already exists — not re-clobbering its config)`);
  } else {
    console.log(`  1. INSERT '${NAME}' type=youtube-discovery interval=7d`);
    console.log(`     config: ${JSON.stringify(watcherConfig)}`);
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
    VALUES (${userId}, ${botName}, ${NAME}, 'youtube-discovery', ${sql.json(watcherConfig as any)}, ${WEEKLY_INTERVAL_MS})
    RETURNING id
  `;
  console.log(`  ✓ Created '${NAME}' (id=${row!.id})`);
  console.log();
  console.log("Done. The row is due now (last_run_at NULL): it fires on the first tick at or after");
  console.log("12:00 Oslo, then weekly. forceNextRun from the dashboard Automation panel to watch a first run.");
}

main()
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  })
  .finally(() => sql.end());
