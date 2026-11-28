/**
 * Discuss v2 PR 5 (mimir plan muninn-wiki-discuss-v2, D2 and D3): the
 * selection menu. A bar at the selection and a right-click menu with the same
 * actions; ⇧-right-click is the browser's own. «Explain with context» answers
 * in an inline card under the paragraph that is a turn of the page's thread
 * (the same turn in the pane, once, with the pane closed when it starts);
 * «Where else» and «History» list what the mentions route finds, with no
 * model; a key in the selection gets a chip (its Trace since PR 6); «Add to Oppfølging» shows only on
 * a page with that heading; «Fact check» calls the existing route (its stream is
 * stubbed in the page here: a runner has no `claude`, and a fast-failing stream
 * that the client closes crashed Bun 1.3.10's server).
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
 *
 * Fix round 1 batch 2: a card in a collapsed DecisionLog item is visible (the
 * compact lens rule hid it), and an inline card's «Change the wording» and
 * Apply show the Discuss tab (the reword box lives there; Apply's render
 * removes the card). Those two stub the turn as `wiki-discuss-apply.spec.ts`
 * does (a row with a hand-written edit, the discuss POST answered in the
 * page); the preview and Apply are the real routes. Apply writes the page, so
 * its test runs last.
 *
 * Fix round 1 batch 3: «Where else» on a phrase that wraps or carries markup
 * in the source never says «named nowhere» (F8); a page render drops the
 * mentions answers (F7); Explain where the thread cannot take the turn (a
 * turn still running, the article head) is the classic Explain (F9).
 *
 * Fix round 1 batch 4: a render of the page (its rail row clicked again)
 * puts the open Explain card back under its passage, a running turn's and a
 * classic stream's alike (F10); ⇧F10 opens the menu from the keyboard, its
 * arrows move and Escape closes it (F11); on a long page the bar hides while
 * its selection is scrolled away and a scroll closes the menu (F12).
 *
 * Fix round 2 batch 1: Enter and ⇧F10 inside an answerable `<Question>` card
 * and an overflowing mermaid box (plain `[tabindex]` containers) are the
 * bar's, and Escape puts focus back on the container (R2-1); a scroll of the
 * Discuss pane leaves the menu open (R2-2); on a second wiki with no
 * `.wiki-agent.md`, Explain answers in the inline card too (R2-3). The answer
 * routes need `WIKI_ANSWER_WIKIS`, so the server names this wiki there.
 *
 * Class check (round 3): a triple-clicked head title the body repeats, and a
 * selection across two DecisionLog items shown newest first, come back under
 * their passage when the unchanged page renders again; Explain while an
 * inline Apply runs is the classic card, so the Apply's 409 still shows on
 * the Discuss tab; an explainer's card hides with its frame in graph mode.
 * The fixture gains `plans/frame.html` and `plans/titled.mdx` (no key), in
 * the first commit, and the DecisionLog page text before and after its log.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
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
// Discuss v3 P1: a second /chat user of the bot, a default user no thread lists, and a second bot for /models.
const USER2 = "e2e-selection-user-2";
const USER3 = "e2e-selection-unlisted";
const BOT2 = "selbot-two";
const MODEL = "claude-sonnet-4-5";
const KEY = "MEL-1029036";
const NIGHT = `The night route for ${KEY} is unchanged.`;
const PAGE = ["---", "title: Ferry plan", "---", "", "# Ferry plan", "", "## Brief", "", NIGHT, "", "The morning route adds a stop.", "", "## Oppfølging", "", "- Check the berth list.", ""].join("\n");
const PAGE_NO_FOLLOW = ["---", "title: Harbour plan", "---", "", "# Harbour plan", "", `The harbour waits for ${KEY}.`, "", "The pier opens at six.", ""].join("\n");
const RULES = ["# Rules", "", "Answer the question first.", "", "<!-- discuss:edit -->", "## Changing the page", "Propose at most one edit.", "<!-- /discuss:edit -->", ""].join("\n");
const ANSWER = "EXPLAIN-ANSWER: the night route keeps its timetable for this case.";
const DECISIONS = "plans/decisions.mdx";
const FLAT = "Use the flat file";
const FOLLOW_OLD_TEXT = "The morning route adds a stop.";
const QUAY = "plans/quay.mdx";
const WRAPPED = "The ferry leaves from the north quay.";
const MARKED = "The berth list is long.";
// One phrase wraps across two source lines, one carries bold in the source.
const PAGE_QUAY = ["---", "title: Quay plan", "---", "", "# Quay plan", "", "The ferry leaves", "from the north quay.", "", "The **berth** list is long.", ""].join("\n");
const LONG = "plans/long.mdx";
const LONG_TARGET = "The long page keeps its target sentence near the top.";
// Enough paragraphs that the article pane scrolls well past the first one.
const PAGE_LONG = ["---", "title: Long plan", "---", "", "# Long plan", "", LONG_TARGET, "", ...Array.from({ length: 80 }, (_, i) => `Filler paragraph ${i + 1} about the harbour timetable and its berths.\n`)].join("\n");
const CARDS = "plans/cards.mdx";
const Q_TEXT = "Should the ferry wait for the late train?";
// Sixteen nodes in a row: wider than the column, so the box is a scrolling tab stop.
const WIDE_MERMAID = ["```mermaid", "graph LR", ...Array.from({ length: 15 }, (_, i) => `  N${i}[step ${i}] --> N${i + 1}[step ${i + 1}]`), "```"].join("\n");
const PAGE_CARDS = ["---", "title: Cards plan", "---", "", "# Cards plan", "", '<Question id="Q1">', "", Q_TEXT, "", "</Question>", "", WIDE_MERMAID, "", "The line after the diagram.", ""].join("\n");
const NOAGENT = "e2e-selection-noagent";
const PLAIN = "plans/plain.mdx";
const PLAIN_FIRST = "The plain wiki keeps its first sentence here.";
const PLAIN_SECOND = "The second sentence follows it.";
const PAGE_PLAIN = ["---", "title: Plain plan", "---", "", "# Plain plan", "", PLAIN_FIRST, "", PLAIN_SECOND, ""].join("\n");
// Fix round 2 batch 2, R2-6: a page the reader serves but git does not track
// yet, holding on one line a phrase a committed page holds too.
const FRESH = "plans/fresh.mdx";
const PIER = "The pier opens at six.";
const PAGE_FRESH = ["---", "title: Fresh plan", "---", "", "# Fresh plan", "", "Not committed yet.", "", PIER, ""].join("\n");
// Class check (round 3): an HTML explainer, to select in its frame.
const FRAME = "plans/frame.html";
const FRAME_TEXT = "The frame passage the reader selects.";
// Class check (round 3): a page whose body names its own title again.
const TITLED = "plans/titled.mdx";
const TITLE = "Pier timetable plan";
const PAGE_TITLED = ["---", `title: ${TITLE}`, "---", "", `The ${TITLE} is named here again, in the body.`, "", "The pier opens at seven.", ""].join("\n");
const PAGE_FRAME = `<!doctype html><html><head><title>Frame plan</title></head><body><h2>Frame heading</h2><p>${FRAME_TEXT}</p></body></html>`;
// Text before and after the log (class check): with none, the held context is empty on both sides.
const PAGE_DECISIONS = ["---", "title: Decisions plan", "---", "", "# Decisions plan", "", "The decisions below are for the ferry.", "", "<DecisionLog>", "", `- **D1** — ${FLAT}. The berth list stays in one place.`, "- **D2** — Keep the night route.", "", "</DecisionLog>", "", "The log closes here for now.", ""].join("\n");

let server: ChildProcess | undefined;
let fake: ChildProcess | undefined;
let root = "";
let plainRoot = "";
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
  await writeFile(path.join(root, DECISIONS), PAGE_DECISIONS, "utf8");
  await writeFile(path.join(root, QUAY), PAGE_QUAY, "utf8");
  await writeFile(path.join(root, LONG), PAGE_LONG, "utf8");
  await writeFile(path.join(root, CARDS), PAGE_CARDS, "utf8");
  await writeFile(path.join(root, FRAME), PAGE_FRAME, "utf8");
  await writeFile(path.join(root, TITLED), PAGE_TITLED, "utf8");
  // A second wiki with no `.wiki-agent.md`: no thread to put a turn in.
  plainRoot = path.join(scratch, "plain-wiki");
  await mkdir(path.join(plainRoot, "plans"), { recursive: true });
  await writeFile(path.join(plainRoot, PLAIN), PAGE_PLAIN, "utf8");
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
  // Left untracked: the grep behind «Where else» never reads it.
  await writeFile(path.join(root, FRESH), PAGE_FRESH, "utf8");
  const bot = path.join(scratch, "bots", BOT);
  await mkdir(bot, { recursive: true });
  await writeFile(path.join(bot, "CLAUDE.md"), "# e2e selection bot\n\nCreated by e2e/wiki-selection-menu.spec.ts.\n");
  await writeFile(path.join(bot, "config.json"), JSON.stringify({ connector: "claude-sdk", model: MODEL, timeoutMs: 120000 }));
  const bot2 = path.join(scratch, "bots", BOT2);
  await mkdir(bot2, { recursive: true });
  await writeFile(path.join(bot2, "CLAUDE.md"), "# e2e second bot\n\nCreated by e2e/wiki-selection-menu.spec.ts for /models?bot=.\n");
  await writeFile(path.join(bot2, "config.json"), JSON.stringify({ connector: "claude-sdk", model: MODEL }));
  await mkdir(path.join(scratch, "claude-config"), { recursive: true });
  await mkdir(path.join(scratch, "agent-home"), { recursive: true });
  const f = await startFake();
  requestsUrl = f.requests;

  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  await sql`DELETE FROM threads WHERE user_id IN (${USER}, ${USER2}, ${USER3})`;
  await sql`DELETE FROM wiki_discuss_turns WHERE wiki = ${WIKI}`;
  await sql`INSERT INTO users (id, username, platform) VALUES (${USER}, 'E2E Selection', 'web') ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO users (id, username, platform) VALUES (${USER2}, 'E2E Other', 'web') ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO users (id, username, platform) VALUES (${USER3}, 'E2E Unlisted', 'web') ON CONFLICT (id) DO NOTHING`;
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
      WIKI_EXTRA: `${WIKI}=${root},${NOAGENT}=${plainRoot}`,
      WIKI_ANSWER_WIKIS: WIKI,
      WIKI_ANSWER_OWNER: "E2E Owner (X000001)",
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
    await sql`DELETE FROM threads WHERE user_id IN (${USER}, ${USER2}, ${USER3})`.catch(() => {});
    await sql`DELETE FROM wiki_discuss_turns WHERE wiki = ${WIKI}`.catch(() => {});
    await sql.end({ timeout: 2 });
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test.use({ viewport: { width: 1360, height: 1000 } });

const bar = (page: Page) => page.locator("#wikiSelBar");
const menu = (page: Page) => page.locator("#wikiSelMenu");

async function openPage(page: Page, rel = REL, wiki = WIKI): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}&relPath=${encodeURIComponent(rel)}`);
  const shown: Record<string, string> = { [REL]: "The morning route adds a stop.", [OTHER]: "The pier opens at six.", [DECISIONS]: "Keep the night route.", [QUAY]: "list is long.", [LONG]: "Filler paragraph 80", [CARDS]: "The line after the diagram.", [PLAIN]: PLAIN_SECOND, [FRESH]: PIER, [TITLED]: "The pier opens at seven." };
  await expect(page.locator("#articleWrap .wiki-article")).toContainText(shown[rel]!);
}

/** The client rects of `text`'s first copy in the article (across inline
 *  markup's text nodes): its first and last line. */
