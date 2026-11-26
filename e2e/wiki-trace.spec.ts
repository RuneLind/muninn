/**
 * Discuss v2 PR 6 (mimir plan muninn-wiki-discuss-v2, D4 and D5): the key
 * peek and the Trace view.
 *
 * - Keys the wiki's `trackers` and `keys` kinds name are underlined in the
 *   article, never in code; a key with its own fact chip is not underlined
 *   twice, and the peek sits on its chip.
 * - Hovering a key shows its peek from `GET /api/wiki/mentions`, once per key
 *   (cached), with no model.
 * - «Trace» opens the Trace view: mentions and a timeline from the fixture's
 *   git history at once. «Summarize» starts the key's trace thread on the
 *   Discuss engine, a REAL claude-sdk one-shot on the fake Messages API: one
 *   ledger row with `trace_key` set and no page, two `source 'wiki'` messages,
 *   the thread not active. A follow-up continues the same thread, a
 *   selection's key chip opens the Trace view with the thread read back, and
 *   Apply refuses a trace turn.
 * - Fix round 1 batch 4: a key whose fact chip hides (no counted PR, no Jira
 *   status) keeps its underline and its peek (J1); a key the page's
 *   CaseBoard defines opens one peek, the key's, with the row's «Go to ↓»
 *   (J2); a wiki that is no git work tree gets no mark, and on a read-only
 *   root or a wiki with no agent the Trace view shows the mentions with no
 *   «Summarize» or follow-up box (J3).
 *
 * Its own muninn with `e2eEnv()`, a git wiki with no remote in a temp dir
 * (`WIKI_EXTRA`) with two commits, a `keys` kind, a Jira tracker and a facts
 * file; a throwaway `claude-sdk` bot under `MUNINN_BOTS_DIR` seeded as its
 * own default user; the fake Messages API as its own process. Invented keys,
 * repos and pages only.
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

const PORT = e2ePort("wiki-trace");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-trace";
const REL = "plans/ferry.mdx";
const OTHER = "plans/harbour.mdx";
const BOT = "tracebot";
const USER = "e2e-trace-user";
const KEY = "MEL-1029036";
const NIGHT = `The night route for ${KEY} is unchanged.`;
const SUMMARY = "TRACE-SUMMARY: the case is named on two plans and in the log.";
const RULES = ["# Rules", "", "Answer the question first.", "", "<!-- discuss:edit -->", "## Changing the page", "Propose at most one edit.", "<!-- /discuss:edit -->", ""].join("\n");
const PAGE = ["---", "title: Ferry plan", "---", "", "# Ferry plan", "", NIGHT, "", "DEMO-12 has facts. DEMO-20 has none.", "", "In code: `MEL-55` stays plain.", ""].join("\n");
const PAGE_OTHER = ["---", "title: Harbour plan", "---", "", "# Harbour plan", "", `The harbour waits for ${KEY}.`, ""].join("\n");
const CASES_REL = "plans/cases.mdx";
const CASE_KEY = "MEL-700001";
const PAGE_CASES = ["---", "title: Case plan", "---", "", "# Case plan", "", "DEMO-30 has only a closed PR.", "", `${CASE_KEY} is held out.`, "", '<CaseBoard src="cases.yaml" />', ""].join("\n");
const CASES_YAML = `- id: ${CASE_KEY}\n  status: hold\n  note: "Held out for now"\n`;
/** The side wikis (J3): a read-only root and one with no agent, both git; one that is no git work tree. */
const SIDE_REL = "plans/side.mdx";
const SIDE_KEY = "MEL-800001";
const PAGE_SIDE = ["---", "title: Side plan", "---", "", "# Side plan", "", `The side note names ${SIDE_KEY}.`, ""].join("\n");
const RO_WIKI = "e2e-trace-ro";
const NA_WIKI = "e2e-trace-na";
const NG_WIKI = "e2e-trace-ng";
const FACTS = {
  version: 1,
  prs: {
    "acme/acme-api#5": { title: "DEMO-12 fix", state: "MERGED", isDraft: false, mergedAt: "2026-11-02T10:00:00Z", inProd: null, draftTag: null, firstProd: null, checkedAt: "2026-11-20T10:00:00Z" },
    "acme/acme-api#6": { title: "DEMO-30 try", state: "CLOSED", isDraft: false, mergedAt: null, inProd: null, draftTag: null, firstProd: null, checkedAt: "2026-11-20T10:00:00Z" },
  },
  keys: { "DEMO-12": { prs: ["acme/acme-api#5"] }, "DEMO-30": { prs: ["acme/acme-api#6"] } },
};

