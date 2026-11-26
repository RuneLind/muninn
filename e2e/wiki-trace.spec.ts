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
 * - Fix round 1 batch 5: a render of the same page puts the Trace card back
 *   with its turn still streaming into it, and closing it or another page
 *   aborts that stream (K1, the discuss POST held by `page.route`); a send
 *   refused 409 `busy` and a reopened card show the key's running turn with no
 *   «Summarize» or follow-up box and pick up its answer (K2); read-back turns
 *   take their state from the ledger row and their answer by message id (K3).
 *   K2 and K3 write the thread, messages and ledger rows as the engine does.
 * - Fix round 2 batch 4: a failed thread read (a network failure, a 500) is
 *   read again until the turn is seen to end; a thread that is gone puts the
 *   card back on «Summarize» with a note, and a 404 ends the running turn as
 *   an error with the follow-up box back; a closed card reads no more. The
 *   thread reads are answered by `page.route`.
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

// ── Fix round 1 batch 5: the Trace card's thread state (K1–K3) ────────────

/** Render the page on screen again: its rail row, the page fetched and drawn anew. */
async function renderAgain(page: Page, rel: string, shown: string): Promise<void> {
  const rendered = page.waitForResponse((r) => r.url().includes("/api/wiki/page?"));
  await page.locator(`.wiki-list-item[data-relpath="${rel}"]`).first().click();
  await rendered;
  await expect(article(page)).toContainText(shown);
}

/** The Trace card of the key mark `key` on the page shown, from its peek. */
async function traceFromPeek(page: Page, key: string): Promise<void> {
  await page.mouse.move(5, 5);
  await article(page).locator(`.wiki-key[data-wiki-key="${key}"]`).hover();
  await peek(page).locator(`[data-key-trace="${key}"]`).click();
  await expect(traceCard(page).locator('[data-trace-sec="thread"]')).toBeVisible();
}

/** A key's live trace thread written as the engine writes one (another tab's or /chat's turns). */
async function seedTraceThread(key: string): Promise<string> {
  const [t] = await sql!`INSERT INTO threads (user_id, bot_name, name, kind, wiki, trace_key) VALUES (${USER}, ${BOT}, ${`wiki trace: ${key.toLowerCase()}`}, 'wiki', ${WIKI}, ${key}) RETURNING id`;
  return t!.id as string;
}
async function seedMessage(threadId: string, role: "user" | "assistant", content: string): Promise<string> {
  const [m] = await sql!`INSERT INTO messages (user_id, bot_name, role, content, source, platform, thread_id) VALUES (${USER}, ${BOT}, ${role}, ${content}, 'wiki', 'web', ${threadId}) RETURNING id`;
  return m!.id as string;
}
async function seedTurn(
  threadId: string,
  key: string,
  seq: number,
  question: string,
  o: { endState: string; answer?: string; error?: string; userMessageId: string; assistantMessageId?: string | null },
): Promise<string> {
  const [t] = await sql!`
    INSERT INTO wiki_discuss_turns (discussion_id, seq, wiki, trace_key, thread_id, question, answer, end_state, error, bot_name, connector, user_message_id, assistant_message_id, finished_at)
    VALUES (${threadId}, ${seq}, ${WIKI}, ${key}, ${threadId}, ${question}, ${o.answer ?? ""}, ${o.endState}, ${o.error ?? null}, ${BOT}, 'claude-sdk', ${o.userMessageId}, ${o.assistantMessageId ?? null}, ${o.endState === "running" ? null : new Date()})
    RETURNING id`;
  return t!.id as string;
}
/** The running turn ends done, as the engine finishes one: the row, then its answer message. */
async function finishSeeded(threadId: string, turnId: string, answer: string): Promise<void> {
  const a = await seedMessage(threadId, "assistant", answer);
  await sql!`UPDATE wiki_discuss_turns SET end_state = 'done', answer = ${answer}, assistant_message_id = ${a}, finished_at = now() WHERE id = ${turnId}`;
}

