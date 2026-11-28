/**
 * Discuss v3 P2 (mimir plan muninn-wiki-discuss-v3, PR 2): «follow up» on an
 * inline Explain card.
 *
 * What the unit and route tests cannot reach: a real selection of a word that
 * stands many times on the page, made in a browser on a copy that is not the
 * first, sent as a card's first turn with the passage the reader held, then
 * two follow-ups from the card's own box (the selection gone) that the server
 * places on that same copy (`location` on all three ledger rows), the thread
 * read returning the three turns with one origin and `sent_from` `card`;
 * «⌘ Continue in Claude Code» absent on a one-turn card and present once it
 * has a follow-up (D4); a follow-up naming another page's turn as its origin
 * refused 409 `origin`; and the card put back after a render of the page (not
 * a browser reload), with a follow-up from it that still works; and, after a
 * browser reload, the Discuss tab's chip on a follow-up (read back from the
 * thread) reaching the card's copy, not the page's first.
 *
 * Its own muninn with `e2eEnv()`, a git wiki with no remote in a temp dir
 * (`WIKI_EXTRA`), a throwaway `claude-sdk` bot under `MUNINN_BOTS_DIR`, a chat
 * user seeded here as the bot's default, and the fake Messages API run by
 * `bun` as its own process (`e2e/fake-messages-api-server.ts`).
 * `E2E_SHOTS=<dir>` saves one screenshot per state; `E2E_FOLLOW_JSON=<file>`
 * writes the thread read the first test checks.
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

const PORT = e2ePort("wiki-discuss-follow-up");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-discuss-follow";
const REL = "plans/felttap.mdx";
const OTHER = "plans/other.mdx";
const BOT = "followbot";
const USER = "e2e-follow-user";
const ANSWER = "FOLLOW-ANSWER: the gate is named here.";
/** «TWFA» stands five times; the specs select the third copy (line 13). */
const PAGE = [
  "---",
  "title: Felttap plan",
  "---",
  "",
  "# Felttap plan",
  "",
  "## Brief",
  "",
  "TWFA alpha starts the gate.",
  "",
  "TWFA beta holds the gate.",
  "",
  "The TWFA gamma copy is the one.",
  "",
  "TWFA delta closes the gate.",
  "",
  "## Notes",
  "",
  "The morning route adds a stop after TWFA.",
  "",
].join("\n");
const GAMMA_LINE = 13;
const OTHER_PAGE = ["---", "title: Other plan", "---", "", "# Other plan", "", "The pier opens at six.", ""].join("\n");
const RULES = "# Rules\n\nAnswer the question first.\n";

let server: ChildProcess | undefined;
let fake: ChildProcess | undefined;
let root = "";
let scratch = "";
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

function startFake(): Promise<{ url: string }> {
  fake = spawn("bun", ["--no-env-file", path.join(REPO_ROOT, "e2e/fake-messages-api-server.ts")], {
    cwd: REPO_ROOT,
    env: { ...process.env, FAKE_API_CHUNKS: JSON.stringify([ANSWER]), FAKE_API_DELAY_MS: "100" },
    stdio: ["ignore", "pipe", "inherit"],
    detached: true,
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("the fake Messages API did not start")), 15_000);
    fake!.stdout!.on("data", (b: Buffer) => {
      out += b.toString();
      const url = /FAKE_API_URL=(\S+)/.exec(out)?.[1];
      if (url) {
        clearTimeout(timer);
        resolve({ url });
      }
    });
  });
}

test.beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "muninn-e2e-discuss-follow-"));
  root = path.join(scratch, "wiki");
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REL), PAGE, "utf8");
  await writeFile(path.join(root, OTHER), OTHER_PAGE, "utf8");
  await writeFile(path.join(root, ".wiki-agent.md"), RULES, "utf8");
  const init = spawnSync("git", ["init", "-q", "-b", "main", root], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`git init: ${init.stderr}`);
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  const bot = path.join(scratch, "bots", BOT);
  await mkdir(bot, { recursive: true });
  await writeFile(path.join(bot, "CLAUDE.md"), "# e2e follow-up bot\n\nCreated by e2e/wiki-discuss-follow-up.spec.ts.\n");
  await writeFile(path.join(bot, "config.json"), JSON.stringify({ connector: "claude-sdk", model: "claude-sonnet-4-5", timeoutMs: 120000 }));
  await mkdir(path.join(scratch, "claude-config"), { recursive: true });
  await mkdir(path.join(scratch, "agent-home"), { recursive: true });
  const f = await startFake();

  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  await sql`DELETE FROM threads WHERE user_id = ${USER}`;
  await sql`DELETE FROM wiki_discuss_turns WHERE wiki = ${WIKI}`;
  await sql`INSERT INTO users (id, username, platform) VALUES (${USER}, 'E2E Follow', 'web') ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO bot_default_user (bot_name, user_id) VALUES (${BOT}, ${USER}) ON CONFLICT (bot_name) DO UPDATE SET user_id = EXCLUDED.user_id`;
  await sql`INSERT INTO threads (user_id, bot_name, name, is_active) VALUES (${USER}, ${BOT}, 'main', true)`;

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

