/**
 * Set up the Anthropic watcher rows.
 *
 * Phase 1/3 seeded a single "Anthropic Updates" row. Phase 4 splits it into the
 * 3-row Highlights / Daily / Weekly digest cadence (mirroring scripts/setup-x-watchers.ts):
 *
 *   1. Reconfigures the existing base row → "Anthropic Highlights" (real-time, every 2h,
 *      gate minScore 0.8 + the strict Highlights prompt; keeps its warm Tier-1 dedup ids
 *      and Tier-2 snapshots so it doesn't cold-start). The UPDATE sets ONLY name + config
 *      — NOT last_run_at — so the row keeps its 2h schedule slot.
 *   2. Creates "Anthropic Daily Digest" (24h, fires at 12:00, digest mode, Sonnet).
 *   3. Creates "Anthropic Weekly Digest" (7d, fires at 18:00, digest mode, Sonnet).
 *
 * Idempotent:
 *   - If "Anthropic Highlights" already exists, the reconfigure step is SKIPPED — never
 *     re-clobber a possibly hand-tuned Highlights config (its minScore is calibrated from
 *     real output). On a fresh box with no anthropic row at all, Highlights is INSERTed.
 *   - Daily/Weekly are INSERTed only if missing for the owner.
 *
 * Owner reuse: copies user_id/bot_name from an existing anthropic row (else any watcher),
 * so the rows land under the same Telegram user + bot. Override with OWNER_USER_ID /
 * OWNER_BOT_NAME.
 *
 * A fresh row has last_run_at IS NULL → immediately due; its first run records a silent
 * cold-start baseline (no Telegram), and only subsequent new items alert/digest.
 *
 * Usage:
 *   bun scripts/setup-anthropic-watchers.ts             # dry-run — prints the plan
 *   bun scripts/setup-anthropic-watchers.ts --apply     # writes to the DB
 */
import postgres from "postgres";
import { loadConfig } from "../src/config.ts";
import {
  DEFAULT_ANTHROPIC_HIGHLIGHTS_PROMPT,
  DEFAULT_ANTHROPIC_DAILY_PROMPT,
  DEFAULT_ANTHROPIC_WEEKLY_PROMPT,
} from "../src/watchers/anthropic.ts";

const apply = process.argv.includes("--apply");

const HIGHLIGHTS = "Anthropic Highlights";
const DAILY = "Anthropic Daily Digest";
const WEEKLY = "Anthropic Weekly Digest";
const DIGEST_NAMES = new Set([DAILY, WEEKLY]);

const SONNET = "claude-sonnet-4-6";
const TIMEOUT_MS = 300000; // clears the runner's 120s watcher-timeout floor (net = +30s)

const config = loadConfig();
const sql = postgres(config.databaseUrl, { max: 1 });

/** Highlights: real-time, quiet. Keeps the base row's warm ids/snapshots. No `feeds` key
 *  (tracks the code-default DEFAULT_ANTHROPIC_FEEDS); no `hour` (daytime via quiet-hours). */
const highlightsConfig = {
  tier2: true,
  gate: true,
  minScore: 0.8,
  timeoutMs: TIMEOUT_MS,
  prompt: DEFAULT_ANTHROPIC_HIGHLIGHTS_PROMPT,
};

/** Daily digest: once/day at 12:00, one message. quietMode so an all-churn day can SKIP. */
const dailyConfig = {
  tier2: true,
  digest: true,
  quietMode: true,
  model: SONNET,
  timeoutMs: TIMEOUT_MS,
  lookbackDays: 3, // retry cushion: > interval (1d) so a failed run's window survives
  hour: 12,
  minute: 0,
  prompt: DEFAULT_ANTHROPIC_DAILY_PROMPT,
};

/** Weekly digest: once/week at 18:00, themes + top picks. Always sends (no quietMode). */
const weeklyConfig = {
  tier2: true,
  digest: true,
  model: SONNET,
  timeoutMs: TIMEOUT_MS,
  lookbackDays: 16, // retry cushion: > 2×interval (14d) + jitter so a failed run survives
  hour: 18,
  minute: 0,
  prompt: DEFAULT_ANTHROPIC_WEEKLY_PROMPT,
};

const DAILY_INTERVAL_MS = 86_400_000; // 24h
const WEEKLY_INTERVAL_MS = 604_800_000; // 7d
const HIGHLIGHTS_INTERVAL_MS = 7_200_000; // 2h

/** Abbreviate the long prompt fields for readable dry-run output. */
function summarizeConfig(c: Record<string, unknown>): string {
  const copy = { ...c };
  if (typeof copy.prompt === "string") copy.prompt = `<${copy.prompt.length} chars>`;
  return JSON.stringify(copy);
}

