/**
 * Discuss v2 PR 4 (mimir plan muninn-wiki-discuss-v2): the Discuss pane on the
 * page's wiki thread, and the same thread in /chat.
 *
 * What the unit and DB tests cannot reach: the pane reading the thread back
 * and the turns it streams, in a browser, against a REAL claude-sdk one-shot
 * on the fake Messages API; the prompt the model receives on a follow-up (the
 * fake records every request, so the spec reads what turn 2 actually sent);
 * the Explore/Edit toggle reaching the system prompt; Apply on the page file;
 * «Continue in Claude Code»; «Pop out ↗» opening /chat on the same thread
 * (both turns there, the «Wiki» group, no connector selector), a turn sent
 * from /chat appearing in the pane after a reload, a refused /chat send
 * keeping its text and showing the refusal; «Start over» moving the thread
 * under «Earlier discussions» beside an old one-shot turn, and Delete; the
 * «as <name> ▾» picker switching the pane to a second /chat user's own thread,
 * and the turn's tool calls as a /chat-style tool group with its model line;
 * and (Discuss v3 P4) a seeded Explain thread in /chat: the page bar with the
 * page's title, the Explain chip, «⌘ Continue in Claude Code», «Start over»
 * leaving it read-only under «Earlier discussions», and the page's next
 * Explain opening a new thread that /chat lists.
 *
 * Its own muninn with `e2eEnv()`, a git wiki with no remote in a temp dir
 * (`WIKI_EXTRA`), a throwaway `claude-sdk` bot under `MUNINN_BOTS_DIR`, a
 * chat user seeded here as the bot's default, one connector row (so /chat
 * would show its selector), and the fake Messages API run by `bun` as its own
 * process (`e2e/fake-messages-api-server.ts`) with a tool call before each
 * answer and its request log served. `E2E_SHOTS=<dir>` saves one screenshot
 * per state.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { EXPLAIN_QUESTION } from "../src/wiki/discuss-bounds.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-discuss-thread");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-discuss-thread";
const REL = "plans/ferry.mdx";
const BOT = "threadbot";
const USER = "e2e-thread-user";
/** A second /chat user of the bot: «as <name> ▾» switches the page's discussion to theirs. */
const USER2 = "e2e-thread-user-2";
const OLD_LINE = "The night route is unchanged.";
const NEW_LINE = "The night route is unchanged since May.";
const PAGE = ["---", "title: Ferry plan", "---", "", "# Ferry plan", "", "## Brief", "", `- ${OLD_LINE}`, "- The morning route adds a stop.", ""].join("\n");
const RULES = [
  "# Rules",
  "",
  "Answer the question first, and name the files you read.",
  "",
  "<!-- discuss:edit -->",
  "## Changing the page",
  "EDIT-RULES-SENTINEL: propose at most one edit, in a fenced json block.",
  "<!-- /discuss:edit -->",
  "",
].join("\n");
const EDIT_JSON = JSON.stringify({ edits: [{ old: OLD_LINE, new: NEW_LINE, reason: "The timetable changed in May." }] });
const ANSWER_CHUNKS = ["The night route is named on this page only.", `\n\n\`\`\`json\n${EDIT_JSON}\n\`\`\`\n`];
const Q1 = "Where is the night route named?";
const Q2 = "And who owns the night route?";
const Q3 = "Fix the night route line.";
const Q4 = "Sent from chat: is the morning stop new?";
const Q5 = "Sent while the last turn runs";
const OLD_Q = "Is the berth list current?";
/** Discuss v3 P4's page: a seeded Explain thread of it, read in /chat. */
const REL2 = "plans/harbour.mdx";
const PAGE2 = ["---", "title: Harbour plan", "---", "", "# Harbour plan", "", "## Brief", "", "- The quay opens at dawn.", "- The crane moves in spring.", ""].join("\n");
const PASSAGE2 = "The quay opens at dawn.";
const EXPLAIN_Q = "Explain this passage with context: what it means, why it is here, and what led to it.";
const OLD_EDIT_JSON = JSON.stringify({ edits: [{ old: "The morning route adds a stop.", new: "The morning route adds two stops.", reason: "October list." }] });

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
  await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
}

