/**
 * Set up the wiki-gardener watcher row (Claude knowledge-wiki gardener, PR 1).
 *
 * Creates ONE weekly `wiki-gardener` watcher for the jarvis bot. The gardener
 * clusters recently-ingested summaries and drafts knowledge-wiki page proposals
 * into `wiki_proposals` (reviewable via psql in PR 1; a web gate lands in PR 2).
 *
 * Config choices (see the plan's "Watcher-runner interactions"):
 *  - `interval_ms` weekly (7d).
 *  - `config.hour: 10` — a daytime fire, so a weekly run never lands in quiet
 *    hours (a quiet-hours skip still advances last_run_at, silently costing a week).
 *  - `config.timeoutMs: 720000` (12 min) — the runner's net is
 *    max(120s, timeoutMs + 30s); 3 drafts × 180s + cluster + harvest need the
 *    headroom, and a timed-out run advances last_run_at and loses the week.
 *
 * Idempotent: if a `wiki-gardener` watcher already exists for the owner, it is
 * SKIPPED (never re-clobber a hand-tuned row).
 *
 * Owner: OWNER_USER_ID / OWNER_BOT_NAME env override; otherwise bot_name defaults
 * to "jarvis" and the user_id is copied from an existing watcher for that bot
 * (else any watcher).
 *
 * Usage:
 *   bun scripts/setup-wiki-gardener.ts            # dry-run — prints the plan
 *   bun scripts/setup-wiki-gardener.ts --apply    # writes to the DB
 */
import postgres from "postgres";
import { loadConfig } from "../src/config.ts";

const apply = process.argv.includes("--apply");

const NAME = "Wiki Gardener";
const WEEKLY_INTERVAL_MS = 604_800_000; // 7d
const gardenerConfig = {
  hour: 10, // daytime — clear of quiet hours
  timeoutMs: 720_000, // 12 min net headroom for 3 drafts + cluster + harvest
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
    WHERE user_id = ${userId} AND bot_name = ${botName} AND type = 'wiki-gardener'
    ORDER BY created_at ASC
  `;

  console.log("Owner:", `${userId}/${botName}`);
  console.log("Existing wiki-gardener watchers:", existing.length);
  console.log();
  console.log("Plan:");
  if (existing.length > 0) {
    console.log(`  1. SKIP '${NAME}' (already exists — not re-clobbering its config)`);
  } else {
    console.log(`  1. INSERT '${NAME}' type=wiki-gardener interval=7d`);
    console.log(`     config: ${JSON.stringify(gardenerConfig)}`);
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
    VALUES (${userId}, ${botName}, ${NAME}, 'wiki-gardener', ${sql.json(gardenerConfig as any)}, ${WEEKLY_INTERVAL_MS})
    RETURNING id
  `;
  console.log(`  ✓ Created '${NAME}' (id=${row!.id})`);
  console.log();
  console.log("Done. The row is immediately due (last_run_at NULL); forceNextRun a first");
  console.log("supervised run from the dashboard Automation panel, or wait for the weekly fire.");
}

main()
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  })
  .finally(() => sql.end());
