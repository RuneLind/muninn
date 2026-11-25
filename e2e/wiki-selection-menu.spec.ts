/**
 * Discuss v2 PR 5 (mimir plan muninn-wiki-discuss-v2, D2 and D3): the
 * selection menu. A bar at the selection and a right-click menu with the same
 * actions; ⇧-right-click is the browser's own. «Explain with context» answers
 * in an inline card under the paragraph that is a turn of the page's thread
 * (the same turn in the pane, once, with the pane closed when it starts);
 * «Where else» and «History» list what the mentions route finds, with no
 * model; a key in the selection gets a chip; «Add to Oppfølging» shows only on
 * a page with that heading; «Fact check» reaches the existing route.
 *
 * What the unit tests cannot reach: real mouse selection and a real
 * right-click in a browser, the bar's place at the selection, the card's
 * place under the paragraph, the turn streamed from a REAL claude-sdk
 * one-shot on the fake Messages API (its request carries the selection), and
 * `git grep`/`git log` over a real git wiki behind «Where else» and
 * «History».
 *
 * Its own muninn with `e2eEnv()`, a git wiki with no remote in a temp dir
 * (`WIKI_EXTRA`) with two commits and a `keys` kind, a throwaway `claude-sdk`
 * bot under `MUNINN_BOTS_DIR`, a chat user seeded as the bot's default, and
 * the fake Messages API as its own process (`e2e/fake-messages-api-server.ts`)
 * with its request log served. `E2E_SHOTS=<dir>` saves one screenshot per
 * state, in light and dark.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-selection-menu");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-selection-menu";
const REL = "plans/ferry.mdx";
const OTHER = "plans/harbour.mdx";
const BOT = "selbot";
const USER = "e2e-selection-user";
const KEY = "MEL-1029036";
const NIGHT = `The night route for ${KEY} is unchanged.`;
const PAGE = ["---", "title: Ferry plan", "---", "", "# Ferry plan", "", "## Brief", "", NIGHT, "", "The morning route adds a stop.", "", "## Oppfølging", "", "- Check the berth list.", ""].join("\n");
const PAGE_NO_FOLLOW = ["---", "title: Harbour plan", "---", "", "# Harbour plan", "", `The harbour waits for ${KEY}.`, "", "The pier opens at six.", ""].join("\n");
const RULES = ["# Rules", "", "Answer the question first.", "", "<!-- discuss:edit -->", "## Changing the page", "Propose at most one edit.", "<!-- /discuss:edit -->", ""].join("\n");
const ANSWER = "EXPLAIN-ANSWER: the night route keeps its timetable for this case.";

let server: ChildProcess | undefined;
let fake: ChildProcess | undefined;
let root = "";
let scratch = "";
let requestsUrl = "";
let sql: ReturnType<typeof postgres> | null = null;
const shots = process.env.E2E_SHOTS ?? "";

const GIT_IDENT = { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" };
function git(...args: string[]): string {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_IDENT } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: path.join(shots, `${name}-${scheme}.png`), fullPage: false });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

function startFake(): Promise<{ url: string; requests: string }> {
  fake = spawn("bun", ["--no-env-file", path.join(REPO_ROOT, "e2e/fake-messages-api-server.ts")], {
    cwd: REPO_ROOT,
    env: { ...process.env, FAKE_API_CHUNKS: JSON.stringify([ANSWER]), FAKE_API_DELAY_MS: "300", FAKE_API_REQUESTS: "1" },
    stdio: ["ignore", "pipe", "inherit"],
    detached: true,
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("the fake Messages API did not start")), 15_000);
    fake!.stdout!.on("data", (b: Buffer) => {
      out += b.toString();
      const url = /FAKE_API_URL=(\S+)/.exec(out)?.[1];
      const requests = /FAKE_API_REQUESTS_URL=(\S+)/.exec(out)?.[1];
      if (url && requests) {
        clearTimeout(timer);
        resolve({ url, requests });
      }
    });
  });
}

async function recorded(): Promise<string[]> {
  const bodies = (await (await fetch(requestsUrl)).json()) as { body: unknown }[];
  return bodies.map((r) => JSON.stringify(r.body));
}

test.beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "muninn-e2e-selection-menu-"));
  root = path.join(scratch, "wiki");
  await mkdir(path.join(root, "plans"), { recursive: true });
  await mkdir(path.join(root, "sql"), { recursive: true });
  await writeFile(path.join(root, ".wiki-agent.md"), RULES, "utf8");
  await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ keys: [{ name: "case", pattern: "MEL-\\d+" }] }), "utf8");
  await writeFile(path.join(root, OTHER), PAGE_NO_FOLLOW, "utf8");
  await writeFile(path.join(root, "log.md"), `# Log\n\n## [2026-11-04] note | Q-3\n\n- ${KEY} is outside the data fix.\n`, "utf8");
  const init = spawnSync("git", ["init", "-q", "-b", "main", root], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`git init: ${init.stderr}`);
  git("add", "-A");
  git("commit", "-q", "-m", "Harbour plan names the case");
  // A second commit adds the key to two more files: «History» lists both commits.
  await writeFile(path.join(root, REL), PAGE, "utf8");
  await writeFile(path.join(root, "sql/q3.csv"), `case,state\n${KEY},open\n`, "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "Ferry plan and Q-3 name the case");
  const bot = path.join(scratch, "bots", BOT);
  await mkdir(bot, { recursive: true });
  await writeFile(path.join(bot, "CLAUDE.md"), "# e2e selection bot\n\nCreated by e2e/wiki-selection-menu.spec.ts.\n");
  await writeFile(path.join(bot, "config.json"), JSON.stringify({ connector: "claude-sdk", model: "claude-sonnet-4-5", timeoutMs: 120000 }));
  await mkdir(path.join(scratch, "claude-config"), { recursive: true });
  await mkdir(path.join(scratch, "agent-home"), { recursive: true });
  const f = await startFake();
  requestsUrl = f.requests;

  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  await sql`DELETE FROM threads WHERE user_id = ${USER}`;
  await sql`DELETE FROM wiki_discuss_turns WHERE wiki = ${WIKI}`;
  await sql`INSERT INTO users (id, username, platform) VALUES (${USER}, 'E2E Selection', 'web') ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO bot_default_user (bot_name, user_id) VALUES (${BOT}, ${USER}) ON CONFLICT (bot_name) DO UPDATE SET user_id = EXCLUDED.user_id`;

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root}`,
      MUNINN_BOTS_DIR: path.join(scratch, "bots"),
      RESEARCH_BOT: BOT,
      PLAN_CARD_BIN: "",
      DECISION_TRIAGE_REPO_ROOTS: "",
      MUNINN_AGENT_CWD: path.join(scratch, "agent-home"),
      ANTHROPIC_BASE_URL: f.url,
      ANTHROPIC_API_KEY: "sk-e2e-dummy",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_USE_VERTEX: "",
      CLAUDE_CONFIG_DIR: path.join(scratch, "claude-config"),
      ...GIT_IDENT,
    },
    stdio: process.env.E2E_DEBUG_SERVER ? "inherit" : "ignore",
    detached: true,
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(async () => {
  for (const p of [server, fake]) {
    if (!p?.pid) continue;
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  if (sql) {
    await sql`DELETE FROM threads WHERE user_id = ${USER}`.catch(() => {});
    await sql`DELETE FROM wiki_discuss_turns WHERE wiki = ${WIKI}`.catch(() => {});
    await sql.end({ timeout: 2 });
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test.use({ viewport: { width: 1360, height: 1000 } });

const bar = (page: Page) => page.locator("#wikiSelBar");
const menu = (page: Page) => page.locator("#wikiSelMenu");

async function openPage(page: Page, rel = REL): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(page.locator("#articleWrap .wiki-article")).toContainText(rel === REL ? "The morning route adds a stop." : "The pier opens at six.");
}

/** The client rects of `text`'s first copy in the article: its first and last line. */
async function textBox(page: Page, text: string): Promise<{ x0: number; y0: number; x1: number; y1: number }> {
  return page.evaluate((text) => {
    const article = document.querySelector("#articleWrap .wiki-article")!;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      const i = t.data.indexOf(text);
      if (i === -1) continue;
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + text.length);
      const rects = r.getClientRects();
      const a = rects[0]!;
      const b = rects[rects.length - 1]!;
      return { x0: a.left + 1, y0: a.top + a.height / 2, x1: b.right - 1, y1: b.top + b.height / 2 };
    }
    throw new Error(`no text ${text}`);
  }, text);
}