/** Start the fake Messages API; its URL and its request log's URL from its first lines. */
function startFake(): Promise<{ url: string; requests: string }> {
  fake = spawn("bun", ["--no-env-file", path.join(REPO_ROOT, "e2e/fake-messages-api-server.ts")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      FAKE_API_CHUNKS: JSON.stringify(ANSWER_CHUNKS),
      FAKE_API_DELAY_MS: "300",
      FAKE_API_TOOL_FIRST: JSON.stringify([{ name: "Grep", input: { pattern: "night route" } }]),
      FAKE_API_REQUESTS: "1",
    },
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

/** The request bodies the fake received, each as its JSON text. */
async function recorded(): Promise<string[]> {
  const bodies = (await (await fetch(requestsUrl)).json()) as { body: unknown }[];
  return bodies.map((r) => JSON.stringify(r.body));
}

/** The first model request whose body carries `needle`: the turn that asked
 *  it. The CLI's own session-title request carries the prompt too, without the
 *  agent's system prompt or tools, so it is left out. */
async function requestAsking(needle: string): Promise<string> {
  let hit: string | undefined;
  const isTurn = (b: string) => b.includes(needle) && !b.includes("naming a coding session");
  await expect.poll(async () => (hit = (await recorded()).find(isTurn)) !== undefined, { timeout: 30_000 }).toBe(true);
  return hit!;
}

test.beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "muninn-e2e-discuss-thread-"));
  root = path.join(scratch, "wiki");
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REL), PAGE, "utf8");
  await writeFile(path.join(root, REL2), PAGE2, "utf8");
  await writeFile(path.join(root, ".wiki-agent.md"), RULES, "utf8");
  const init = spawnSync("git", ["init", "-q", "-b", "main", root], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`git init: ${init.stderr}`);
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  const bot = path.join(scratch, "bots", BOT);
  await mkdir(bot, { recursive: true });
  await writeFile(path.join(bot, "CLAUDE.md"), "# e2e thread bot\n\nCreated by e2e/wiki-discuss-thread.spec.ts.\n");
  await writeFile(path.join(bot, "config.json"), JSON.stringify({ connector: "claude-sdk", model: "claude-sonnet-4-5", timeoutMs: 120000 }));
  await mkdir(path.join(scratch, "claude-config"), { recursive: true });
  await mkdir(path.join(scratch, "agent-home"), { recursive: true });
  const f = await startFake();
  requestsUrl = f.requests;

  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  // A clean slate for this wiki and user (a rerun on the same database).
  await sql`DELETE FROM threads WHERE user_id IN (${USER}, ${USER2})`;
  // A deleted thread leaves its messages behind with no thread, where the main thread's read shows them.
  await sql`DELETE FROM messages WHERE user_id IN (${USER}, ${USER2})`;
  await sql`DELETE FROM wiki_discuss_turns WHERE wiki = ${WIKI}`;
  await sql`INSERT INTO users (id, username, platform) VALUES (${USER}, 'E2E Thread', 'web') ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO users (id, username, platform) VALUES (${USER2}, 'E2E Other', 'web') ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO threads (user_id, bot_name, name, is_active) VALUES (${USER2}, ${BOT}, 'main', true)`;
  await sql`INSERT INTO bot_default_user (bot_name, user_id) VALUES (${BOT}, ${USER}) ON CONFLICT (bot_name) DO UPDATE SET user_id = EXCLUDED.user_id`;
  await sql`INSERT INTO threads (user_id, bot_name, name, is_active) VALUES (${USER}, ${BOT}, 'main', true)`;
  // A connector, so /chat shows its selector on a chat thread: its absence on the wiki thread is then the kind's doing.
  await sql`INSERT INTO connectors (name, connector_type, model) SELECT 'e2e-thread-conn', 'claude-cli', 'claude-sonnet-4-5' WHERE NOT EXISTS (SELECT 1 FROM connectors WHERE name = 'e2e-thread-conn')`;
  // An old one-shot discussion of the page (v1: no thread). Its answer is the
  // ledger's raw one, edit block and all, as v1 stored it.
  const pageHash = createHash("sha256").update(PAGE).digest("hex");
  const oldAnswer = `It was, in October.\n\n\`\`\`json\n${OLD_EDIT_JSON}\n\`\`\``;
  await sql`
    INSERT INTO wiki_discuss_turns (discussion_id, seq, wiki, rel_path, page_hash, question, answer, end_state, bot_name, connector, finished_at)
    VALUES (${randomUUID()}, 1, ${WIKI}, ${REL}, ${pageHash}, ${OLD_Q}, ${oldAnswer}, 'done', ${BOT}, 'claude-sdk', now())`;

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
    await sql`DELETE FROM threads WHERE user_id IN (${USER}, ${USER2})`.catch(() => {});
    await sql`DELETE FROM messages WHERE user_id IN (${USER}, ${USER2})`.catch(() => {});
    await sql`DELETE FROM wiki_discuss_turns WHERE wiki = ${WIKI}`.catch(() => {});
    await sql`DELETE FROM connectors WHERE name = 'e2e-thread-conn'`.catch(() => {});
    await sql.end({ timeout: 2 });
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