async function textBox(page: Page, text: string, after = ""): Promise<{ x0: number; y0: number; x1: number; y1: number }> {
  return page.evaluate(({ text, after }) => {
    const article = document.querySelector("#articleWrap .wiki-article")!;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    const nodes: { t: Text; at: number }[] = [];
    let all = "";
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      nodes.push({ t, at: all.length });
      all += t.data;
    }
    // The first copy after `after`'s first copy, when given.
    const i = all.indexOf(text, after ? all.indexOf(after) : 0);
    if (i === -1) throw new Error(`no text ${text}`);
    const find = (n: number, end: boolean) => nodes.findLast((x) => (end ? x.at < n : x.at <= n))!;
    const s = find(i, false);
    const e = find(i + text.length, true);
    const r = document.createRange();
    r.setStart(s.t, i - s.at);
    r.setEnd(e.t, i + text.length - e.at);
    const rects = r.getClientRects();
    const a = rects[0]!;
    const b = rects[rects.length - 1]!;
    return { x0: a.left + 1, y0: a.top + a.height / 2, x1: b.right - 1, y1: b.top + b.height / 2 };
  }, { text, after });
}

/** A real mouse drag over `text` (as the DOM holds it); the selection reads `selected`. */
async function dragSelect(page: Page, text: string, selected = text, after = ""): Promise<{ x0: number; y0: number; x1: number; y1: number }> {
  // A press inside a live selection drags it instead of starting a new one.
  await page.evaluate(() => getSelection()!.removeAllRanges());
  const at = await textBox(page, text, after);
  await page.mouse.move(at.x0, at.y0);
  await page.mouse.down();
  await page.mouse.move(at.x1, at.y1, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(selected);
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
  // The passage item (Discuss v3 P1, «One button»): an agent and no handoff here, so the agent's label.
  expect(barActs).toEqual(["explain", "where", "history", "factcheck", "copy", "handoff", "follow", `key:${KEY}`]);
  await expect(bar(page).locator("#wikiDiscussHandoffBtn")).toHaveText("💬 Ask about this");
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
  expect(await bar(page).locator("[data-selact]").evaluateAll((els) => els.map((e) => e.getAttribute("data-selact")))).toEqual(["explain", "where", "history", "factcheck", "copy", "handoff", "follow"]);
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

test("«Where else» lists the fixture's files and «History» its commits, with no model; a key chip opens its Trace", async ({ page }) => {
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

  // The key chip on a longer selection: its Trace (PR 6), whose mentions list the same files.
  await dragSelect(page, NIGHT);
  const chip = bar(page).locator(`[data-selact="key"][data-selkey="${KEY}"]`);
  await expect(chip).toHaveText(`🧭 ${KEY}`);
  await shot(page, "7-key-chip");
  await chip.click();
  const chipCard = page.locator('#articleWrap .wiki-sel-card[data-sel-card="trace"]');
  await expect(chipCard.locator(".wiki-sel-card-sub")).toContainText(KEY);
  await expect(chipCard.locator(".wiki-sel-file")).toHaveCount(4);
  // No model was asked for any of it.
  expect((await recorded()).length).toBe(before);
});

test("«Fact check» calls the selection fact-check route (stream stubbed)", async ({ page }) => {
  await openPage(page);
  await dragSelect(page, NIGHT);
  // The stream is answered in the page, not by this spec's server. A runner has
  // no `claude`, so the real route's one-shot fails at once, and the client closes
  // its EventSource on that `app_error` while the server ends the response: on
  // that race Bun 1.3.10 segfaulted in uWS's socket-close handler (`panic(main
  // thread): Segmentation fault at address 0x0`), hung ~25 s in its crash handler
  // and died, so the next test's goto got ERR_CONNECTION_RESET. What is asserted
  // here is the client's half: the request and where its answer lands.
  const STUBBED = "stubbed fact-check end";
  await page.route("**/api/wiki/factcheck?**", (r) =>
    r.fulfill({ status: 200, contentType: "text/event-stream", body: `event: app_error\ndata: ${JSON.stringify({ type: "error", message: STUBBED })}\n\n` }),
  );
  const fc = page.waitForRequest((r) => r.url().includes("/api/wiki/factcheck?"));
  await bar(page).locator("#wikiFactcheckBtn").click();
  const url = new URL((await fc).url());
  expect(url.searchParams.get("mode")).toBe("sel");
  expect(url.searchParams.get("sel")).toBe(NIGHT);
  expect(url.searchParams.get("relPath")).toBe(REL);
  // The fact-check turn opens where it always has: the Ask tab, which shows the stream's end.
  await expect(page.locator(".wiki-conn-tab[data-conntab='ask']")).toHaveClass(/active/);
  await expect(page.locator("#wikiAskStatus")).toContainText(STUBBED);
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

test("a «Where else» card on a collapsed DecisionLog item is shown, in All and Overview", async ({ page }) => {
  await openPage(page, DECISIONS);
  const item = page.locator("#articleWrap .wiki-article li.dl-item").filter({ hasText: FLAT });
  await expect(item).not.toHaveClass(/dl-expanded/);
  await dragSelect(page, FLAT);
  await bar(page).locator('[data-selact="where"]').click();
  const card = item.locator('.wiki-sel-card[data-sel-card="where"]');
  await expect(card.locator(`[data-sel-file="${DECISIONS}"]`)).toHaveCount(1);
  // In the item, after its text, and laid out: not folded away with the item's rest.
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  // The item's rest is still folded: only the card is let through.
  await expect(item.locator(".dl-rest")).toBeHidden();
  await shot(page, "8-decisionlog-card");
  // Overview: this wiki offers no lens switch, so its class is set by hand; the
  // compact rule is the same, and the card stays shown.
  await expect(page.locator("#articleWrap .wiki-article")).toHaveClass(/\blens-all\b/);
  await page.evaluate(() => document.querySelector("#articleWrap .wiki-article")!.classList.replace("lens-all", "lens-overview"));
  await expect(card).toBeVisible();
  await expect(item.locator(".dl-rest")).toBeHidden();
});

test("«Where else» on a phrase that wraps or carries bold in the source: never «named nowhere»", async ({ page }) => {
  await openPage(page, QUAY);
  // The wrapped phrase keeps its source line break in the DOM; the selection reads a space.
  for (const [phrase, dom] of [[MARKED, MARKED], [WRAPPED, WRAPPED.replace("leaves ", "leaves\n")]] as const) {
    await dragSelect(page, dom, phrase);
    const answered = page.waitForResponse((r) => r.url().includes("/api/wiki/mentions?"));
    await bar(page).locator('[data-selact="where"]').click();
    const body = (await (await answered).json()) as { files: unknown[]; kind: string | null };
    // The route finds neither as written: the source has `**berth**`, and a line break.
    expect([phrase, body.files.length, body.kind]).toEqual([phrase, 0, null]);
    const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="where"]');
    await expect(card.locator(".wiki-sel-empty")).toContainText(`«${phrase}» is not found as written`);
    await expect(card).not.toContainText("named nowhere");
  }
  await shot(page, "11-where-else-not-as-written");
});

test("a page render drops the mentions answers: «Where else» after navigating asks the route again", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/wiki/mentions?")) asked.push(new URL(r.url()).searchParams.get("key")!);
  });
  await openPage(page);
  const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="where"]');
  for (let i = 0; i < 2; i++) {
    await dragSelect(page, KEY);
    await bar(page).locator('[data-selact="where"]').click();
    await expect(card.locator(".wiki-sel-file")).toHaveCount(4);
  }
  // On one render, within the freshness window: one request.
  expect(asked).toEqual([KEY]);
  // A page row opens the other page (a render), and its row back here (another).
  await card.locator(`[data-sel-file="${OTHER}"] a`).click();
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("The pier opens at six.");
  await dragSelect(page, KEY);
  await bar(page).locator('[data-selact="where"]').click();
  await expect(card.locator(".wiki-sel-file")).toHaveCount(4);
  expect(asked).toEqual([KEY, KEY]);
});