/** A real mouse drag over `text`. */
async function dragSelect(page: Page, text: string): Promise<{ x0: number; y0: number; x1: number; y1: number }> {
  // A press inside a live selection drags it instead of starting a new one.
  await page.evaluate(() => getSelection()!.removeAllRanges());
  const at = await textBox(page, text);
  await page.mouse.move(at.x0, at.y0);
  await page.mouse.down();
  await page.mouse.move(at.x1, at.y1, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(text);
  return at;
}

test("the bar and the right-click menu offer the same actions; ⇧-right-click is the browser's", async ({ page }) => {
  await openPage(page);
  // The breadcrumb keeps only the whole-page Fact check.
  await expect(page.locator("#wikiBreadcrumb #wikiFactcheckArticleBtn")).toBeVisible();
  await expect(page.locator("#wikiBreadcrumb #wikiExplainBtn, #wikiBreadcrumb #wikiFactcheckBtn")).toHaveCount(0);

  const at = await dragSelect(page, NIGHT);
  await expect(bar(page)).toBeVisible();
  const barActs = await bar(page).locator("[data-selact]").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-selact")}${e.getAttribute("data-selkey") ? `:${e.getAttribute("data-selkey")}` : ""}`));
  // The default first; one line of 3–80 characters is searchable as written; the key it
  // holds gets its own chip; Oppfølging is on this page.
  expect(barActs).toEqual(["explain", "where", "history", "factcheck", "copy", "follow", `key:${KEY}`]);
  await expect(bar(page).locator("#wikiExplainBtn")).toHaveText("✨ Explain with context");
  // The bar sits just under the selection's line.
  const box = (await bar(page).boundingBox())!;
  expect(box.y).toBeGreaterThan(at.y1);
  expect(box.y).toBeLessThan(at.y1 + 40);
  await shot(page, "1-bar-on-selection");

  // ⇧-right-click: the browser's menu (nothing prevented), not ours.
  const shiftPrevented = await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y)!;
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, shiftKey: true });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, { x: (at.x0 + at.x1) / 2, y: at.y0 });
  expect(shiftPrevented).toBe(false);
  await expect(menu(page)).toBeHidden();

  // A right-click on the selection: our menu, with the same actions as the bar.
  await page.mouse.click((at.x0 + at.x1) / 2, at.y0, { button: "right" });
  await expect(menu(page)).toBeVisible();
  await expect(bar(page)).toBeHidden();
  const menuActs = await menu(page).locator("[data-selact]").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-selact")}${e.getAttribute("data-selkey") ? `:${e.getAttribute("data-selkey")}` : ""}`));
  expect(menuActs).toEqual(barActs);
  await expect(menu(page)).toContainText("⇧ right-click");
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(NIGHT);
  await shot(page, "2-right-click-menu");
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();

  // The key alone: no chip beside «Where else», which already searches it.
  await dragSelect(page, KEY);
  await expect(bar(page)).toBeVisible();
  expect(await bar(page).locator("[data-selact]").evaluateAll((els) => els.map((e) => e.getAttribute("data-selact")))).toEqual(["explain", "where", "history", "factcheck", "copy", "follow"]);
  // Two lines are no key the route takes: no «Where else» or «History».
  await page.evaluate(() => {
    const article = document.querySelector("#articleWrap .wiki-article")!;
    const r = document.createRange();
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let first: Text | null = null;
    let last: Text | null = null;
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      if (!first && t.data.includes("The night route")) first = t;
      if (t.data.includes("The morning route")) last = t;
    }
    r.setStart(first!, first!.data.indexOf("The night route"));
    r.setEnd(last!, last!.data.indexOf("adds"));
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
    document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await expect(bar(page)).toBeVisible();
  await expect(bar(page).locator('[data-selact="where"], [data-selact="history"]')).toHaveCount(0);

  // A page with no Oppfølging heading offers no «Add to Oppfølging».
  await openPage(page, OTHER);
  await dragSelect(page, "The pier opens at six.");
  await expect(bar(page)).toBeVisible();
  await expect(bar(page).locator('[data-selact="follow"]')).toHaveCount(0);
});

