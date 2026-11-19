/**
 * Discuss's tab in the /wiki reader (Discuss P3, mimir plan muninn-wiki-discuss).
 *
 * What the unit tests cannot reach:
 *
 *  1. **The chain from a real selection to an answer in the tab.** P1's panel
 *     reads the selection and its context in the browser, «Ask here» posts it
 *     to `POST /api/wiki/discuss`, the route runs a REAL claude-sdk one-shot
 *     (the Agent SDK's own CLI binary, on the read-and-search surface over a
 *     real wiki snapshot) against the fake Messages API, and the SSE stream is
 *     read and rendered by the tab. The fake sends its answer in chunks 700 ms
 *     apart, so the answer is seen in the tab while the turn still runs.
 *  2. **The chip in the real article.** It scrolls the bullet into view and
 *     flashes it; after the page file is edited and the page shown again (the
 *     discussion kept, no reload), the chip says the passage is gone.
 *  3. **The follow-up and the hand-over, in the database.** The follow-up box
 *     sends turn 2 of the same discussion; «Continue in Claude Code» copies a
 *     prompt and sets `handed_over_at` on that turn's row only.
 *  4. **The read-only wiki.** The page payload still says the wiki has an agent,
 *     but the tab is not shown, and a click, a mousedown or Enter on the
 *     controls (forced visible) sends nothing.
 *
 * Its own muninn with `e2eEnv()`, the wikis in temp dirs (git work trees,
 * which the read-and-search surface needs) through `WIKI_EXTRA`, a throwaway
 * `claude-sdk` bot under `MUNINN_BOTS_DIR`, and the fake Messages API
 * (`src/test/fake-messages-api.ts`, as the fence tests use it) run by `bun` as
 * a process of its own (`e2e/fake-messages-api-server.ts`): the fake is a
 * `Bun.serve`, and Playwright runs this file under Node. The Agent SDK reads
 * the fake's URL and a dummy key from the server's env; `CLAUDE_CONFIG_DIR`
 * points at an empty temp dir so no user settings reach it.
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
import { DISCUSS_HANDOFF_PANEL_ID, DISCUSS_HANDOFF_SEL_BTN_ID } from "../src/dashboard/views/components/wiki-discuss-handoff.ts";

const PORT = e2ePort("wiki-discuss-tab");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-discuss";
const RO_WIKI = "e2e-discuss-ro";
const REL = "plans/first-screen.mdx";
const OTHER_REL = "notes/other.md";
const BULLET = "R2, behind. The check compares the frontmatter status_date with the date on the Brief's Status line.";
const PAGE = [
  "---",
  "title: First screen claims",
  "---",
  "",
  "# First screen claims",
  "",
  "## Brief",
  "",
  "- **R2, behind.** The check compares the frontmatter `status_date` with the date on the Brief's Status line.",
  "- The night route is unchanged.",
  "",
  "## Long",
  "",
  ...Array.from({ length: 60 }, (_, k) => `Line ${k} of the long section says something different about berth number ${k}.`),
  "",
].join("\n");
const ANSWER_CHUNKS = ["R2 reads the frontmatter ", "`status_date`, not the Status line's date.", "\n\nRead: src/wiki/status-date-check.ts"];

let server: ChildProcess | undefined;
let fake: ChildProcess | undefined;
let root = "";
let roRoot = "";
let botsDir = "";
let scratch = "";
let sql: ReturnType<typeof postgres> | null = null;

function gitInit(dir: string): void {
  const r = spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git init: ${r.stderr}`);
}

/** Start the fake Messages API and resolve its URL from its first line. */
function startFake(): Promise<string> {
  fake = spawn("bun", ["--no-env-file", path.join(REPO_ROOT, "e2e/fake-messages-api-server.ts")], {
    cwd: REPO_ROOT,
    env: { ...process.env, FAKE_API_CHUNKS: JSON.stringify(ANSWER_CHUNKS), FAKE_API_DELAY_MS: "700" },
    stdio: ["ignore", "pipe", "inherit"],
    detached: true,
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("the fake Messages API did not start")), 15_000);
    fake!.stdout!.on("data", (b: Buffer) => {
      out += b.toString();
      const m = /FAKE_API_URL=(\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
  });
}

test.beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "muninn-e2e-discuss-tab-"));
  root = path.join(scratch, "wiki");
  roRoot = path.join(scratch, "wiki-ro");
  botsDir = path.join(scratch, "bots");
  for (const r of [root, roRoot]) {
    await mkdir(path.join(r, "plans"), { recursive: true });
    await mkdir(path.join(r, "notes"), { recursive: true });
    await writeFile(path.join(r, REL), PAGE, "utf8");
    await writeFile(path.join(r, OTHER_REL), "---\ntitle: Other\n---\n\n# Other\n\nNothing here.\n", "utf8");
    await writeFile(path.join(r, ".wiki-agent.md"), "# Rules\n\nAnswer the marked passage first, and name the files you read.\n", "utf8");
    gitInit(r);
  }
  const bot = path.join(botsDir, "discussbot");
  await mkdir(bot, { recursive: true });
  await writeFile(path.join(bot, "CLAUDE.md"), "# e2e discuss bot\n\nCreated by e2e/wiki-discuss-tab.spec.ts.\n");
  await writeFile(path.join(bot, "config.json"), JSON.stringify({ connector: "claude-sdk", model: "claude-sonnet-4-5", timeoutMs: 120000 }));
  await mkdir(path.join(scratch, "claude-config"), { recursive: true });
  await mkdir(path.join(scratch, "agent-home"), { recursive: true });
  const fakeUrl = await startFake();

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
      WIKI_EXTRA: `${WIKI}=${root},${RO_WIKI}=${roRoot}`,
      WIKI_READONLY_ROOTS: roRoot,
      MUNINN_BOTS_DIR: botsDir,
      RESEARCH_BOT: "discussbot",
      PLAN_CARD_BIN: "",
      DECISION_TRIAGE_REPO_ROOTS: "",
      MUNINN_AGENT_CWD: path.join(scratch, "agent-home"),
      // The Agent SDK's CLI: the fake API, a dummy key, no user settings, no real credential.
      ANTHROPIC_BASE_URL: fakeUrl,
      ANTHROPIC_API_KEY: "sk-e2e-dummy",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_USE_VERTEX: "",
      CLAUDE_CONFIG_DIR: path.join(scratch, "claude-config"),
    },
    stdio: "ignore",
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
      p.kill("SIGTERM");
    }
  }
  await sql?.end({ timeout: 2 });
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function openPage(page: Page, wiki: string, rel = REL): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}&relPath=${encodeURIComponent(rel)}`);
  await expect(page.locator("#articleWrap .wiki-article")).toContainText(rel === REL ? "The night route is unchanged." : "Nothing here.");
}

/** Select the bullet's text in the article, as P1's spec does. */
async function selectBullet(page: Page): Promise<void> {
  await page.evaluate(() => {
    const li = Array.from(document.querySelectorAll(".wiki-article li")).find((l) => l.textContent?.startsWith("R2, behind."))!;
    const r = document.createRange();
    r.selectNodeContents(li);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  });
}

/** The bullet's box against the article's scroll box. */
function bulletInView(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const li = Array.from(document.querySelectorAll(".wiki-article li")).find((l) => l.textContent?.startsWith("R2, behind."))!;
    const wrap = document.getElementById("articleWrap")!;
    const a = li.getBoundingClientRect();
    const b = wrap.getBoundingClientRect();
    return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  });
}

test.describe("Wiki reader: the Discuss tab", () => {
  test("select, ask here, the answer streams in the tab, the chip scrolls; a follow-up; Continue in Claude Code; a passage gone", async ({ page, context }) => {
    test.setTimeout(180_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    // The payload key, read off the spec server.
    const payload = (await (await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`)).json()) as { reader: { discussAgent: boolean; discussHandoff: boolean } };
    expect(payload.reader).toMatchObject({ discussAgent: true, discussHandoff: false });

    await openPage(page, WIKI);
    const tab = page.locator('[data-conntab="discuss"]');
    await expect(tab).toBeVisible();
    // The breadcrumb's 💬 Discuss opens the tab on a wiki with an agent, not the chat dialog.
    await page.locator("#wikiDiscussBtn").click();
    await expect(tab).toHaveClass(/active/);
    await expect(page.locator("#discussBody")).toBeVisible();
    await expect(page.locator("#wikiChatOpt")).toBeHidden();
    await page.locator('[data-conntab="conn"]').click();

    // Select the bullet; the selection control opens P1's panel with «Ask here».
    await selectBullet(page);
    const selBtn = page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`);
    await expect(selBtn).toBeVisible();
    await selBtn.click();
    const panel = page.locator(`#${DISCUSS_HANDOFF_PANEL_ID}`);
    await expect(panel).toBeVisible();
    // No handoff on this wiki: no Copy prompt, only «Ask here».
    await expect(panel.locator("[data-handoff=copy]")).toHaveCount(0);
    await panel.locator("textarea.wiki-handoff-q").fill("Does R2 use the frontmatter status_date or the date on the Brief's Status line?");
    await panel.locator("[data-handoff=ask-here]").click();
    await expect(panel).toBeHidden();
    await expect(tab).toHaveClass(/active/);

    // The answer is in the tab while the turn still runs: the deltas render before `done`.
    const turn1 = page.locator('.wiki-discuss-turn[data-turn-seq="1"]');
    await expect(page.locator('.wiki-discuss-turn[data-turn-state="running"] .wiki-discuss-answer')).toContainText("R2 reads the frontmatter", { timeout: 90_000 });
    const midStream = await turn1.locator(".wiki-discuss-answer").innerText();
    console.log("MID-STREAM", JSON.stringify(midStream));
    expect(midStream).not.toContain("status-date-check.ts");
    await expect(turn1).toHaveAttribute("data-turn-state", "done", { timeout: 60_000 });
    const answer = turn1.locator(".wiki-discuss-answer");
    await expect(answer).toContainText("Read: src/wiki/status-date-check.ts");
    // The Ask tab's markdown function: the backticks are a code element.
    await expect(answer.locator("code")).toHaveText("status_date");

    // The chip scrolls the bullet into view and flashes it.
    await page.evaluate(() => {
      const wrap = document.getElementById("articleWrap")!;
      wrap.scrollTop = wrap.scrollHeight;
    });
    expect(await bulletInView(page)).toBe(false);
    await turn1.locator("[data-discuss-chip]").click();
    await expect.poll(() => bulletInView(page)).toBe(true);
    await expect(page.locator(".wiki-article li.wiki-hash-flash")).toContainText("R2, behind.");

    // A follow-up from the tab's box: turn 2 of the same discussion.
    await page.locator("#wikiDiscussInput").fill("And where is that date read?");
    await page.locator("#wikiDiscussInput").press("Enter");
    const turn2 = page.locator('.wiki-discuss-turn[data-turn-seq="2"]');
    await expect(turn2).toHaveAttribute("data-turn-state", "done", { timeout: 90_000 });

    // Continue in Claude Code on turn 1: a prompt copied, the row marked.
    await turn1.locator("[data-discuss-continue]").click();
    await expect(turn1.locator(".wiki-discuss-cont-status")).toContainText("Copied");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain(`Page: ${path.join(root, REL)}`);
    expect(clip).toContain("Question: Does R2 use the frontmatter status_date");
    expect(clip).not.toContain("And where is that date read?");
    const rows = await sql!`
      SELECT seq, discussion_id, end_state, selection, location, handed_over_at
      FROM wiki_discuss_turns WHERE wiki = ${WIKI} AND rel_path = ${REL} ORDER BY created_at DESC LIMIT 2`;
    const [r2, r1] = rows as unknown as { seq: number; discussion_id: string; end_state: string; selection: string | null; location: { found: string } | null; handed_over_at: Date | null }[];
    console.log("DISCUSS-ROWS", JSON.stringify(rows));
    expect(r1!.seq).toBe(1);
    expect(r2!.seq).toBe(2);
    expect(r2!.discussion_id).toBe(r1!.discussion_id);
    expect(r1!.end_state).toBe("done");
    expect(r1!.selection).toBe(BULLET);
    // The context the client sent places the passage exactly.
    expect(r1!.location?.found).toBe("exact");
    expect(r1!.handed_over_at).not.toBeNull();
    expect(r2!.handed_over_at).toBeNull();

    // The page file loses the bullet; shown again (no reload, the discussion kept), the chip says it is gone.
    await writeFile(path.join(root, REL), PAGE.replace(/^- \*\*R2, behind\.\*\*.*$/m, "- R2 was rewritten."), "utf8");
    await page.locator(`#wikiList [data-relpath="${OTHER_REL}"]`).first().click();
    await expect(page.locator("#articleWrap .wiki-article")).toContainText("Nothing here.");
    await page.goBack();
    await expect(page.locator("#articleWrap .wiki-article")).toContainText("R2 was rewritten.");
    await page.locator('[data-conntab="discuss"]').click();
    await turn1.locator("[data-discuss-chip]").click();
    await expect(turn1.locator(".wiki-discuss-gone")).toHaveText("That passage is no longer in the page.");
  });

  test("a read-only wiki: no tab, and no control path sends a turn", async ({ page }) => {
    const payload = (await (await fetch(`${BASE}/api/wiki/page?wiki=${RO_WIKI}&relPath=${encodeURIComponent(REL)}`)).json()) as { reader: { discussAgent: boolean } };
    // The payload says the wiki has an agent (an admin, the rules file): the reader keeps it off.
    expect(payload.reader.discussAgent).toBe(true);
    const sent: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/wiki/discuss")) sent.push(r.url());
    });
    await openPage(page, RO_WIKI);
    await expect(page.locator('[data-conntab="discuss"]')).toBeHidden();
    // No passage control either: the wiki has no handoff, and the agent is off here.
    await selectBullet(page);
    await page.waitForTimeout(200);
    await expect(page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`)).toHaveCount(0);
    // Forced visible, the tab's controls still send nothing: click, mousedown, Enter.
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-conntab="discuss"]')!.hidden = false;
      document.getElementById("discussBody")!.style.display = "flex";
    });
    const input = page.locator("#wikiDiscussInput");
    await expect(input).toBeDisabled();
    await page.evaluate(() => {
      const box = document.getElementById("wikiDiscussInput") as HTMLTextAreaElement;
      box.disabled = false;
      box.value = "Anything?";
    });
    await input.press("Enter");
    await page.locator("#wikiDiscussAskBtn").dispatchEvent("mousedown");
    await page.locator("#wikiDiscussAskBtn").click();
    await expect(page.locator("#wikiReadonlyNote")).toBeVisible();
    await page.waitForTimeout(300);
    expect(sent).toEqual([]);
  });
});