test("Explain where the page's thread cannot take the turn streams the classic answer into its own card: a turn still running, the article head", async ({ page }) => {
  const discussPosts: string[] = [];
  // The first inline turn never answers: it stays live.
  await page.route("**/api/wiki/discuss", (route) => {
    discussPosts.push(route.request().postData() ?? "");
  });
  const explains: URL[] = [];
  await page.route("**/api/wiki/explain?**", (route) => {
    const u = new URL(route.request().url());
    explains.push(u);
    const body = `event: delta\ndata: {"text":"CLASSIC "}\n\nevent: done\ndata: ${JSON.stringify({ answer: `CLASSIC-ANSWER for ${u.searchParams.get("sel")}` })}\n\nevent: end\ndata: {}\n\n`;
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
  });
  await openPage(page);
  await dragSelect(page, NIGHT);
  await bar(page).locator("#wikiExplainBtn").click();
  await expect.poll(() => discussPosts.length).toBe(1);
  const threadCard = page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"][data-sel-turn]');
  await expect(threadCard).toBeVisible();

  // A second Explain while it runs: answered in its own card, not refused, the page kept.
  await dragSelect(page, FOLLOW_OLD_TEXT);
  await bar(page).locator("#wikiExplainBtn").click();
  await expect.poll(() => explains.length).toBe(1);
  expect(explains[0]!.searchParams.get("sel")).toBe(FOLLOW_OLD_TEXT);
  expect(explains[0]!.searchParams.get("relPath")).toBe(REL);
  const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"]:not([data-sel-turn])');
  await expect(card.locator(".wiki-sel-card-body")).toContainText(`CLASSIC-ANSWER for ${FOLLOW_OLD_TEXT}`);
  await expect(card.locator(".wiki-sel-card-sub")).toContainText("busy");
  await expect(page.locator("#articleWrap .wiki-sel-card .wiki-discuss-error")).toHaveCount(0);
  await expect(page.locator("#articleWrap .wiki-article-head h1")).toHaveText("Ferry plan");
  await expect(page.locator(".wiki-conn-tab[data-conntab='ask']")).not.toHaveClass(/active/);
  await shot(page, "12-explain-busy-classic-card");
  expect(discussPosts.length).toBe(1);

  // The article head is in the article pane, not in the page's text: the same, under the head.
  await page.evaluate(() => getSelection()!.removeAllRanges());
  const h = (await page.locator("#articleWrap .wiki-article-head h1").boundingBox())!;
  await page.mouse.move(h.x + 1, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width - 1, h.y + h.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()!.toString().trim())).toBe("Ferry plan");
  await bar(page).locator("#wikiExplainBtn").click();
  await expect.poll(() => explains.length).toBe(2);
  expect(explains[1]!.searchParams.get("sel")).toBe("Ferry plan");
  await expect(card.locator(".wiki-sel-card-body")).toContainText("CLASSIC-ANSWER for Ferry plan");
  await expect(card.locator(".wiki-sel-card-sub")).toContainText("outside the page's text");
  expect(await card.evaluate((c) => c.previousElementSibling?.classList.contains("wiki-article-head"))).toBe(true);
  await expect(page.locator("#articleWrap .wiki-sel-card .wiki-discuss-error")).toHaveCount(0);
  expect(discussPosts.length).toBe(1);
});

/** Where `card`'s text sits in the article's text, against two sentences around it. */
async function cardBetween(page: Page, sel: string, before: string, after: string): Promise<boolean> {
  return page.evaluate(({ sel, before, after }) => {
    const article = document.querySelector("#articleWrap .wiki-article")!;
    const text = article.textContent ?? "";
    const c = document.querySelector(sel)?.textContent ?? "";
    const at = c ? text.indexOf(c) : -1;
    return at > text.indexOf(before) && at < (after ? text.indexOf(after) : Infinity);
  }, { sel, before, after });
}