test("K1: a render of the same page puts the Trace card back with its follow-up still streaming into it; closing it or leaving the page aborts that stream", async ({ page }) => {
  let release: () => void = () => {};
  const released = new Promise<void>((r) => (release = r));
  let posts = 0;
  await page.route("**/api/wiki/discuss", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    // Only the first turn ever answers; the later ones stay pending until aborted.
    if (posts > 1) return;
    await released;
    const body = `event: delta\ndata: {"text":"TRACE-AFTER "}\n\nevent: done\ndata: ${JSON.stringify({ answer: "TRACE-AFTER-RENDER: the answer reached the held card." })}\n\nevent: end\ndata: {}\n\n`;
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body }).catch(() => {});
  });
  const failed: string[] = [];
  page.on("requestfailed", (r) => {
    if (r.url().endsWith("/api/wiki/discuss") && r.method() === "POST") failed.push(r.failure()?.errorText ?? "failed");
  });
  await openPage(page);
  await traceFromPeek(page, KEY);
  const card = traceCard(page);
  await expect(card.locator('.wiki-trace-turn[data-trace-state="done"]')).toHaveCount(2);
  await card.evaluate((el) => el.setAttribute("data-e2e-mark", "trace"));
  await card.locator(".wiki-trace-input").fill("Is the night route still open?");
  await card.locator(".wiki-trace-follow button[type=submit]").click();
  await expect(card.locator('.wiki-trace-turn[data-trace-state="running"]')).toHaveCount(1);
  await renderAgain(page, REL, "DEMO-20 has none.");
  // The same element, back under the key's paragraph.
  const back = page.locator('#articleWrap .wiki-sel-card[data-sel-card="trace"][data-e2e-mark="trace"]');
  await expect(back).toHaveCount(1);
  // Under the key's line: after the night route's sentence, before the next line.
  expect(
    await back.evaluate((el, night) => {
      const text = el.parentElement?.closest(".wiki-article")?.textContent ?? "";
      const at = text.indexOf(el.textContent ?? "\u0000");
      return at > text.indexOf(night) && at < text.indexOf("DEMO-20 has none.");
    }, NIGHT),
  ).toBe(true);
  release();
  await expect(back.locator(".wiki-trace-a").last()).toContainText("TRACE-AFTER-RENDER");
  await expect(back.locator('.wiki-trace-turn[data-trace-state="done"]')).toHaveCount(3);
  expect(failed).toEqual([]);

  // Closed while its turn streams: the stream is aborted.
  await back.locator(".wiki-trace-input").fill("Who owns it?");
  await back.locator(".wiki-trace-follow button[type=submit]").click();
  await expect.poll(() => posts).toBe(2);
  await back.locator("[data-sel-card-close]").click();
  await expect.poll(() => failed.length).toBe(1);

  // Another page while its turn streams: aborted too.
  await traceFromPeek(page, KEY);
  await traceCard(page).locator(".wiki-trace-input").fill("And the harbour?");
  await traceCard(page).locator(".wiki-trace-follow button[type=submit]").click();
  await expect.poll(() => posts).toBe(3);
  await renderAgain(page, OTHER, "The harbour waits for");
  await expect.poll(() => failed.length).toBe(2);
  await expect(traceCard(page)).toHaveCount(0);
});

test("K2: «Summarize» refused busy shows the key's running turn, with no «Summarize» or follow-up box, and picks up its answer; a reopened card does the same", async ({ page }) => {
  const key = "DEMO-20";
  await openPage(page);
  await traceFromPeek(page, key);
  const card = traceCard(page);
  await expect(card.locator("[data-trace-summarize]")).toBeVisible();
  // A turn of the key's thread starts elsewhere after the card read it back.
  const threadId = await seedTraceThread(key);
  const u1 = await seedMessage(threadId, "user", "BUSY-Q1: what is DEMO-20?");
  const t1 = await seedTurn(threadId, key, 1, "BUSY-Q1: what is DEMO-20?", { endState: "running", userMessageId: u1 });
  const refused = page.waitForResponse((r) => r.url().endsWith("/api/wiki/discuss") && r.request().method() === "POST");
  await card.locator("[data-trace-summarize]").click();
  expect((await refused).status()).toBe(409);
  await expect(card.locator('.wiki-trace-turn[data-trace-state="running"]')).toHaveCount(1);
  await expect(card.locator(".wiki-trace-q")).toHaveText(["BUSY-Q1: what is DEMO-20?"]);
  await expect(card.locator(".wiki-discuss-error")).toHaveCount(0);
  await expect(card.locator("[data-trace-summarize]")).toBeHidden();
  await expect(card.locator(".wiki-trace-follow")).toBeHidden();
  await finishSeeded(threadId, t1, "BUSY-A1: DEMO-20 is the ferry's ticket.");
  await expect(card.locator('.wiki-trace-turn[data-trace-state="done"]')).toHaveCount(1);
  await expect(card.locator(".wiki-trace-a")).toContainText("BUSY-A1");
  await expect(card.locator(".wiki-trace-follow")).toBeVisible();
  await expect(card.locator("[data-trace-summarize]")).toBeHidden();

  // A second turn runs when the card is opened again: read back running.
  const u2 = await seedMessage(threadId, "user", "BUSY-Q2: and its PR?");
  const t2 = await seedTurn(threadId, key, 2, "BUSY-Q2: and its PR?", { endState: "running", userMessageId: u2 });
  await card.locator("[data-sel-card-close]").click();
  await traceFromPeek(page, key);
  const again = traceCard(page);
  await expect(again.locator(".wiki-trace-turn")).toHaveCount(2);
  await expect(again.locator(".wiki-trace-turn").nth(1)).toHaveAttribute("data-trace-state", "running");
  await expect(again.locator("[data-trace-summarize]")).toBeHidden();
  await expect(again.locator(".wiki-trace-follow")).toBeHidden();
  await finishSeeded(threadId, t2, "BUSY-A2: none yet.");
  await expect(again.locator('.wiki-trace-turn[data-trace-state="done"]')).toHaveCount(2);
  await expect(again.locator(".wiki-trace-a").nth(1)).toContainText("BUSY-A2");
  await expect(again.locator(".wiki-trace-follow")).toBeVisible();
});

