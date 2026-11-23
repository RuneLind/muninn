/**
 * Discuss P4 in the /wiki reader (mimir plan muninn-wiki-discuss): the wiki
 * agent's proposed edit as a diff card in the Discuss tab, and Apply.
 *
 * What the unit tests cannot reach: the chain from a turn that ends with an
 * edit, through the tab's preview request by turn id, the card and its mark on
 * the replaced text (a CSS highlight; no element is added to the article), to
 * Apply's write on disk, its `log.md` entry, its commit
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
  "## Crossings",
  "",
  "A plain paragraph says the ferry leaves at nine every day.",
  "",
  "- Intro: the Status line is checked.",
  "",
  "The rules follow.",
  "",
  "- R1: the berth list is current.",
  "- R2: the **Status** line is checked.",
  "",
  'The "Brief" section names the owner of the night route.',
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

const OTHER_REL = "notes/other.md";
const pageText = () => readFile(path.join(root, REL), "utf8");

/**
 * The edit mark as the page shows it: the text of each range in the
 * `wiki-discuss-edit-mark` CSS highlight, or (where no highlight is set) of
 * each element carrying that class; the list item the first one starts in;
 * and how many `<mark>` or classed elements the article holds.
 */
function editMark(page: Page) {
  return page.evaluate(() => {
    const article = document.querySelector("#articleWrap .wiki-article")!;
    const hl = (globalThis as unknown as { CSS: { highlights?: Map<string, Set<Range>> } }).CSS.highlights?.get("wiki-discuss-edit-mark");
    const ranges = hl ? [...hl] : [];
    const els = Array.from(article.querySelectorAll(".wiki-discuss-edit-mark"));
    const texts = ranges.length ? ranges.map((r) => r.toString()) : els.map((e) => e.textContent ?? "");
    const start = ranges.length ? ranges[0]!.startContainer.parentElement : (els[0] ?? null);
    return {
      texts,
      inArticle: ranges.every((r) => article.contains(r.startContainer)),
      li: start?.closest("li")?.textContent ?? null,
      elements: article.querySelectorAll("mark, .wiki-discuss-edit-mark").length,
    };
  });
}
const markTexts = async (page: Page) => (await editMark(page)).texts;
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
  await mkdir(path.join(root, "notes"), { recursive: true });
  await writeFile(path.join(root, OTHER_REL), "---\ntitle: Other\n---\n\n# Other\n\nNothing here.\n", "utf8");
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
  // The mark is on the replaced words, not on the whole bullet.
  await expect.poll(() => markTexts(page)).toEqual([OLD]);

  await card.locator("[data-discuss-apply]").click();
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("not with any date in the frontmatter.");
  // After the page renders again the reader is still on Discuss, looking at the applied card.
  await expect(page.locator('[data-conntab="discuss"]')).toHaveClass(/active/);
  const applied = page.locator('.wiki-discuss-edit[data-edit-state="applied"]');
  await expect(applied).toBeVisible();
  await expect(applied).toContainText("Applied to the page, with a log.md entry and a commit.");
  await expect(applied.locator(".wiki-discuss-edit-done")).toBeFocused();
  await expect.poll(() => markTexts(page)).toEqual([]);

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

test("«Change the wording» fills the follow-up box; the mark opens its Fold; Discard drops the card and the mark; nothing is written", async ({ page }) => {
  expect(git("remote").trim()).toBe("");
  await askWithEdit(page, edit("The north pier takes the morning ferry.", "The south pier takes the morning ferry."));
  const card = page.locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(card).toBeVisible();
  await expect.poll(() => markTexts(page)).toEqual(["The north pier takes the morning ferry."]);
  // The edit is inside a closed Fold: the mark opens it, so the reader sees it.
  await expect(page.locator("#articleWrap .wiki-article details.fold")).toHaveAttribute("open", "");
  await card.locator("[data-discuss-reword]").click();
  await expect(page.locator("#wikiDiscussInput")).toHaveValue("Propose another wording for that edit, for the same passage: ");
  await expect(page.locator("#wikiDiscussInput")).toBeFocused();
  await card.locator("[data-discuss-discard]").click();
  await expect(page.locator('[data-edit-state="discarded"]')).toHaveText("The proposed edit was discarded.");
  await expect.poll(() => markTexts(page)).toEqual([]);
  expect(await pageText()).toBe(PAGE);
});