test("a render of the same page puts the open Explain card back under its passage: a turn still running, then a classic stream", async ({ page }) => {
  // The inline turn never answers: it stays live, so the second Explain is the classic one.
  const discussPosts: string[] = [];
  await page.route("**/api/wiki/discuss", (route) => {
    discussPosts.push(route.request().postData() ?? "");
  });
  // The classic answer waits until the page has rendered again.
  let release: () => void = () => {};
  const released = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/explain?**", async (route) => {
    await released;
    const body = `event: delta\ndata: {"text":"CLASSIC "}\n\nevent: done\ndata: ${JSON.stringify({ answer: "CLASSIC-ANSWER after the render" })}\n\nevent: end\ndata: {}\n\n`;
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
  });
  const renderAgain = async () => {
    const rendered = page.waitForResponse((r) => r.url().includes("/api/wiki/page?"));
    // The rail row of the page on screen: the page is fetched and rendered again.
    await page.locator(`.wiki-list-item[data-relpath="${REL}"]`).first().click();
    await rendered;
    await expect(page.locator("#articleWrap .wiki-article")).toContainText(FOLLOW_OLD_TEXT);
  };
  await openPage(page);
  await dragSelect(page, NIGHT);
  await bar(page).locator("#wikiExplainBtn").click();
  await expect.poll(() => discussPosts.length).toBe(1);
  const threadCard = page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"][data-sel-turn]');
  await expect(threadCard).toBeVisible();
  const key = await threadCard.getAttribute("data-sel-turn");
  // A mark on the element: the card after the render is this one, not a new one.
  await threadCard.evaluate((el) => el.setAttribute("data-e2e-mark", "thread"));
  await renderAgain();
  await expect(page.locator(`#articleWrap .wiki-sel-card[data-sel-turn="${key}"][data-e2e-mark="thread"]`)).toBeVisible();
  expect(await cardBetween(page, ".wiki-sel-card", "The night route", FOLLOW_OLD_TEXT)).toBe(true);
  await shot(page, "13-card-back-after-render");

  // Explain on the morning sentence while that turn runs: the classic stream, its answer after a render.
  await dragSelect(page, FOLLOW_OLD_TEXT);
  await bar(page).locator("#wikiExplainBtn").click();
  const classic = page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"]:not([data-sel-turn])');
  await expect(classic).toBeVisible();
  await classic.evaluate((el) => el.setAttribute("data-e2e-mark", "classic"));
  await renderAgain();
  release();
  await expect(classic.locator(".wiki-sel-card-body")).toContainText("CLASSIC-ANSWER after the render");
  await expect(classic).toHaveAttribute("data-e2e-mark", "classic");
  expect(await cardBetween(page, ".wiki-sel-card", FOLLOW_OLD_TEXT, "Check the berth list")).toBe(true);
  expect(discussPosts.length).toBe(1);
});

test("fix round 2 R2-5: the selected paragraph rewritten on disk, its words still in another one: the card at the article's top with the note, not under that copy", async ({ page }) => {
  const PHRASE = "about the harbour timetable";
  const discussPosts: string[] = [];
  // The turn never answers: the card stays open across the render.
  await page.route("**/api/wiki/discuss", (route) => {
    discussPosts.push(route.request().postData() ?? "");
  });
  try {
    await openPage(page, LONG);
    await dragSelect(page, PHRASE, PHRASE, "Filler paragraph 5 ");
    await bar(page).locator("#wikiExplainBtn").click();
    await expect.poll(() => discussPosts.length).toBe(1);
    const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"][data-sel-turn]');
    await expect(card).toBeVisible();
    expect(await cardBetween(page, ".wiki-sel-card", "Filler paragraph 5 about", "Filler paragraph 6 about")).toBe(true);
    await card.evaluate((el) => el.setAttribute("data-e2e-mark", "r25"));
    await writeFile(path.join(root, LONG), PAGE_LONG.replace("Filler paragraph 5 about the harbour timetable and its berths.", "Paragraph 5 now covers the bus schedule instead."), "utf8");
    const rendered = page.waitForResponse((r) => r.url().includes("/api/wiki/page?"));
    await page.locator(`.wiki-list-item[data-relpath="${LONG}"]`).first().click();
    await rendered;
    await expect(page.locator("#articleWrap .wiki-article")).toContainText("Paragraph 5 now covers the bus schedule");
    const back = page.locator('#articleWrap .wiki-sel-card[data-e2e-mark="r25"]');
    await expect(back.locator(".wiki-sel-card-moved")).toHaveText("The passage this answers is no longer on the page as it was.");
    expect(await back.evaluate((el) => el.parentElement?.classList.contains("wiki-article") && el.parentElement.firstElementChild === el)).toBe(true);
    await shot(page, "16-card-moved-after-rewrite");
  } finally {
    await writeFile(path.join(root, LONG), PAGE_LONG, "utf8");
  }
});

test("fix round 2 R2-6: «Where else» on a phrase of a page git does not track yet never says its source lacks the phrase", async ({ page }) => {
  await openPage(page, FRESH);
  await dragSelect(page, PIER);
  const answered = page.waitForResponse((r) => r.url().includes("/api/wiki/mentions?"));
  await bar(page).locator('[data-selact="where"]').click();
  const body = (await (await answered).json()) as { files: { relPath: string }[]; kind: string | null };
  // The real grep: the committed page only, never the untracked one on screen.
  expect([body.kind, body.files.map((f) => f.relPath)]).toEqual([null, [OTHER]]);
  const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="where"]');
  await expect(card.locator(".wiki-sel-empty")).toContainText("This page is not listed, though the phrase was selected on it.");
  await expect(card.locator(".wiki-sel-empty")).toContainText("a new page not yet in git");
  await expect(card).not.toContainText("does not have the phrase");
  await shot(page, "17-where-else-untracked-page");
});

test("the keyboard reaches the menu: ⇧F10 on a keyboard selection opens it on its first item; arrows move, Escape puts focus back on the page, Enter runs the item", async ({ page }) => {
  await openPage(page);
  // The night sentence's first character selected, extended with ⇧→ (a collapsed
  // caret takes no ⇧→ outside caret browsing). Found by its start: the key
  // mark (PR 6) splits the sentence across text nodes.
  await page.evaluate((text) => {
    const walker = document.createTreeWalker(document.querySelector("#articleWrap .wiki-article")!, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      const i = t.data.indexOf(text);
      if (i === -1) continue;
      getSelection()!.setBaseAndExtent(t, i, t, i + 1);
      return;
    }
    throw new Error(text);
  }, NIGHT.slice(0, NIGHT.indexOf(KEY)));
  for (let i = 1; i < NIGHT.length; i++) await page.keyboard.press("Shift+ArrowRight");
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(NIGHT);
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-selact") ?? document.activeElement?.tagName ?? null);
  expect(await focused()).toBe("BODY");

  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  expect(await focused()).toBe("explain");
  // Under the selection, not at the corner.
  const at = await textBox(page, NIGHT);
  const box = (await menu(page).boundingBox())!;
  expect(box.y).toBeGreaterThan(at.y1);
  expect(box.y).toBeLessThan(at.y1 + 40);
  await page.keyboard.press("ArrowDown");
  expect(await focused()).toBe("where");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  // Wraps to the last item: the key chip.
  expect(await focused()).toBe("key");
  await page.keyboard.press("Home");
  expect(await focused()).toBe("explain");
  await shot(page, "14-keyboard-menu");
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  expect(await focused()).toBe("BODY");
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(NIGHT);

  // ↓ to «Where else», Enter: its card (no model), focus off the closed menu.
  await page.keyboard.press("Shift+F10");
  await page.keyboard.press("ArrowDown");
  expect(await focused()).toBe("where");
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeHidden();
  const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="where"]');
  await expect(card.locator(`[data-sel-file="${REL}"]`)).toHaveCount(1);
  expect(await focused()).toBe("BODY");

  // ⇧F10 on a focused link is the link's: our menu stays closed.
  await dragSelect(page, NIGHT);
  await page.locator("#wikiBreadcrumb a.wiki-bc-wiki").focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeHidden();
});

