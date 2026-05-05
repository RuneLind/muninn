/**
 * One-off migration: split the existing "Timeline" X watcher into three tiers.
 *
 * Reads the existing Timeline row (type='x') to reuse its user_id, bot_name,
 * model, timeoutMs, maxDocs, slackChannels, slackBot, etc. Then:
 *
 *   1. Reconfigures Timeline → "X Daily Digest" (fires at 12:00, re-ranks the full day)
 *   2. Creates "X Highlights" (every 2h, minScore gate + quietMode, silent unless exceptional)
 *   3. Creates "X Weekly Digest" (weekly at 18:00, 7-day window with themes prompt)
 *
 * Idempotent: skips steps whose target already exists under the same user+bot.
 *
 * Usage:
 *   bun scripts/setup-x-watchers.ts             # dry-run — prints the plan
 *   bun scripts/setup-x-watchers.ts --apply     # writes to the DB
 */
import postgres from "postgres";
import { loadConfig } from "../src/config.ts";
import { DEFAULT_X_PROMPT, DEFAULT_X_HIGHLIGHTS_PROMPT } from "../src/watchers/x.ts";

const DEFAULT_X_WEEKLY_PROMPT = `Write a weekly X/Twitter digest with three sections:

**Themes of the Week** (3-5 bullets) — what the community talked about this week. Cluster by topic, not by tweet. One sentence each.

**Top Picks** (5-7 items) — the most valuable individual tweets of the week:
- Bold one-line summary with linked @handle
- Prioritize articles, original insights, novel results, threads
- Skip anything ephemeral (news that already aged out)

**Also Notable** (up to 12 items) — one-liners with linked @handle

Format rules:
- Do NOT start with a heading — jump straight into "**Themes of the Week**"
- Use bold for section headers
- Casual, informative tone`;

const apply = process.argv.includes("--apply");

const config = loadConfig();
const sql = postgres(config.databaseUrl, { max: 1 });