// Tall enough that a screenshot shows two turns of the pane.
test.use({ viewport: { width: 1280, height: 1400 } });

const turn = (page: Page, seq: number) => page.locator(`#discussBody .wiki-discuss-turn[data-turn-seq="${seq}"]`);

async function ask(page: Page, question: string, seq: number): Promise<void> {
  await page.locator("#wikiDiscussInput").fill(question);
  await page.locator("#wikiDiscussAskBtn").click();
  await expect(turn(page, seq)).toHaveAttribute("data-turn-state", "done", { timeout: 90_000 });
  await expect(turn(page, seq).locator(".wiki-discuss-q")).toHaveText(question);
}

async function openPane(page: Page): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("The morning route adds a stop.");
  await page.locator('[data-conntab="discuss"]').click();
  await expect(page.locator("#discussBody")).toBeVisible();
}

test("the pane on the page's thread: follow-up with history, Edit → Apply, Continue, pop out to /chat and back, Start over beside an old one-shot turn", async ({ page, context }) => {
  test.setTimeout(300_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openPane(page);
  // No thread yet: no pop-out and no Start over; the old one-shot turn waits, collapsed.
  await expect(page.locator("#wikiDiscussPopout")).toBeHidden();
  await expect(page.locator("#wikiDiscussStartOver")).toBeHidden();
  await expect(page.locator(".wiki-discuss-earlier > summary")).toHaveText("Earlier discussions (1)");
  await expect(page.locator(".wiki-discuss-earlier")).not.toHaveAttribute("open", "");

  // 1. Ask, then follow up: both on one thread; turn 2's request carries turn 1.
  await ask(page, Q1, 1);
  await expect(turn(page, 1).locator(".wiki-discuss-tools-head")).toHaveText(/Used 1 tool/);
  await ask(page, Q2, 2);
  await expect(turn(page, 2).locator(".wiki-discuss-tools-head")).toHaveText(/Used 1 tool/);
  const req1 = await requestAsking(Q1);
  const req2 = await requestAsking(Q2);
  expect(req1).not.toContain("The discussion so far");
  expect(req2).toContain("The discussion so far");
  expect(req2).toContain(`Question: ${Q1}`);
  expect(req2).toContain("The night route is named on this page only.");
  // Explore turns get no edit rules.
  expect(req1).not.toContain("EDIT-RULES-SENTINEL");
  expect(req2).not.toContain("EDIT-RULES-SENTINEL");
  const [thread] = await sql!`SELECT id, kind, is_active, user_id, bot_name FROM threads WHERE kind = 'wiki' AND wiki = ${WIKI} AND closed_at IS NULL`;
  expect(thread).toMatchObject({ kind: "wiki", is_active: false, user_id: USER, bot_name: BOT });
  const rows = await sql!`SELECT seq, thread_id FROM wiki_discuss_turns WHERE thread_id = ${thread!.id} ORDER BY seq`;
  expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  await expect(page.locator("#wikiDiscussPopout")).toBeVisible();
  await page.locator("#discussBody").evaluate((el) => (el.scrollTop = 0));
  await shot(page, "1-pane-two-turns-tool-lines");

  // 2. Edit → Apply: the Edit turn's request carries the edit rules; Apply writes the page.
  await page.locator('[data-discuss-mode="edit"]').click();
  await expect(page.locator('[data-discuss-mode="edit"]')).toHaveAttribute("aria-pressed", "true");
  await ask(page, Q3, 3);
  expect(await requestAsking(Q3)).toContain("EDIT-RULES-SENTINEL");
  const card = turn(page, 3).locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator("ins")).toHaveText(NEW_LINE);
  await shot(page, "2-edit-card");
  await card.locator("[data-discuss-apply]").click();
  await expect(turn(page, 3).locator('.wiki-discuss-edit[data-edit-state="applied"]')).toBeVisible({ timeout: 30_000 });
  expect(await readFile(path.join(root, REL), "utf8")).toContain(NEW_LINE);

  // 3. «Continue in Claude Code» still returns a prompt.
  const cont = page.waitForResponse((r) => r.url().endsWith("/api/wiki/discuss/continue"));
  await turn(page, 3).locator("[data-discuss-continue]").click();
  const contBody = (await (await cont).json()) as { prompt?: string };
  expect(contBody.prompt).toContain(Q3);
  await expect(turn(page, 3).locator(".wiki-discuss-cont-status")).toContainText(/Copied|copy it by hand/);

  // 4. Pop out: /chat on the same thread, every turn there, under «Wiki», no connector selector.
  const href = await page.locator("#wikiDiscussPopout").getAttribute("href");
  const q = new URL(href!, BASE).searchParams;
  expect([q.get("bot"), q.get("thread"), q.get("user"), q.get("src")]).toEqual([BOT, thread!.id, USER, "wiki"]);
  const [chat] = await Promise.all([context.waitForEvent("page"), page.locator("#wikiDiscussPopout").click()]);
  await chat.waitForLoadState();
  const msgs = chat.locator("#chatMessages");
  await expect(msgs).toContainText(Q1, { timeout: 20_000 });
  await expect(msgs).toContainText(Q2);
  await expect(msgs).toContainText(Q3);
  // The open thread keeps the pointer: the pane has the edit card.
  await expect(msgs).toContainText("Proposed edit: preview and apply it in the page's Discuss tab.");
  await expect(chat.locator(".thread-group-label")).toHaveText("Wiki");
  await expect(chat.locator(`.thread-item.wiki[data-id="${thread!.id}"]`)).toHaveClass(/active/);
  await expect(chat.locator("#connectorSelector")).toBeHidden();
  // The inspector shows no personal context on it (D7): its page instead.
  const insContext = chat.locator("#inspectorContext");
  await expect(insContext).toContainText("no personal context");
  await expect(insContext).toContainText(REL);
  await expect(insContext).not.toContainText("Memories");
  await expect(chat.locator("#skipExtractionsCheckbox")).toHaveCount(0);
  // A chat thread shows the selector and the personal sections: the hiding is the wiki thread's kind.
  await chat.locator(".thread-item:not(.wiki)").first().click();
  await expect(chat.locator("#connectorSelector")).toBeVisible();
  await expect(insContext).toContainText("Memories");
  await expect(chat.locator("#skipExtractionsCheckbox")).toHaveCount(1);
  await chat.locator(`.thread-item.wiki[data-id="${thread!.id}"]`).click();
  await expect(chat.locator("#connectorSelector")).toBeHidden();
  await expect(insContext).not.toContainText("Memories");
  await expect(insContext).toContainText("no personal context");
  await expect(msgs).toContainText(Q2);
  await shot(chat, "4-chat-popped-out-wiki-thread");

  // 5. A turn sent from /chat; a second send while it runs is refused, keeps its text and shows why.
  const botBefore = await chat.locator("#chatMessages .msg-bot").count();
  const sent = chat.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/messages"));
  await chat.locator("#chatInput").fill(Q4);
  await chat.locator("#chatSend").click();
  expect((await sent).status()).toBe(202);
  const refused = chat.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/messages"));
  await chat.locator("#chatInput").fill(Q5);
  await chat.locator("#chatSend").click();
  expect((await refused).status()).toBe(409);
  await expect(chat.locator("#chatTransientError")).toContainText("still running");
  await expect(chat.locator("#chatInput")).toHaveValue(Q5);
  await shot(chat, "5-chat-refused-send-kept-text");
  await expect.poll(async () => chat.locator("#chatMessages .msg-bot").count(), { timeout: 90_000 }).toBeGreaterThan(botBefore);
  await expect
    .poll(async () => (await sql!`SELECT count(*)::int AS n FROM wiki_discuss_turns WHERE thread_id = ${thread!.id} AND end_state = 'done'`)[0]!.n, { timeout: 90_000 })
    .toBe(4);
  await chat.close();

  // The /chat turn shows in the pane after a reload, on the same thread.
  await openPane(page);
  await expect(turn(page, 4).locator(".wiki-discuss-q")).toHaveText(Q4, { timeout: 20_000 });
  await expect(turn(page, 1).locator(".wiki-discuss-q")).toHaveText(Q1);
  expect(await page.locator("#discussBody .wiki-discuss-turn").count()).toBe(4);

  // 6. Start over: the thread moves under «Earlier discussions», beside the old one-shot turn.
  await page.locator("#wikiDiscussStartOver").click();
  await expect(page.locator("#discussBody .wiki-discuss-turn")).toHaveCount(0);
  await expect(page.locator(".wiki-discuss-earlier > summary")).toHaveText("Earlier discussions (2)");
  await page.locator(".wiki-discuss-earlier > summary").click();
  const closedGroup = page.locator(`[data-earlier-thread="${thread!.id}"]`);
  await expect(closedGroup).toContainText(Q1);
  await expect(closedGroup).toContainText(Q4);
  await expect(page.locator("[data-earlier-oneshot]")).toContainText(OLD_Q);
  await expect(page.locator("[data-earlier-oneshot]")).toContainText("It was, in October.");
  // Its raw edit block reads as the server reads it: the note, no JSON.
  await expect(page.locator("[data-earlier-oneshot]")).toContainText("This answer proposed an edit; an earlier discussion cannot apply it.");
  await expect(page.locator("[data-earlier-oneshot]")).not.toContainText("adds two stops");
  // Turn 3 proposed an edit: the closed thread says so, without pointing to an Apply it has not got.
  await expect(closedGroup).toContainText("This answer proposed an edit; an earlier discussion cannot apply it.");
  await expect(closedGroup).not.toContainText("preview and apply");
  await shot(page, "3-earlier-discussions-open");
  // The closed thread is gone from /chat's list.
  const list = (await (await fetch(`${BASE}/chat/threads/${USER}/${BOT}`)).json()) as { threads: { id: string }[] };
  expect(list.threads.map((t) => t.id)).not.toContain(thread!.id);
  // The pop-out link opened again after Start over: /chat still knows it is a wiki thread
  // (looked up by id), shows it read-only, and stamps nothing on it.
  const reopened = await context.newPage();
  const patches: string[] = [];
  reopened.on("request", (r) => {
    if (r.method() === "PATCH") patches.push(r.url());
  });
  await reopened.goto(new URL(href!, BASE).toString());
  await expect(reopened.locator("#chatMessages")).toContainText(Q4, { timeout: 20_000 });
  await expect(reopened.locator("#chatHeader .chat-title")).toContainText("(closed)");
  // Turn 3's edit: no pointer to an Apply the closed thread has not got.
  await expect(reopened.locator("#chatMessages")).toContainText("This answer proposed an edit; an earlier discussion cannot apply it.");
  await expect(reopened.locator("#chatMessages")).not.toContainText("preview and apply");
  await expect(reopened.locator("#chatInput")).toBeDisabled();
  await expect(reopened.locator("#connectorSelector")).toBeHidden();
  await expect(reopened.locator("#inspectorContext")).toContainText("no personal context");
  await expect(reopened.locator("#inspectorContext")).not.toContainText("Memories");
  await expect(reopened.locator(`.thread-item[data-id="${thread!.id}"]`)).toHaveCount(0);
  await shot(reopened, "6-chat-closed-wiki-thread-read-only");
  expect(patches).toEqual([]);
  await reopened.close();
  // Delete it: its turns go with it; the one-shot turn stays.
  page.once("dialog", (d) => void d.accept());
  await closedGroup.locator("[data-discuss-delete-thread]").click();
  await expect(closedGroup).toHaveCount(0);
  await expect(page.locator(".wiki-discuss-earlier > summary")).toHaveText("Earlier discussions (1)");
  expect((await sql!`SELECT count(*)::int AS n FROM wiki_discuss_turns WHERE thread_id = ${thread!.id}`)[0]!.n).toBe(0);
  // A new ask starts a new thread.
  await page.locator('[data-discuss-mode="explore"]').click();
  await ask(page, "A fresh start?", 1);
  const [fresh] = await sql!`SELECT id FROM threads WHERE kind = 'wiki' AND wiki = ${WIKI} AND user_id = ${USER} AND closed_at IS NULL`;
  expect(fresh!.id).not.toBe(thread!.id);
});