test("the bar hides while its selection is scrolled out of the article pane and comes back with it; a scroll closes the right-click menu", async ({ page }) => {
  await openPage(page, LONG);
  const at = await dragSelect(page, LONG_TARGET);
  await expect(bar(page)).toBeVisible();
  const pane = (await page.locator("#articleWrap").boundingBox())!;
  // The wheel over the article pane: the selection goes up out of it.
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => page.locator("#articleWrap").evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
  await expect(bar(page)).toBeHidden();
  // Enter with the bar hidden starts nothing.
  const turns: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname.startsWith("/api/wiki/discuss")) turns.push(r.url());
  });
  await page.keyboard.press("Enter");
  await expect(page.locator("#articleWrap .wiki-sel-card")).toHaveCount(0);
  await page.mouse.wheel(0, -1500);
  await expect.poll(() => page.locator("#articleWrap").evaluate((el) => el.scrollTop)).toBe(0);
  await expect(bar(page)).toBeVisible();
  const box = (await bar(page).boundingBox())!;
  expect(box.y).toBeGreaterThan(at.y1);
  expect(box.y).toBeLessThan(at.y1 + 40);
  expect(turns).toEqual([]);
  // Just above the pane's top, still in the viewport (under the breadcrumb): hidden too.
  const under = await page.evaluate((text) => {
    const wrap = document.getElementById("articleWrap")!;
    const r = getSelection()!.getRangeAt(0).getBoundingClientRect();
    wrap.scrollTop += r.bottom - wrap.getBoundingClientRect().top + 2;
    return { text: getSelection()!.toString() === text, bottom: getSelection()!.getRangeAt(0).getBoundingClientRect().bottom, top: wrap.getBoundingClientRect().top };
  }, LONG_TARGET);
  expect(under.text).toBe(true);
  expect(under.bottom).toBeLessThan(under.top);
  expect(under.bottom).toBeGreaterThan(0);
  await expect(bar(page)).toBeHidden();
  await page.locator("#articleWrap").evaluate((el) => (el.scrollTop = 0));
  await expect(bar(page)).toBeVisible();

  // A selection that fills the pane, its last line at the viewport's foot: the
  // bar has no room under it, and above it may not climb over the breadcrumb.
  await page.evaluate((text) => {
    const article = document.querySelector("#articleWrap .wiki-article")!;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let start: Text | null = null;
    let end: Text | null = null;
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      if (t.data.includes(text)) start = t;
      if (!start || !t.data.trim()) continue;
      // An .mdx page's bare paragraphs are text runs in one block: measured per text node.
      const tr = document.createRange();
      tr.selectNodeContents(t);
      if (tr.getBoundingClientRect().bottom < innerHeight - 8) end = t;
    }
    const r = document.createRange();
    r.setStart(start!, start!.data.indexOf(text));
    r.setEnd(end!, end!.data.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
    document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  }, LONG_TARGET);
  await expect(bar(page)).toBeVisible();
  const tall = (await bar(page).boundingBox())!;
  expect(tall.y).toBeGreaterThanOrEqual(pane.y);
  await dragSelect(page, LONG_TARGET);
  // The release shows the bar on a timer: a right-click before it lands would be closed by it.
  await expect(bar(page)).toBeVisible();

  // The right-click menu closes on a scroll, as the browser's own does.
  await page.mouse.click((at.x0 + at.x1) / 2, at.y0, { button: "right" });
  await expect(menu(page)).toBeVisible();
  await page.mouse.wheel(0, 300);
  await expect(menu(page)).toBeHidden();
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(LONG_TARGET);
});

const focusedEl = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a?.getAttribute("data-selact") ?? (a ? `${a.tagName}${a.className && typeof a.className === "string" ? `.${a.className.split(" ")[0]}` : ""}` : null);
  });