async function main() {
  // Owner: prefer an existing anthropic row, else any watcher (bootstrap). Override via env.
  const [anthropicRow] = await sql<{ user_id: string; bot_name: string }[]>`
    SELECT user_id, bot_name FROM watchers WHERE type = 'anthropic' ORDER BY created_at ASC LIMIT 1
  `;
  const fallback = anthropicRow
    ? [anthropicRow]
    : await sql<{ user_id: string; bot_name: string }[]>`
        SELECT user_id, bot_name FROM watchers ORDER BY created_at ASC LIMIT 1
      `;
  const userId = process.env.OWNER_USER_ID ?? fallback[0]?.user_id;
  const botName = process.env.OWNER_BOT_NAME ?? fallback[0]?.bot_name;
  if (!userId || !botName) {
    console.error(
      "No existing watcher to copy owner from. Create one first (e.g. /watch x in " +
        "Telegram), or set OWNER_USER_ID and OWNER_BOT_NAME.",
    );
    process.exit(1);
  }

  // All existing anthropic rows for this owner.
  const existing = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM watchers
    WHERE user_id = ${userId} AND bot_name = ${botName} AND type = 'anthropic'
    ORDER BY created_at ASC
  `;
  const names = new Set(existing.map((r) => r.name));

  // Base row for the Highlights reconfigure: prefer the Phase-1/3 "Anthropic Updates",
  // else the oldest anthropic row that isn't already a Daily/Weekly digest.
  const baseRow =
    existing.find((r) => r.name === "Anthropic Updates") ??
    existing.find((r) => !DIGEST_NAMES.has(r.name) && r.name !== HIGHLIGHTS);

  console.log("Owner:", `${userId}/${botName}`);
  console.log("Existing anthropic watchers:", Array.from(names).join(", ") || "(none)");
  console.log();

  // --- Plan ---
  console.log("Plan:");

  const haveHighlights = names.has(HIGHLIGHTS);
  if (haveHighlights) {
    console.log(`  1. SKIP '${HIGHLIGHTS}' (already exists — not re-clobbering its config)`);
  } else if (baseRow) {
    console.log(`  1. UPDATE ${baseRow.id.slice(0, 8)} ('${baseRow.name}') → name='${HIGHLIGHTS}', interval=2h (NO last_run_at reset)`);
    console.log(`     config: ${summarizeConfig(highlightsConfig)}`);
  } else {
    console.log(`  1. INSERT '${HIGHLIGHTS}' interval=2h (no base row to reconfigure)`);
    console.log(`     config: ${summarizeConfig(highlightsConfig)}`);
  }

  if (names.has(DAILY)) {
    console.log(`  2. SKIP '${DAILY}' (already exists)`);
  } else {
    console.log(`  2. INSERT '${DAILY}' interval=24h hour=12`);
    console.log(`     config: ${summarizeConfig(dailyConfig)}`);
  }

  if (names.has(WEEKLY)) {
    console.log(`  3. SKIP '${WEEKLY}' (already exists)`);
  } else {
    console.log(`  3. INSERT '${WEEKLY}' interval=7d hour=18`);
    console.log(`     config: ${summarizeConfig(weeklyConfig)}`);
  }
  console.log();

  if (!apply) {
    console.log("Dry run — pass --apply to write to the DB.");
    return;
  }

  console.log("Applying…");

  // 1. Highlights — reconfigure base in place (name + config ONLY, no last_run_at), or insert.
  if (haveHighlights) {
    console.log(`  • '${HIGHLIGHTS}' already exists — skipped.`);
  } else if (baseRow) {
    await sql`
      UPDATE watchers
      SET name = ${HIGHLIGHTS},
          interval_ms = ${HIGHLIGHTS_INTERVAL_MS},
          config = ${sql.json(highlightsConfig as any)}
      WHERE id = ${baseRow.id}
    `;
    console.log(`  ✓ Reconfigured '${baseRow.name}' → '${HIGHLIGHTS}' (id=${baseRow.id}, kept warm ids/snapshots, last_run_at unchanged)`);
  } else {
    const [h] = await sql`
      INSERT INTO watchers (user_id, bot_name, name, type, config, interval_ms)
      VALUES (${userId}, ${botName}, ${HIGHLIGHTS}, 'anthropic', ${sql.json(highlightsConfig as any)}, ${HIGHLIGHTS_INTERVAL_MS})
      RETURNING id
    `;
    console.log(`  ✓ Created '${HIGHLIGHTS}' (id=${h!.id})`);
  }

  // 2. Daily digest.
  if (!names.has(DAILY)) {
    const [d] = await sql`
      INSERT INTO watchers (user_id, bot_name, name, type, config, interval_ms)
      VALUES (${userId}, ${botName}, ${DAILY}, 'anthropic', ${sql.json(dailyConfig as any)}, ${DAILY_INTERVAL_MS})
      RETURNING id
    `;
    console.log(`  ✓ Created '${DAILY}' (id=${d!.id})`);
  }

  // 3. Weekly digest.
  if (!names.has(WEEKLY)) {
    const [w] = await sql`
      INSERT INTO watchers (user_id, bot_name, name, type, config, interval_ms)
      VALUES (${userId}, ${botName}, ${WEEKLY}, 'anthropic', ${sql.json(weeklyConfig as any)}, ${WEEKLY_INTERVAL_MS})
      RETURNING id
    `;
    console.log(`  ✓ Created '${WEEKLY}' (id=${w!.id})`);
  }

  console.log();
  console.log("Done. The two new digest rows record a silent cold-start baseline on their");
  console.log("first run; real digests follow. Check the dashboard Automation panel for the 3 rows.");
}

main()
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  })
  .finally(() => sql.end());