test("«as <name> ▾» switches the pane to another /chat user's own thread of the page; tool calls read as a /chat tool group with the model line", async ({ page }) => {
  test.setTimeout(180_000);
  // Runs after the first test, on the fresh thread it ends with.
  await openPane(page);
  // The thread read names the user the route resolved (the bot's default here).
  const as = page.locator("#discussBody [data-discuss-as]");
  await expect(as).toHaveText("as E2E Thread ▾");
  await expect(turn(page, 1).locator(".wiki-discuss-q")).toHaveText("A fresh start?");

  // The tool group: «Used 1 tool», closed once the turn ended; opened, a human line, no JSON.
  const tools = turn(page, 1).locator(".wiki-discuss-tools");
  await expect(tools.locator(".wiki-discuss-tools-head")).toHaveText(/^Used 1 tool/);
  await expect(tools.locator(".wiki-discuss-tool")).toHaveCount(0);
  await tools.locator(".wiki-discuss-tools-head").click();
  await expect(tools.locator(".wiki-discuss-tool")).toHaveText('Searching files: "night route"');
  await expect(tools.locator(".wiki-discuss-tool-detail")).toHaveText('"night route"');
  // The model line: the model the API reported (the fake answers as `claude-fake`,
  // not the bot's configured claude-sonnet-4-5) · connector · duration.
  await expect(turn(page, 1).locator(".wiki-discuss-model")).toHaveText(/^claude-fake · claude-sdk · \d+\.\d s$/);
  await shot(page, "7-tool-group-and-model-line");

  // Switch to the other user: their thread (none yet), kept for the bot, the read carrying their id.
  await as.click();
  const select = page.locator("#discussBody .wiki-discuss-user-select");
  await expect(select).toHaveValue(USER);
  const reread = page.waitForRequest((r) => r.url().includes("/api/wiki/discuss/thread?") && new URL(r.url()).searchParams.get("userId") === USER2);
  await select.selectOption(USER2);
  await page.locator("#discussBody [data-discuss-pick-user]").click();
  await reread;
  await expect(as).toHaveText("as E2E Other ▾");
  await expect(page.locator("#discussBody .wiki-discuss-turn")).toHaveCount(0);
  await expect(select).toHaveCount(0);
  await shot(page, "8-switched-user");

  // A turn now lands on the other user's own thread; the first user's thread is untouched.
  await page.locator('[data-discuss-mode="explore"]').click();
  await ask(page, "Asked as the other user?", 1);
  const live = await sql!`SELECT user_id FROM threads WHERE kind = 'wiki' AND wiki = ${WIKI} AND closed_at IS NULL ORDER BY user_id`;
  expect(live.map((r) => r.user_id)).toEqual([USER, USER2]);

  // A reload keeps the choice; switching back shows the first user's turn again.
  await openPane(page);
  await expect(as).toHaveText("as E2E Other ▾");
  await expect(turn(page, 1).locator(".wiki-discuss-q")).toHaveText("Asked as the other user?");
  await as.click();
  await select.selectOption(USER);
  await page.locator("#discussBody [data-discuss-pick-user]").click();
  await expect(as).toHaveText("as E2E Thread ▾");
  await expect(turn(page, 1).locator(".wiki-discuss-q")).toHaveText("A fresh start?");
});

