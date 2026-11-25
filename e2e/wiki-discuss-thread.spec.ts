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
 * under «Earlier discussions» beside an old one-shot turn, and Delete.
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
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-discuss-thread");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-discuss-thread";
const REL = "plans/ferry.mdx";
const BOT = "threadbot";
const USER = "e2e-thread-user";
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
  await sql`DELETE FROM threads WHERE user_id = ${USER}`;
  await sql`DELETE FROM wiki_discuss_turns WHERE wiki = ${WIKI}`;
  await sql`INSERT INTO users (id, username, platform) VALUES (${USER}, 'E2E Thread', 'web') ON CONFLICT (id) DO NOTHING`;
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
    await sql`DELETE FROM threads WHERE user_id = ${USER}`.catch(() => {});
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
  await expect(turn(page, 1).locator(".wiki-discuss-tool").first()).toContainText("Grep");
  await ask(page, Q2, 2);
  await expect(turn(page, 2).locator(".wiki-discuss-tool").first()).toContainText("Grep");
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
  const [fresh] = await sql!`SELECT id FROM threads WHERE kind = 'wiki' AND wiki = ${WIKI} AND closed_at IS NULL`;
  expect(fresh!.id).not.toBe(thread!.id);
});
