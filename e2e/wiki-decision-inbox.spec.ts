/**
 * The Decisions section of the Your work card (decision inbox P3a, mimir
 * plans/muninn-wiki-decision-triage.mdx). The rule is unit-tested
 * (`inbox.test.ts`) and the route against the test database
 * (`wiki-decision-inbox-db.test.ts`); what only a real page can hold:
 *
 *  1. The lanes holding cards paint with the right counts, «close?» and
 *     «ask you» open, «pass on» folded, the empty «take the default» in the one
 *     «Nothing …» line; a wiki whose only lane is «take the default» opens it.
 *  2. An answer in place (a pick, then Answer) goes through `POST /api/wiki/answers`
 *     and the row leaves «ask you» for «close?»; «take the default» answers with
 *     the recommendation.
 *  3. A card the reader already answered offers the page, not a form (the 409 race is a unit test).
 *  4. The section is legible in the Light and Dark themes.
 *  6. An opened card shows its choices as rows, rendered: no literal `**`.
 *  5. (P3b) Close previews the lines, writes them, and `/api/wiki/page` reads the
 *     close back; «Still open» hides a card across a reload until its evidence changes.
 *
 * One muninn on its own port, the test database, two temp git wikis:
 * `melosys-kode-wiki` (the rule's «ask» wiki) and one other. Answers are seeded
 * through the API and deleted by wiki and path before and after. Synthetic cards.
 * `SCHEDULER_ENABLED=false`: no work-map run, no model call.
 * ENV PREREQUISITE: `bun run db:setup:test`.
 */

import { test, expect, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { assertPortFree, waitForOwnServer } from "./own-server.ts";
import { contrastOf } from "./contrast.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-decision-inbox");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const KODE = "melosys-kode-wiki";
const OTHER = "e2e-inbox-other";
const REL = "plans/e2e-inbox-cards.mdx";
const OTHER_REL = "plans/e2e-inbox-other.mdx";
const OWNER = "Test Owner (T000001)";
const HOUR = 3_600_000;

const q = (id: string, attrs: string, text: string) => `<Question id="${id}"${attrs}>\n\n${text}\n\n</Question>\n`;
const PAGE = [
  "---\ntitle: Inbox cards\n---\n",
  q("O1", ' choices="A|B"', "**Ask me first?**\n\n**Recommendation:** A"),
  q("O2", ' choices="A|B"', "Answered by choice?"),
  q("O3", ' to="Someone Else (X999999)"', "For someone else?"),
  q("O4", ' choices="A|B"', "Answered not sure?"),
  q("O5", "", "Answered in text only?"),
  q("O6", ' to="Test Owner (T000001)|Someone Else (X999999)"', "For both of us?"),
  q("O7", "", "Ruled on the page?"),
  "<DecisionLog>\n\n- **O7** — Decided in the meeting.\n\n</DecisionLog>\n",
].join("\n");
const OTHER_PAGE = `---\ntitle: Other cards\n---\n\n${q("O1", ' choices="A|B"', "**Default this?**\n\nThe context, **bold**.\n\n- **A — first way:** cheap.\n- **B — second way:** safe.\n\n**Recommendation: B.** It holds.")}`;

function mapJson(wiki: string, runAtMs: number): string {
  return JSON.stringify({
    version: 1, wiki, runAtMs, model: "test-model",
    coverage: { sessionsSinceMs: runAtMs - 8 * 24 * HOUR, sessionsAsOfMs: runAtMs, touchWindowDays: 28, activePages: 1, threads: 1, logEntries: 1, logEntriesInWindow: 1, digestChars: 100, metadataFilter: { degraded: false }, warnings: [] },
    summary: "", needsYou: [], themes: [], efforts: [], loose: [],
  });
}

function commitAll(root: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) execFileSync("git", ["-C", root, ...args], { stdio: "ignore", env });
}

let server: ChildProcess | undefined;
let sql: postgres.Sql | undefined;
const roots: string[] = [];

const deleteRows = async () => {
  await sql!`DELETE FROM wiki_answers WHERE wiki IN (${KODE}, ${OTHER}) AND rel_path LIKE 'plans/e2e-inbox-%'`;
};

async function seedWiki(name: string, rel: string, text: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-${name}-`));
  roots.push(root);
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, rel), text, "utf8");
  await writeFile(path.join(root, ".work-map.json"), mapJson(name, Date.now() - 2 * HOUR), "utf8");
  commitAll(root);
  return root;
}

async function answer(questionId: string, choice: string | null, body: string): Promise<void> {
  const res = await fetch(`${BASE}/api/wiki/answers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wiki: KODE, relPath: REL, questionId, choice, body }),
  });
  expect(res.status).toBe(201);
}