test("«Change the wording» keeps a half-typed follow-up behind the prompt", async ({ page }) => {
  expect(git("remote").trim()).toBe("");
  await askWithEdit(page, edit(OLD, NEW));
  const card = page.locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(card).toBeVisible();
  await page.locator("#wikiDiscussInput").fill("and keep it short");
  await card.locator("[data-discuss-reword]").click();
  await expect(page.locator("#wikiDiscussInput")).toHaveValue("Propose another wording for that edit, for the same passage: and keep it short");
  await expect(page.locator("#wikiDiscussInput")).toBeFocused();
  expect(await pageText()).toBe(PAGE);
});

test("a plain paragraph (no block element around it) is marked, exactly its text; moving to another page takes the mark off", async ({ page }) => {
  expect(git("remote").trim()).toBe("");
  const para = "A plain paragraph says the ferry leaves at nine every day.";
  await askWithEdit(page, edit(para, "A plain paragraph says the ferry leaves at ten every day."));
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="ready"]')).toBeVisible();
  await expect.poll(() => markTexts(page)).toEqual([para]);
  await page.locator(`#wikiList [data-relpath="${OTHER_REL}"]`).first().click();
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("Nothing here.");
  await expect.poll(() => markTexts(page)).toEqual([]);
  expect(await pageText()).toBe(PAGE);
});

test("a paragraph holding a quoted section title: back on the page, the mark covers the paragraph again (fix round 2 batch 5)", async ({ page }) => {
  expect(git("remote").trim()).toBe("");
  const para = 'The "Brief" section names the owner of the night route.';
  await askWithEdit(page, edit(para, 'The "Brief" section names the night route\'s owner.'));
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="ready"]')).toBeVisible();
  // The ref links turn «"Brief"» into a link: the text node the mark sat in is replaced.
  await expect(page.locator("#articleWrap .wiki-article a").filter({ hasText: "Brief" })).toHaveCount(1);
  await expect.poll(() => markTexts(page)).toEqual([para]);
  await page.locator(`#wikiList [data-relpath="${OTHER_REL}"]`).first().click();
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("Nothing here.");
  await expect.poll(() => markTexts(page)).toEqual([]);
  await page.locator(`#wikiList [data-relpath="${REL}"]`).first().click();
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("names the owner of the night route.");
  await expect.poll(() => markTexts(page)).toEqual([para]);
  expect(await pageText()).toBe(PAGE);
});

test("the mark is searched once per preview and article; a range broken later is found again, and a Fold the reader closed stays closed (fix round 2 batch 5)", async ({ page }) => {
  expect(git("remote").trim()).toBe("");
  const para = "The north pier takes the morning ferry.";
  await askWithEdit(page, edit(para, "The south pier takes the morning ferry."));
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="ready"]')).toBeVisible();
  await expect.poll(() => markTexts(page)).toEqual([para]);
  const fold = page.locator("#articleWrap .wiki-article details.fold");
  await expect(fold).toHaveAttribute("open", "");
  /** The highlight's first range is the one kept in the page as `__mark`. */
  const sameRange = () =>
    page.evaluate(() => {
      const w = window as unknown as { __mark?: Range; CSS: { highlights: Map<string, Set<Range>> } };
      const now = [...(w.CSS.highlights.get("wiki-discuss-edit-mark") ?? [])][0];
      if (!w.__mark) w.__mark = now;
      return now === w.__mark;
    });
  expect(await sameRange()).toBe(true);
  // The reader closes the Fold; a paint follows (the breadcrumb's 💬 Discuss).
  await fold.locator("summary").first().click();
  await expect(fold).not.toHaveAttribute("open", "");
  await page.locator("#wikiDiscussBtn").click();
  await expect(fold).not.toHaveAttribute("open", "");
  // Not searched again: the highlight holds the same range object.
  expect(await sameRange()).toBe(true);
  // A later enhancement replaces the text node the mark sits in; the next paint finds it again, the Fold left closed.
  await page.evaluate(() => {
    const n = (window as unknown as { __mark: Range }).__mark.startContainer as Text;
    n.replaceWith(document.createTextNode(n.data));
  });
  await page.locator("#wikiDiscussBtn").click();
  await expect.poll(() => markTexts(page)).toEqual([para]);
  await expect(fold).not.toHaveAttribute("open", "");
});

