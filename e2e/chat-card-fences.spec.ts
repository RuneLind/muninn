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
import { OWN_CHROME_FIXTURES, NO_OWN_CHROME_FIXTURE } from "../src/test/own-chrome-fixtures.ts";
import { COMPONENT_FENCE_CHROME } from "../src/dashboard/views/components/code-block-chrome.ts";

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
/**
 * Have the ROWS been written? The teardown's error handling forks on it.
 *
 * ⚠️ Not "did `beforeAll` finish". The inserts happen before the spawn, so the
 * likeliest setup failure — `waitUp()` timing out on a busy port or a muninn that
 * dies at boot — leaves rows on the table, and a flag set after the spawn would
 * still read `false` there and swallow a genuine cleanup failure over them.
 *
 * Residual, accepted and written down: a throw BETWEEN the inserts (schema drift,
 * a constraint) leaves some rows with the flag still `false`, so a real cleanup
 * failure over them is still swallowed. Bounded on both sides — `beforeAll`'s own
 * leading DELETEs heal it on the next run, and `jira_drafts`, the one row nothing
 * cascades, is written last — so the flag covers the failure that matters rather
 * than every failure.
 */
let seeded = false;

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
  // stack a second copy of each card into the same thread — the card assertions
  // below resolve ONE node each (Playwright strict mode), so a duplicate reads as
  // a failure rather than silently passing on whichever came first.
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
  // Every row this file owns now exists — see the declaration.
  seeded = true;

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
  // Delete what this file wrote. `beforeAll` already clears the same rows, so the
  // suite is correct without this — but `jira_drafts.thread_id`/`message_id` are
  // plain UUID columns with no FK (migration 071), so a draft left behind is not
  // cascaded away by anything and would sit in `/jira?all=1` forever on whatever
  // database this ran against. Deleted in FK order.
  //
  // ⚠️ try/finally, not an `if (sql)` guard. `postgres()` does not connect
  // eagerly and is `beforeAll`'s FIRST statement, so `sql` is non-null in every
  // realistic setup failure and such a guard protects nothing: with the database
  // down, `beforeAll` throws on its first DELETE, these four throw again, the
  // hook aborts on the first one and `end()` never runs — a teardown error
  // stacked on the setup error, plus a leaked pool. The finally always closes
  // the pool.
  //
  // ⚠️ And the catch RE-THROWS unless setup itself failed. Swallowing outright
  // was the easy version and the wrong one: this block's whole reason for
  // existing is that a leaked draft row is cascaded away by nothing, so a DELETE
  // failing for a real reason — a constraint, a permission, schema drift — must
  // not leave those rows behind under a green run and one warn line in stdout.
  // `seeded` is the narrow case the swallow is actually for.
  try {
    if (sql) {
      await sql`DELETE FROM jira_drafts WHERE thread_id IN (SELECT id FROM threads WHERE user_id = ${USER_ID})`;
      await sql`DELETE FROM messages WHERE user_id = ${USER_ID}`;
      await sql`DELETE FROM threads WHERE user_id = ${USER_ID}`;
      await sql`DELETE FROM users WHERE id = ${USER_ID}`;
    }
  } catch (err) {
    if (seeded) throw err;
    console.warn("chat-card-fences: setup failed, so teardown could not clean up:", err);
  } finally {
    await sql?.end();
  }
});

