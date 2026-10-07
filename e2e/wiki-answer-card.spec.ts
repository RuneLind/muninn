/**
 * The answer card's client (answer cards PR 3) in the /wiki reader: a real
 * muninn, the real test database, `MUNINN_AUTH` off with `WIKI_ANSWER_OWNER`
 * set, and three temp wikis — two in `WIKI_ANSWER_WIKIS` (English, Norwegian)
 * and one outside it.
 *
 * What a unit test cannot show: the reader bundle hydrates the server-rendered
 * card from `/api/wiki/page`'s `answers` flag, the composer posts to the real
 * route and the card repaints from the real GET (owner name, the server's
 * `asked`, `edited N×`, the log fold), a double-click stores one answer, a
 * second browser's edit turns a stale edit into the conflict message, a closed
 * card offers no composer while a reopened one takes an answer, and a wiki
 * outside the list never fetches answers at all. Plus token + 4.5:1 in both
 * themes for the new text-on-tint pairs, and the 390px focus layout.
 *
 * Synthetic fixtures only. Rows are deleted by wiki name before and after.
 * ENV PREREQUISITE: `bun run db:setup:test`. No model calls.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedContrast } from "./contrast.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-answer-card");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-answer-card";
const WIKI_NO = "e2e-answer-card-no";
const WIKI_RO = "e2e-answer-card-ro";
const REL = "plans/card.mdx";
const STYLE_REL = "plans/style.mdx";
// Synthetic throughout: invented names, ids and wording.
const OWNER = "Rune Owner";

const q = (id: string, text: string, attrs = "") => [`<Question id="${id}"${attrs}>`, "", `**${text}**`, "", "</Question>", ""];

const PAGE = [
  "---",
  "title: Card page",
  "type: plan",
  "---",
  "",
  "# Card page",
  "",
  ...q("O1", "Keep the export block in one language?", ' choices="A|B"'),
  ...q("O2", "Was the old flag dropped?"),
  ...q("O3", "Was the reopened one settled?"),
  ...q("O4", "Double-click safe?"),
  ...q("O5", "Who edits last?"),
  "<DecisionLog>",
  "",
  "- **D99** — The page's language.",
  "- **O1** — Export block language?",
  "- **O2** — Old flag? Closed 2026-10-08 (D99).",
  "- **O3** — Settled? Closed 2026-10-08 (D99). Reopened 2026-10-09.",
  "- **O4** — Double-click?",
  "- **O5** — Edits?",
  "",
  "</DecisionLog>",
  "",
].join("\n");

// Every new text-on-tint pair on one screen: an answered card with a choice,
// an edit and its log (C1), an answer from someone the page did not ask (C4),
// a closed card holding an uncopied answer (C2) and an empty composer (C3).
const STYLE_PAGE = [
  "---",
  "title: Style page",
  "type: plan",
  "---",
  "",
  ...q("C1", "Answered and edited?", ' choices="A|B"'),
  ...q("C2", "Closed with a new answer?"),
  ...q("C3", "Still open?", ' choices="A|B"'),
  ...q("C4", "Asked someone else?", ' to="Kari Nordmann (X222222)"'),
  "<DecisionLog>",
  "",
  "- **D99** — Done.",
  "- **C1** — One.",
  "- **C2** — Two. Closed 2026-10-08 (D99).",
  "- **C3** — Three.",
  "- **C4** — Four.",
  "",
  "</DecisionLog>",
  "",
].join("\n");

const PAGE_NO = [
  "---",
  "title: Kortside",
  "type: plan",
  'questions_to: ["Kari Nordmann (X222222)"]',
  "---",
  "",
  ...q("O1", "Skal blokken være på norsk?", ' choices="A|B"'),
  "<DecisionLog>",
  "",
  "- **O1** — Språk?",
  "",
  "</DecisionLog>",
  "",
].join("\n");

let server: ChildProcess | undefined;
let base = "";
let sql: postgres.Sql | undefined;

const deleteRows = async () => {
  await sql!`DELETE FROM wiki_answers WHERE wiki IN (${WIKI}, ${WIKI_NO}, ${WIKI_RO})`;
};

async function api(body: Record<string, unknown>): Promise<{ answerId: string; version: number }> {
  const res = await fetch(`${BASE}/api/wiki/answers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wiki: WIKI, ...body }),
  });
  if (!res.ok) throw new Error(`seed POST ${res.status}: ${await res.text()}`);
  return res.json();
}

test.beforeAll(async ({}, info) => {
  info.setTimeout(90_000);
  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  await sql.unsafe(readFileSync(path.join(REPO_ROOT, "db/migrations/082-wiki-answers.sql"), "utf8"));
  await deleteRows();
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-answer-card-"));
  for (const dir of ["a", "no", "ro"]) await mkdir(path.join(base, dir, "plans"), { recursive: true });
  await writeFile(path.join(base, "a", REL), PAGE, "utf8");
  await writeFile(path.join(base, "a", STYLE_REL), STYLE_PAGE, "utf8");
  await writeFile(path.join(base, "ro", REL), PAGE, "utf8");
  await writeFile(path.join(base, "no", REL), PAGE_NO, "utf8");
  await writeFile(path.join(base, "no", ".wiki-reader.json"), JSON.stringify({ language: "no" }), "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${path.join(base, "a")},${WIKI_NO}=${path.join(base, "no")},${WIKI_RO}=${path.join(base, "ro")}`,
      WIKI_ANSWER_WIKIS: `${WIKI},${WIKI_NO}`,
      WIKI_ANSWER_OWNER: OWNER,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }

  // The style page's state, through the real route.
  const c1 = await api({ relPath: STYLE_REL, questionId: "C1", choice: "A", body: "First thought." });
  await api({ relPath: STYLE_REL, questionId: "C1", choice: "B", body: "Second thought.", answerId: c1.answerId, baseVersion: 1 });
  await api({ relPath: STYLE_REL, questionId: "C4", body: "Not asked, answered anyway." });
  // C2 is closed, so the route refuses it: an answer saved before the close.
  await sql`INSERT INTO wiki_answers (answer_id, version, wiki, rel_path, question_id, author_name, body, question_hash)
            VALUES (${randomUUID()}, 1, ${WIKI}, ${STYLE_REL}, 'C2', ${OWNER}, 'Saved before the close.', 'seed')`;
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (sql) await deleteRows();
  await sql?.end();
  if (base) await rm(base, { recursive: true, force: true });
});

function watch(page: Page): { failed: string[]; errors: string[]; answerGets: string[] } {
  const failed: string[] = [];
  const errors: string[] = [];
  const answerGets: string[] = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.pathname === "/api/wiki/answers" && req.method() === "GET") answerGets.push(u.search);
  });
  page.on("response", (res) => {
    const u = new URL(res.url());
    const similarDegrade = u.pathname === "/api/wiki/similar" && res.status() === 404;
    if (u.origin === BASE && res.status() >= 400 && !similarDegrade) failed.push(`${res.status()} ${u.pathname}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return { failed, errors, answerGets };
}

const card = (page: Page, id: string) => page.locator(`.wiki-article section.question[data-question-id="${id}"]`);

async function openPage(page: Page, wiki = WIKI, rel = REL) {
  const seen = watch(page);
  await page.goto(`${BASE}/wiki?wiki=${wiki}&relPath=${encodeURIComponent(rel)}`);
  await expect(page.locator(".wiki-article section.question").first()).toBeVisible();
  return seen;
}

const expectClean = (seen: { failed: string[]; errors: string[] }) => {
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
};

const rowsFor = async (questionId: string, rel = REL) =>
  sql!`SELECT answer_id, version, author_name, choice, body FROM wiki_answers
       WHERE wiki = ${WIKI} AND rel_path = ${rel} AND question_id = ${questionId} ORDER BY version`;

test.describe("Wiki reader: the answer card's composer", () => {
  test("answer with a choice and a body → Answered, the owner, asked; edit → edited 1× with both versions in the log", async ({ page }) => {
    const seen = await openPage(page);
    const o1 = card(page, "O1");
    await expect(o1.locator("form.q-composer")).toBeVisible();
    await expect(o1.locator(".q-state")).toHaveText("Open");
    await expect(o1.locator('input[type="radio"]')).toHaveCount(3);
    await expect(o1.locator(".q-choice")).toHaveText(["A", "B", "Not sure yet"]);
    await expect(o1.locator("button.q-save")).toBeDisabled();

    await o1.locator(".q-choice", { hasText: "B" }).click();
    await o1.locator("textarea.q-text").fill("Use the page's language.\nSecond line.");
    await expect(o1.locator(".q-count")).toHaveText("37 / 8000");
    await o1.locator("button.q-save").click();

    await expect(o1.locator(".q-state")).toHaveText("Answered");
    await expect(o1).toHaveAttribute("data-answer-state", "answered");
    const item = o1.locator(".q-answer");
    await expect(item).toHaveCount(1);
    await expect(item.locator(".q-author")).toHaveText(OWNER);
    await expect(item.locator(".q-asked")).toHaveText("asked");
    await expect(item.locator(".q-pick")).toHaveText("B");
    await expect(item.locator(".q-answer-body")).toHaveText("Use the page's language.\nSecond line.");
    // The viewer has an answer now: no second composer, an Edit instead.
    await expect(o1.locator("form.q-composer")).toHaveCount(0);

    await item.locator("button.q-edit").click();
    const edit = o1.locator("form.q-composer-edit");
    await expect(edit.locator("textarea.q-text")).toHaveValue("Use the page's language.\nSecond line.");
    await expect(edit.locator('input[value="B"]')).toBeChecked();
    await edit.locator(".q-choice", { hasText: "Not sure yet" }).click();
    await edit.locator("textarea.q-text").fill("Not sure after all.");
    await edit.locator("button.q-save").click();

    const after = o1.locator(".q-answer");
    await expect(after.locator(".q-edited")).toHaveText("· edited 1×");
    await expect(after.locator(":scope > .q-pick")).toHaveText("Not sure yet");
    await expect(after.locator(":scope > .q-answer-body")).toHaveText("Not sure after all.");
    await after.locator(".q-log > summary").click();
    await expect(after.locator(".q-log > summary")).toHaveText("Earlier versions (1)");
    await expect(after.locator(".q-log-item .q-by")).toContainText("version 1");
    await expect(after.locator(".q-log-item .q-answer-body")).toHaveText("Use the page's language.\nSecond line.");

    const rows = await rowsFor("O1");
    expect(rows.map((r) => [r.version, r.author_name, r.choice, r.body])).toEqual([
      [1, OWNER, "B", "Use the page's language.\nSecond line."],
      [2, OWNER, "not-sure", "Not sure after all."],
    ]);
    expect(new Set(rows.map((r) => r.answer_id)).size).toBe(1);
    expectClean(seen);
  });

  test("a closed card has no composer; a reopened card takes an answer", async ({ page }) => {
    const seen = await openPage(page);
    await expect(card(page, "O2").locator(".q-state")).toHaveText("Decided → D99");
    await expect(card(page, "O3").locator("form.q-composer")).toBeVisible();
    await expect(card(page, "O2").locator("form.q-composer, textarea, button.q-save")).toHaveCount(0);

    const o3 = card(page, "O3");
    await o3.locator("textarea.q-text").fill("Settled after the reopen.");
    await o3.locator("button.q-save").click();
    await expect(o3.locator(".q-state")).toHaveText("Answered");
    expect((await rowsFor("O3")).map((r) => r.body)).toEqual(["Settled after the reopen."]);
    expectClean(seen);
  });

  test("a double-click on Save stores one answer", async ({ page }) => {
    const seen = await openPage(page);
    const o4 = card(page, "O4");
    await o4.locator("textarea.q-text").fill("Once.");
    await o4.locator("button.q-save").dblclick();
    await expect(o4.locator(".q-answer")).toHaveCount(1);
    // Let any second request land before counting.
    await page.waitForTimeout(500);
    expect((await rowsFor("O4")).length).toBe(1);
    await expect(o4.locator(".q-answer")).toHaveCount(1);
    expectClean(seen);
  });

  test("an edit made from a stale version shows the conflict message and the newer answer", async ({ browser }) => {
    const first = await api({ relPath: REL, questionId: "O5", body: "Version one." });
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    const seenA = await openPage(a);
    await openPage(b);

    await card(a, "O5").locator("button.q-edit").click();
    await card(a, "O5").locator("textarea.q-text").fill("A's edit, from version one.");

    await card(b, "O5").locator("button.q-edit").click();
    await card(b, "O5").locator("textarea.q-text").fill("B got there first.");
    await card(b, "O5").locator("button.q-save").click();
    await expect(card(b, "O5").locator(".q-edited")).toHaveText("· edited 1×");

    await card(a, "O5").locator("button.q-save").click();
    const msg = card(a, "O5").locator(".q-msg");
    await expect(msg).toHaveText(
      "This answer changed somewhere else. The latest version is shown; edit it again to change it.",
    );
    await expect(card(a, "O5").locator(".q-answer > .q-answer-body")).toHaveText("B got there first.");
    const rows = await rowsFor("O5");
    expect(rows.map((r) => [r.answer_id, r.version, r.body])).toEqual([
      [first.answerId, 1, "Version one."],
      [first.answerId, 2, "B got there first."],
    ]);
    // The 409 is the one failed response, and it is the expected one.
    expect(seenA.failed).toEqual(["409 /api/wiki/answers"]);
    expect(seenA.errors).toEqual([]);
    await ctxA.close();
    await ctxB.close();
  });

  test("a wiki outside WIKI_ANSWER_WIKIS renders the card read-only and never asks for answers", async ({ page }) => {
    const seen = await openPage(page, WIKI_RO);
    await page.waitForTimeout(800);
    const cards = page.locator(".wiki-article section.question");
    await expect(cards).toHaveCount(5);
    await expect(cards.first()).toHaveAttribute("data-wiki-answerable", "false");
    await expect(page.locator(".wiki-article .q-composer, .wiki-article .q-answers, .wiki-article .q-edit")).toHaveCount(0);
    expect(seen.answerGets).toEqual([]);
    expectClean(seen);
  });

  test('language "no": the composer, the states and "not asked" in Norwegian', async ({ page }) => {
    const seen = await openPage(page, WIKI_NO);
    const o1 = card(page, "O1");
    await expect(o1.locator(".q-choice")).toHaveText(["A", "B", "Vet ikke ennå"]);
    await expect(o1.locator("button.q-save")).toHaveText("Lagre svar");
    await expect(o1.locator("textarea.q-text")).toHaveAttribute("placeholder", "Svaret ditt …");
    await o1.locator(".q-choice", { hasText: "A" }).click();
    await o1.locator("button.q-save").click();
    await expect(o1.locator(".q-state")).toHaveText("Besvart");
    // questions_to names Kari, so the owner's answer is "ikke spurt".
    await expect(o1.locator(".q-asked")).toHaveText("ikke spurt");
    await expect(o1.locator("button.q-edit")).toHaveText("Endre");
    expectClean(seen);
  });
});

test.describe("Wiki reader: the answer card's look", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`new text-on-tint pairs read at 4.5:1 on their tokens, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const seen = await openPage(page, WIKI, STYLE_REL);
      await expect(card(page, "C1").locator(".q-answer")).toHaveCount(1);
      await card(page, "C1").locator(".q-log > summary").click();
      await page.mouse.move(0, 0);
      const token = (name: string) =>
        page.evaluate((v) => {
          const p = document.createElement("span");
          p.style.color = `var(${v})`;
          document.body.appendChild(p);
          const c = getComputedStyle(p).color;
          p.remove();
          return c;
        }, name);
      const soft = await token("--text-soft");
      const primary = await token("--text-primary");
      const c1 = card(page, "C1");
      const c3 = card(page, "C3");
      const pinned: [string, ReturnType<Page["locator"]>, string][] = [
        ["by line", c1.locator(".q-answer > .q-by").first(), soft],
        ["counter", c3.locator(".q-count"), soft],
        ["log summary", c1.locator(".q-log > summary"), soft],
        ["author", c1.locator(".q-author"), primary],
        ["asked", c1.locator(".q-asked"), primary],
        ["not asked", card(page, "C4").locator(".q-asked"), primary],
        ["choice chip", c1.locator(".q-answer > .q-pick"), primary],
        ["answered pill", c1.locator(".q-state"), primary],
        ["new badge", card(page, "C2").locator(".q-new"), primary],
        ["composer choice", c3.locator(".q-choice").first(), primary],
        ["edit button", c1.locator("button.q-edit"), primary],
      ];
      await expect(card(page, "C2").locator(".q-new")).toHaveText("1 new");
      await expect(card(page, "C4").locator(".q-asked")).toHaveText("not asked");
      for (const [name, loc, color] of pinned) {
        expect(await loc.evaluate((el) => getComputedStyle(el).color), `${name} token`).toBe(color);
        expect(await paintedContrast(loc), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      // The answer body and the textarea's own text.
      expect(await paintedContrast(c1.locator(".q-answer > .q-answer-body")), "body contrast").toBeGreaterThanOrEqual(4.5);
      await c3.locator("textarea.q-text").fill("typed");
      expect(await paintedContrast(c3.locator("textarea.q-text")), "textarea contrast").toBeGreaterThanOrEqual(4.5);
      expect(await paintedContrast(c3.locator("button.q-save")), "save contrast").toBeGreaterThanOrEqual(4.5);

      // The two message tones, from stubbed refusals (no row is written).
      await page.route("**/api/wiki/answers", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "a refusal", code: "x" }) })
          : route.fallback(),
      );
      await c3.locator("button.q-save").click();
      const err = c3.locator(".q-msg-error");
      await expect(err).toHaveText("The answer was not saved: a refusal");
      expect(await paintedContrast(err), "error message contrast").toBeGreaterThanOrEqual(4.5);
      await page.unroute("**/api/wiki/answers");
      await page.route("**/api/wiki/answers", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "x", code: "version_conflict" }) })
          : route.fallback(),
      );
      await c3.locator("textarea.q-text").fill("typed again");
      await c3.locator("button.q-save").click();
      const warn = c3.locator(".q-msg-warn");
      await expect(warn).toBeVisible();
      expect(await paintedContrast(warn), "warn message contrast").toBeGreaterThanOrEqual(4.5);
      expect(seen.errors).toEqual([]);
    });
  }

  test("at 390px in focus mode the cards do not scroll the page sideways", async ({ page }) => {
    const seen = await openPage(page, WIKI, STYLE_REL);
    await expect(card(page, "C1").locator(".q-answer")).toHaveCount(1);
    await card(page, "C1").locator(".q-log > summary").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("f");
    await expect.poll(async () => (await page.locator(".wiki-article").boundingBox())!.width).toBeGreaterThan(250);
    const m = await page.evaluate(() => {
      const art = document.querySelector(".wiki-article")!.getBoundingClientRect().right;
      const all = Array.from(document.querySelectorAll(".wiki-article section.question")).flatMap((s) => [
        s,
        ...Array.from(s.querySelectorAll("*")),
      ]);
      return {
        page: document.documentElement.scrollWidth <= window.innerWidth + 1,
        checked: all.length,
        overflow: all
          .filter((e) => e.getBoundingClientRect().right > art + 1)
          .map((e) => `${e.tagName.toLowerCase()}.${e.className} +${Math.round(e.getBoundingClientRect().right - art)}px`),
      };
    });
    expect(m.page).toBe(true);
    expect(m.checked).toBeGreaterThan(30);
    expect(m.overflow).toEqual([]);
    expectClean(seen);
  });
});