test("a heading edit marks the heading's text", async ({ page }) => {
  expect(git("remote").trim()).toBe("");
  await askWithEdit(page, edit("## Crossings", "## Ferry crossings"));
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="ready"]')).toBeVisible();
  await expect.poll(() => markTexts(page)).toEqual(["Crossings"]);
});

test("the mark adds no element and leaves the article's text nodes as rendered (P3's passage anchors hold them)", async ({ page }) => {
  expect(git("remote").trim()).toBe("");
  const proposedEdit = edit(OLD, NEW);
  const turnId = await insertTurn(proposedEdit);
  await stubTurn(page, turnId, proposedEdit);
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("The night route is unchanged.");
  // Every text node of the article as rendered, kept in the page.
  await page.evaluate(() => {
    const w = document.createTreeWalker(document.querySelector("#articleWrap .wiki-article")!, NodeFilter.SHOW_TEXT);
    const nodes: [Text, string][] = [];
    for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) nodes.push([n, n.data]);
    (window as unknown as { __rendered: [Text, string][] }).__rendered = nodes;
  });
  await page.locator('[data-conntab="discuss"]').click();
  await page.locator("#wikiDiscussInput").fill("Is R2 right?");
  await page.locator("#wikiDiscussAskBtn").click();
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="ready"]')).toBeVisible();
  await expect.poll(() => markTexts(page)).toEqual([OLD]);
  const same = await page.evaluate(() => {
    const w = document.createTreeWalker(document.querySelector("#articleWrap .wiki-article")!, NodeFilter.SHOW_TEXT);
    const now: Text[] = [];
    for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) now.push(n);
    const was = (window as unknown as { __rendered: [Text, string][] }).__rendered;
    return { count: [was.length, now.length], identical: was.every(([n, d], k) => now[k] === n && n.data === d) };
  });
  expect(same.count[1]).toBe(same.count[0]);
  expect(same.identical).toBe(true);
  expect((await editMark(page)).elements).toBe(0);
});

test("text the page shows twice: the mark lands on the copy the edit replaces", async ({ page }) => {
  expect(git("remote").trim()).toBe("");
  // «the Status line is checked.» reads the same in the intro bullet and in R2; the edit is R2's.
  await askWithEdit(page, edit("the **Status** line is checked.", "the **Status** line is read."));
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="ready"]')).toBeVisible();
  await expect.poll(() => markTexts(page)).toEqual(["the Status line is checked."]);
  expect((await editMark(page)).li).toContain("R2:");
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
  const refused = page.locator('.wiki-discuss-edit[data-edit-state="refused"]');
  await expect(refused).toContainText("The page changed since the edit was shown.");
  await expect(refused.locator("[data-discuss-apply]")).toHaveCount(0);
  expect(await pageText()).toBe(edited);
  // «Preview again» previews the same turn against the page as it is now: fresh hashes, and Apply writes.
  await refused.locator("[data-discuss-repreview]").click();
  const again = page.locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(again).toBeVisible();
  await again.locator("[data-discuss-apply]").click();
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="applied"]')).toBeVisible();
  expect(await pageText()).toBe(edited.replace(OLD, NEW));
});