test.beforeAll(async () => {
  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  await deleteRows();
  const kode = await seedWiki(KODE, REL, PAGE);
  const other = await seedWiki(OTHER, OTHER_REL, OTHER_PAGE);
  await assertPortFree(PORT);
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_DIR: "",
      WIKI_EXTRA: `${KODE}=${kode},${OTHER}=${other}`,
      WORK_MAP_WIKIS: `${KODE},${OTHER}`,
      WIKI_ANSWER_WIKIS: `${KODE},${OTHER}`,
      WIKI_ANSWER_OWNER: OWNER,
    },
    stdio: "ignore",
  });
  await waitForOwnServer(server, `${BASE}/api/wiki/pages?wiki=${KODE}`);
  await answer("O2", "A", "");
  await answer("O4", "not-sure", "Not yet.");
  await answer("O5", null, "Go with the second.");
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (sql) await deleteRows();
  await sql?.end();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const lane = (page: Page, l: string) => page.locator(`#wikiWorkInbox details[data-wi-lane="${l}"]`);
const count = (page: Page, l: string) => lane(page, l).locator(":scope > summary .wiki-wm-count");
const row = (page: Page, l: string, id: string) => lane(page, l).locator(".wiki-wi-item", { has: page.locator(".wiki-wi-q", { hasText: new RegExp(`^${id} · `) }) });

async function openInbox(page: Page, wiki: string): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  await expect(page.locator("#wikiWorkInbox")).toBeVisible();
}