async function main() {
  const [timeline] = await sql`
    SELECT id, user_id, bot_name, config, interval_ms, enabled
    FROM watchers
    WHERE type = 'x' AND name = 'Timeline'
    ORDER BY created_at ASC
    LIMIT 1
  `;

  if (!timeline) {
    console.error("No Timeline X watcher found — aborting. Create one first via /watch x in Telegram.");
    process.exit(1);
  }

  const { id: timelineId, user_id: userId, bot_name: botName } = timeline;
  // Pre-existing bug: updateWatcher stringifies configs before storing in JSONB, so rows
  // edited via the dashboard come back as JSON-strings-inside-JSONB. Normalize both shapes.
  const rawConfig = timeline.config;
  const baseConfig = (typeof rawConfig === "string"
    ? JSON.parse(rawConfig)
    : rawConfig) as Record<string, unknown>;

  // Preserve shared fields from Timeline: collection, model, timeoutMs, maxDocs,
  // slackChannels, slackBot — but drop its custom prompt and any old scheduling hints.
  const shared: Record<string, unknown> = {
    collection: baseConfig.collection ?? "x-feed",
    model: baseConfig.model ?? "claude-sonnet-4-6",
    timeoutMs: baseConfig.timeoutMs ?? 600_000,
    maxDocs: baseConfig.maxDocs ?? 80,
    ...(baseConfig.slackChannels ? { slackChannels: baseConfig.slackChannels } : {}),
    ...(baseConfig.slackBot ? { slackBot: baseConfig.slackBot } : {}),
  };

  console.log("Reusing from Timeline:");
  console.log("  user_id:", userId);
  console.log("  bot_name:", botName);
  console.log("  shared config:", JSON.stringify(shared, null, 2));
  console.log();

  // 1. Reconfigure Timeline → X Daily Digest (12:00, full-day re-rank)
  const dailyConfig = {
    ...shared,
    windowDays: 1,
    dedupByTweetId: false,
    topN: 30,
    hour: 12,
    minute: 0,
    prompt: DEFAULT_X_PROMPT,
  };
  const dailyUpdate = {
    name: "X Daily Digest",
    intervalMs: 86_400_000, // 24h
    config: dailyConfig,
  };

  // 2. X Highlights — quiet daytime alerts
  const highlightsConfig = {
    ...shared,
    windowDays: 1,
    dedupByTweetId: true,
    minScore: 0.85,
    quietMode: true,
    topN: 10,
    prompt: DEFAULT_X_HIGHLIGHTS_PROMPT,
  };
  const highlightsInsert = {
    userId,
    botName,
    name: "X Highlights",
    type: "x" as const,
    config: highlightsConfig,
    intervalMs: 7_200_000, // 2h
  };

  // 3. X Weekly Digest — weekly at 18:00, 7-day window
  const weeklyConfig = {
    ...shared,
    windowDays: 7,
    dedupByTweetId: false,
    topN: 60,
    hour: 18,
    minute: 0,
    prompt: DEFAULT_X_WEEKLY_PROMPT,
  };
  const weeklyInsert = {
    userId,
    botName,
    name: "X Weekly Digest",
    type: "x" as const,
    config: weeklyConfig,
    intervalMs: 604_800_000, // 7d
  };

  // Check which targets already exist (idempotency)
  const existing = await sql<{ name: string }[]>`
    SELECT name FROM watchers
    WHERE user_id = ${userId} AND bot_name = ${botName} AND type = 'x'
  `;
  const names = new Set(existing.map((r) => r.name));

  console.log("Existing X watchers for this user+bot:", Array.from(names).join(", ") || "(none)");
  console.log();

  console.log("Plan:");
  console.log(`  1. UPDATE ${timelineId} → name='${dailyUpdate.name}', interval=24h`);
  console.log(`     new config: ${JSON.stringify({ ...dailyConfig, prompt: `<${dailyConfig.prompt.length} chars>` })}`);
  if (names.has("X Highlights")) {
    console.log("  2. SKIP 'X Highlights' (already exists)");
  } else {
    console.log(`  2. INSERT '${highlightsInsert.name}' interval=2h`);
    console.log(`     config: ${JSON.stringify({ ...highlightsConfig, prompt: `<${highlightsConfig.prompt.length} chars>` })}`);
  }
  if (names.has("X Weekly Digest")) {
    console.log("  3. SKIP 'X Weekly Digest' (already exists)");
  } else {
    console.log(`  3. INSERT '${weeklyInsert.name}' interval=7d`);
    console.log(`     config: ${JSON.stringify({ ...weeklyConfig, prompt: `<${weeklyConfig.prompt.length} chars>` })}`);
  }
  console.log();

  if (!apply) {
    console.log("Dry run — pass --apply to write to the DB.");
    return;
  }

  console.log("Applying…");

  // 1. Update Timeline row in place. Also reset last_run_at so the new 24h interval starts fresh.
  await sql`
    UPDATE watchers
    SET name = ${dailyUpdate.name},
        interval_ms = ${dailyUpdate.intervalMs},
        config = ${sql.json(dailyConfig as any)},
        last_run_at = now()
    WHERE id = ${timelineId}
  `;
  console.log(`  ✓ Updated Timeline → X Daily Digest (id=${timelineId})`);

  // 2. Insert X Highlights if missing
  if (!names.has("X Highlights")) {
    const [h] = await sql`
      INSERT INTO watchers (user_id, bot_name, name, type, config, interval_ms)
      VALUES (${userId}, ${botName}, ${highlightsInsert.name}, 'x',
              ${sql.json(highlightsConfig as any)}, ${highlightsInsert.intervalMs})
      RETURNING id
    `;
    console.log(`  ✓ Created X Highlights (id=${h!.id})`);
  }

  // 3. Insert X Weekly Digest if missing
  if (!names.has("X Weekly Digest")) {
    const [w] = await sql`
      INSERT INTO watchers (user_id, bot_name, name, type, config, interval_ms)
      VALUES (${userId}, ${botName}, ${weeklyInsert.name}, 'x',
              ${sql.json(weeklyConfig as any)}, ${weeklyInsert.intervalMs})
      RETURNING id
    `;
    console.log(`  ✓ Created X Weekly Digest (id=${w!.id})`);
  }

  console.log();
  console.log("Done. Check the dashboard Automation panel to verify the three rows.");
}

main()
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  })
  .finally(() => sql.end());