test.use({ viewport: { width: 1360, height: 1100 } });

// Each test starts on a page with no thread: «Start over» is not this slice's,
// so the rows go straight from the database.
test.beforeEach(async () => {
  await sql!`DELETE FROM threads WHERE user_id = ${USER} AND kind = 'wiki'`;
  await sql!`DELETE FROM wiki_discuss_turns WHERE wiki = ${WIKI}`;
});

const card = (page: Page) => page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"][data-sel-turn]');

async function openPage(page: Page): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("The morning route adds a stop");
}

/** A real mouse drag over the first copy of `text` after `after`'s first copy. */
async function dragSelect(page: Page, text: string, after: string): Promise<void> {
  await page.evaluate(() => getSelection()!.removeAllRanges());
  const at = await page.evaluate(
    ({ text, after }) => {
      const article = document.querySelector("#articleWrap .wiki-article")!;
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      const nodes: { t: Text; at: number }[] = [];
      let all = "";
      for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
        nodes.push({ t, at: all.length });
        all += t.data;
      }
      const i = all.indexOf(text, all.indexOf(after));
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
    },
    { text, after },
  );
  await page.mouse.move(at.x0, at.y0);
  await page.mouse.down();
  await page.mouse.move(at.x1, at.y1, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(text);
}

/** Explain on the third «TWFA» (not the page's first): the card, answered. */
async function explainGamma(page: Page): Promise<void> {
  await dragSelect(page, "TWFA", "The TWFA gamma");
  await page.locator("#wikiSelBar #wikiExplainBtn").click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator(".wiki-sel-turn")).toHaveCount(1);
  await expect(card(page).locator(".wiki-discuss-answer").first()).toContainText("FOLLOW-ANSWER", { timeout: 90_000 });
}

/** A follow-up from the card's own box, with the selection gone; waits for its answer. */
async function followUp(page: Page, question: string, n: number): Promise<void> {
  await page.evaluate(() => getSelection()!.removeAllRanges());
  const input = card(page).locator("[data-sel-followup-input]");
  // Send waits while any turn or Apply of the discussion runs; the input never does.
  await expect(card(page).locator("[data-sel-followup-send]")).toBeEnabled({ timeout: 30_000 });
  await expect(input).toBeEnabled();
  await input.fill(question);
  await input.press("Enter");
  // Enter keeps the focus in the box (fix round 1 batch 3 E), in a real browser.
  await expect(input).toBeFocused();
  await expect(card(page).locator(".wiki-sel-turn")).toHaveCount(n);
  await expect(card(page).locator(".wiki-sel-turn").nth(n - 1).locator(".wiki-sel-turn-q")).toHaveText(question);
  await expect(card(page).locator(".wiki-sel-turn").nth(n - 1).locator(".wiki-discuss-answer")).toContainText("FOLLOW-ANSWER", { timeout: 90_000 });
}

/** The page's live thread's ledger rows, oldest first. */
async function rows(): Promise<{ id: string; seq: number; origin_turn_id: string | null; sent_from: string | null; passage: unknown; location: { found?: string; fromLine?: number } | null }[]> {
  return (await sql!`
    SELECT w.id, w.seq, w.origin_turn_id, w.sent_from, w.passage, w.location
    FROM wiki_discuss_turns w JOIN threads t ON t.id = w.thread_id
    WHERE t.kind = 'wiki' AND t.wiki = ${WIKI} AND t.rel_path = ${REL} AND t.closed_at IS NULL
    ORDER BY w.seq`) as never;
}