test("fix round 2 R2-1: Enter and ⇧F10 inside an answerable Question card and an overflowing diagram box are the bar's; Escape puts focus back on the box", async ({ page }) => {
  const started: string[] = [];
  // The inline turn never answers (it stays live); a classic stream answers at once.
  await page.route("**/api/wiki/discuss", (route) => {
    if (route.request().method() === "POST") started.push("turn");
  });
  await page.route("**/api/wiki/explain?**", (route) => {
    started.push("classic");
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: done\ndata: {"answer":"CLASSIC"}\n\nevent: end\ndata: {}\n\n` });
  });
  await openPage(page, CARDS);
  const question = page.locator("#articleWrap section.question");
  // Wired as answerable: focusable from code (`tabindex="-1"`), no role of its own.
  await expect(question).toHaveAttribute("tabindex", "-1");
  const box = page.locator("#articleWrap .diagram-body");
  await expect(box).toHaveAttribute("role", "region", { timeout: 20_000 });
  await expect(box).toHaveAttribute("tabindex", "0");

  for (const [name, text, holder] of [["question", Q_TEXT, "SECTION.question"], ["diagram", "step 2", "DIV.diagram-body"]] as const) {
    // ⇧F10 there: our menu on its first item; Escape puts focus back on the container.
    await dragSelect(page, text);
    await expect(bar(page)).toBeVisible();
    // The press inside it focused the container: the case the finding measured.
    expect([name, await focusedEl(page)]).toEqual([name, holder]);
    await page.keyboard.press("Shift+F10");
    await expect(menu(page)).toBeVisible();
    expect([name, await focusedEl(page)]).toEqual([name, "explain"]);
    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();
    expect([name, await focusedEl(page)]).toEqual([name, holder]);

    // Enter there, the bar open: the Explain turn starts.
    await dragSelect(page, text);
    await expect(bar(page)).toBeVisible();
    expect([name, await focusedEl(page)]).toEqual([name, holder]);
    const before = started.length;
    await page.keyboard.press("Enter");
    await expect.poll(() => started.length, { message: name }).toBe(before + 1);
    await expect(page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"]')).toHaveCount(1);
    await expect(bar(page)).toBeHidden();
    await page.locator("#articleWrap .wiki-sel-card [data-sel-card-close]").click();
  }
  test.info().annotations.push({ type: "R2-1 started", description: started.join(",") });
});

test("fix round 2 R2-2: the menu stays open while the Discuss pane scrolls; the article's scroll still closes it", async ({ page }) => {
  await openPage(page, LONG);
  await page.locator('[data-conntab="discuss"]').click();
  await expect(page.locator("#discussBody")).toBeVisible();
  // As a streaming turn makes it: taller than the pane, so its follow scroll moves it.
  await page.locator("#discussBody").evaluate((b) => b.insertAdjacentHTML("beforeend", `<div id="e2eTall" style="height:3000px;flex:none"></div>`));
  const paneScroll = (to: number) => page.locator("#discussBody").evaluate((b, to) => ((b.scrollTop = to), b.scrollTop), to);
  const at = await dragSelect(page, LONG_TARGET);
  await expect(bar(page)).toBeVisible();

  await page.mouse.click((at.x0 + at.x1) / 2, at.y0, { button: "right" });
  await expect(menu(page)).toBeVisible();
  expect(await paneScroll(600)).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();

  // The keyboard's menu, being arrowed through: the pane's scroll leaves it and its focus.
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  expect(await focusedEl(page)).toBe("where");
  expect(await paneScroll(0)).toBe(0);
  await page.waitForTimeout(300);
  await expect(menu(page)).toBeVisible();
  expect(await focusedEl(page)).toBe("where");
  await page.keyboard.press("Escape");

  // The article's own scroll moves the selection: it still closes the menu, and the bar follows.
  await page.mouse.click((at.x0 + at.x1) / 2, at.y0, { button: "right" });
  await expect(menu(page)).toBeVisible();
  await page.locator("#articleWrap").evaluate((el) => (el.scrollTop = 40));
  await expect(menu(page)).toBeHidden();
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(LONG_TARGET);
});

test("fix round 2 R2-3: on a wiki with no agent, Explain answers in a card under the paragraph; the article stays and the pane does not switch to Ask", async ({ page }) => {
  const discussPosts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname.startsWith("/api/wiki/discuss")) discussPosts.push(r.url());
  });
  const explains: URL[] = [];
  await page.route("**/api/wiki/explain?**", (route) => {
    explains.push(new URL(route.request().url()));
    // The route's order: deltas, done, the server's answer_html, end.
    const body =
      `event: delta\ndata: {"text":"PLAIN so far"}\n\n` +
      `event: done\ndata: ${JSON.stringify({ answer: "PLAIN whole" })}\n\n` +
      `event: answer_html\ndata: ${JSON.stringify({ html: "<p>PLAIN-ANSWER <strong>rendered</strong> by the server.</p>" })}\n\n` +
      `event: end\ndata: {}\n\n`;
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
  });
  await openPage(page, PLAIN, NOAGENT);
  await expect(page.locator(".wiki-conn-tab[data-conntab='ask']")).not.toHaveClass(/active/);
  await dragSelect(page, PLAIN_FIRST);
  await bar(page).locator("#wikiExplainBtn").click();
  await expect.poll(() => explains.length).toBe(1);
  expect(explains[0]!.searchParams.get("sel")).toBe(PLAIN_FIRST);
  expect(explains[0]!.searchParams.get("relPath")).toBe(PLAIN);
  const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"]');
  await expect(card.locator(".wiki-sel-card-body strong")).toHaveText("rendered");
  await expect(card.locator(".wiki-sel-card-body")).toContainText("PLAIN-ANSWER rendered by the server.");
  expect(await card.getAttribute("data-sel-turn")).toBeNull();
  // Under the first paragraph, before the second; the page is still there.
  expect(await cardBetween(page, ".wiki-sel-card", PLAIN_FIRST, PLAIN_SECOND)).toBe(true);
  await expect(page.locator("#articleWrap .wiki-article-head h1")).toHaveText("Plain plan");
  await expect(page.locator("#articleWrap .wiki-article")).toContainText(PLAIN_SECOND);
  await expect(page.locator(".wiki-conn-tab[data-conntab='ask']")).not.toHaveClass(/active/);
  await shot(page, "15-explain-no-agent-card");
  expect(discussPosts).toEqual([]);
});

// ── Class check (round 3) ───────────────────────────────────────────────

/** Render the page on screen again: its rail row, the page fetched and drawn anew. */
async function renderAgain(page: Page, rel: string, shown: string): Promise<void> {
  const rendered = page.waitForResponse((r) => r.url().includes("/api/wiki/page?"));
  await page.locator(`.wiki-list-item[data-relpath="${rel}"]`).first().click();
  await rendered;
  await expect(page.locator("#articleWrap .wiki-article")).toContainText(shown);
}

test("class check S1: a triple-clicked head title the body repeats comes back under the head when the unchanged page renders again", async ({ page }) => {
  const explains: string[] = [];
  await page.route("**/api/wiki/explain?**", async (route) => {
    explains.push(route.request().url());
    const body = `event: done\ndata: ${JSON.stringify({ answer: "CLASSIC-ANSWER for the title" })}\n\nevent: end\ndata: {}\n\n`;
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
  });
  await openPage(page, TITLED);
  await expect(page.locator("#articleWrap .wiki-article")).toContainText(`The ${TITLE} is named here again`);
  await page.evaluate(() => getSelection()!.removeAllRanges());
  const h1 = page.locator("#articleWrap .wiki-article-head h1");
  const box = (await h1.boundingBox())!;
  await page.mouse.click(box.x + 20, box.y + box.height / 2, { clickCount: 3 });
  await expect(bar(page)).toBeVisible();
  const end = await page.evaluate(() => {
    const r = getSelection()!.getRangeAt(0);
    return { node: r.endContainer.nodeName, offset: r.endOffset, text: getSelection()!.toString().trim() };
  });
  test.info().annotations.push({ type: "triple-click end", description: JSON.stringify(end) });
  expect(end.text).toBe(TITLE);
  await bar(page).locator("#wikiExplainBtn").click();
  const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"]');
  await expect(card.locator(".wiki-sel-card-body")).toContainText("CLASSIC-ANSWER for the title");
  expect(await card.evaluate((c) => c.previousElementSibling?.classList.contains("wiki-article-head"))).toBe(true);
  await card.evaluate((el) => el.setAttribute("data-e2e-mark", "head"));
  await renderAgain(page, TITLED, "The pier opens at seven.");
  const back = page.locator('#articleWrap .wiki-sel-card[data-e2e-mark="head"]');
  await expect(back).toBeVisible();
  expect(await back.evaluate((c) => c.previousElementSibling?.classList.contains("wiki-article-head"))).toBe(true);
  await expect(back.locator(".wiki-sel-card-moved")).toHaveCount(0);
  expect(explains.length).toBe(1);
});

test("class check S1: a selection across two DecisionLog items shown newest first comes back in its item when the unchanged page renders again", async ({ page }) => {
  const discussPosts: string[] = [];
  // The turn never answers: the card stays open across the render.
  await page.route("**/api/wiki/discuss", (route) => {
    discussPosts.push(route.request().postData() ?? "");
  });
  await openPage(page, DECISIONS);
  const d2 = page.locator("#articleWrap .wiki-article li.dl-item").filter({ hasText: "Keep the night route" });
  const d1 = page.locator("#articleWrap .wiki-article li.dl-item").filter({ hasText: FLAT });
  // Newest first: D2 above D1 in the page.
  expect((await d2.boundingBox())!.y).toBeLessThan((await d1.boundingBox())!.y);
  await page.evaluate(() => getSelection()!.removeAllRanges());
  const from = await textBox(page, "Keep the night");
  const to = await textBox(page, "Use the flat");
  await page.mouse.move(from.x0, from.y0);
  await page.mouse.down();
  await page.mouse.move(to.x1, to.y1, { steps: 8 });
  await page.mouse.up();
  const text = await page.evaluate(() => getSelection()!.toString());
  expect(text).toContain("Keep the night route.");
  expect(text).toContain("Use the flat");
  await bar(page).locator("#wikiExplainBtn").click();
  await expect.poll(() => discussPosts.length).toBe(1);
  const card = d1.locator('.wiki-sel-card[data-sel-card="explain"][data-sel-turn]');
  await expect(card).toBeVisible();
  await card.evaluate((el) => el.setAttribute("data-e2e-mark", "dl"));
  await renderAgain(page, DECISIONS, "Keep the night route.");
  const back = page.locator('#articleWrap .wiki-sel-card[data-e2e-mark="dl"]');
  await expect(back).toBeVisible();
  expect(await back.evaluate((c) => c.closest("li.dl-item")?.textContent?.includes("Use the flat file") ?? false)).toBe(true);
  await expect(back.locator(".wiki-sel-card-moved")).toHaveCount(0);
});

test("class check S3: an explainer's card hides with its frame in graph mode and comes back with it", async ({ page }) => {
  await page.route("**/api/wiki/explain?**", async (route) => {
    const body = `event: done\ndata: ${JSON.stringify({ answer: "CLASSIC-ANSWER for the frame" })}\n\nevent: end\ndata: {}\n\n`;
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
  });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(FRAME)}`);
  const frameEl = page.locator("#articleWrap > iframe.wiki-explainer-frame");
  await expect(frameEl).toBeVisible();
  await expect(page.frameLocator("iframe.wiki-explainer-frame").locator("p")).toHaveText(FRAME_TEXT);
  const frame = page.frames().find((f) => f.url().includes("/api/wiki/html"))!;
  // A selection in the frame: its bridge posts it up and the bar shows at the frame's top.
  await frame.evaluate(() => {
    const r = document.createRange();
    r.selectNodeContents(document.querySelector("p")!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
  });
  await expect(bar(page)).toBeVisible();
  await bar(page).locator("#wikiExplainBtn").click();
  const card = page.locator('#articleWrap > .wiki-sel-card[data-sel-card="explain"]');
  await expect(card.locator(".wiki-sel-card-body")).toContainText("CLASSIC-ANSWER for the frame");
  expect(await card.evaluate((c) => c.nextElementSibling?.classList.contains("wiki-explainer-frame"))).toBe(true);
  // Graph mode: this fixture wiki is no tracker wiki, so the pane's class is set
  // as `applyDisplay` sets it; the reader's own CSS then hides the frame.
  await page.evaluate(() => document.getElementById("articleWrap")!.classList.add("wiki-graph-on"));
  await expect(frameEl).toBeHidden();
  await expect(card).toBeHidden();
  await expect(page.locator("#articleWrap .wiki-article-head h1")).toBeVisible();
  await page.evaluate(() => document.getElementById("articleWrap")!.classList.remove("wiki-graph-on"));
  await expect(frameEl).toBeVisible();
  await expect(card).toBeVisible();
});

// ── Discuss v3 P1: who answers ─────────────────────────────────────────

/** Hover Explain in the bar: its drawn tooltip. */
async function explainTip(page: Page) {
  await bar(page).locator("#wikiExplainBtn").hover();
  const tip = page.locator("#wikiSelTip");
  await expect(tip).toBeVisible();
  return tip;
}

/** The Discuss POSTs the page sends, with their bodies. */
function discussPosts(page: Page): Record<string, unknown>[] {
  const posts: Record<string, unknown>[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/wiki/discuss") posts.push(JSON.parse(r.postData() ?? "{}") as Record<string, unknown>);
  });
  return posts;
}

test("Discuss v3 P1: the tooltip names the kept user and the bot's model before any POST; a pick in the who box is refused while a turn runs, then closes the open card, changes the next turn's userId and names the new user from the card's placing", async ({ page }) => {
  test.setTimeout(240_000);
  // Both users listed for the bot (a thread each), the first one kept in this browser.
  await sql!`INSERT INTO threads (user_id, bot_name, name, is_active) VALUES (${USER}, ${BOT}, 'e2e-p1-main', false), (${USER2}, ${BOT}, 'e2e-p1-main', false)`;
  try {
    await page.addInitScript(([wiki, bot, user]) => {
      if (sessionStorage.getItem("p1-seeded")) return;
      sessionStorage.setItem("p1-seeded", "1");
      localStorage.setItem(`muninn-discuss-bot-${wiki}`, bot);
      localStorage.setItem(`muninn-discuss-user-${bot}`, user);
    }, [WIKI, BOT, USER] as const);
    const posts = discussPosts(page);
    await openPage(page, OTHER);
    await dragSelect(page, "The pier opens at six.");
    const tip = await explainTip(page);
    await expect(tip).toContainText("What this means, why it is here and what led to it");
    await expect(tip.locator(".wiki-seltip-l2")).toHaveText(`Runs as E2E Selection · ${MODEL} · claude-sdk · Change…`);
    expect(posts).toEqual([]);
    await shot(page, "15-runs-as-tooltip");

    // The turn's answer held back: it is still running while the reader picks.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/wiki/discuss", async (route) => {
      await held;
      await route.continue();
    }, { times: 1 });
    await bar(page).locator("#wikiExplainBtn").click();
    const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"][data-sel-turn]');
    await expect(card.locator(".wiki-sel-card-sub")).toHaveText("· a turn in E2E Selection's discussion of this page");
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]!.userId).toBe(USER);

    // «Change…» opens the who box: a group, the users, the bot and «Change on /models ↗».
    await dragSelect(page, "The harbour waits for", "The harbour waits for");
    await (await explainTip(page)).locator("[data-selwho-open]").click();
    const box = page.locator("#wikiSelWho");
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute("role", "group");
    await expect(box.locator('a[href="/models?bot=selbot"]')).toHaveText("Change on /models ↗");
    await expect(box.locator(`[data-selwho-user="${USER}"]`)).toHaveAttribute("aria-pressed", "true");
    await shot(page, "16-who-box");
    // A pick while the turn runs: refused, said in the box; the card stays.
    await box.locator(`[data-selwho-user="${USER2}"]`).click();
    await expect(box.locator("[role=alert]")).toContainText("A turn is still running");
    await expect(card).toHaveCount(1);
    expect(await page.evaluate((b) => localStorage.getItem(`muninn-discuss-user-${b}`), BOT)).toBe(USER);

    release();
    await expect(card.locator(".wiki-discuss-answer")).toContainText("EXPLAIN-ANSWER", { timeout: 90_000 });
    // The answer streams before the turn ends: wait for its end (the status line goes).
    await expect(card.locator(".wiki-discuss-status")).toHaveCount(0, { timeout: 60_000 });
    // The pick now: the open card closes (its thread is the other user's), the kept user moves.
    await box.locator(`[data-selwho-user="${USER2}"]`).click();
    await expect(card).toHaveCount(0);
    expect(await page.evaluate((b) => localStorage.getItem(`muninn-discuss-user-${b}`), BOT)).toBe(USER2);
    await expect(box.locator(`[data-selwho-user="${USER2}"]`)).toHaveAttribute("aria-pressed", "true");
    // The next card names the new user from the moment it is placed, and its turn carries that user.
    await bar(page).locator("#wikiExplainBtn").click();
    const next = page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"][data-sel-turn]');
    await expect(next.locator(".wiki-sel-card-sub")).toHaveText("· a turn in E2E Other's discussion of this page");
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]!.userId).toBe(USER2);
    await expect(next.locator(".wiki-discuss-answer")).toContainText("EXPLAIN-ANSWER", { timeout: 90_000 });
    await expect(next.locator(".wiki-sel-card-sub")).toHaveText("· a turn in E2E Other's discussion of this page");
    const [row] = await sql!`SELECT t.user_id FROM wiki_discuss_turns d JOIN threads t ON t.id = d.thread_id WHERE d.wiki = ${WIKI} AND d.rel_path = ${OTHER} ORDER BY d.created_at DESC LIMIT 1`;
    expect(row!.user_id).toBe(USER2);
  } finally {
    await sql!`DELETE FROM threads WHERE user_id IN (${USER}, ${USER2}) AND name = 'e2e-p1-main'`;
    await sql!`DELETE FROM threads WHERE user_id = ${USER2} AND kind = 'wiki'`;
  }
});