test("«Explain with context» answers in an inline card under the paragraph: a turn of the page's thread, once in the pane", async ({ page }) => {
  test.setTimeout(180_000);
  await openPage(page);
  // The pane is not on the Discuss tab: the turn needs no open pane.
  await expect(page.locator('[data-conntab="discuss"]')).not.toHaveClass(/active/);
  await dragSelect(page, NIGHT);
  await bar(page).locator("#wikiExplainBtn").click();
  const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"]');
  await expect(card).toBeVisible();
  // Under the paragraph: after the selected text, before the next one.
  const order = await page.evaluate(() => {
    const article = document.querySelector("#articleWrap .wiki-article")!;
    const text = article.textContent ?? "";
    const c = article.querySelector(".wiki-sel-card")!.textContent ?? "";
    const at = text.indexOf(c);
    return { night: text.indexOf("The night route"), card: at, morning: text.indexOf("The morning route adds") };
  });
  expect(order.card).toBeGreaterThan(order.night);
  expect(order.card).toBeLessThan(order.morning);
  await expect(card.locator(".wiki-discuss-answer")).toContainText("EXPLAIN-ANSWER", { timeout: 90_000 });
  await expect(page.locator('[data-conntab="discuss"]')).not.toHaveClass(/active/);
  await shot(page, "3-explain-card-answered");

  // The request carried the selection and its place; an Explore turn.
  const req = (await recorded()).find((b) => b.includes("Explain this passage with context") && !b.includes("naming a coding session"));
  expect(req).toBeTruthy();
  expect(req).toContain(NIGHT);
  // A thread turn: one ledger row on the page's live wiki thread.
  const [thread] = await sql!`SELECT id FROM threads WHERE kind = 'wiki' AND wiki = ${WIKI} AND rel_path = ${REL} AND closed_at IS NULL`;
  expect(thread).toBeTruthy();
  await expect.poll(async () => (await sql!`SELECT count(*)::int AS n FROM wiki_discuss_turns WHERE thread_id = ${thread!.id} AND end_state = 'done'`)[0]!.n, { timeout: 30_000 }).toBe(1);
  const [row] = await sql!`SELECT question, selection FROM wiki_discuss_turns WHERE thread_id = ${thread!.id}`;
  expect(row!.question).toContain("Explain this passage with context");
  expect(row!.selection).toBe(NIGHT);

  // The card links to the pane: the same turn there, once.
  await card.locator("[data-sel-card-pane]").click();
  await expect(page.locator('[data-conntab="discuss"]')).toHaveClass(/active/);
  const turns = page.locator("#discussBody .wiki-discuss-turn");
  await expect(turns).toHaveCount(1);
  await expect(turns.first().locator(".wiki-discuss-answer")).toContainText("EXPLAIN-ANSWER");
  await expect(turns.first().locator(".wiki-discuss-chip")).toContainText("The night route");
  await shot(page, "4-explain-turn-in-pane");
  // After a reload the pane reads it back from the thread, still once.
  await page.reload();
  await page.locator('[data-conntab="discuss"]').click();
  await expect(page.locator("#discussBody .wiki-discuss-turn")).toHaveCount(1);
});

