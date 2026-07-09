/**
 * Set up the wiki-linter watcher row (report-only knowledge-wiki hygiene).
 *
 * Creates ONE weekly `wiki-linter` watcher for the jarvis bot. The linter runs
 * the lint engine (`src/wiki/lint.ts`) over the bot's wiki and, when there are
 * findings, sends ONE summarizing alert pointing at `/wiki/gardener` (which
 * hosts the Lint findings section). It NEVER writes to the wiki or the DB.
 *
 * Config choices:
 *  - `interval_ms` weekly (7d).
 *  - `config.hour: 11` — a daytime fire, one hour after the gardener's hour-10
 *    slot so the two weekly wiki watchers don't fire in the same tick. Lint is
 *    fast (fs + parsing), so 5 min net is plenty of headroom.
 *  - `config.timeoutMs: 300000` (5 min) — the runner's net is
 *    max(120s, timeoutMs + 30s).
 *
 * Idempotent: if a `wiki-linter` watcher already exists for the owner, it is
 * SKIPPED (never re-clobber a hand-tuned row).
 *
 * Owner: OWNER_USER_ID / OWNER_BOT_NAME env override; otherwise bot_name defaults
 * to "jarvis" and the user_id is copied from an existing watcher for that bot
 * (else any watcher).
 *
 * Usage:
 *   bun scripts/setup-wiki-linter.ts            # dry-run — prints the plan
 *   bun scripts/setup-wiki-linter.ts --apply    # writes to the DB
 */
import postgres from "postgres";
import { loadConfig } from "../src/config.ts";

const apply = process.argv.includes("--apply");

const NAME = "Wiki Linter";
const WEEKLY_INTERVAL_MS = 604_800_000; // 7d
const linterConfig = {
  hour: 11, // daytime; one hour after the gardener (hour 10) to avoid colliding
  timeoutMs: 300_000, // 5 min — lint is fast (fs + parsing)
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
    WHERE user_id = ${userId} AND bot_name = ${botName} AND type = 'wiki-linter'
    ORDER BY created_at ASC
  `;

  console.log("Owner:", `${userId}/${botName}`);
  console.log("Existing wiki-linter watchers:", existing.length);
  console.log();
  console.log("Plan:");
  if (existing.length > 0) {
    console.log(`  1. SKIP '${NAME}' (already exists — not re-clobbering its config)`);
  } else {
    console.log(`  1. INSERT '${NAME}' type=wiki-linter interval=7d`);
    console.log(`     config: ${JSON.stringify(linterConfig)}`);
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
    VALUES (${userId}, ${botName}, ${NAME}, 'wiki-linter', ${sql.json(linterConfig as any)}, ${WEEKLY_INTERVAL_MS})
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