test("a send the browser holds back past 5 s says it is still waiting on the turn, and the line clears when the response arrives", async ({ page }) => {
  test.setTimeout(120_000);
  // Runs after the tests above, on the first user's thread they leave.
  await openPane(page);
  // Hold the POST as a browser does when every connection to the host is taken.
  await page.route("**/api/wiki/discuss", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise((r) => setTimeout(r, 7_000));
    await route.continue();
  });
  const q = "Held back by the browser?";
  await page.locator("#wikiDiscussInput").fill(q);
  await page.locator("#wikiDiscussAskBtn").click();
  const sending = page.locator('#discussBody .wiki-discuss-turn[data-turn-state="sending"]');
  await expect(sending.locator(".wiki-discuss-status")).toHaveText("Starting the turn…");
  await expect(sending.locator("[data-discuss-waiting]")).toHaveCount(0);
  await expect(sending.locator("[data-discuss-waiting]")).toHaveText(
    "Still waiting for the server to take this turn. If several muninn tabs are open, the browser may be holding it back: closing one sends it.",
    { timeout: 6_500 },
  );
  await shot(page, "9-waiting-line");
  await expect(page.locator("#discussBody [data-discuss-waiting]")).toHaveCount(0, { timeout: 15_000 });
  const asked = page.locator("#discussBody .wiki-discuss-turn").filter({ has: page.locator(".wiki-discuss-q", { hasText: q }) });
  await expect(asked).toHaveAttribute("data-turn-state", "done", { timeout: 90_000 });
});

