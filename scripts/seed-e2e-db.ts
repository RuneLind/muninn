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
 * re-run is a no-op. It also REFUSES a database whose name does not end in
 * `_test` (override with `--force`): the rows are permanent, and `e2e-seed-user`
 * plus its threads would otherwise sit in a developer's /chat user picker and
 * inspector lists forever.
 *
 *   bun run scripts/seed-e2e-db.ts
 *
 * TWO THREADS, not one: `inspector.spec.ts` has a case that switches between
 * threads and skips itself below two. And EVERY discovered bot is seeded, not
 * just the first: the inspector's bot-switch case selects a second bot and then
 * expects a thread there, so seeding only `bots[0]` turns that case from a skip
 * into a failure on any machine that has more than one bot folder. CI has
 * exactly one (`bots/jarvis/` is all this repo tracks), so the bot-switch case
 * skips there and says so.
 */

import { loadConfig } from "../src/config.ts";
import { initDb, closeDb } from "../src/db/client.ts";
import { ensureUser } from "../src/db/users.ts";
import { createThread, findThreadByName } from "../src/db/threads.ts";
import { saveSpan } from "../src/db/traces.ts";
import { discoverAllBots } from "../src/bots/config.ts";

const USER_ID = "e2e-seed-user";
const THREADS = ["main", "e2e-second"];

/** Postgres' unique_violation. Matched on the CODE, not on a substring of the
 *  message: `String(err).includes("duplicate key")` swallows a duplicate on ANY
 *  constraint, including one that means something has genuinely gone wrong. */
function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

async function seed(): Promise<void> {
  const config = loadConfig();

  // The rows below are permanent: `e2e-seed-user` and its threads show up in
  // /chat's user picker, the inspector's thread lists and `/api/users` forever,
  // and `main` is a name the real threads use too. That is fine in CI and a
  // footgun on a developer's machine, so the database has to SAY it is a test
  // database. `--force` is the deliberate override.
  const dbName = config.databaseUrl.split("/").pop()?.split("?")[0] ?? "";
  if (!dbName.endsWith("_test") && !process.argv.includes("--force")) {
    throw new Error(
      `Refusing to seed "${dbName}": this writes permanent rows and the database name does not end in "_test". ` +
        `Point DATABASE_URL at a test database, or pass --force if you really mean this one.`,
    );
  }

  initDb(config);

  const bots = discoverAllBots();
  if (bots.length === 0) {
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

  for (const bot of bots) {
    for (const name of THREADS) {
      // `createThread` is not idempotent (it inserts unconditionally), so the
      // existence check is ours to do.
      if (!(await findThreadByName(USER_ID, bot.name, name))) {
        await createThread(USER_ID, bot.name, name, "seeded for the e2e suite");
      }
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
  // One try/catch PER insert, not one around both: with a shared catch, a run
  // interrupted between the two `await`s leaves the root behind, and every later
  // run duplicate-keys on the root and skips the child forever — the
  // traces-waterfall spec then finds a trace with no child bar to click and no
  // error anywhere.
  try {
    await saveSpan({
      id: rootSpanId,
      traceId,
      name: "e2e seed request",
      kind: "root",
      botName: bots[0]!.name,
      userId: USER_ID,
      username: "e2e",
      platform: "web",
      startedAt: started,
      durationMs: 1200,
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
  try {
    await saveSpan({
      id: childSpanId,
      traceId,
      parentId: rootSpanId,
      name: "e2e seed child span",
      kind: "span",
      botName: bots[0]!.name,
      startedAt: new Date(started.getTime() + 100),
      durationMs: 400,
    });
  } catch (err) {
    // A duplicate key is the idempotent path. Anything else is a real failure.
    if (!isDuplicateKey(err)) throw err;
  }

  console.log(
    `Seeded e2e fixtures for bot(s) "${bots.map((b) => b.name).join(", ")}": ` +
      `user ${USER_ID}, threads ${THREADS.join(", ")}, trace ${traceId}`,
  );
}

await seed()
  .catch((err) => {
    console.error("e2e seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await closeDb();
  });