test.describe.serial("the Decisions section", () => {
  test("paints the lanes holding cards with their counts, the first two open, the empty one as a line", async ({ page }) => {
    await openInbox(page, KODE);
    await expect(count(page, "close")).toHaveText("3");
    await expect(count(page, "ask")).toHaveText("3");
    await expect(count(page, "pass")).toHaveText("1");
    await expect(lane(page, "default")).toHaveCount(0);
    await expect(page.locator("#wikiWorkInbox .wiki-wi-empty")).toHaveText("Nothing to take by default.");
    await expect(page.locator("#wikiWorkInbox")).not.toContainText("None.");
    for (const [l, open] of [["close", true], ["ask", true], ["pass", false]] as const) {
      expect(await lane(page, l).evaluate((d) => (d as HTMLDetailsElement).open)).toBe(open);
    }
    await expect(row(page, "close", "O5").locator(".wiki-wi-tag")).toHaveText("read it before closing");
    await expect(row(page, "close", "O7").locator(".wiki-wi-tag")).toHaveText("page rules");
    // A «close?» row offers Close…, Still open and the page (P3b).
    await row(page, "close", "O2").locator(".wiki-wi-row").click();
    await expect(row(page, "close", "O2").locator(".wiki-wi-acts")).toHaveText(/^Close…\s*Still open\s*Open on the page$/);
  });

  test("an answer in place moves the row from «ask you» to «close?»", async ({ page }) => {
    await openInbox(page, KODE);
    const o1 = row(page, "ask", "O1");
    await o1.locator(".wiki-wi-row").click();
    await expect(o1.locator('[data-wi-act="answer"]')).toBeDisabled();
    await o1.locator('[data-wi-choice="A"]').click();
    await o1.locator('[data-wi-act="answer"]').click();
    await expect(count(page, "ask")).toHaveText("2");
    await expect(count(page, "close")).toHaveText("4");
    await expect(row(page, "close", "O1").locator(".wiki-wi-ev")).toContainText("Answered A · Test Owner");
    await expect(row(page, "ask", "O1")).toHaveCount(0);
  });

  test("a card the reader already answered not sure offers the page, not a form", async ({ page }) => {
    await openInbox(page, KODE);
    const o4 = row(page, "ask", "O4");
    await o4.locator(".wiki-wi-row").click();
    await expect(o4.locator(".wiki-wi-detail")).toContainText("change it on the page");
    await expect(o4.locator('[data-wi-act="answer"]')).toHaveCount(0);
    await expect(o4.locator(".wiki-wi-detail a")).toHaveAttribute("data-relpath", REL);
    await expect(count(page, "ask")).toHaveText("2");
  });

  test("a default-only wiki opens that lane; its card shows choice rows; Take answers with the recommendation", async ({ page }) => {
    await openInbox(page, OTHER);
    await expect(count(page, "default")).toHaveText("1");
    expect(await lane(page, "default").evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
    await expect(page.locator("#wikiWorkInbox .wiki-wi-empty")).toHaveText("Nothing to close · for you · to pass on.");
    const o1 = row(page, "default", "O1");
    await expect(o1.locator(".wiki-wi-q")).toContainText("O1 · Default this?");
    await o1.locator(".wiki-wi-row").click();
    const detail = o1.locator(".wiki-wi-detail");
    await expect(detail.locator(".wiki-wi-context strong")).toHaveText("bold");
    await expect(detail.locator(".wiki-wi-choice")).toHaveText([/^A\s*first way cheap\.$/, /^B\s*second way safe\.\s*Recommended$/]);
    await expect(detail.locator(".wiki-wi-choice.rec")).toHaveAttribute("data-wi-choice", "B");
    await expect(detail.locator(".wiki-wi-why")).toHaveText(/^Why B\s+It holds\.$/);
    expect(await detail.textContent()).not.toContain("**");
    await expect(detail).not.toContainText("Default this?");
    // A row is the pick: it presses, and Answer wakes.
    await detail.locator('.wiki-wi-choice[data-wi-choice="A"]').click();
    await expect(o1.locator('.wiki-wi-choice[data-wi-choice="A"]')).toHaveAttribute("aria-pressed", "true");
    await expect(o1.locator('[data-wi-act="answer"]')).toBeEnabled();
    await o1.locator('.wiki-wi-choice[data-wi-choice="A"]').click();
    await o1.locator('[data-wi-act="take"]').click();
    await expect(lane(page, "default")).toHaveCount(0);
    await expect(row(page, "close", "O1").locator(".wiki-wi-ev")).toContainText("Answered B");
  });

  test("Close previews the lines, writes them, and the page reads closed", async ({ page }) => {
    await openInbox(page, KODE);
    const o2 = row(page, "close", "O2");
    await o2.locator(".wiki-wi-row").click();
    await o2.locator('[data-wi-act="preview"]').click();
    await expect(o2.locator(".wiki-wi-pre")).toHaveText(/- \*\*O2\*\* — See the card\. Closed \d{4}-\d{2}-\d{2} \(D1\)\.\n- \*\*D1\*\* — Answer A on card O2\. Test Owner, \d{2}\.\d{2}\.\d{4}\./);
    const before = await count(page, "close").textContent();
    await o2.locator('[data-wi-act="close"]').click();
    await expect(row(page, "close", "O2")).toHaveCount(0);
    await expect(count(page, "close")).toHaveText(String(Number(before) - 1));
    const res = await page.request.get(`${BASE}/api/wiki/page?wiki=${KODE}&relPath=${encodeURIComponent(REL)}`);
    expect(res.status()).toBe(200);
    const html = ((await res.json()) as { html: string }).html;
    expect(html).toContain('data-question-id="O2" data-question-state="decided" data-question-decision="D1"');
    expect(html).toMatch(/See the card\. Closed \d{4}-\d{2}-\d{2} \(D1\)\./);
  });

  test("«Still open» hides a card across a reload; Show brings it back", async ({ page }) => {
    await openInbox(page, KODE);
    const o5 = row(page, "close", "O5");
    await o5.locator(".wiki-wi-row").click();
    await o5.locator('[data-wi-act="keep"]').click();
    await expect(row(page, "close", "O5")).toHaveCount(0);
    await page.reload();
    await expect(page.locator("#wikiWorkInbox")).toBeVisible();
    await expect(row(page, "close", "O5")).toHaveCount(0);
    await lane(page, "close").locator('[data-wi-act="kept"]').click();
    await expect(row(page, "close", "O5").locator(".wiki-wi-tag")).toHaveText("kept open");
  });

  test("a kept-open store that is not an object reads as empty, and «Still open» still hides the card", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("muninn-inbox-kept", "5"));
    await openInbox(page, KODE);
    const o5 = row(page, "close", "O5");
    await o5.locator(".wiki-wi-row").click();
    await o5.locator('[data-wi-act="keep"]').click();
    await expect(row(page, "close", "O5")).toHaveCount(0);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`legible in the ${theme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((v) => localStorage.setItem("muninn-theme", v), theme);
      await openInbox(page, KODE);
      await row(page, "close", "O5").locator(".wiki-wi-row").click();
      await row(page, "ask", "O4").locator(".wiki-wi-row").click();
      await page.mouse.move(0, 0);
      const inbox = page.locator("#wikiWorkInbox");
      const sweep = async (sels: string[], required: boolean) => {
        for (const sel of sels) {
          const els = await inbox.locator(sel).all();
          if (required) expect(els.length, `${sel} in ${theme}`).toBeGreaterThan(0);
          for (const el of els) {
            if (!(await el.isVisible())) continue;
            expect(await contrastOf(el), `${sel} in ${theme}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      };
      await sweep([".wiki-wi-q", ".wiki-wi-page", ".wiki-wi-age", ".wiki-wi-tag", ".wiki-wi-ev b", ".wiki-wi-quote", ".wiki-wi-body", ".wiki-wi-btn", ".wiki-wi-hint"], false);
      // The choice rows: OTHER's card, answered B by now, sits in «close?», the lane that opens.
      await openInbox(page, OTHER);
      await row(page, "close", "O1").locator(".wiki-wi-row").click();
      await page.mouse.move(0, 0);
      await sweep([".wiki-wi-context", ".wiki-wi-letter", ".wiki-wi-choice-text", ".wiki-wi-choice-text b", ".wiki-wi-rec", ".wiki-wi-why", ".wiki-wi-why > b", ".wiki-wi-empty"], true);
    });
  }
});