test("Discuss v3 P1: no kept user and a default user who is not listed: the tooltip and the card head name that default user, and the turn runs as it", async ({ page }) => {
  test.setTimeout(180_000);
  await sql!`UPDATE bot_default_user SET user_id = ${USER3} WHERE bot_name = ${BOT}`;
  try {
    const posts = discussPosts(page);
    await openPage(page, OTHER);
    await dragSelect(page, "The pier opens at six.");
    // No /chat name for a user no thread lists: named by id.
    await expect((await explainTip(page)).locator(".wiki-seltip-l2")).toHaveText(`Runs as ${USER3} · ${MODEL} · claude-sdk · Change…`);
    await bar(page).locator("#wikiExplainBtn").click();
    const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"][data-sel-turn]');
    await expect(card.locator(".wiki-sel-card-sub")).toHaveText(`· a turn in ${USER3}'s discussion of this page`);
    await expect(card.locator(".wiki-discuss-answer")).toContainText("EXPLAIN-ANSWER", { timeout: 90_000 });
    // Rule R2: a default user the route would refuse as a posted id is not sent; the engine runs the turn as it.
    expect(posts.length).toBe(1);
    expect(posts[0]!.userId).toBeUndefined();
    const [row] = await sql!`SELECT t.user_id FROM wiki_discuss_turns d JOIN threads t ON t.id = d.thread_id WHERE d.wiki = ${WIKI} AND d.rel_path = ${OTHER} ORDER BY d.created_at DESC LIMIT 1`;
    expect(row!.user_id).toBe(USER3);
  } finally {
    await sql!`UPDATE bot_default_user SET user_id = ${USER} WHERE bot_name = ${BOT}`;
    await sql!`DELETE FROM threads WHERE user_id = ${USER3}`;
  }
});

test("Discuss v3 P1: /models?bot=x opens on bot x and leaves the stored selection alone", async ({ page }) => {
  // The selector lists bots with messages: the first bot has some; the second
  // gets its pill from the parameter (a discovered bot), then from a message.
  await page.addInitScript((b) => {
    if (sessionStorage.getItem("models-seeded")) return;
    sessionStorage.setItem("models-seeded", "1");
    localStorage.setItem("muninn-selected-bot", b);
  }, BOT2);
  const overview: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/models/overview")) overview.push(new URL(r.url()).searchParams.get("bot") ?? "");
  });
  await sql!`INSERT INTO messages (user_id, bot_name, role, content, platform) VALUES (${USER}, ${BOT}, 'user', 'e2e-p1-models', 'web')`;
  try {
    await page.goto(`${BASE}/models?bot=${BOT2}`);
    await expect(page.locator(`#botSelector .bot-pill[data-bot="${BOT2}"]`)).toHaveClass(/active/);
    await expect.poll(() => overview.includes(BOT2)).toBe(true);
    await page.goto(`${BASE}/models?bot=${BOT}`);
    await expect(page.locator(`#botSelector .bot-pill[data-bot="${BOT}"]`)).toHaveClass(/active/);
    await expect.poll(() => overview.includes(BOT)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("muninn-selected-bot"))).toBe(BOT2);
    // From here the second bot has a message, so its own pill. A parameter naming no bot: the stored one.
    await sql!`INSERT INTO messages (user_id, bot_name, role, content, platform) VALUES (${USER}, ${BOT2}, 'user', 'e2e-p1-models', 'web')`;
    await page.goto(`${BASE}/models?bot=not-a-bot`);
    await expect(page.locator(`#botSelector .bot-pill[data-bot="${BOT2}"]`)).toHaveClass(/active/);
    // Without the parameter the stored bot is the one shown; a pick on the page writes it.
    await page.goto(`${BASE}/models`);
    await expect(page.locator(`#botSelector .bot-pill[data-bot="${BOT2}"]`)).toHaveClass(/active/);
    await page.locator(`#botSelector .bot-pill[data-bot="${BOT}"]`).click();
    expect(await page.evaluate(() => localStorage.getItem("muninn-selected-bot"))).toBe(BOT);
  } finally {
    await sql!`DELETE FROM messages WHERE content = 'e2e-p1-models'`;
  }
});

