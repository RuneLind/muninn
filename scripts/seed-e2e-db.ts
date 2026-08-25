/**
 * Seed the minimum DB content the Playwright suite needs to actually RUN.
 *
 * A developer's `muninn` database has users, threads and traces in it, so the
 * suite exercises the chat sidebar, the inspector and the traces waterfall
 * without anyone noticing they depend on that. A CI database has none, and the
 * two failure modes are opposite and both bad:
 *
 *   - `chat.spec.ts` / `inspector.spec.ts` FAIL — the client's `loadThreads`
 *     early-returns to "Select a bot" whenever no user is selected, and with an
 *     empty `users` table there is nothing to select. Measured on a fresh
 *     database: 12 failures that reproduce nowhere else.
 *   - `traces-waterfall.spec.ts` and eight `inspector.spec.ts` cases SKIP
 *     themselves ("No traces in DB", "No threads available"). A skip is worse
 *     than a failure here: the run is green and the coverage is gone.
 *
 * So CI seeds, rather than lowering what the specs assert. Everything written
 * here is addressed by a fixed `e2e-` id and the script is idempotent, so a
 * re-run is a no-op and a developer who runs it against their own database gets
 * one extra user rather than a mangled one.
 *
 *   bun run scripts/seed-e2e-db.ts
 *
 * TWO THREADS, not one: `inspector.spec.ts` has a case that switches between
 * threads and skips itself below two. Only ONE bot is seeded against, because
 * `bots/jarvis/` is the only bot folder this repo tracks — the bot-switch case
 * skips on CI and says so.
 */

import { loadConfig } from "../src/config.ts";
import { initDb, closeDb } from "../src/db/client.ts";
import { ensureUser } from "../src/db/users.ts";
import { createThread, findThreadByName } from "../src/db/threads.ts";
import { saveSpan } from "../src/db/traces.ts";
import { discoverAllBots } from "../src/bots/config.ts";

const USER_ID = "e2e-seed-user";
const THREADS = ["main", "e2e-second"];

async function seed(): Promise<void> {
  initDb(loadConfig());

  const bots = discoverAllBots();
  const bot = bots[0];
  if (!bot) {
    // Loud, and a non-zero exit: a suite seeded against no bot looks seeded and
    // then skips half of itself.
    throw new Error(
      "No bot folders found — the e2e suite needs at least one `bots/<name>/CLAUDE.md`. " +
        "`bots/jarvis/` is tracked; check the checkout.",
    );
  }

  await ensureUser({
    id: USER_ID,
    username: "e2e",
    displayName: "E2E Seed",
    platform: "web",
  });

  for (const name of THREADS) {
    // `createThread` is not idempotent (it inserts unconditionally), so the
    // existence check is ours to do.
    if (!(await findThreadByName(USER_ID, bot.name, name))) {
      await createThread(USER_ID, bot.name, name, "seeded for the e2e suite");
    }
  }

  // One two-span trace, so the waterfall has a row to open and a bar to click.
  // Fixed ids ⇒ the insert conflicts on a re-run, which is what makes this
  // idempotent; `traces` has no upsert helper, so the duplicate is swallowed.
  // `traces.id`/`trace_id` are UUID columns, so the fixed ids have to be
  // well-formed UUIDs — a readable `e2e-seed-trace` is rejected by the type, not
  // by a constraint, and the seed dies before the suite ever runs.
  const traceId = "e2e5eed0-0000-4000-8000-000000000000";
  const rootSpanId = "e2e5eed0-0000-4000-8000-000000000001";
  const childSpanId = "e2e5eed0-0000-4000-8000-000000000002";
  const started = new Date(Date.now() - 60_000);
  try {
    await saveSpan({
      id: rootSpanId,
      traceId,
      name: "e2e seed request",
      kind: "root",
      botName: bot.name,
      userId: USER_ID,
      username: "e2e",
      platform: "web",
      startedAt: started,
      durationMs: 1200,
    });
    await saveSpan({
      id: childSpanId,
      traceId,
      parentId: rootSpanId,
      name: "e2e seed child span",
      kind: "span",
      botName: bot.name,
      startedAt: new Date(started.getTime() + 100),
      durationMs: 400,
    });
  } catch (err) {
    // A duplicate key is the idempotent path. Anything else is a real failure.
    if (!String(err).includes("duplicate key")) throw err;
  }

  console.log(`Seeded e2e fixtures for bot "${bot.name}": user ${USER_ID}, threads ${THREADS.join(", ")}, trace ${traceId}`);
}

await seed()
  .catch((err) => {
    console.error("e2e seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await closeDb();
  });