let server: ChildProcess | undefined;
let fake: ChildProcess | undefined;
let root = "";
let scratch = "";
let sql: ReturnType<typeof postgres> | null = null;

const GIT_IDENT = { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" };
function git(...args: string[]): string {
  return gitAt(root, ...args);
}
function gitAt(at: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", at, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_IDENT } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function startFake(): Promise<string> {
  fake = spawn("bun", ["--no-env-file", path.join(REPO_ROOT, "e2e/fake-messages-api-server.ts")], {
    cwd: REPO_ROOT,
    env: { ...process.env, FAKE_API_CHUNKS: JSON.stringify([SUMMARY]), FAKE_API_DELAY_MS: "100" },
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
        resolve(url);
      }
    });
  });
}

test.beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "muninn-e2e-trace-"));
  root = path.join(scratch, "wiki");
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, ".wiki-agent.md"), RULES, "utf8");
  await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ keys: [{ name: "case", pattern: "MEL-\\d+" }], trackers: [{ id: "jira", projects: ["DEMO"] }] }), "utf8");
  await writeFile(path.join(root, ".wiki-facts.json"), JSON.stringify(FACTS), "utf8");
  await writeFile(path.join(root, OTHER), PAGE_OTHER, "utf8");
  await writeFile(path.join(root, "log.md"), `# Log\n\n## [2026-11-04] note | ferry\n\n- ${KEY} is outside the data fix.\n`, "utf8");
  const init = spawnSync("git", ["init", "-q", "-b", "main", root], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`git init: ${init.stderr}`);
  git("add", "-A");
  git("commit", "-q", "-m", "Harbour plan names the case");
  await writeFile(path.join(root, REL), PAGE, "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "Ferry plan names the case");
  await writeFile(path.join(root, CASES_REL), PAGE_CASES, "utf8");
  await writeFile(path.join(root, "plans/cases.yaml"), CASES_YAML, "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "Case plan");
  const sides: Record<string, string> = {};
  for (const [name, isGit, rules] of [[RO_WIKI, true, true], [NA_WIKI, true, false], [NG_WIKI, false, true]] as const) {
    const at = path.join(scratch, name);
    sides[name] = at;
    await mkdir(path.join(at, "plans"), { recursive: true });
    if (rules) await writeFile(path.join(at, ".wiki-agent.md"), RULES, "utf8");
    await writeFile(path.join(at, ".wiki-reader.json"), JSON.stringify({ keys: [{ name: "case", pattern: "MEL-\\d+" }] }), "utf8");
    await writeFile(path.join(at, SIDE_REL), PAGE_SIDE, "utf8");
    if (isGit) {
      const init = spawnSync("git", ["init", "-q", "-b", "main", at], { encoding: "utf8" });
      if (init.status !== 0) throw new Error(`git init: ${init.stderr}`);
      gitAt(at, "add", "-A");
      gitAt(at, "commit", "-q", "-m", "Side plan names the case");
    }
  }
  const bot = path.join(scratch, "bots", BOT);
  await mkdir(bot, { recursive: true });
  await writeFile(path.join(bot, "CLAUDE.md"), "# e2e trace bot\n\nCreated by e2e/wiki-trace.spec.ts.\n");
  await writeFile(path.join(bot, "config.json"), JSON.stringify({ connector: "claude-sdk", model: "claude-sonnet-4-5", timeoutMs: 120000 }));
  await mkdir(path.join(scratch, "claude-config"), { recursive: true });
  await mkdir(path.join(scratch, "agent-home"), { recursive: true });
  const fakeUrl = await startFake();

  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  await sql`DELETE FROM threads WHERE user_id = ${USER}`;
  await sql`DELETE FROM wiki_discuss_turns WHERE wiki = ${WIKI}`;
  await sql`INSERT INTO users (id, username, platform) VALUES (${USER}, 'E2E Trace', 'web') ON CONFLICT (id) DO NOTHING`;
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
      WIKI_EXTRA: `${WIKI}=${root},${RO_WIKI}=${sides[RO_WIKI]},${NA_WIKI}=${sides[NA_WIKI]},${NG_WIKI}=${sides[NG_WIKI]}`,
      WIKI_READONLY_ROOTS: sides[RO_WIKI],
      MUNINN_BOTS_DIR: path.join(scratch, "bots"),
      RESEARCH_BOT: BOT,
      PLAN_CARD_BIN: "",
      DECISION_TRIAGE_REPO_ROOTS: "",
      MUNINN_AGENT_CWD: path.join(scratch, "agent-home"),
      ANTHROPIC_BASE_URL: fakeUrl,
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
test.describe.configure({ mode: "serial" });

const article = (page: Page) => page.locator("#articleWrap .wiki-article");
const peek = (page: Page) => page.locator("#wikiKeyPeek");
const traceCard = (page: Page) => page.locator('#articleWrap .wiki-sel-card[data-sel-card="trace"]');

async function openPage(page: Page): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(article(page)).toContainText("DEMO-20 has none.");
}

/** A real mouse drag over `text` in the article. */
async function dragSelect(page: Page, text: string): Promise<void> {
  await page.evaluate(() => getSelection()!.removeAllRanges());
  const at = await page.evaluate((text) => {
    const a = document.querySelector("#articleWrap .wiki-article")!;
    const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
    const nodes: { t: Text; at: number }[] = [];
    let all = "";
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      nodes.push({ t, at: all.length });
      all += t.data;
    }
    const i = all.indexOf(text);
    const find = (n: number, end: boolean) => nodes.findLast((x) => (end ? x.at < n : x.at <= n))!;
    const s = find(i, false);
    const e = find(i + text.length, true);
    const r = document.createRange();
    r.setStart(s.t, i - s.at);
    r.setEnd(e.t, i + text.length - e.at);
    const rects = r.getClientRects();
    const f = rects[0]!;
    const l = rects[rects.length - 1]!;
    return { x0: f.left + 1, y0: f.top + f.height / 2, x1: l.right - 1, y1: l.top + l.height / 2 };
  }, text);
  await page.mouse.move(at.x0, at.y0);
  await page.mouse.down();
  await page.mouse.move(at.x1, at.y1, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(text);
}

test("keys are underlined beside a fact chip, never twice and never in code", async ({ page }) => {
  await openPage(page);
  const a = article(page);
  await expect(a.locator(`.wiki-key[data-wiki-key="${KEY}"]`)).toHaveText(KEY);
  await expect(a.locator('.wiki-key[data-wiki-key="DEMO-20"]')).toHaveText("DEMO-20");
  // DEMO-12 has a facts entry: its chip shows, and its mark draws no underline (fix round 1 J1).
  await expect(a.locator('span.fact-chip[data-live-fact="DEMO-12"]')).toBeVisible();
  await expect(a.locator('.wiki-key[data-wiki-key="DEMO-12"]')).toHaveText("DEMO-12");
  expect(await a.locator('.wiki-key[data-wiki-key="DEMO-12"]').evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
  await expect(a.locator("code .wiki-key, pre .wiki-key")).toHaveCount(0);
  await expect(a.locator("code", { hasText: "MEL-55" })).toHaveCount(1);
  // The underline is drawn (the reader's CSS reaches the mark).
  const deco = await a.locator(`.wiki-key[data-wiki-key="${KEY}"]`).evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(deco).toContain("underline");
});

test("hovering a key shows its peek from the mentions route, asked once per key; the chip carries the peek of its key", async ({ page }) => {
  await openPage(page);
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/wiki/mentions?")) asked.push(new URL(r.url()).searchParams.get("key") ?? "");
  });
  await article(page).locator(`.wiki-key[data-wiki-key="${KEY}"]`).hover();
  await expect(peek(page)).toBeVisible();
  await expect(peek(page).locator(".wiki-key-peek-key")).toHaveText(KEY);
  await expect(peek(page).locator("[data-peek-totals]")).toContainText("3 lines in 3 files");
  await expect(peek(page).locator("[data-key-trace]")).toBeVisible();
  // Away and back: the cached answer, no second request.
  await page.mouse.move(5, 5);
  await expect(peek(page)).toBeHidden();
  await article(page).locator(`.wiki-key[data-wiki-key="${KEY}"]`).hover();
  await expect(peek(page)).toBeVisible();
  expect(asked.filter((k) => k === KEY)).toHaveLength(1);
  // DEMO-12's own text is no second target: its chip shows.
  await page.mouse.move(5, 5);
  await expect(peek(page)).toBeHidden();
  await article(page).locator('.wiki-key[data-wiki-key="DEMO-12"]').hover();
  await page.waitForTimeout(700);
  await expect(peek(page)).toBeHidden();
  // The fact chip of DEMO-12 shows DEMO-12's peek.
  await page.mouse.move(5, 5);
  await article(page).locator('span.fact-chip[data-live-fact="DEMO-12"]').hover();
  await expect(peek(page).locator(".wiki-key-peek-key")).toHaveText("DEMO-12");
  // The page and the tracked facts file.
  await expect(peek(page).locator("[data-peek-totals]")).toContainText("2 lines in 2 files");
});