const FOLLOW_OLD = "The morning route adds a stop.";
const FOLLOW_NEW = "The morning route adds two stops.";
const pageText = () => readFile(path.join(root, REL), "utf8");

/** «Add to Oppfølging» on the morning sentence, its turn stubbed to end with an
 *  edit (a row with that edit, the discuss POST answered in the page); the real
 *  preview gives the inline card its Apply. The Discuss tab is not shown. */
async function followCardWithEdit(page: Page) {
  const proposedEdit = { edits: [{ claimIndex: 0, verdict: "", old: FOLLOW_OLD, new: FOLLOW_NEW, reason: "Two stops now." }], dropped: [], overLimit: false };
  const hash = createHash("sha256").update(await pageText()).digest("hex");
  const [row] = await sql!`
    INSERT INTO wiki_discuss_turns (discussion_id, seq, wiki, rel_path, page_hash, question, answer, end_state, bot_name, connector, proposed_edit, finished_at)
    VALUES (${randomUUID()}, 1, ${WIKI}, ${REL}, ${hash}, 'Add this to Oppfølging', 'Proposed.', 'done', ${BOT}, 'claude-sdk', ${sql!.json(proposedEdit as never)}, now())
    RETURNING id`;
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const discussionId = randomUUID();
  const body =
    frame("turn", { turnId: row!.id, discussionId, seq: 1, location: null }) +
    frame("done", { turnId: row!.id, discussionId, endState: "done", answer: "Proposed.", proposedEdit, toolCalls: [] }) +
    frame("end", {});
  await page.route("**/api/wiki/discuss", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body }), { times: 1 });
  await openPage(page);
  await expect(page.locator('[data-conntab="discuss"]')).not.toHaveClass(/active/);
  await dragSelect(page, FOLLOW_OLD);
  await bar(page).locator('[data-selact="follow"]').click();
  const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="follow"]');
  await expect(card.locator('.wiki-discuss-edit[data-edit-state="ready"] [data-discuss-apply]')).toBeVisible();
  await expect(page.locator('[data-conntab="discuss"]')).not.toHaveClass(/active/);
  return card;
}

test("«Change the wording» on an inline card shows the Discuss tab, its box holding the draft and focused", async ({ page }) => {
  const card = await followCardWithEdit(page);
  await card.locator("[data-discuss-reword]").click();
  await expect(page.locator('[data-conntab="discuss"]')).toHaveClass(/active/);
  const input = page.locator("#wikiDiscussInput");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("Propose another wording for that edit, for the same passage: ");
  await expect(input).toBeFocused();
  await shot(page, "9-reword-from-card");
  expect(await pageText()).toBe(PAGE);
});

test("fix round 2 R2-4: Apply on an inline card, the card closed while Apply runs, the page changed meanwhile: the Discuss tab shows the turn's refusal", async ({ page }) => {
  const card = await followCardWithEdit(page);
  const key = await card.getAttribute("data-sel-turn");
  // The real Apply request, held until the card is closed and the page has changed on disk.
  let release: () => void = () => {};
  const released = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/discuss/apply", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { preview?: boolean };
    if (body.preview !== true) await released;
    await route.continue();
  });
  try {
    await card.locator("[data-discuss-apply]").click();
    await expect(card.locator("[data-discuss-apply]")).toHaveText("Applying…");
    await card.locator("[data-sel-card-close]").click();
    await expect(page.locator("#articleWrap .wiki-sel-card")).toHaveCount(0);
    await writeFile(path.join(root, REL), PAGE.replace("## Oppfølging", "Changed while Apply ran.\n\n## Oppfølging"), "utf8");
    const applied = page.waitForResponse((r) => r.url().includes("/api/wiki/discuss/apply") && r.request().postData()?.includes("previewHash") === true && !r.request().postData()?.includes('"preview":true'));
    release();
    const answer = await applied;
    expect(answer.status()).toBe(409);
    await expect(page.locator('[data-conntab="discuss"]')).toHaveClass(/active/);
    const refused = page.locator(`#discussBody [data-turn-key="${key}"] .wiki-discuss-edit[data-edit-state="refused"]`);
    await expect(refused).toBeVisible();
    await shot(page, "18-refused-after-card-closed");
  } finally {
    await page.unroute("**/api/wiki/discuss/apply");
    await writeFile(path.join(root, REL), PAGE, "utf8");
  }
  expect(await pageText()).toBe(PAGE);
});

test("class check S2: Explain from another selection while an inline Apply runs is the classic card, naming the Apply; the Apply's 409 then shows on the Discuss tab", async ({ page }) => {
  const card = await followCardWithEdit(page);
  const key = await card.getAttribute("data-sel-turn");
  const discussPosts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/wiki/discuss") discussPosts.push(r.url());
  });
  await page.route("**/api/wiki/explain?**", async (route) => {
    const body = `event: done\ndata: ${JSON.stringify({ answer: "CLASSIC-ANSWER while Apply runs" })}\n\nevent: end\ndata: {}\n\n`;
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
  });
  let release: () => void = () => {};
  const released = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/discuss/apply", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { preview?: boolean };
    if (body.preview !== true) await released;
    await route.continue();
  });
  try {
    await card.locator("[data-discuss-apply]").click();
    await expect(card.locator("[data-discuss-apply]")).toHaveText("Applying…");
    await dragSelect(page, NIGHT);
    await bar(page).locator("#wikiExplainBtn").click();
    const classic = page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"]:not([data-sel-turn])');
    await expect(classic.locator(".wiki-sel-card-body")).toContainText("CLASSIC-ANSWER while Apply runs");
    await expect(classic.locator(".wiki-sel-card-sub")).toHaveText("· an Apply in the page's discussion is still running, so not in it");
    expect(discussPosts.length).toBe(0);
    await writeFile(path.join(root, REL), PAGE.replace("## Oppfølging", "Changed while Apply ran.\n\n## Oppfølging"), "utf8");
    const applied = page.waitForResponse((r) => r.url().includes("/api/wiki/discuss/apply") && r.request().postData()?.includes("previewHash") === true && !r.request().postData()?.includes('"preview":true'));
    release();
    expect((await applied).status()).toBe(409);
    await expect(page.locator('[data-conntab="discuss"]')).toHaveClass(/active/);
    const turn = page.locator(`#discussBody [data-turn-key="${key}"]`);
    await expect(turn.locator('.wiki-discuss-edit[data-edit-state="refused"]')).toBeVisible();
    await expect(turn).not.toContainText("A newer turn follows");
    expect(discussPosts.length).toBe(0);
  } finally {
    await page.unroute("**/api/wiki/discuss/apply");
    await writeFile(path.join(root, REL), PAGE, "utf8");
  }
  expect(await pageText()).toBe(PAGE);
});

test("Apply on an inline card with the tab closed: the page renders again without the card, and the reader is on Discuss looking at the applied turn", async ({ page }) => {
  const card = await followCardWithEdit(page);
  await card.locator("[data-discuss-apply]").click();
  await expect(page.locator("#articleWrap .wiki-article")).toContainText(FOLLOW_NEW);
  await expect(page.locator("#articleWrap .wiki-sel-card")).toHaveCount(0);
  await expect(page.locator('[data-conntab="discuss"]')).toHaveClass(/active/);
  const applied = page.locator('#discussBody .wiki-discuss-edit[data-edit-state="applied"]');
  await expect(applied).toBeVisible();
  await expect(applied).toContainText("Applied to the page, with a log.md entry and a commit.");
  await expect(applied.locator(".wiki-discuss-edit-done")).toBeFocused();
  await shot(page, "10-applied-from-card");
  expect(await pageText()).toBe(PAGE.replace(FOLLOW_OLD, FOLLOW_NEW));
});