test("«Where else» lists the fixture's files and «History» its commits, with no model; a key chip opens its «Where else»", async ({ page }) => {
  await openPage(page);
  const before = (await recorded()).length;
  await dragSelect(page, KEY);
  const mentions = page.waitForResponse((r) => r.url().includes("/api/wiki/mentions?"));
  await bar(page).locator('[data-selact="where"]').click();
  expect((await mentions).status()).toBe(200);
  const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="where"]');
  await expect(card.locator(".wiki-sel-file")).toHaveCount(4);
  const files = await card.locator(".wiki-sel-file").evaluateAll((els) => els.map((e) => e.getAttribute("data-sel-file")).sort());
  expect(files).toEqual(["log.md", "plans/ferry.mdx", "plans/harbour.mdx", "sql/q3.csv"]);
  await expect(card.locator(`[data-sel-file="${REL}"] .wiki-sel-here`)).toHaveText("this page");
  await expect(card.locator(".wiki-sel-log")).toContainText("log.md: 1 line");
  await shot(page, "5-where-else-card");
  // A page row opens that page.
  await card.locator(`[data-sel-file="${OTHER}"] a`).click();
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("The pier opens at six.");

  // «History»: both commits, and the log.md entry.
  await openPage(page);
  await dragSelect(page, KEY);
  await bar(page).locator('[data-selact="history"]').click();
  const hist = page.locator('#articleWrap .wiki-sel-card[data-sel-card="history"]');
  await expect(hist.locator('.wiki-sel-ev[data-ev="commit"]')).toHaveCount(2);
  await expect(hist).toContainText("Ferry plan and Q-3 name the case");
  await expect(hist).toContainText("Harbour plan names the case");
  await expect(hist.locator('.wiki-sel-ev[data-ev="log"]')).toHaveCount(1);
  await shot(page, "6-history-card");

  // The key chip on a longer selection: its «Where else».
  await dragSelect(page, NIGHT);
  const chip = bar(page).locator(`[data-selact="key"][data-selkey="${KEY}"]`);
  await expect(chip).toHaveText(`🔗 ${KEY}`);
  await shot(page, "7-key-chip");
  await chip.click();
  const chipCard = page.locator('#articleWrap .wiki-sel-card[data-sel-card="where"]');
  await expect(chipCard.locator(".wiki-sel-card-sub")).toContainText(KEY);
  await expect(chipCard.locator(".wiki-sel-file")).toHaveCount(4);
  // No model was asked for any of it.
  expect((await recorded()).length).toBe(before);
});