async function openThread(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${BASE}/chat?bot=${BOT}&user=${USER_ID}&thread=${threadId}`);
  // The replay is done once the last seeded bubble is on screen.
  await expect(page.locator(".msg-bot").last()).toContainText("Her er utkastet.");
}

/**
 * The chrome #494 builds, as the DOM shows it: a wrapper, a bar, a Copy button.
 *
 * NB the button assertion is a PRESENCE check, not a visibility one, and cannot
 * be more than that here: `shared-styles.ts` gives `.fence-copy { opacity: 0 }`
 * and lifts it only on `.fence:hover` / `:focus-within`, and Playwright counts an
 * `opacity: 0` element as visible. The hover reveal is asserted once, on its own,
 * in the case below — asserting it in every call would be three identical hovers
 * proving one CSS rule.
 */
async function expectChrome(fence: import("@playwright/test").Locator, source: string) {
  await expect(fence).toBeVisible();
  await expect(fence.locator(".fence-bar .fence-copy")).toHaveCount(1);
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

  test("the IN-PLACE redraw re-enhances without nesting a second bar", async ({
    page,
    context,
  }) => {
    // ⚠️ This has to hit `existing.outerHTML = html` in `attachJiraCard`, which
    // a `page.reload()` does NOT: a reload throws the document away, so the
    // rebuild finds no existing card and takes the `insertAdjacentHTML` branch —
    // i.e. the same path the three cases above already cover, under a name that
    // claims otherwise. The reachable in-place paths are the generating→ready
    // transition and a message-signature change; a Kopier markdown click is the
    // latter, needs no model call, and is the one this drives.
    //
    // What it pins: the redraw builds fresh markup from `view.markdown` and never
    // clones enhanced DOM, which is why no `unwrapCodeBlockChrome` is owed here.
    // If that ever stops being true the clone carries the old wrapper and a dead
    // button, and re-enhancing wraps it a SECOND time inside the first — the
    // measured failure `unwrapCodeBlockChrome`'s docblock records.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openThread(page);
    const card = page.locator(`[data-jira-card="${draftId}"]`);
    await expect(card).toBeVisible({ timeout: 20_000 });

    await page.locator(`[data-jc-copy="${draftId}"]`).click();
    // ⚠️ THE REDRAW PROBE. Three review rounds patched this one line, so the
    // choice is written down rather than re-derived: what distinguishes the card
    // BEFORE the in-place redraw from the card after it?
    //
    //   .jira-card                 present → present          proves nothing
    //   .jira-card-msg present     present → present          proves nothing —
    //     `jira-card-pure.ts:277` renders `<span class="jira-card-msg" hidden>`
    //     on the FIRST paint, so `toHaveCount(1)` is satisfied before the click
    //   .jira-card-msg textContent ""      → non-empty        correct, but a
    //     one-shot `textContent()` read does NOT retry and races
    //     `copyJiraCard`'s `await navigator.clipboard.writeText`
    //   text contains «kopiert»    ""      → success only     branch-specific:
    //     the write has no fallback and writes a DIFFERENT sentence on reject,
    //     so this reports a clipboard-permission failure as a redraw failure
    //   .jira-card-msg VISIBLE     false   → true             ← the only cell
    //     that is both retrying and branch-independent: `hidden` is on the node
    //     until a message exists, and BOTH copy branches set one
    //   .fence count               1       → 1                unchanged
    //
    // So: visibility. Nothing below it can pass without a redraw having landed.
    // The same 20 s the sibling card assertions ask for: this round exists because
    // a contended runner is the failure mode, so the probe should not be the one
    // assertion on the default 5 s.
    await expect(card.locator(".jira-card-msg")).toBeVisible({ timeout: 20_000 });

    await expect(card.locator(".fence")).toHaveCount(1);
    await expect(card.locator(".fence .fence")).toHaveCount(0);
    await expect(card.locator(".fence-bar")).toHaveCount(1);
    // The rebuilt button is LIVE, not the dead clone a nested wrap would leave.
    await expectChrome(card.locator(".fence"), JIRA_FENCE);
    await card.locator(".fence").hover();
    await expect(card.locator(".fence-copy")).toHaveCSS("opacity", "1");
  });

  test("a component that owns its chrome gets NO second bar — in chat too", async ({ page }) => {
    // The `COMPONENT_FENCE_CHROME` skip reads a CLASS through `closest()`, and the
    // chat sanitizer strips a class that is not in `COMPONENT_CLASS_ALLOW`. Two of
    // the four selectors — `annotated-code` and `filetree` — were NOT allowlisted
    // when #494 shipped, so the skip was inert in chat and those blocks grew the
    // doubled bar the Record exists to prevent, on the one surface no unit test
    // sees. Driven through the real bundled `formatWebHtml` + `sanitizeHtml` +
    // `enhanceCodeBlocks`, because a copy of the allowlist would prove nothing.
    await page.goto(`${BASE}/chat`);
    await page.waitForFunction(
      () =>
        typeof (globalThis as { formatWebHtml?: unknown }).formatWebHtml === "function" &&
        typeof (globalThis as { enhanceCodeBlocks?: unknown }).enhanceCodeBlocks === "function",
    );

    const counts = await page.evaluate(({ fixtures, control }) => {
      const g = globalThis as unknown as {
        formatWebHtml: (s: string) => string;
        sanitizeHtml: (h: string, isWeb: boolean) => string;
        enhanceCodeBlocks: (root: ParentNode) => void;
      };
      // The SHARED fixture map, plus the no-chrome control. Hand-listing them
      // here was rebuilding, one layer up, the forgettable list
      // `COMPONENT_FENCE_CHROME` is a Record to prevent — and the unit guard's
      // coverage assertion is derived over that Record, so a fifth chrome-owning
      // component fails there until it has a fixture, and the fixture it gets is
      // the one this case iterates.
      const sources: Record<string, string> = { ...fixtures, Callout: control };
      const out: Record<string, { bars: number; wrapperClass: string; classes: string[] }> = {};
      for (const [name, src] of Object.entries(sources)) {
        const host = document.createElement("div");
        host.innerHTML = g.sanitizeHtml(g.formatWebHtml(src), true);
        document.body.appendChild(host);
        const divs = Array.from(host.querySelectorAll("div"));
        const wrapperClass = divs[0]?.className ?? "";
        // Every surviving class, so an INNER one the allowlist forgot is visible
        // here too — the outer wrapper surviving is not proof the block is whole.
        const classes = divs.map((d) => d.className).filter(Boolean);
        g.enhanceCodeBlocks(host);
        out[name] = { bars: host.querySelectorAll(".fence-bar").length, wrapperClass, classes };
        host.remove();
      }
      return out;
    }, { fixtures: OWN_CHROME_FIXTURES, control: NO_OWN_CHROME_FIXTURE });

    // Every chrome-owning component was actually exercised. Derived from the
    // RECORD, not from the fixture map: the first cut compared `counts`' keys
    // against `OWN_CHROME_FIXTURES`, but `counts` is BUILT from that same map, so
    // the two moved together and the assertion could not fail — measured,
    // dropping `Tab` from the map left this green over three components.
    const owners = Object.entries(COMPONENT_FENCE_CHROME)
      .filter(([, sel]) => sel !== null)
      .map(([name]) => name);
    expect(owners.filter((name) => !(name in counts))).toEqual([]);
    expect(Object.keys(counts)).toContain("Callout");
    for (const name of Object.keys(OWN_CHROME_FIXTURES)) {
      expect(`${name}: ${counts[name]!.bars} bars`).toBe(`${name}: 0 bars`);
    }

    // The class survived the sanitizer — which is the whole mechanism.
    expect(counts.AnnotatedCode!.wrapperClass).toBe("annotated-code");
    expect(counts.FileTree!.wrapperClass).toBe("filetree");
    // …and so did the block's INNER classes. The skip only needs the outer one;
    // a stripped inner class is the other half of the same allowlist omission,
    // and it renders a half-styled block that looks worse than an unstyled one.
    expect(counts.AnnotatedCode!.classes).toEqual([
      "annotated-code",
      "annotated-code-file",
      "annotated-code-panel",
      "annotated-code-notes",
    ]);
    // The control still gets one: the skip is a skip, not an off switch.
    expect(counts.Callout!.bars).toBe(1);
  });
});