/** A real mouse drag over the first copy of `text` in the article. */
async function dragSelect(page: Page, text: string): Promise<void> {
  await page.evaluate(() => getSelection()!.removeAllRanges());
  const at = await page.evaluate((text) => {
    const article = document.querySelector("#articleWrap .wiki-article")!;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      const i = t.data.indexOf(text);
      if (i === -1) continue;
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + text.length);
      const rect = r.getBoundingClientRect();
      return { x0: rect.left + 1, x1: rect.right - 1, y: rect.top + rect.height / 2 };
    }
    throw new Error(`no text ${text}`);
  }, text);
  await page.mouse.move(at.x0, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x1, at.y, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(text);
}

test("/chat on a seeded Explain thread: the page bar and the chip, Continue, Start over leaves it read-only under Earlier discussions, and the page's next Explain opens a new thread /chat lists", async ({ page, context }) => {
  test.setTimeout(180_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  expect(EXPLAIN_Q).toBe(EXPLAIN_QUESTION);
  // The seeded thread: one Explain turn and its two messages, as the engine stores them.
  const [seeded] = await sql!`
    INSERT INTO threads (user_id, bot_name, name, is_active, kind, wiki, rel_path)
    VALUES (${USER}, ${BOT}, 'wiki: harbour plan', false, 'wiki', ${WIKI}, ${REL2}) RETURNING id`;
  const threadId = seeded!.id as string;
  const [um] = await sql!`
    INSERT INTO messages (user_id, bot_name, role, content, source, platform, thread_id, created_at)
    VALUES (${USER}, ${BOT}, 'user', ${`> ${PASSAGE2}\n\n${EXPLAIN_QUESTION}`}, 'wiki', 'web', ${threadId}, now() - interval '2 minutes') RETURNING id`;
  const [am] = await sql!`
    INSERT INTO messages (user_id, bot_name, role, content, source, platform, thread_id, created_at)
    VALUES (${USER}, ${BOT}, 'assistant', 'SEEDED-ANSWER: the quay opens at dawn since the ferry moved.', 'wiki', 'web', ${threadId}, now() - interval '1 minute') RETURNING id`;
  const pageHash = createHash("sha256").update(PAGE2).digest("hex");
  const [seededTurn] = await sql!`
    INSERT INTO wiki_discuss_turns (discussion_id, seq, wiki, rel_path, page_hash, thread_id, user_message_id, assistant_message_id, selection, question, answer, end_state, bot_name, connector, finished_at, sent_from)
    VALUES (${threadId}, 1, ${WIKI}, ${REL2}, ${pageHash}, ${threadId}, ${um!.id}, ${am!.id}, ${PASSAGE2}, ${EXPLAIN_QUESTION}, 'SEEDED-ANSWER: the quay opens at dawn since the ferry moved.', 'done', ${BOT}, 'claude-sdk', now(), 'card')
    RETURNING id`;
  const turnId = seededTurn!.id as string;

  // The message read /chat makes: the turn on the user message, the page with its title.
  const read = page.waitForResponse((r) => r.url().includes("/messages?thread=" + threadId));
  await page.goto(`${BASE}/chat?bot=${BOT}&thread=${threadId}&user=${USER}`);
  const readRes = await read;
  const readBody = (await readRes.json()) as { messages: { sender: string; turn?: unknown }[]; wikiPage: unknown };
  // A chat thread's read on the same conversation: as before, no page and no turns.
  const [main] = await sql!`SELECT id FROM threads WHERE user_id = ${USER} AND bot_name = ${BOT} AND name = 'main'`;
  await sql!`INSERT INTO messages (user_id, bot_name, role, content, platform, thread_id) VALUES (${USER}, ${BOT}, 'user', 'A chat line.', 'web', ${main!.id})`;
  const chatRead = (await (await fetch(readRes.url().replace(/\?thread=.*$/, `?thread=${main!.id}`))).json()) as Record<string, unknown>;
  expect(Object.keys(chatRead)).toEqual(["messages"]);
  expect((chatRead.messages as { text: string }[]).map((m) => m.text)).toEqual(["A chat line."]);
  expect((chatRead.messages as Record<string, unknown>[]).every((m) => !("turn" in m))).toBe(true);
  if (process.env.E2E_P4_JSON) await writeFile(process.env.E2E_P4_JSON, JSON.stringify({ wikiRead: readBody, chatRead }, null, 2));
  expect(readBody.wikiPage).toEqual({ wiki: WIKI, relPath: REL2, traceKey: null, title: "Harbour plan" });
  expect(readBody.messages.find((m) => m.sender === "user")?.turn).toEqual({ id: turnId, question: EXPLAIN_QUESTION, passage: PASSAGE2 });

  const bar = page.locator("#chatWikiBar");
  await expect(bar.locator("[data-wiki-page-title]")).toHaveText("Harbour plan");
  await expect(bar.locator(".chat-wiki-name")).toHaveText(WIKI);
  await expect(bar.locator("[data-wiki-back]")).toHaveText("↩ Back to the page");
  await expect(bar.locator("[data-wiki-back]")).toHaveAttribute("href", `/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL2)}`);
  const chip = page.locator("#chatMessages .msg-user .chat-explain-chip");
  await expect(chip).toHaveText(`✨ Explain · «${PASSAGE2}»`);
  await expect(chip).toHaveAttribute("href", `/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL2)}&turn=${turnId}`);
  await expect(page.locator("#chatMessages .msg-user")).not.toContainText(EXPLAIN_QUESTION);
  // «⌘ Continue in Claude Code» under the last answer, on the seeded turn.
  const cont = page.locator("#chatMessages .chat-wiki-continue");
  await expect(cont.locator("xpath=preceding-sibling::*[1]")).toHaveClass(/msg-bot/);
  const contRes = page.waitForResponse((r) => r.url().endsWith("/api/wiki/discuss/continue"));
  await cont.locator("[data-chat-continue]").click();
  const contBody = (await (await contRes).json()) as { prompt?: string };
  expect(contBody.prompt).toContain(PASSAGE2);
  await expect(cont.locator("[data-chat-continue-status]")).toContainText(/Copied|copy it by hand/);
  await shot(page, "p4-1-chat-wiki-bar-chip");

  // Start over: closed through the tab's route; read-only here, listed under Earlier discussions.
  const closeRes = page.waitForResponse((r) => r.url().endsWith("/api/wiki/discuss/thread/close"));
  await bar.locator("[data-wiki-start-over]").click();
  expect((await closeRes).status()).toBe(200);
  await expect(page.locator("#chatHeader .chat-title")).toContainText("(closed)");
  await expect(page.locator("#chatInput")).toBeDisabled();
  await expect(page.locator("#chatInput")).toHaveAttribute("placeholder", "Closed with Start over: the page's next question starts a new discussion.");
  await expect(bar.locator("[data-wiki-closed]")).toHaveText("Closed with Start over: the page's next question starts a new discussion.");
  await expect(bar.locator("[data-wiki-start-over]")).toHaveCount(0);
  await expect(bar.locator("[data-wiki-back]")).toBeVisible();
  await expect(bar.locator("[data-wiki-earlier-list] > summary")).toHaveText("Earlier discussions (1)");
  await bar.locator("[data-wiki-earlier-list] > summary").click();
  await expect(bar.locator(`[data-wiki-earlier="${threadId}"]`)).toBeVisible();
  await expect(chip).toBeVisible();
  await expect(page.locator(`.thread-item[data-id="${threadId}"]`)).toHaveCount(0);
  expect((await sql!`SELECT closed_at FROM threads WHERE id = ${threadId}`)[0]!.closed_at).not.toBeNull();
  await shot(page, "p4-2-chat-closed-earlier");

  // The page's next Explain opens the new thread (D14), which /chat lists.
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL2)}`);
  await expect(page.locator("#articleWrap .wiki-article")).toContainText(PASSAGE2);
  await dragSelect(page, "quay");
  await page.locator("#wikiSelBar #wikiExplainBtn").click();
  const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="explain"][data-sel-turn]');
  await expect(card.locator(".wiki-discuss-answer").first()).toContainText("The night route is named on this page only.", { timeout: 90_000 });
  const [fresh] = await sql!`SELECT id FROM threads WHERE kind = 'wiki' AND wiki = ${WIKI} AND rel_path = ${REL2} AND user_id = ${USER} AND closed_at IS NULL`;
  expect(fresh!.id).not.toBe(threadId);
  await page.goto(`${BASE}/chat?bot=${BOT}&user=${USER}`);
  const item = page.locator(`.thread-item.wiki[data-id="${fresh!.id}"]`);
  await expect(item).toBeVisible({ timeout: 20_000 });
  await item.click();
  // The engine's own Explain turn reads as the chip too, and the closed thread is its page's earlier one.
  await expect(page.locator("#chatMessages .msg-user .chat-explain-chip")).toHaveText("✨ Explain · «quay»");
  await expect(page.locator("#chatWikiBar [data-wiki-start-over]")).toBeVisible();
  await expect(page.locator("#chatWikiBar [data-wiki-earlier-list] > summary")).toHaveText("Earlier discussions (1)");
  await shot(page, "p4-3-chat-new-thread");
});