test("«Fact check» reaches the existing selection fact-check route", async ({ page }) => {
  await openPage(page);
  await dragSelect(page, NIGHT);
  const fc = page.waitForRequest((r) => r.url().includes("/api/wiki/factcheck?"));
  await bar(page).locator("#wikiFactcheckBtn").click();
  const url = new URL((await fc).url());
  expect(url.searchParams.get("mode")).toBe("sel");
  expect(url.searchParams.get("sel")).toBe(NIGHT);
  expect(url.searchParams.get("relPath")).toBe(REL);
  // The fact-check turn opens where it always has: the Ask tab.
  await expect(page.locator(".wiki-conn-tab[data-conntab='ask']")).toHaveClass(/active/);
});

test("Enter with the bar open is the focused link's: the breadcrumb's ⌂ navigates and no turn starts", async ({ page }) => {
  await openPage(page);
  const turns: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname.startsWith("/api/wiki/discuss")) turns.push(r.url());
  });
  await dragSelect(page, NIGHT);
  await expect(bar(page)).toBeVisible();
  await page.locator("#wikiBreadcrumb a.wiki-bc-wiki").focus();
  await expect(bar(page)).toBeVisible();
  const from = page.url();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.url()).not.toBe(from);
  expect(new URL(page.url()).searchParams.get("relPath")).toBeNull();
  await expect(page.locator("#articleWrap .wiki-sel-card")).toHaveCount(0);
  expect(turns).toEqual([]);
});

test("a triple-clicked paragraph's «Where else» card lands under that paragraph, not at the page's end", async ({ page }) => {
  await openPage(page);
  await page.evaluate(() => getSelection()!.removeAllRanges());
  const at = await textBox(page, NIGHT);
  await page.mouse.click((at.x0 + at.x1) / 2, at.y0, { clickCount: 3 });
  await expect(bar(page)).toBeVisible();
  // Where Chrome ends a triple-click: on a boundary, not in the paragraph's text.
  const end = await page.evaluate(() => {
    const r = getSelection()!.getRangeAt(0);
    return { node: r.endContainer.nodeName, offset: r.endOffset, text: getSelection()!.toString().trim() };
  });
  test.info().annotations.push({ type: "triple-click end", description: JSON.stringify(end) });
  expect(end.text).toBe(NIGHT);
  await bar(page).locator('[data-selact="where"]').click();
  const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="where"]');
  // The whole sentence is named on this page only.
  await expect(card.locator(".wiki-sel-file")).toHaveCount(1);
  const order = await page.evaluate(() => {
    const article = document.querySelector("#articleWrap .wiki-article")!;
    const text = article.textContent ?? "";
    const c = article.querySelector(".wiki-sel-card")!.textContent ?? "";
    return { night: text.indexOf("The night route"), card: text.indexOf(c), morning: text.indexOf("The morning route adds") };
  });
  expect(order.card).toBeGreaterThan(order.night);
  expect(order.card).toBeLessThan(order.morning);
});
