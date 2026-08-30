/**
 * Fenced code blocks inside the chat's THREE card render sites: the Jira draft
 * card, the Jira Research card and the research-action prompt card.
 *
 * All three call `formatWebHtml` + `sanitizeHtml` and then insert the HTML. Until
 * this spec's PR none of them called an ENHANCER afterwards, so their fences got
 * neither the CodeTabs wiring nor #494's header bar and Copy button — bare `pre`
 * blocks that look identical in a unit test and different on screen. A Jira
 * description routinely carries SQL and log fences, which is what made the draft
 * card the one that mattered.
 *
 * Driven end-to-end because that is the only place the failure is visible: the
 * enhancer is client-only, so a server-side assertion on the rendered HTML is
 * green either way — the exact "vacuous test" shape two of #494's first-cut tests
 * had. Mutation-checked: deleting any one of the three
 * `enhanceCodeBlocks(...)` calls turns the matching case red.
 *
 * The fixtures are seeded straight into Postgres and the muninn is spawned after,
 * so nothing here spends a model call. `JIRA_BOT` is pinned to the seeded bot
 * because `jiraCardsPossible()` requires `selectedBot === jiraBot` — a per-PROCESS
 * setting, hence a dedicated server rather than the config's shared 3011.
 *
 * ENV PREREQUISITE / SPAWN ENV: as every other spec here — a working `.env` at
 * the repo root, and `e2eEnv()` to keep this muninn off Telegram/Slack and off
 * the host's instance-profile flags.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("chat-card-fences");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

/** The one bot this repo tracks, so CI has it. */
const BOT = "jarvis";
const USER_ID = "e2e-fence-user";
const THREAD_NAME = "e2e-card-fences";

/** One fence body per card, each distinguishable in a failure message. */
const RESEARCH_FENCE = "SELECT saksnummer FROM behandling WHERE id = 1;";
const PROMPT_FENCE = 'const answer: number = 42;\nconsole.log("hi");';
const JIRA_FENCE = "psql -c 'select 1' \\\n  | grep -c ok";

const RESEARCH_MSG = [
  "<!-- research:jira -->",
  "MELOSYS-1 A seeded research card",
  "",
  "```sql",
  RESEARCH_FENCE,
  "```",
].join("\n");

const PROMPT_MSG = ["<!-- prompt:investigateCode -->", "", "```ts", PROMPT_FENCE, "```"].join("\n");

const JIRA_MARKDOWN = ["## Symptom", "", "```bash", JIRA_FENCE, "```"].join("\n");

let muninn: ChildProcess | undefined;
let sql: ReturnType<typeof postgres> | null = null;
let threadId = "";
let draftId = "";

async function waitUp(): Promise<void> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/live`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`muninn did not start on ${BASE}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

test.beforeAll(async () => {
  sql = postgres(TEST_DB, { max: 2 });

  // Idempotent: the rows are addressed by fixed ids/names, and a re-run must not
  // stack a second copy of each card into the same thread (every assertion below
  // is `.first()`-free on purpose, so a duplicate would read as a failure).
  await sql`DELETE FROM jira_drafts WHERE bot_name = ${BOT} AND notes = 'e2e-card-fences'`;
  await sql`DELETE FROM messages WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM threads WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM users WHERE id = ${USER_ID}`;

  await sql`INSERT INTO users (id, username, display_name, platform)
            VALUES (${USER_ID}, 'e2e-fences', 'E2E Card Fences', 'web')`;
  const [thread] = await sql<{ id: string }[]>`
    INSERT INTO threads (user_id, bot_name, name, description)
    VALUES (${USER_ID}, ${BOT}, ${THREAD_NAME}, 'seeded for chat-card-fences.spec.ts')
    RETURNING id`;
  threadId = thread!.id;

  // The two USER messages: the client renders both cards from raw markdown, so
  // these are the rows that exercise `formatWebHtml` in the browser.
  const insert = (role: string, content: string) => sql!<{ id: string }[]>`
    INSERT INTO messages (user_id, bot_name, username, role, content, platform, thread_id)
    VALUES (${USER_ID}, ${BOT}, 'e2e-fences', ${role}, ${content}, 'web', ${threadId})
    RETURNING id`;
  await insert("user", RESEARCH_MSG);
  await insert("user", PROMPT_MSG);
  // The bubble the Jira card hangs under. Its own body is irrelevant — the card
  // renders the DRAFT's markdown, never the reply's.
  const [botMsg] = await insert("assistant", "Her er utkastet.");

  const [draft] = await sql<{ id: string }[]>`
    INSERT INTO jira_drafts
      (bot_name, template, depth, notes, status, markdown, retrieval_coverage,
       source, thread_id, message_id)
    VALUES (${BOT}, 'bug', 'ingen', 'e2e-card-fences', 'ready', ${JIRA_MARKDOWN},
            'no_hits', 'thread', ${threadId}, ${botMsg!.id})
    RETURNING id`;
  draftId = draft!.id;

  muninn = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      JIRA_BOT: BOT,
    },
    stdio: "ignore",
  });
  await waitUp();
});

test.afterAll(async () => {
  muninn?.kill("SIGTERM");
  await sql?.end();
});

async function openThread(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${BASE}/chat?bot=${BOT}&user=${USER_ID}&thread=${threadId}`);
  // The replay is done once the last seeded bubble is on screen.
  await expect(page.locator(".msg-bot").last()).toContainText("Her er utkastet.");
}

/** The chrome #494 builds, as the DOM shows it: a wrapper, a bar, a Copy button. */
async function expectChrome(fence: import("@playwright/test").Locator, source: string) {
  await expect(fence).toBeVisible();
  await expect(fence.locator(".fence-bar .fence-copy")).toBeVisible();
  // …and wrapping did not disturb the source. This is what Copy hands over.
  expect(await fence.locator("pre > code").textContent()).toBe(source);
}

test.describe("chat card fences get the same chrome as every other bubble", () => {
  test("the Jira Research card", async ({ page }) => {
    await openThread(page);
    const card = page.locator(".msg-research-card:not(.msg-prompt-card)");
    await expect(card).toHaveCount(1);
    await expectChrome(card.locator(".fence"), RESEARCH_FENCE);
    await expect(card.locator(".fence-lang")).toHaveText("sql");
  });

  test("the research-action prompt card", async ({ page }) => {
    await openThread(page);
    const card = page.locator(".msg-prompt-card");
    await expect(card).toHaveCount(1);
    await expectChrome(card.locator(".fence"), PROMPT_FENCE);
    await expect(card.locator(".fence-lang")).toHaveText("ts");
  });

  test("the Jira draft card — the one that carries SQL and log fences in real use", async ({
    page,
  }) => {
    await openThread(page);
    // Adopted after the replay, off `GET /api/jira/drafts?thread=`.
    const card = page.locator(`[data-jira-card="${draftId}"]`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expectChrome(card.locator(".fence"), JIRA_FENCE);
    await expect(card.locator(".fence-lang")).toHaveText("bash");
  });

  test("a card redraw re-enhances without nesting a second bar", async ({ page }) => {
    await openThread(page);
    const card = page.locator(`[data-jira-card="${draftId}"]`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    // A thread switch away and back is the ordinary redraw path: the card is
    // rebuilt from `view.markdown`, so the old wrapper leaves with the old node
    // and no `unwrapCodeBlockChrome` is owed. A nested `.fence .fence` here is
    // what the clone hazard would look like if that ever stopped being true.
    await page.reload();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator(".fence")).toHaveCount(1);
    await expect(card.locator(".fence .fence")).toHaveCount(0);
  });
});
