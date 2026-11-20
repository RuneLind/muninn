/**
 * Discuss P4 in the /wiki reader (mimir plan muninn-wiki-discuss): the wiki
 * agent's proposed edit as a diff card in the Discuss tab, and Apply.
 *
 * What the unit tests cannot reach: the chain from a turn that ends with an
 * edit, through the tab's preview request by turn id, the card and its mark on
 * the article block, to Apply's write on disk, its `log.md` entry, its commit
 * and the page rendered again; and the card's refusals as a reader sees them.
 *
 * The turn itself is not run: its row is inserted into the test database with
 * a hand-written `proposed_edit`, and the tab's `POST /api/wiki/discuss` is
 * answered in the page with that row's id (a `turn` and a `done` event), so no
 * bot and no model are needed. The preview and Apply are the real routes.
 *
 * Its own muninn with `e2eEnv()`, on a wiki written here in a temp dir: a git
 * work tree with no remote, through `WIKI_EXTRA`. A wiki no bot owns pushes on
 * Apply by default, so every test first asserts that `git remote` prints
 * nothing.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-discuss-apply");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-discuss-apply";
const REL = "plans/ferry.mdx";
const OLD = "with the date on the Brief's Status line.";
const NEW = "with the Brief's Status line, not with any date in the frontmatter.";
const PAGE = [
  "---",
  "title: Ferry plan",
  "---",
  "",
  "# Ferry plan",
  "",
  "## Brief",
  "",
  "- **R2, behind.** The check compares the frontmatter `status_date` " + OLD,
  "- The night route is unchanged.",
  "",
  'The check reads <Fact v="ok" n="1">the frontmatter status date</Fact> and nothing else.',
  "",
  '<Fold title="The berths">',
  "",
  "The north pier takes the morning ferry.",
  "",
  "</Fold>",
  "",
].join("\n");

let server: ChildProcess | undefined;
let root = "";
let scratch = "";
let sql: ReturnType<typeof postgres> | null = null;

const GIT_IDENT = { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" };
const GIT_ENV = { ...process.env, ...GIT_IDENT };
function git(...args: string[]): string {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const pageText = () => readFile(path.join(root, REL), "utf8");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The page as written here, committed; the wiki has no remote. */
async function resetPage(text = PAGE): Promise<void> {
  await writeFile(path.join(root, REL), text, "utf8");
  git("add", "-A");
  if (git("status", "--porcelain").trim()) git("commit", "-q", "-m", "fixture");
  expect(git("remote").trim()).toBe("");
}

const edit = (old: string, neu: string) => ({ edits: [{ claimIndex: 0, verdict: "", old, new: neu, reason: "R2 reads the Status line." }], dropped: [], overLimit: false });

/** A finished turn row carrying `proposedEdit`; its id. */
async function insertTurn(proposedEdit: unknown): Promise<string> {
  const [row] = await sql!`
    INSERT INTO wiki_discuss_turns (discussion_id, seq, wiki, rel_path, page_hash, question, answer, end_state, bot_name, connector, proposed_edit, finished_at)
    VALUES (${randomUUID()}, 1, ${WIKI}, ${REL}, ${sha256(await pageText())}, 'Is R2 right?', 'It reads the Status line.', 'done', 'e2e', 'claude-sdk', ${sql!.json(proposedEdit as never)}, now())
    RETURNING id`;
  return row!.id as string;
}

/** Answer the tab's next discuss request in the page: the row's id, then `done` with its edit. */
async function stubTurn(page: Page, turnId: string, proposedEdit: unknown): Promise<void> {
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const discussionId = randomUUID();
  const body =
    frame("turn", { turnId, discussionId, seq: 1, location: null }) +
    frame("done", { turnId, discussionId, endState: "done", answer: "R2 reads the Status line, not the frontmatter.", proposedEdit, toolCalls: [] }) +
    frame("end", {});
  await page.route("**/api/wiki/discuss", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body }), { times: 1 });
}

/** Open the page, the Discuss tab, and ask: the stubbed turn ends with its edit. */
async function askWithEdit(page: Page, proposedEdit: unknown): Promise<void> {
  const turnId = await insertTurn(proposedEdit);
  await stubTurn(page, turnId, proposedEdit);
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("The night route is unchanged.");
  await page.locator('[data-conntab="discuss"]').click();
  await page.locator("#wikiDiscussInput").fill("Is R2 right?");
  await page.locator("#wikiDiscussAskBtn").click();
  await expect(page.locator('.wiki-discuss-turn[data-turn-seq="1"]')).toHaveAttribute("data-turn-state", "done");
}