test("K3: read-back turns take their state from the ledger row and their answer by message id: an error turn reads as an error, and a turn with no stored answer shifts no turn id", async ({ page }) => {
  const threadId = await seedTraceThread(CASE_KEY);
  // Turn 1: done, but its answer message was never stored.
  const u1 = await seedMessage(threadId, "user", "IDS-Q1");
  const t1 = await seedTurn(threadId, CASE_KEY, 1, "IDS-Q1", { endState: "done", answer: "IDS-A1 from the row", userMessageId: u1, assistantMessageId: null });
  // Turn 2: failed, its «(unfinished)» message stored.
  const u2 = await seedMessage(threadId, "user", "IDS-Q2");
  const a2 = await seedMessage(threadId, "assistant", "IDS-PARTIAL\n\n(unfinished)");
  const t2 = await seedTurn(threadId, CASE_KEY, 2, "IDS-Q2", { endState: "error", answer: "IDS-PARTIAL", error: "connector broke", userMessageId: u2, assistantMessageId: a2 });
  // Turn 3: done.
  const u3 = await seedMessage(threadId, "user", "IDS-Q3");
  const a3 = await seedMessage(threadId, "assistant", "IDS-A3 the newest answer");
  const t3 = await seedTurn(threadId, CASE_KEY, 3, "IDS-Q3", { endState: "done", answer: "IDS-A3 the newest answer", userMessageId: u3, assistantMessageId: a3 });

  await openAt(page, WIKI, CASES_REL, "is held out");
  await traceFromPeek(page, CASE_KEY);
  const card = traceCard(page);
  const turns = card.locator(".wiki-trace-turn");
  await expect(turns).toHaveCount(3);
  expect(await turns.evaluateAll((els) => els.map((e) => `${e.getAttribute("data-trace-turn")}:${e.getAttribute("data-trace-state")}`))).toEqual([`${t1}:done`, `${t2}:error`, `${t3}:done`]);
  await expect(turns.nth(0).locator(".wiki-trace-a")).toContainText("IDS-A1 from the row");
  await expect(turns.nth(1).locator(".wiki-discuss-error")).toHaveText("The turn failed. connector broke");
  await expect(turns.nth(2).locator(".wiki-trace-a")).toContainText("IDS-A3 the newest answer");
  // «Continue in Claude Code» builds the prompt for the newest turn, not one by position.
  const posted = page.waitForRequest((r) => r.url().endsWith("/api/wiki/discuss/continue") && r.method() === "POST");
  await card.locator("[data-trace-continue]").click();
  expect(JSON.parse((await posted).postData() ?? "{}")).toEqual({ turnId: t3 });
});

// ── Poll failures (fix round 2 batch 4) ──────────────────────────────────────

const POLL_Q = "POLL-Q1: is the night route open?";
const runningThread = { thread: { id: "poll-thread" }, messages: [{ id: "pm1", role: "user", content: POLL_Q, turn: { id: "pt1", seq: 1, question: POLL_Q, answer: "", endState: "running", error: null, assistantMessageId: null } }] };
const doneThread = {
  thread: { id: "poll-thread" },
  messages: [
    { id: "pm1", role: "user", content: POLL_Q, turn: { id: "pt1", seq: 1, question: POLL_Q, answer: "POLL-A1", endState: "done", error: null, assistantMessageId: "pm2" } },
    { id: "pm2", role: "assistant", content: "POLL-A1: the night route is open.", turn: null },
  ],
};

