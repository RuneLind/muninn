/**
 * The answer export button (answer cards PR 4, acceptance row 4) in the /wiki
 * reader, against a real muninn and the real test database.
 *
 * What a unit test cannot show: the reader mounts "Copy new answers (N)" in
 * the breadcrumb row from the page payload's `answers.canExport`, the click
 * writes the prefetched block to the REAL clipboard inside the user gesture,
 * the confirm runs only after that write succeeded, and the cards then flip to
 * Copied; a second click finds none; "Copy again" marks nothing; a block
 * fetched for other answers than the cards show is never copied; an answer
 * edited before the copy is exported once, in its latest version. And the
 * button is absent for role `user` (a second muninn: `MUNINN_PROFILE=nais`,
 * `MUNINN_AUTH=local`, the loopback session at role `user`).
 *
 * Synthetic fixtures only. Rows are deleted by wiki name before and after.
 * ENV PREREQUISITE: `bun run db:setup:test`. No model calls.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-answer-export");
const BASE = `http://127.0.0.1:${PORT}`;
const USER_PORT = e2ePort("wiki-answer-export/user");
const USER_BASE = `http://127.0.0.1:${USER_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-answer-export";
const OWNER = "Rune Owner";
const REL = "plans/export.mdx";
const STALE_REL = "plans/stale.mdx";
const FAIL_REL = "plans/fail.mdx";
const SECRET = "e2e-answer-export-secret-not-real";

const q = (id: string, text: string, attrs = "") => [`<Question id="${id}"${attrs}>`, "", `**${text}**`, "", "</Question>", ""];
const page = (title: string, ids: string[]) =>
  [
    "---",
    `title: ${title}`,
    "type: plan",
    "---",
    "",
    ...ids.flatMap((id, i) => q(id, `Spørsmål ${i + 1}?`, i === 0 ? ' choices="A|B"' : "")),
    "<DecisionLog>",
    "",
    ...ids.map((id) => `- **${id}** — Åpent.`),
    "",
    "</DecisionLog>",
    "",
  ].join("\n");

let server: ChildProcess | undefined;
let userServer: ChildProcess | undefined;
let base = "";
let botsDir = "";
let sql: postgres.Sql | undefined;

const deleteRows = async () => {
  await sql!`DELETE FROM wiki_answers WHERE wiki = ${WIKI}`;
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

async function waitUp(url: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("muninn did not start: " + url);
    await new Promise((r) => setTimeout(r, 400));
  }
}

test.beforeAll(async ({}, info) => {
  info.setTimeout(90_000);
  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  await sql.unsafe(readFileSync(path.join(REPO_ROOT, "db/migrations/082-wiki-answers.sql"), "utf8"));
  await deleteRows();
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-answer-export-"));
  await mkdir(path.join(base, "plans"), { recursive: true });
  await writeFile(path.join(base, REL), page("Eksportside", ["O1", "O2", "O3"]), "utf8");
  await writeFile(path.join(base, STALE_REL), page("Stale page", ["S1", "S2"]), "utf8");
  await writeFile(path.join(base, FAIL_REL), page("Fail page", ["F1"]), "utf8");
  botsDir = await mkdtemp(path.join(tmpdir(), "muninn-e2e-answer-export-bots-"));
  await mkdir(path.join(botsDir, "e2e-export-bot"));
  await writeFile(path.join(botsDir, "e2e-export-bot", "CLAUDE.md"), "# throwaway e2e bot, no wiki\n", "utf8");

  const common = {
    ...process.env,
    ...e2eEnv(),
    DATABASE_URL: TEST_DB,
    DASHBOARD_HOST: "127.0.0.1",
    SCHEDULER_ENABLED: "false",
    WIKI_ANSWER_WIKIS: WIKI,
    WIKI_ANSWER_OWNER: OWNER,
  };
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: { ...common, DASHBOARD_PORT: String(PORT), WIKI_EXTRA: `${WIKI}=${base}` },
    stdio: "ignore",
  });
  // The pod shape: the read slice serves the reader to role `user` over a
  // read-only root; the answer routes are outside that role's zone.
  userServer = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...common,
      DASHBOARD_PORT: String(USER_PORT),
      MUNINN_PROFILE: "nais",
      MUNINN_AUTH: "local",
      MUNINN_LOCAL_TOKEN: SECRET,
      MUNINN_LOCAL_USER: "e2e-export-reader",
      MUNINN_ADMIN_IDENTS: "A123456",
      MUNINN_ALLOWED_ORIGINS: USER_BASE,
      WIKI_EXTRA: `${WIKI}=${base}`,
      WIKI_READONLY_ROOTS: base,
      MUNINN_BOTS_DIR: botsDir,
    },
    stdio: "ignore",
  });
  await Promise.all([waitUp(`${BASE}/api/wiki/pages?wiki=${WIKI}`), waitUp(`${USER_BASE}/api/live`)]);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  userServer?.kill("SIGTERM");
  if (sql) await deleteRows();
  await sql?.end();
  if (base) await rm(base, { recursive: true, force: true });
  if (botsDir) await rm(botsDir, { recursive: true, force: true });
});

const exportBtn = (p: Page) => p.locator('#wikiAnswerExport button[data-answer-export="new"]');
const againBtn = (p: Page) => p.locator('#wikiAnswerExport button[data-answer-export="again"]');
const status = (p: Page) => p.locator("#wikiAnswerExport .wiki-answer-export-msg");
const card = (p: Page, id: string) => p.locator(`.wiki-article section.question[data-question-id="${id}"]`);
const clipboard = (p: Page) => p.evaluate(() => navigator.clipboard.readText());

async function open(p: Page, rel: string, b = BASE) {
  await p.goto(`${b}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(p.locator(".wiki-article section.question").first()).toBeVisible();
}

const exportedRows = async (rel: string) =>
  sql!`SELECT question_id, version, exported_at FROM wiki_answers
       WHERE wiki = ${WIKI} AND rel_path = ${rel} ORDER BY question_id, version`;

test.describe("Wiki reader: Copy new answers", () => {
  test("copies every unexported answer word for word, marks them after the copy, then finds none; Copy again marks nothing", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    await api({ relPath: REL, questionId: "O1", choice: "B", body: "Første linje.\n\nTredje — «sitat» med **markdown** og `kode`." });
    // O2 is edited before the copy: exported once, in its latest version.
    const o2 = await api({ relPath: REL, questionId: "O2", body: "Første utkast." });
    await api({ relPath: REL, questionId: "O2", body: "Endelig svar.", answerId: o2.answerId, baseVersion: 1 });

    await open(page, REL);
    await expect(exportBtn(page)).toHaveText("Copy new answers (2)");
    await expect(exportBtn(page)).toBeEnabled();
    await expect(card(page, "O2")).toHaveAttribute("data-answer-state", "answered");
    expect((await exportedRows(REL)).every((r) => r.exported_at === null)).toBe(true);

    await page.evaluate(() => navigator.clipboard.writeText("before"));
    await exportBtn(page).click();
    await expect(status(page)).toHaveText("Copied 2 answers.");

    const block = await clipboard(page);
    const lines = block.split("\n");
    expect(lines[0]).toMatch(new RegExp(`^<!-- answers · ${WIKI} · plans/export\\.mdx · exported \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} -->$`));
    expect(lines.slice(1).join("\n").replace(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/g, "<when>")).toBe(
      [
        "### O1 — Rune Owner (asked), <when>, chose B, version 1",
        "> Første linje.",
        ">",
        "> Tredje — «sitat» med **markdown** og `kode`.",
        "",
        "### O2 — Rune Owner (asked), <when>, version 2",
        "> Endelig svar.",
        "",
        `<!-- orphaned answers in ${WIKI}: 0 -->`,
        "",
      ].join("\n"),
    );
    expect(block).not.toContain("Første utkast.");

    // Marked: every row, O2's first version with it, one shared timestamp.
    const rows = await exportedRows(REL);
    expect(rows.map((r) => [r.question_id, r.version, r.exported_at !== null])).toEqual([
      ["O1", 1, true],
      ["O2", 1, true],
      ["O2", 2, true],
    ]);
    expect(new Set(rows.map((r) => (r.exported_at as Date).getTime())).size).toBe(1);

    // The cards flip to Copied and the count clears: a second click finds none.
    await expect(card(page, "O1")).toHaveAttribute("data-answer-state", "copied");
    await expect(card(page, "O2")).toHaveAttribute("data-answer-state", "copied");
    await expect(exportBtn(page)).toHaveText("Copy new answers (0)");
    await expect(exportBtn(page)).toBeDisabled();

    // Copy again: the same answers, and nothing marked anew.
    const stampBefore = (rows[0]!.exported_at as Date).getTime();
    await page.evaluate(() => navigator.clipboard.writeText("before again"));
    await expect(againBtn(page)).toBeEnabled();
    await againBtn(page).click();
    await expect(status(page)).toHaveText("Copied 2 answers again.");
    const again = await clipboard(page);
    expect(again.split("\n").slice(1).join("\n")).toBe(lines.slice(1).join("\n"));
    const after = await exportedRows(REL);
    expect(after.map((r) => (r.exported_at as Date).getTime())).toEqual([stampBefore, stampBefore, stampBefore]);
  });

  test("a block fetched for other answers than the cards show is not copied: it refetches and asks for a second click", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    await api({ relPath: STALE_REL, questionId: "S1", choice: "A", body: "Først." });
    await open(page, STALE_REL);
    await expect(exportBtn(page)).toHaveText("Copy new answers (1)");

    // Hold every later export fetch, then save a second answer in the card.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/wiki/answers/export?*", async (route) => {
      await held;
      await route.continue();
    });
    const s2 = card(page, "S2");
    await s2.locator("textarea.q-text").fill("Lagt til etterpå.");
    await s2.locator("button.q-save").click();
    await expect(exportBtn(page)).toHaveText("Copy new answers (2)");

    await page.evaluate(() => navigator.clipboard.writeText("untouched"));
    await exportBtn(page).click();
    await expect(status(page)).toHaveText("The answers changed. Loading the new ones; click again.");
    expect(await clipboard(page)).toBe("untouched");
    expect((await exportedRows(STALE_REL)).every((r) => r.exported_at === null)).toBe(true);

    release();
    await expect(async () => {
      await exportBtn(page).click();
      await expect(status(page)).toHaveText("Copied 2 answers.", { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    const copied = await clipboard(page);
    expect(copied).toContain("> Først.");
    expect(copied).toContain("> Lagt til etterpå.");
    expect((await exportedRows(STALE_REL)).every((r) => r.exported_at !== null)).toBe(true);
  });

  test("a failed clipboard write marks nothing", async ({ page }) => {
    await api({ relPath: FAIL_REL, questionId: "F1", choice: "A", body: "Svar." });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new Error("denied")), readText: () => Promise.resolve("") },
      });
      document.execCommand = () => false;
    });
    await open(page, FAIL_REL);
    await expect(exportBtn(page)).toHaveText("Copy new answers (1)");
    await exportBtn(page).click();
    await expect(status(page)).toHaveText("Could not copy to the clipboard. Nothing was marked as copied.");
    await expect(exportBtn(page)).toHaveText("Copy new answers (1)");
    await expect(exportBtn(page)).toBeEnabled();
    expect((await exportedRows(FAIL_REL)).map((r) => r.exported_at)).toEqual([null]);
  });
});

test.describe("Wiki reader: no export for role user", () => {
  test("the button is absent and both export routes answer 403", async ({ page }) => {
    await api({ relPath: REL, questionId: "O3", body: "Et svar en bruker ikke skal kopiere." });
    const exportRequests: string[] = [];
    page.on("request", (req) => {
      if (new URL(req.url()).pathname.startsWith("/api/wiki/answers")) exportRequests.push(req.url());
    });
    await open(page, REL, USER_BASE);
    await expect(card(page, "O3")).toBeVisible();
    await expect(page.locator("#wikiBreadcrumb")).toBeVisible();
    await expect(page.locator("#wikiAnswerExport")).toHaveCount(0);
    expect(exportRequests).toEqual([]);

    const get = await fetch(`${USER_BASE}/api/wiki/answers/export?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    expect(get.status).toBe(403);
    const post = await fetch(`${USER_BASE}/api/wiki/answers/export/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: USER_BASE },
      body: JSON.stringify({ rows: [] }),
    });
    expect(post.status).toBe(403);
  });
});
