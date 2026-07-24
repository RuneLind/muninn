/**
 * Set up the consolidation-gardener watcher row (weekly wiki-consolidation
 * automation — PR 3).
 *
 * Creates ONE weekly `consolidation-gardener` watcher for a standalone wiki
 * (default `mimir`). The watcher clusters the wiki's OWN pages (the Atlas rail's
 * synthesis candidates) and drafts saga-style synthesis-page proposals into
 * `wiki_proposals` (reviewable at `/wiki/gardener?wiki=<name>`), deduping against
 * clusters already drafted/approved/applied.
 *
 * Ownership (mirrors setup-wiki-gardener, but wiki-driven):
 *  - `bot_name` = the wiki's RESOLVED synthesis bot (`resolveWikiSynthesisBot` —
 *    mimir → jarvis), so the run's connector/model chip and attribution are truthful.
 *  - `user_id` = that bot's `bot_default_user` mapping (`getBotDefaultUser`).
 *    watchers.user_id is NOT NULL, so a missing mapping is a FAIL-LOUD error — we
 *    never insert a row with an empty/placeholder owner.
 *
 * Config choices:
 *  - `interval_ms` weekly (7d); `config.hour: 10` — a daytime fire so a weekly run
 *    never lands in quiet hours (a quiet-hours skip still advances last_run_at,
 *    silently costing a week). Matches the wiki-gardener slot.
 *  - `config.wiki` — the wiki name to consolidate.
 *  - `config.threshold: 0.98` — the Atlas slider default edge threshold.
 *  - `config.capPerRun: 2` — max real model drafts per run (the tail drains weekly).
 *  - `config.timeoutMs: 1200000` (20 min) — the runner's net is
 *    max(120s, timeoutMs + 30s); cap 2 drafts + overlay fetch need headroom, and a
 *    timed-out run advances last_run_at and loses the week.
 *
 * Seeded **disabled** (`enabled = false`) for safety — the orchestrator enables it
 * at landing. Idempotent: an existing `consolidation-gardener` row for the same
 * wiki is SKIPPED (never re-clobbers a hand-tuned config).
 *
 * Usage:
 *   bun scripts/setup-consolidation-gardener.ts            # dry-run — prints the plan
 *   bun scripts/setup-consolidation-gardener.ts --apply    # writes to the DB
 *   WIKI=mimir bun scripts/setup-consolidation-gardener.ts --apply
 */
import { loadConfig } from "../src/config.ts";
import { initDb, getDb, closeDb } from "../src/db/client.ts";
import { getWikiRegistry } from "../src/wiki/registry-memo.ts";
import { findWiki } from "../src/wiki/registry.ts";
import { discoverAllBots, resolveWikiSynthesisBot } from "../src/bots/config.ts";
import { getBotDefaultUser } from "../src/db/chat-preferences.ts";

const apply = process.argv.includes("--apply");

const WIKI = (process.env.WIKI ?? "mimir").trim();
const NAME = "Consolidation Gardener";
const WEEKLY_INTERVAL_MS = 604_800_000; // 7d
const gardenerConfig = {
  wiki: WIKI,
  hour: 10, // daytime — clear of quiet hours (matches wiki-gardener)
  threshold: 0.98, // Atlas slider default
  capPerRun: 2, // max real model drafts per run
  timeoutMs: 1_200_000, // 20 min net headroom for cap 2 drafts + overlay fetch
};

async function main() {
  const config = loadConfig();
  initDb(config);
  const sql = getDb();

  // Resolve the wiki + its synthesis bot (attribution owner).
  const entry = findWiki(getWikiRegistry(), WIKI);
  if (!entry) {
    console.error(
      `No wiki registry entry for "${WIKI}". Standalone wikis are registered via ` +
        `WIKI_EXTRA (e.g. WIKI_EXTRA=mimir=../mimir=mimir=jarvis). Check your .env.`,
    );
    await closeDb();
    process.exit(1);
  }
  if (!entry.collections || entry.collections.length === 0) {
    console.error(
      `Wiki "${WIKI}" has no backing search collections (the WIKI_EXTRA 3rd segment). ` +
        `The consolidation gardener needs collections to fetch the semantic overlay.`,
    );
    await closeDb();
    process.exit(1);
  }

  const { bot, origin } = resolveWikiSynthesisBot(entry, discoverAllBots());
  if (!bot) {
    console.error(`No synthesis bot resolves for wiki "${WIKI}" — cannot own the watcher.`);
    await closeDb();
    process.exit(1);
  }
  const botName = bot.name;

  // watchers.user_id is NOT NULL — fail loud rather than insert a placeholder owner.
  const userId = await getBotDefaultUser(botName);
  if (!userId) {
    console.error(
      `No bot_default_user mapping for bot "${botName}" (the synthesis bot for wiki ` +
        `"${WIKI}"). watchers.user_id is NOT NULL, so this script REFUSES to insert a ` +
        `row without a real owner. Set one first: open the web chat as ${botName} (which ` +
        `calls syncDefaultUser), or insert into bot_default_user directly.`,
    );
    await closeDb();
    process.exit(1);
  }

  const existing = await sql<{ id: string }[]>`
    SELECT id FROM watchers
    WHERE bot_name = ${botName} AND type = 'consolidation-gardener'
      AND config->>'wiki' = ${WIKI}
    ORDER BY created_at ASC
  `;

  console.log("Wiki:", WIKI, `(collections: ${entry.collections.join(", ")})`);
  console.log("Owner:", `${userId}/${botName}`, `(synthesis bot origin: ${origin})`);
  console.log("Existing consolidation-gardener watchers for this wiki:", existing.length);
  console.log();
  console.log("Plan:");
  if (existing.length > 0) {
    console.log(`  1. SKIP '${NAME}' (already exists — not re-clobbering its config)`);
  } else {
    console.log(`  1. INSERT '${NAME}' type=consolidation-gardener interval=7d enabled=false`);
    console.log(`     config: ${JSON.stringify(gardenerConfig)}`);
  }
  console.log();

  if (!apply) {
    console.log("Dry run — pass --apply to write to the DB.");
    await closeDb();
    return;
  }

  if (existing.length > 0) {
    console.log(`  • '${NAME}' already exists — skipped.`);
    await closeDb();
    return;
  }

  const [row] = await sql`
    INSERT INTO watchers (user_id, bot_name, name, type, config, interval_ms, enabled)
    VALUES (
      ${userId}, ${botName}, ${NAME}, 'consolidation-gardener',
      ${sql.json(gardenerConfig as any)}, ${WEEKLY_INTERVAL_MS}, false
    )
    RETURNING id
  `;
  console.log(`  ✓ Created '${NAME}' (id=${row!.id}) — DISABLED.`);
  console.log();
  console.log("Done. The row is seeded disabled; the orchestrator enables it at landing.");
  console.log("The scheduler ignores disabled watchers, so it is inert until enabled.");
  await closeDb();
}

main().catch(async (err) => {
  console.error("Failed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