/** Answer the Trace card's thread reads (`?traceKey=`) with `answer(n)`, n counting from 1. */
async function routeTraceReads(page: Page, answer: (n: number) => "abort" | { status: number; body: unknown }): Promise<() => number> {
  let n = 0;
  await page.route(
    (url) => url.pathname === "/api/wiki/discuss/thread" && url.searchParams.has("traceKey"),
    async (route) => {
      const a = answer(++n);
      if (a === "abort") return route.abort("failed");
      await route.fulfill({ status: a.status, contentType: "application/json", body: JSON.stringify(a.body) });
    },
  );
  return () => n;
}

test("a failed thread read is read again: after a network failure and a 500 the card picks up the finished turn, with its follow-up box", async ({ page }) => {
  const reads = await routeTraceReads(page, (n) => (n === 1 ? { status: 200, body: runningThread } : n === 2 ? "abort" : n === 3 ? { status: 500, body: { error: "could not read the thread" } } : { status: 200, body: doneThread }));
  await openPage(page);
  await traceFromPeek(page, KEY);
  const card = traceCard(page);
  await expect(card.locator('.wiki-trace-turn[data-trace-state="running"]')).toHaveCount(1);
  // Reads at 1.5 s (aborted), 1.5 s later (500), then 3 s later (the finished turn).
  await expect(card.locator('.wiki-trace-turn[data-trace-state="done"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(card.locator(".wiki-trace-a")).toContainText("POLL-A1: the night route is open.");
  await expect(card.locator(".wiki-trace-follow")).toBeVisible();
  await expect(card.locator("[data-trace-summarize]")).toBeHidden();
  expect(reads()).toBe(4);
  // Ended: no more reads.
  await page.waitForTimeout(2000);
  expect(reads()).toBe(4);
});

test("a thread that is gone (Start over, deleted from /chat) puts the card back on «Summarize» with a note", async ({ page }) => {
  const reads = await routeTraceReads(page, (n) => (n === 1 ? { status: 200, body: runningThread } : { status: 200, body: { thread: null, messages: [] } }));
  await openPage(page);
  await traceFromPeek(page, KEY);
  const card = traceCard(page);
  await expect.poll(reads).toBe(2);
  await expect(card.locator(".wiki-trace-turn")).toHaveCount(0);
  await expect(card.locator(".wiki-trace-note[data-trace-end]")).toHaveText("This key's trace thread is gone: it was started over or deleted. «Summarize» starts a new one.");
  await expect(card.locator("[data-trace-summarize]")).toBeVisible();
  await expect(card.locator("[data-trace-summarize]")).toBeEnabled();
  await expect(card.locator(".wiki-trace-follow")).toBeHidden();
  await page.waitForTimeout(2000);
  expect(reads()).toBe(2);
});

test("a 404 ends the running turn as an error, with the follow-up box back", async ({ page }) => {
  const reads = await routeTraceReads(page, (n) => (n === 1 ? { status: 200, body: runningThread } : { status: 404, body: { error: "trace-off", reason: "trace-off" } }));
  await openPage(page);
  await traceFromPeek(page, KEY);
  const card = traceCard(page);
  await expect.poll(reads).toBe(2);
  await expect(card.locator('.wiki-trace-turn[data-trace-state="running"]')).toHaveCount(0);
  await expect(card.locator('.wiki-trace-turn[data-trace-state="error"] .wiki-discuss-error')).toHaveText("trace-off (404).");
  await expect(card.locator(".wiki-trace-follow")).toBeVisible();
  await expect(card.locator("[data-trace-summarize]")).toBeHidden();
  await page.waitForTimeout(2000);
  expect(reads()).toBe(2);
});

test("a closed card reads no more: its read after a failure is never made", async ({ page }) => {
  const reads = await routeTraceReads(page, (n) => (n === 1 ? { status: 200, body: runningThread } : { status: 500, body: { error: "could not read the thread" } }));
  await openPage(page);
  await traceFromPeek(page, KEY);
  await expect(traceCard(page).locator('.wiki-trace-turn[data-trace-state="running"]')).toHaveCount(1);
  await expect.poll(reads).toBe(2);
  await traceCard(page).locator("[data-sel-card-close]").click();
  // The next read was due 1.5 s after the failed one.
  await page.waitForTimeout(3500);
  expect(reads()).toBe(2);
});