test("«Trace» shows the mentions and the timeline at once; «Summarize» is a trace thread whose turn writes its ledger row and two wiki messages; a follow-up continues it", async ({ page }) => {
  await openPage(page);
  await article(page).locator(`.wiki-key[data-wiki-key="${KEY}"]`).hover();
  await peek(page).locator("[data-key-trace]").click();
  const card = traceCard(page);
  await expect(card.locator(".wiki-sel-card-sub")).toContainText(KEY);
  const files = await card.locator(".wiki-sel-file").evaluateAll((els) => els.map((e) => e.getAttribute("data-sel-file")).sort());
  expect(files).toEqual(["log.md", REL, OTHER]);
  await expect(card.locator('[data-trace-ev="commit"]')).toHaveCount(2);
  await expect(card.locator('[data-trace-ev="log"]')).toHaveCount(1);
  await expect(card.locator('[data-trace-sec="timeline"]')).toContainText("Ferry plan names the case");

  const posted = page.waitForRequest((r) => r.url().endsWith("/api/wiki/discuss") && r.method() === "POST");
  await card.locator("[data-trace-summarize]").click();
  const body = JSON.parse((await posted).postData() ?? "{}") as Record<string, unknown>;
  expect(body).toMatchObject({ wiki: WIKI, traceKey: KEY, mode: "explore" });
  expect(body.relPath).toBeUndefined();
  await expect(card.locator('.wiki-trace-turn[data-trace-state="done"]')).toHaveCount(1);
  await expect(card.locator(".wiki-trace-a")).toContainText("TRACE-SUMMARY");

  const rows = await sql!`SELECT thread_id, trace_key, rel_path, page_hash, end_state, user_message_id, assistant_message_id FROM wiki_discuss_turns WHERE wiki = ${WIKI} ORDER BY seq`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ trace_key: KEY, rel_path: null, page_hash: null, end_state: "done" });
  const threadId = rows[0]!.thread_id as string;
  const [thread] = await sql!`SELECT kind, trace_key, rel_path, is_active, name FROM threads WHERE id = ${threadId}`;
  expect(thread).toMatchObject({ kind: "wiki", trace_key: KEY, rel_path: null, is_active: false, name: `wiki trace: ${KEY.toLowerCase()}` });
  const msgs = await sql!`SELECT role, source FROM messages WHERE thread_id = ${threadId} ORDER BY created_at, role DESC`;
  expect(msgs.map((m) => `${m.role}:${m.source}`)).toEqual(["user:wiki", "assistant:wiki"]);

  // A follow-up continues the same thread.
  await card.locator(".wiki-trace-input").fill("Which plan named it first?");
  await card.locator(".wiki-trace-follow button[type=submit]").click();
  await expect(card.locator('.wiki-trace-turn[data-trace-state="done"]')).toHaveCount(2);
  const after = await sql!`SELECT thread_id, trace_key, rel_path FROM wiki_discuss_turns WHERE wiki = ${WIKI} ORDER BY seq`;
  expect(after.map((r) => `${r.thread_id === threadId}:${r.trace_key}:${r.rel_path}`)).toEqual([`true:${KEY}:null`, `true:${KEY}:null`]);
  expect((await sql!`SELECT count(*)::int AS n FROM messages WHERE thread_id = ${threadId} AND source = 'wiki'`)[0]!.n).toBe(4);
});