test("an edit far down the page: after Apply the article shows the changed passage, not its top", async ({ page }) => {
  const filler = Array.from({ length: 80 }, (_, i) => `Filler paragraph ${i + 1} about the harbour timetable.\n`).join("\n");
  const tail = "The last berth closes at dusk.";
  const long = PAGE + "\n" + filler + "\n" + tail + "\n";
  await resetPage(long);
  await askWithEdit(page, edit(tail, "The last berth closes an hour after dusk."));
  const card = page.locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(card).toBeVisible();
  await page.locator("#articleWrap").evaluate((el) => (el.scrollTop = 0));
  await card.locator("[data-discuss-apply]").click();
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="applied"]')).toBeVisible();
  await expect(page.locator('[data-conntab="discuss"]')).toHaveClass(/active/);
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("The last berth closes an hour after dusk.");
  // The changed words themselves sit inside the article pane's visible box, which scrolled down to them.
  await expect
    .poll(() =>
      page.evaluate((words) => {
        const wrap = document.getElementById("articleWrap")!;
        const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const at = n.textContent!.indexOf(words);
          if (at === -1) continue;
          const range = document.createRange();
          range.setStart(n, at);
          range.setEnd(n, at + words.length);
          const r = range.getBoundingClientRect();
          const w = wrap.getBoundingClientRect();
          return r.top >= w.top && r.bottom <= w.bottom;
        }
        return false;
      }, "an hour after dusk."),
    )
    .toBe(true);
  expect(await page.locator("#articleWrap").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("Apply's answer lost after the write: the card finds out, shows it applied and renders the page again", async ({ page }) => {
  await askWithEdit(page, edit(OLD, NEW));
  const card = page.locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(card).toBeVisible();
  // The request reaches the server and writes; its answer never reaches the page.
  await page.route("**/api/wiki/discuss/apply", async (route) => {
    if (route.request().postData()?.includes("baseHash")) {
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await card.locator("[data-discuss-apply]").click();
  const applied = page.locator('.wiki-discuss-edit[data-edit-state="applied"]');
  await expect(applied).toBeVisible();
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("not with any date in the frontmatter.");
  await expect(page.locator(".wiki-discuss-edit")).not.toContainText("nothing was written");
  expect(await pageText()).toBe(PAGE.replace(OLD, NEW));
});

test("a gateway's 502 after the write landed is a lost answer: the card finds out, shows it applied and renders the page again (fix round 2 batch 3)", async ({ page }) => {
  await askWithEdit(page, edit(OLD, NEW));
  const card = page.locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(card).toBeVisible();
  // The request reaches the server and writes; a proxy answers with its own HTML page.
  await page.route("**/api/wiki/discuss/apply", async (route) => {
    if (route.request().postData()?.includes("baseHash")) {
      await route.fetch();
      await route.fulfill({ status: 502, headers: { "content-type": "text/html" }, body: "<html><body><h1>502 Bad Gateway</h1></body></html>" });
    } else await route.continue();
  });
  await card.locator("[data-discuss-apply]").click();
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="applied"]')).toBeVisible();
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("not with any date in the frontmatter.");
  await expect(page.locator(".wiki-discuss-edit")).not.toContainText("could not be applied");
  expect(await pageText()).toBe(PAGE.replace(OLD, NEW));
});

test("a transient refusal (uncommitted changes) keeps Apply: committed, the same card applies", async ({ page }) => {
  await askWithEdit(page, edit(OLD, NEW));
  const card = page.locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(card).toBeVisible();
  // HEAD moves on while the file on disk stays the page the preview read: the page is dirty, its hash unchanged.
  await resetPage(PAGE.replace("The north pier", "The south pier"));
  await writeFile(path.join(root, REL), PAGE, "utf8");
  await card.locator("[data-discuss-apply]").click();
  await expect(card.locator(".wiki-discuss-error")).toBeVisible();
  await expect(card.locator("[data-discuss-apply]")).toBeEnabled();
  expect(await pageText()).toBe(PAGE);
  git("commit", "-qam", "commit the hand edit");
  await card.locator("[data-discuss-apply]").click();
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="applied"]')).toBeVisible();
  expect(await pageText()).toBe(PAGE.replace(OLD, NEW));
});

test("a preview the server did not answer offers «Preview again»", async ({ page }) => {
  await page.route("**/api/wiki/discuss/apply", (route) => route.abort(), { times: 1 });
  await askWithEdit(page, edit(OLD, NEW));
  const failed = page.locator('.wiki-discuss-edit[data-edit-state="failed"]');
  await expect(failed).toContainText("The preview could not be fetched");
  await failed.locator("[data-discuss-repreview]").click();
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="ready"] [data-discuss-apply]')).toBeEnabled();
});

/** Whether the first text node in the article pane holding `words` sits inside the pane's visible box. */
function wordsInView(page: Page, words: string) {
  return page.evaluate((w) => {
    const wrap = document.getElementById("articleWrap")!;
    const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.textContent!.indexOf(w);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(n, at);
      range.setEnd(n, at + w.length);
      const r = range.getBoundingClientRect();
      const box = wrap.getBoundingClientRect();
      return r.top >= box.top && r.bottom <= box.bottom;
    }
    return false;
  }, words);
}