test.beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "muninn-e2e-discuss-apply-"));
  root = path.join(scratch, "wiki");
  await mkdir(path.join(root, "plans"), { recursive: true });
  // A throwaway bot: muninn boots only with one. Its connector is never called (the turn is stubbed).
  await mkdir(path.join(scratch, "bots", "applybot"), { recursive: true });
  await writeFile(path.join(scratch, "bots", "applybot", "CLAUDE.md"), "# e2e apply bot\n\nCreated by e2e/wiki-discuss-apply.spec.ts.\n");
  await writeFile(path.join(scratch, "bots", "applybot", "config.json"), JSON.stringify({ connector: "claude-sdk" }));
  await writeFile(path.join(root, ".wiki-agent.md"), "# Rules\n\nPropose at most one edit.\n", "utf8");
  const init = spawnSync("git", ["init", "-q", "-b", "main", root], { encoding: "utf8", env: GIT_ENV });
  if (init.status !== 0) throw new Error(`git init: ${init.stderr}`);
  git("config", "user.name", "e2e");
  git("config", "user.email", "e2e@example.invalid");
  await resetPage();

  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
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
      PLAN_CARD_BIN: "",
      DECISION_TRIAGE_REPO_ROOTS: "",
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
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  }
  await sql?.end({ timeout: 2 });
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await resetPage();
});

test("the card shows the diff and marks the bullet; Apply writes the range only, one log entry, one commit, and the page renders again", async ({ page }) => {
  expect(git("remote").trim()).toBe("");
  const commitsBefore = Number(git("rev-list", "--count", "HEAD").trim());
  await askWithEdit(page, edit(OLD, NEW));
  const card = page.locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(card).toBeVisible();
  await expect(card.locator("del")).toHaveText(OLD);
  await expect(card.locator("ins")).toHaveText(NEW);
  await expect(card.locator(".wiki-discuss-edit-head")).toHaveText("Proposed edit · line 9");
  const mark = page.locator("#articleWrap .wiki-article .wiki-discuss-edit-mark");
  await expect(mark).toHaveCount(1);
  await expect(mark).toContainText("R2, behind.");

  await card.locator("[data-discuss-apply]").click();
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="applied"]')).toContainText("Applied to the page, with a log.md entry and a commit.");
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("not with any date in the frontmatter.");
  await expect(mark).toHaveCount(0);

  const text = await pageText();
  expect(text).toBe(PAGE.replace(OLD, NEW));
  expect(text.match(/<\/?Fact\b[^>]*>/g)).toEqual(PAGE.match(/<\/?Fact\b[^>]*>/g));
  expect(Number(git("rev-list", "--count", "HEAD").trim())).toBe(commitsBefore + 1);
  expect(git("log", "-1", "--format=%s").trim()).toBe(`[discuss] Apply the wiki agent's edit (turn 1): ${REL}`);
  expect(git("status", "--porcelain").trim()).toBe("");
  const log = await readFile(path.join(root, "log.md"), "utf8");
  expect(log.match(/^## \[.*\] update \| Ferry plan$/gm)?.length).toBe(1);
  expect(git("remote").trim()).toBe("");
});

test("«Change the wording» fills the follow-up box; Discard drops the card and the mark; nothing is written", async ({ page }) => {
  expect(git("remote").trim()).toBe("");
  await askWithEdit(page, edit("The north pier takes the morning ferry.", "The south pier takes the morning ferry."));
  const card = page.locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(card).toBeVisible();
  await expect(page.locator("#articleWrap .wiki-article .wiki-discuss-edit-mark")).toContainText("The north pier");
  await card.locator("[data-discuss-reword]").click();
  await expect(page.locator("#wikiDiscussInput")).toHaveValue("Propose another wording for that edit, for the same passage: ");
  await expect(page.locator("#wikiDiscussInput")).toBeFocused();
  await card.locator("[data-discuss-discard]").click();
  await expect(page.locator('[data-edit-state="discarded"]')).toHaveText("The proposed edit was discarded.");
  await expect(page.locator(".wiki-discuss-edit-mark")).toHaveCount(0);
  expect(await pageText()).toBe(PAGE);
});

test("an edit inside a fact wrapper is refused on the card, with no Apply", async ({ page }) => {
  expect(git("remote").trim()).toBe("");
  await askWithEdit(page, edit("the frontmatter status date", "the status_date field"));
  const card = page.locator('.wiki-discuss-edit[data-edit-state="refused"]');
  await expect(card).toContainText("This edit cannot be applied: the edit's range is inside a fact wrapper");
  await expect(card.locator("[data-discuss-apply]")).toHaveCount(0);
  expect(await pageText()).toBe(PAGE);
});

test("a page changed and committed after the preview: Apply is refused on the card and the other edit stays", async ({ page }) => {
  expect(git("remote").trim()).toBe("");
  await askWithEdit(page, edit(OLD, NEW));
  const card = page.locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(card).toBeVisible();
  const edited = PAGE.replace("The north pier", "The south pier");
  await resetPage(edited);
  await card.locator("[data-discuss-apply]").click();
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="refused"]')).toContainText("The page changed since the edit was shown.");
  expect(await pageText()).toBe(edited);
});