test("a selection's key chip opens the Trace view, which reads the thread back; Apply refuses a trace turn", async ({ page }) => {
  await openPage(page);
  await dragSelect(page, NIGHT);
  const chip = page.locator(`#wikiSelBar [data-selact="key"][data-selkey="${KEY}"]`);
  await expect(chip).toHaveText(`🧭 ${KEY}`);
  await chip.click();
  const card = traceCard(page);
  await expect(card.locator(".wiki-sel-file")).toHaveCount(3);
  await expect(card.locator(".wiki-trace-turn")).toHaveCount(2);
  await expect(card.locator(".wiki-trace-q").first()).toContainText("Summarize");
  await expect(card.locator("[data-trace-summarize]")).toBeHidden();
  await expect(card.locator(".wiki-trace-follow")).toBeVisible();

  const [newest] = await sql!`SELECT id FROM wiki_discuss_turns WHERE wiki = ${WIKI} ORDER BY seq DESC LIMIT 1`;
  const res = await page.request.post(`${BASE}/api/wiki/discuss/apply`, { data: { turnId: newest!.id, preview: true } });
  expect(res.status()).toBe(409);
  expect(((await res.json()) as { reason: string }).reason).toBe("no-page");
});

async function openAt(page: Page, wiki: string, rel: string, text: string): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}&relPath=${encodeURIComponent(rel)}`);
  await expect(article(page)).toContainText(text);
}

test("a key whose fact chip hides keeps its underline and its peek (J1)", async ({ page }) => {
  await openAt(page, WIKI, CASES_REL, "has only a closed PR");
  const a = article(page);
  await expect(a.locator('span.fact-chip[data-live-fact="DEMO-30"]')).toBeHidden();
  const mark = a.locator('.wiki-key[data-wiki-key="DEMO-30"]');
  await expect(mark).toHaveText("DEMO-30");
  expect(await mark.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain("underline");
  await mark.hover();
  await expect(peek(page).locator(".wiki-key-peek-key")).toHaveText("DEMO-30");
});

test("a key the page's CaseBoard defines opens one peek, the key's, whose «Go to ↓» jumps to the row (J2)", async ({ page }) => {
  await openAt(page, WIKI, CASES_REL, "is held out");
  const mark = article(page).locator(`.wiki-key[data-wiki-key="${CASE_KEY}"]`);
  await expect(mark.locator("a.wiki-ref")).toHaveCount(1);
  await mark.hover();
  await expect(peek(page).locator(".wiki-key-peek-key")).toHaveText(CASE_KEY);
  // Past the reference peek's own delay: still the one card.
  await page.waitForTimeout(700);
  await expect(page.locator(".wiki-ref-peek")).toHaveCount(0);
  await expect(peek(page)).toBeVisible();
  // The row's text, as the reference peek showed it.
  await expect(peek(page).locator(".wiki-key-peek-here")).toContainText("Held out for now");
  await peek(page).locator("[data-key-goto]").click();
  await expect(peek(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#case-${CASE_KEY.toLowerCase()}`);
  // A click on the key itself still jumps, as the reference link did.
  await page.evaluate(() => history.replaceState(history.state, "", location.pathname + location.search));
  await mark.locator("a.wiki-ref").click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#case-${CASE_KEY.toLowerCase()}`);
});

test("no mark on a wiki that is no git work tree; a read-only root and a wiki with no agent: the peek and the Trace view's mentions, no «Summarize» or follow-up box (J3)", async ({ page }) => {
  await openAt(page, NG_WIKI, SIDE_REL, "The side note names");
  await expect(article(page).locator(".wiki-key")).toHaveCount(0);
  for (const wiki of [RO_WIKI, NA_WIKI]) {
    await openAt(page, wiki, SIDE_REL, "The side note names");
    const mark = article(page).locator(`.wiki-key[data-wiki-key="${SIDE_KEY}"]`);
    await mark.hover();
    await expect(peek(page).locator("[data-peek-totals]")).toContainText("1 line in 1 file");
    await peek(page).locator("[data-key-trace]").click();
    const card = traceCard(page);
    await expect(card.locator(".wiki-sel-file")).toHaveCount(1);
    await expect(card.locator('[data-trace-ev="commit"]')).toHaveCount(1);
    await expect(card.locator("[data-trace-summarize]")).toHaveCount(0);
    await expect(card.locator(".wiki-trace-follow")).toHaveCount(0);
  }
});