const FILLER = Array.from({ length: 80 }, (_, i) => `Filler paragraph ${i + 1} about the harbour timetable.\n`).join("\n");

test("new text the page also shows above the edit: after Apply the edited copy is the one in view (fix round 2 batch 4)", async ({ page }) => {
  // «the last berth closes at dusk.» is the Summer line near the top before the edit, and the Winter line's after it.
  const long = PAGE.replace("## Crossings", "Summer: the last berth closes at dusk.\n\n## Crossings") + "\n" + FILLER + "\nWinter: the last berth closes at noon.\n";
  await resetPage(long);
  await askWithEdit(page, edit("the last berth closes at noon.", "the last berth closes at dusk."));
  const card = page.locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(card).toBeVisible();
  await page.locator("#articleWrap").evaluate((el) => (el.scrollTop = 0));
  await card.locator("[data-discuss-apply]").click();
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="applied"]')).toBeVisible();
  await expect(page.locator("#articleWrap .wiki-article")).toContainText("Winter: the last berth closes at dusk.");
  await expect.poll(() => wordsInView(page, "Winter: the last berth closes at dusk.")).toBe(true);
  expect(await wordsInView(page, "Summer: the last berth closes at dusk.")).toBe(false);
});

test("new text with inline markdown far down the page: after Apply the changed line is in view (fix round 2 batch 4)", async ({ page }) => {
  const tail = "The last berth closes at noon on weekdays.";
  await resetPage(PAGE + "\n" + FILLER + "\n" + tail + "\n");
  await askWithEdit(page, edit(tail, "The last berth closes at `dusk` on **weekdays**."));
  const card = page.locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(card).toBeVisible();
  await page.locator("#articleWrap").evaluate((el) => (el.scrollTop = 0));
  await card.locator("[data-discuss-apply]").click();
  await expect(page.locator('.wiki-discuss-edit[data-edit-state="applied"]')).toBeVisible();
  await expect(page.locator("#articleWrap .wiki-article code")).toContainText(["dusk"]);
  // «on weekdays.» is the rendered text node after the bold run's end: the line's last words.
  await expect.poll(() => wordsInView(page, "The last berth closes at ")).toBe(true);
  expect(await page.locator("#articleWrap").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("Apply's answer lost and the server did not write: the article is not rendered again and keeps its scroll (fix round 2 batch 4)", async ({ page }) => {
  await resetPage(PAGE + "\n" + FILLER + "\nThe last berth closes at noon.\n");
  await askWithEdit(page, edit(OLD, NEW));
  const card = page.locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(card).toBeVisible();
  // The request never reaches the server; the re-preview does.
  await page.route("**/api/wiki/discuss/apply", async (route) => {
    if (route.request().postData()?.includes("baseHash")) await route.abort();
    else await route.continue();
  });
  const wrap = page.locator("#articleWrap");
  await wrap.evaluate((el) => {
    el.scrollTop = 600;
    (el.querySelector(".wiki-article") as unknown as { __kept?: boolean }).__kept = true;
  });
  const scrolled = await wrap.evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  let pageFetches = 0;
  page.on("request", (req) => {
    if (/\/api\/wiki\/page\?/.test(req.url())) pageFetches++;
  });
  await card.locator("[data-discuss-apply]").click();
  const again = page.locator('.wiki-discuss-edit[data-edit-state="ready"]');
  await expect(again).toContainText("whether it wrote is unknown");
  // Give a reload (if one were sent) its turn to land.
  await page.waitForTimeout(500);
  expect(pageFetches).toBe(0);
  expect(await wrap.evaluate((el) => (el.querySelector(".wiki-article") as unknown as { __kept?: boolean }).__kept === true)).toBe(true);
  expect(await wrap.evaluate((el) => el.scrollTop)).toBe(scrolled);
  expect(await pageText()).toBe(PAGE + "\n" + FILLER + "\nThe last berth closes at noon.\n");
});