test("ask, then follow up twice from the card's box on a «TWFA» that is not the page's first: three turns in order, one origin, sent from the card, each placed on the copy selected", async ({ page }) => {
  test.setTimeout(300_000);
  await openPage(page);
  await explainGamma(page);
  // One turn: no «Continue in Claude Code» (D4); the box is offered.
  await expect(card(page).locator("[data-discuss-continue]")).toHaveCount(0);
  await expect(card(page).locator("form.wiki-sel-follow")).toBeVisible();
  await expect(card(page).locator("[data-sel-card-chat]")).toHaveAttribute("href", /\/chat\?.*src=wiki/);
  await shot(page, "1-card-one-turn");

  await followUp(page, "Who holds the gate there?", 2);
  await followUp(page, "And when does it close?", 3);
  await expect(card(page).locator(".wiki-sel-turn-q")).toHaveText(["Who holds the gate there?", "And when does it close?"]);
  await expect(card(page).locator("[data-discuss-continue]")).toBeVisible();
  await shot(page, "2-card-three-turns");

  // The ledger: one origin, the card's first turn; every turn on line 13.
  await expect.poll(async () => (await rows()).length, { timeout: 30_000 }).toBe(3);
  const r = await rows();
  expect(r.map((x) => x.origin_turn_id)).toEqual([null, r[0]!.id, r[0]!.id]);
  expect(r.map((x) => x.sent_from)).toEqual(["card", "card", "card"]);
  expect(r.map((x) => x.location?.found)).toEqual(["exact", "exact", "exact"]);
  expect(r.map((x) => x.location?.fromLine)).toEqual([GAMMA_LINE, GAMMA_LINE, GAMMA_LINE]);
  expect(r[0]!.passage).toMatchObject({ heading: "Brief", held: { at: expect.any(Number) } });
  expect(r[1]!.passage).toBeNull();

  // The thread read returns the same three, in order, with the origin and sent_from.
  const read = await page.request.get(`${BASE}/api/wiki/discuss/thread?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  expect(read.ok()).toBe(true);
  const body = (await read.json()) as { messages: { turn: { id: string; seq: number; originTurnId: string | null; sentFrom: string | null; question: string } | null }[] };
  const turns = body.messages.map((m) => m.turn).filter((t): t is NonNullable<typeof t> => !!t);
  expect(turns.map((t) => t.seq)).toEqual([1, 2, 3]);
  expect(turns.map((t) => t.originTurnId)).toEqual([null, turns[0]!.id, turns[0]!.id]);
  expect(turns.map((t) => t.sentFrom)).toEqual(["card", "card", "card"]);
  if (process.env.E2E_FOLLOW_JSON) await writeFile(process.env.E2E_FOLLOW_JSON, JSON.stringify(turns.map(({ id, seq, originTurnId, sentFrom, question }) => ({ id, seq, originTurnId, sentFrom, question })), null, 2));
});

test("a follow-up naming another page's turn as its origin is refused 409 origin, as JSON before any stream", async ({ page }) => {
  test.setTimeout(180_000);
  const post = (data: Record<string, unknown>) => page.request.post(`${BASE}/api/wiki/discuss`, { data: { wiki: WIKI, ...data } });
  // A turn on the other page, then this page's card turn.
  expect((await post({ relPath: OTHER, question: "When does the pier open?", sentFrom: "card" })).ok()).toBe(true);
  const [other] = await sql!`SELECT w.id FROM wiki_discuss_turns w JOIN threads t ON t.id = w.thread_id WHERE t.rel_path = ${OTHER} AND t.wiki = ${WIKI}`;
  await openPage(page);
  await explainGamma(page);
  // The card's answer shows while it streams: the turn has to have ended before another starts.
  await expect.poll(async () => (await sql!`SELECT count(*)::int AS n FROM wiki_discuss_turns WHERE wiki = ${WIKI} AND end_state = 'running'`)[0]!.n, { timeout: 30_000 }).toBe(0);
  const [first] = await rows();
  const [thread] = await sql!`SELECT id FROM threads WHERE kind = 'wiki' AND wiki = ${WIKI} AND rel_path = ${REL} AND closed_at IS NULL`;
  const refused = await post({ relPath: REL, question: "From elsewhere?", selection: "TWFA", discussionId: thread!.id, originTurnId: other!.id, sentFrom: "card" });
  expect(refused.status()).toBe(409);
  expect(refused.headers()["content-type"]).toContain("application/json");
  expect(await refused.json()).toMatchObject({ reason: "origin" });
  // This page's own first turn is taken as the origin.
  const ok = await post({ relPath: REL, question: "From here?", selection: "TWFA", discussionId: thread!.id, originTurnId: first!.id, sentFrom: "card" });
  expect(ok.status()).toBe(200);
  expect((await rows()).map((x) => x.origin_turn_id)).toEqual([null, first!.id]);
});

test("after a render of the page (not a browser reload) the card is back under its copy and a follow-up from it works", async ({ page }) => {
  test.setTimeout(240_000);
  await openPage(page);
  await explainGamma(page);
  await card(page).evaluate((el) => el.setAttribute("data-e2e-mark", "kept"));
  const rendered = page.waitForResponse((r) => r.url().includes("/api/wiki/page?"));
  await page.locator(`.wiki-list-item[data-relpath="${REL}"]`).first().click();
  await rendered;
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("The morning route adds a stop");
  await expect(page.locator('#articleWrap .wiki-sel-card[data-e2e-mark="kept"]')).toBeVisible();
  // Under the third copy's paragraph: after «gamma», before «delta».
  const order = await page.evaluate(() => {
    const text = document.querySelector("#articleWrap .wiki-article")!.textContent ?? "";
    const c = document.querySelector("#articleWrap .wiki-sel-card")!.textContent ?? "";
    return { gamma: text.indexOf("gamma copy"), card: text.indexOf(c), delta: text.indexOf("TWFA delta") };
  });
  expect(order.card).toBeGreaterThan(order.gamma);
  expect(order.card).toBeLessThan(order.delta);
  await followUp(page, "After the render: still the same gate?", 2);
  await shot(page, "3-card-after-render");
  await expect.poll(async () => (await rows()).length, { timeout: 30_000 }).toBe(2);
  const r = await rows();
  expect(r[1]!.origin_turn_id).toBe(r[0]!.id);
  expect(r.map((x) => x.location?.fromLine)).toEqual([GAMMA_LINE, GAMMA_LINE]);
});

/** Which copy of «TWFA» (0-based, page order) the Discuss chip flashed: the
 *  first flash seen within 3 s of the press (it fades), else -1. */
function flashedCopy(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const until = Date.now() + 3_000;
    for (;;) {
      const k = once();
      if (k !== -1 || Date.now() > until) return k;
      await new Promise((r) => setTimeout(r, 25));
    }
    function once(): number {
      const article = document.querySelector("#articleWrap .wiki-article")!;
      const hl = (globalThis as unknown as { CSS: { highlights?: Map<string, Set<Range>> } }).CSS.highlights?.get("wiki-range-flash");
      const range = hl && hl.size ? [...hl][0]! : null;
      const el = article.querySelector(".wiki-hash-flash");
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      let k = 0;
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        if (n.parentElement?.closest(".wiki-sel-card, button")) continue;
        for (let at = n.data.indexOf("TWFA"); at !== -1; at = n.data.indexOf("TWFA", at + 1), k++) {
          const copy = document.createRange();
          copy.setStart(n, at);
          copy.setEnd(n, at + 4);
          const hit = range ? range.compareBoundaryPoints(Range.START_TO_START, copy) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, copy) >= 0 : !!el?.contains(n);
          if (hit) return k;
        }
      }
      return -1;
    }
  });
}

// Fix round 1 (finding B): after a reload the tab reads the turns back from the
// thread; a follow-up takes its card's first turn's stored context, so its chip
// reaches the copy the card was asked on, as the first turn's chip does.
test("after a browser reload, the Discuss tab's chip on a follow-up reaches its card's copy, not the page's first «TWFA»", async ({ page }) => {
  test.setTimeout(240_000);
  await openPage(page);
  await explainGamma(page);
  await followUp(page, "Who holds the gate there?", 2);
  await expect.poll(async () => (await rows()).length, { timeout: 30_000 }).toBe(2);
  await page.reload();
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("The morning route adds a stop");
  await page.locator('[data-conntab="discuss"]').click();
  for (const seq of [1, 2]) {
    const chip = page.locator(`.wiki-discuss-turn[data-turn-seq="${seq}"] [data-discuss-chip]`);
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await chip.click();
    expect(await flashedCopy(page)).toBe(2);
    await shot(page, `4-reload-chip-${seq}`);
  }
});
