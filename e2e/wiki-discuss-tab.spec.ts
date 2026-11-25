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
 *  2. **The chip in the real article.** It scrolls the passage's own text
 *     into view and highlights only that text (a CSS highlight, no element
 *     added or flashed): a bullet, a line deep in one long run of lines (one
 *     text node), the second copy of a sentence on the page twice, a paragraph
 *     deep in a long closed Fold, and a selection over two DecisionLog items
 *     (shown newest first), also after the article is rendered anew. After the
 *     page file is edited and the page shown again (the discussion kept, no
 *     reload), the chip says the passage is gone. "In view" is a layout box
 *     against `#articleWrap`, which only a browser has. The reveal lands in
 *     place: the section bar names the section of a line under a later
 *     heading, a cell deep in a Query result is inside both its
 *     `.query-table-wrap` and `#articleWrap`, and a wide table's far-right
 *     cell is inside its `.tablewrap`.
 *  3. **The follow-up and the hand-over, in the database.** The follow-up box
 *     sends turn 2 of the same discussion; «Continue in Claude Code» copies a
 *     prompt and sets `handed_over_at` on that turn's row only.
 *  4. **A refusal keeps the question; a stream leaves finished turns alone.**
 *     A refused send (a stubbed 409, a network failure) leaves the question in
 *     the box; an accepted one clears it, unless the reader typed a new draft
 *     while the turn was starting. While turn 2 streams, a selection in turn
 *     1's answer survives the repaints, and a press on turn 1's chip held
 *     across a repaint still reveals its passage (turn 2's real stream is held
 *     open in the page for those steps, so a slow runner cannot finish it
 *     first), and so does a press on the streaming turn's own chip. The pane
 *     holds still during a press and follows the stream again after it, also
 *     when a context menu or a blur takes the place of the pointerup (that
 *     stream is stubbed in the page).
 *  5. **The read-only wiki.** The page payload still says the wiki has an agent,
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
const CHIP_REL = "plans/chip-targets.mdx";
const DUP = "The ferry leaves at nine on every weekday morning from the north pier.";
const DEEP = "Line 50 of the long run says something different about berth number 50.";
const FOLDED = "Paragraph 40 in the fold talks about crossing number 40 and its tides.";
const CELL = "Berth seventy is the one with the crane.";
const FAR_RIGHT = "Farright the last column holds this.";
const CHIP_PAGE = [
  "---",
  "title: Chip targets",
  "---",
  "",
  "# Chip targets",
  "",
  "## Decisions",
  "",
  "<DecisionLog>",
  "",
  "- **D4** — The older decision keeps the berth list in this page.",
  "- **D5** — The newest decision moves the berth list to a page of its own.",
  "",
  "</DecisionLog>",
  "",
  "## First",
  "",
  DUP,
  "",
  "## Long",
  "",
  ...Array.from({ length: 60 }, (_, k) => `Line ${k} of the long run says something different about berth number ${k}.`),
  "",
  "## Second",
  "",
  DUP,
  "",
  "After the second copy comes a closing note about the summer timetable.",
  "",
  '<Fold title="Forty paragraphs">',
  "",
  ...Array.from({ length: 44 }, (_, k) => `Paragraph ${k} in the fold talks about crossing number ${k} and its tides.\n`),
  "</Fold>",
  "",
  "## Data",
  "",
  '<Query id="Q-1" question="Which berths?" answer="Eighty." csv="chip-data/q1.csv" />',
  "",
  "## Wide",
  "",
  "<ComparisonTable>",
  "",
  `| ${Array.from({ length: 24 }, (_, k) => `Column${k}`).join(" | ")} |`,
  `| ${Array.from({ length: 24 }, () => "---").join(" | ")} |`,
  `| ${Array.from({ length: 23 }, (_, k) => `Widecellvalue${k}withoutanybreaks`).join(" | ")} | ${FAR_RIGHT} |`,
  "",
  "</ComparisonTable>",
  "",
].join("\n");
/** The Query card's result: 80 rows, so its `.query-table-wrap` scrolls. */
const CHIP_CSV = ["berth,note", ...Array.from({ length: 80 }, (_, k) => (k === 70 ? `70,${CELL}` : `${k},Berth ${k} is ordinary`))].join("\n") + "\n";
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
    await writeFile(path.join(r, CHIP_REL), CHIP_PAGE, "utf8");
    await mkdir(path.join(r, "plans", "chip-data"), { recursive: true });
    await writeFile(path.join(r, "plans", "chip-data", "q1.csv"), CHIP_CSV, "utf8");
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
  // Discuss v2 (PR 3): a turn runs on the page's wiki thread, which needs a
  // user. The pane sends one only once a thread holds it (PR 4), so a page's
  // first turn runs on the bot's default chat user.
  await sql!`INSERT INTO users (id, username, platform) VALUES ('e2e-discuss-user', 'E2E Discuss', 'web') ON CONFLICT (id) DO NOTHING`;
  await sql!`INSERT INTO bot_default_user (bot_name, user_id) VALUES ('discussbot', 'e2e-discuss-user') ON CONFLICT (bot_name) DO UPDATE SET user_id = EXCLUDED.user_id`;
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
  await expect(page.locator("#articleWrap .wiki-article")).toContainText(rel === REL ? "The night route is unchanged." : rel === CHIP_REL ? "Paragraph 43 in the fold" : "Nothing here.");
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

/** Select the `nth` copy of `text` in the article (inside one text node). */
async function selectText(page: Page, text: string, nth = 0): Promise<void> {
  await page.evaluate(
    ([text, nth]) => {
      const article = document.querySelector("#articleWrap .wiki-article")!;
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      let k = 0;
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        for (let at = n.data.indexOf(text as string); at !== -1; at = n.data.indexOf(text as string, at + 1)) {
          if (k++ !== nth) continue;
          const r = document.createRange();
          r.setStart(n, at);
          r.setEnd(n, at + (text as string).length);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(r);
          return;
        }
      }
      throw new Error(`no copy ${nth} of ${text}`);
    },
    [text, nth] as const,
  );
}

/** «Ask here» on the live selection; resolves when turn `seq` is done. */
async function askHere(page: Page, question: string, seq: number): Promise<void> {
  await page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`).click();
  const panel = page.locator(`#${DISCUSS_HANDOFF_PANEL_ID}`);
  await expect(panel).toBeVisible();
  await panel.locator("textarea.wiki-handoff-q").fill(question);
  await panel.locator("[data-handoff=ask-here]").click();
  await expect(panel).toBeHidden();
  await expect(page.locator(`.wiki-discuss-turn[data-turn-seq="${seq}"]`)).toHaveAttribute("data-turn-state", "done", { timeout: 90_000 });
}

/**
 * What the chip revealed: the text it flashed (a highlighted range or an
 * element with the flash class), whether that holds the `nth` copy of `text`,
 * whether the `nth` copy's own box is inside `#articleWrap`, whether any
 * `<details>` carries the flash, and whether a wrapper was left in the article.
 */
function revealed(page: Page, text: string, nth = 0) {
  return page.evaluate(
    ([text, nth]) => {
      const article = document.querySelector("#articleWrap .wiki-article")!;
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      let copy: Range | null = null;
      let k = 0;
      for (let n = walker.nextNode() as Text | null; n && !copy; n = walker.nextNode() as Text | null) {
        for (let at = n.data.indexOf(text as string); at !== -1; at = n.data.indexOf(text as string, at + 1)) {
          if (k++ !== nth) continue;
          copy = document.createRange();
          copy.setStart(n, at);
          copy.setEnd(n, at + (text as string).length);
          break;
        }
      }
      const wrap = document.getElementById("articleWrap")!.getBoundingClientRect();
      const box = copy?.getBoundingClientRect();
      const inView = !!box && box.height > 0 && box.top >= wrap.top - 1 && box.bottom <= wrap.bottom + 1;
      const hl = (globalThis as unknown as { CSS: { highlights?: Map<string, Set<Range>> } }).CSS.highlights?.get("wiki-range-flash");
      const range = hl && hl.size ? [...hl][0]! : null;
      const el = article.querySelector(".wiki-hash-flash");
      const flashed = range ? range.toString() : (el?.textContent ?? "");
      const holdsCopy = !!copy && (range ? range.intersectsNode(copy.startContainer) && range.toString().includes(text as string) : !!el?.contains(copy.startContainer));
      return { inView, flashed, holdsCopy, detailsFlashed: !!article.querySelector("details.wiki-hash-flash"), anchors: article.querySelectorAll(".wiki-discuss-anchor").length };
    },
    [text, nth] as const,
  );
}

const flat = (s: string) => s.replace(/\s+/g, "");

/**
 * Hold the page's next `/api/wiki/discuss` stream after its first delta: the
 * fake's three chunks 700 ms apart can end before a test's steps on a slow
 * runner (CI run 44638214225). `__discussHold.step()` feeds one extra delta
 * (one repaint) on demand; `release()` lets the held frames through, and the
 * `done` frame's answer replaces the text the extra deltas added.
 */
function holdNextDiscussStream(page: Page): Promise<void> {
  return page.evaluate(() => {
    const real = window.fetch.bind(window);
    let armed = true;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await real(input, init);
      if (!armed || String(input) !== "/api/wiki/discuss" || !res.ok || !res.body) return res;
      armed = false;
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      const upstream = res.body.getReader();
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      let holding = false;
      let heldOnce = false;
      let ended = false;
      let pending = "";
      const held: Uint8Array[] = [];
      const send = (bytes: Uint8Array) => (holding ? held.push(bytes) : ctl.enqueue(bytes));
      const hold = { step: () => ctl.enqueue(enc.encode(`event: delta\ndata: ${JSON.stringify({ text: " (held)" })}\n\n`)), release: () => {
        holding = false;
        for (const b of held.splice(0)) ctl.enqueue(b);
        if (ended) ctl.close();
      } };
      (window as unknown as { __discussHold: typeof hold }).__discussHold = hold;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
          void (async () => {
            for (;;) {
              const chunk = await upstream.read();
              if (chunk.done) break;
              pending += dec.decode(chunk.value, { stream: true });
              let cut: number;
              while ((cut = pending.indexOf("\n\n")) >= 0) {
                const frame = pending.slice(0, cut + 2);
                pending = pending.slice(cut + 2);
                send(enc.encode(frame));
                if (!heldOnce && /^event: delta$/m.test(frame)) holding = heldOnce = true;
              }
            }
            if (pending) send(enc.encode(pending));
            ended = true;
            if (!holding) ctl.close();
          })();
        },
      });
      return new Response(body, { status: res.status, headers: res.headers });
    }) as typeof fetch;
  });
}

test.describe("Wiki reader: the Discuss tab", () => {
  // Each test starts its own discussion: the pane reads the page's live wiki
  // thread back (Discuss v2 PR 4), so a thread an earlier test left would show
  // its turns here and take the next ask. Close those first, as «Start over» does.
  test.beforeEach(async () => {
    await sql!`UPDATE threads SET closed_at = now() WHERE kind = 'wiki' AND closed_at IS NULL`;
  });
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
    // Only the bullet's text is highlighted; no element is wrapped or flashed.
    const lit = await page.evaluate(() => {
      const hl = (globalThis as unknown as { CSS: { highlights?: Map<string, Set<Range>> } }).CSS.highlights?.get("wiki-range-flash");
      return hl && hl.size ? [...hl][0]!.toString() : "";
    });
    expect(lit.replace(/\s+/g, " ").trim()).toBe(BULLET);

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

  test("the chip reveals the passage itself: deep in a long run, the copy selected, in a long closed Fold, across DecisionLog items", async ({ page }) => {
    test.setTimeout(240_000);
    await openPage(page, WIKI, CHIP_REL);
    // 1. Deep in one long run of lines (one text node: the formatter writes no <p>).
    await selectText(page, DEEP);
    await askHere(page, "What does line 50 say?", 1);
    // 2. The second copy of a sentence that is on the page twice.
    await selectText(page, DUP, 1);
    await askHere(page, "Why is this sentence here twice?", 2);
    // 3. Paragraph 40 of a long Fold, which is closed again before the chip.
    await page.evaluate(() => {
      document.querySelector<HTMLDetailsElement>(".wiki-article details.fold")!.open = true;
    });
    await selectText(page, FOLDED);
    await askHere(page, "What about crossing 40?", 3);
    // 4. Both DecisionLog items, as the reader shows them (newest first).
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll(".wiki-article section.decision-log li"));
      const r = document.createRange();
      r.setStart(items[0]!, 0);
      r.setEnd(items[items.length - 1]!, items[items.length - 1]!.childNodes.length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
    });
    await askHere(page, "Which decision holds?", 4);

    const chip = (seq: number) => page.locator(`.wiki-discuss-turn[data-turn-seq="${seq}"] [data-discuss-chip]`);
    const toTop = () =>
      page.evaluate(() => {
        document.getElementById("articleWrap")!.scrollTop = 0;
        for (const d of Array.from(document.querySelectorAll<HTMLDetailsElement>(".wiki-article details.fold"))) d.open = false;
      });

    await toTop();
    expect((await revealed(page, DEEP)).inView).toBe(false);
    await chip(1).click();
    const deep = await revealed(page, DEEP);
    expect.soft(deep.inView, "line 50 in view").toBe(true);
    expect.soft(flat(deep.flashed), "only line 50 flashed").toBe(flat(DEEP));
    expect.soft(deep.anchors, "no wrapper left in the article").toBe(0);

    await toTop();
    await chip(2).click();
    const dup = await revealed(page, DUP, 1);
    expect.soft(dup.holdsCopy, "the second copy revealed").toBe(true);
    expect.soft(dup.inView, "the second copy in view").toBe(true);
    expect.soft(flat(dup.flashed), "only the sentence flashed").toBe(flat(DUP));

    await toTop();
    await chip(3).click();
    const folded = await revealed(page, FOLDED);
    expect.soft(folded.inView, "paragraph 40 in view").toBe(true);
    expect.soft(folded.detailsFlashed, "the fold is not flashed").toBe(false);
    expect.soft(flat(folded.flashed), "only paragraph 40 flashed").toBe(flat(FOLDED));
    expect.soft(await page.locator(".wiki-article details.fold").evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);

    await toTop();
    await chip(4).click();
    await expect.soft(page.locator('.wiki-discuss-turn[data-turn-seq="4"] .wiki-discuss-gone'), "the DecisionLog passage is found").toHaveCount(0);
    const dl = await revealed(page, "The newest decision moves");
    expect.soft(dl.flashed, "both items revealed").toContain("The older decision keeps");
    expect.soft(dl.flashed).toContain("The newest decision moves");

    // Shown again (the article rendered anew, the discussion kept): the
    // DecisionLog passage is still found, the duplicate still the second copy.
    await page.locator(`#wikiList [data-relpath="${OTHER_REL}"]`).first().click();
    await expect(page.locator("#articleWrap .wiki-article")).toContainText("Nothing here.");
    await page.goBack();
    await expect(page.locator("#articleWrap .wiki-article")).toContainText("Paragraph 43 in the fold");
    await page.locator('[data-conntab="discuss"]').click();
    await toTop();
    await chip(4).click();
    await expect.soft(page.locator('.wiki-discuss-turn[data-turn-seq="4"] .wiki-discuss-gone'), "found after a new render").toHaveCount(0);
    await toTop();
    await chip(2).click();
    expect.soft((await revealed(page, DUP, 1)).holdsCopy, "the second copy after a new render").toBe(true);
  });

  test("the chip reveals in place: the section bar names the passage's section, an inner scroller and a wide table scroll to it", async ({ page }) => {
    test.setTimeout(240_000);
    await openPage(page, WIKI, CHIP_REL);
    await selectText(page, DEEP);
    await askHere(page, "What does line 50 say?", 1);
    await selectText(page, CELL);
    await askHere(page, "Which berth has the crane?", 2);
    await selectText(page, FAR_RIGHT);
    await askHere(page, "What is in the last column?", 3);
    const chip = (seq: number) => page.locator(`.wiki-discuss-turn[data-turn-seq="${seq}"] [data-discuss-chip]`);
    const toTop = () =>
      page.evaluate(() => {
        document.getElementById("articleWrap")!.scrollTop = 0;
        for (const w of Array.from(document.querySelectorAll(".wiki-article .query-table-wrap, .wiki-article .tablewrap"))) {
          w.scrollTop = 0;
          w.scrollLeft = 0;
        }
      });
    /** The text's own box against `#articleWrap` and against its nearest `sel` ancestor. */
    const boxes = (text: string, sel: string) =>
      page.evaluate(
        ([text, sel]) => {
          const article = document.querySelector("#articleWrap .wiki-article")!;
          const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
            const at = n.data.indexOf(text as string);
            if (at === -1) continue;
            const r = document.createRange();
            r.setStart(n, at);
            r.setEnd(n, at + (text as string).length);
            const b = r.getBoundingClientRect();
            const w = document.getElementById("articleWrap")!.getBoundingClientRect();
            const s = n.parentElement!.closest(sel as string)!.getBoundingClientRect();
            const inside = (o: DOMRect) => ({ v: b.top >= o.top - 1 && b.bottom <= o.bottom + 1, h: b.left >= o.left - 1 && b.right <= o.right + 1 });
            return { wrap: inside(w), own: inside(s), box: { top: b.top, left: b.left } };
          }
          throw new Error(`no ${text}`);
        },
        [text, sel] as const,
      );

    // (a) Plain text under `## Long`: the section bar names Long, also after a 1 px scroll.
    await toTop();
    await chip(1).click();
    await expect.soft(page.locator("#wikiSectionBar .wiki-sec-t"), "the bar names the passage's section").toHaveText("Long");
    await page.evaluate(() => (document.getElementById("articleWrap")!.scrollTop += 1));
    await expect.soft(page.locator("#wikiSectionBar .wiki-sec-t"), "still Long after a 1 px scroll").toHaveText("Long");

    // (b) Row 70 of a Query result, inside `.query-table-wrap` far down the page.
    await toTop();
    expect((await boxes(CELL, ".query-table-wrap")).wrap.v, "the cell starts out of view").toBe(false);
    await chip(2).click();
    const cell = await boxes(CELL, ".query-table-wrap");
    expect.soft(cell.wrap.v, `the cell inside #articleWrap (${JSON.stringify(cell.box)})`).toBe(true);
    expect.soft(cell.own.v, "the cell inside its .query-table-wrap").toBe(true);

    // (c) The far-right cell of a wide table inside `.tablewrap`.
    await toTop();
    await chip(3).click();
    const far = await boxes(FAR_RIGHT, ".tablewrap");
    expect.soft(far.own.h, `the cell horizontally inside its .tablewrap (${JSON.stringify(far.box)})`).toBe(true);
    expect.soft(far.wrap.v, "the cell inside #articleWrap").toBe(true);
  });

  test("a refusal keeps the typed question; while a turn streams, turn 1's selection and chip survive", async ({ page }) => {
    test.setTimeout(180_000);
    await openPage(page, WIKI, OTHER_REL);
    await page.locator("#wikiDiscussBtn").click();
    const input = page.locator("#wikiDiscussInput");

    // A refusal (409 busy) and a network failure: the question stays in the box.
    await page.route("**/api/wiki/discuss", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "a turn is running", reason: "busy" }) }), { times: 1 });
    await input.fill("First question?");
    await input.press("Enter");
    await expect(page.locator('.wiki-discuss-turn[data-turn-state="refused"]')).toContainText("still running");
    await expect(input).toHaveValue("First question?");
    await page.route("**/api/wiki/discuss", (route) => route.abort(), { times: 1 });
    await input.press("Enter");
    await expect(page.locator('.wiki-discuss-turn[data-turn-state="refused"]')).toHaveCount(2);
    await expect(input).toHaveValue("First question?");

    // Turn 1, about a passage, from P1's panel.
    await selectText(page, "Nothing here.");
    await askHere(page, "What is here?", 1);
    const answer1 = page.locator('.wiki-discuss-turn[data-turn-seq="1"] .wiki-discuss-answer');
    await expect(answer1).toContainText("R2 reads the frontmatter");

    // Turn 2's real stream is held in the page after its first delta.
    await holdNextDiscussStream(page);
    const turn2Step = () => page.evaluate(() => (window as unknown as { __discussHold: { step(): void } }).__discussHold.step());
    const turn2Running = (why: string) => expect(turn2, `turn 2 still streams ${why}`).toHaveAttribute("data-turn-state", "running", { timeout: 1_000 });

    // Turn 2 from the box (the question kept from the refusals): accepted, the box clears.
    await input.press("Enter");
    const turn2 = page.locator('.wiki-discuss-turn[data-turn-seq="2"]');
    await expect(turn2).toHaveAttribute("data-turn-state", "running", { timeout: 90_000 });
    await expect(input).toHaveValue("");

    // While turn 2 streams, select turn 1's answer and wait for a repaint.
    await expect(turn2.locator(".wiki-discuss-answer")).toContainText("R2 reads the frontmatter", { timeout: 90_000 });
    const turn2Html = () => page.evaluate(() => document.querySelector('.wiki-discuss-turn[data-turn-seq="2"]')?.outerHTML ?? "");
    await turn2Running("before turn 1's answer is selected");
    let before = await turn2Html();
    await page.evaluate(() => {
      const a = document.querySelector('.wiki-discuss-turn[data-turn-seq="1"] .wiki-discuss-answer')!;
      const r = document.createRange();
      r.selectNodeContents(a);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
    });
    await turn2Step();
    await expect.poll(turn2Html, { timeout: 30_000 }).not.toBe(before);
    await page.waitForTimeout(100);
    const sel = await page.evaluate(() => {
      const s = getSelection()!;
      const a = document.querySelector('.wiki-discuss-turn[data-turn-seq="1"] .wiki-discuss-answer');
      return { text: s.toString(), inTurn1: !!a && !!s.anchorNode && a.contains(s.anchorNode) };
    });
    expect(sel.inTurn1, "the selection is still in turn 1's answer").toBe(true);
    expect(sel.text).toContain("R2 reads the frontmatter");

    // A press on turn 1's chip held across a repaint still reveals the passage.
    await page.evaluate(() => (globalThis as unknown as { CSS: { highlights?: Map<string, unknown> } }).CSS.highlights?.clear());
    // The chip in view, and the pane 20px from its bottom, so the next delta
    // would scroll the pane to follow the stream; the press must land on the chip.
    const chip1 = page.locator('.wiki-discuss-turn[data-turn-seq="1"] [data-discuss-chip]');
    await chip1.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const slack = await page.evaluate(() => {
      const b = document.getElementById("discussBody")!;
      b.scrollTop = 0;
      b.style.flex = "none";
      b.style.height = `${b.scrollHeight - 20}px`;
      return b.scrollHeight - b.scrollTop - b.clientHeight;
    });
    expect(slack).toBeGreaterThan(0);
    expect(slack).toBeLessThan(40);
    const box = (await chip1.boundingBox())!;
    const [px, py] = [box.x + box.width / 2, box.y + box.height / 2];
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('.wiki-discuss-turn[data-turn-seq="1"] [data-discuss-chip]'), [px, py])).toBe(true);
    await turn2Running("before the press on turn 1's chip");
    before = await turn2Html();
    await page.mouse.move(px, py);
    await page.mouse.down();
    await turn2Step();
    await expect.poll(turn2Html, { timeout: 30_000 }).not.toBe(before);
    await turn2Running("when the press on turn 1's chip is released");
    await page.mouse.up();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hl = (globalThis as unknown as { CSS: { highlights?: Map<string, Set<Range>> } }).CSS.highlights?.get("wiki-range-flash");
          return hl && hl.size ? [...hl][0]!.toString() : "";
        }),
      )
      .toContain("Nothing here.");
    await page.evaluate(() => (window as unknown as { __discussHold: { release(): void } }).__discussHold.release());
    await expect(turn2).toHaveAttribute("data-turn-state", "done", { timeout: 90_000 });

    // Turn 3: a new draft typed while the turn starts is not cleared when it is accepted.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/wiki/discuss", async (route) => {
      await held;
      await route.continue();
    }, { times: 1 });
    await input.fill("Second question?");
    await input.press("Enter");
    await expect(page.locator('.wiki-discuss-turn[data-turn-state="sending"]')).toHaveCount(1);
    await input.fill("A new draft");
    release();
    const turn3 = page.locator('.wiki-discuss-turn[data-turn-seq="3"]');
    await expect(turn3).toHaveAttribute("data-turn-state", /running|done/, { timeout: 90_000 });
    await expect(turn3.locator(".wiki-discuss-q")).toHaveText("Second question?");
    await expect(input).toHaveValue("A new draft");
    await expect(turn3).toHaveAttribute("data-turn-state", "done", { timeout: 90_000 });
    await expect(input).toHaveValue("A new draft");

    // Turn 4 is accepted after the reader moved to another page and typed the
    // same words there: that page's box is its own draft, never cleared.
    const sameWords = async () => (await sql!`SELECT count(*)::int AS n FROM wiki_discuss_turns WHERE wiki = ${WIKI} AND rel_path = ${OTHER_REL} AND question = 'Same words?'`)[0]!.n as number;
    const rowsBefore = await sameWords();
    let release4!: () => void;
    const held4 = new Promise<void>((r) => (release4 = r));
    await page.route("**/api/wiki/discuss", async (route) => {
      await held4;
      await route.continue();
    }, { times: 1 });
    await input.fill("Same words?");
    await input.press("Enter");
    await expect(page.locator('.wiki-discuss-turn[data-turn-state="sending"]')).toHaveCount(1);
    await page.locator(`#wikiList [data-relpath="${REL}"]`).first().click();
    await expect(page.locator("#articleWrap .wiki-article")).toContainText("The night route is unchanged.");
    await page.locator('[data-conntab="discuss"]').click();
    await input.fill("Same words?");
    release4();
    await expect.poll(sameWords, { timeout: 90_000 }).toBe(rowsBefore + 1);
    await page.waitForTimeout(1500);
    await expect(input).toHaveValue("Same words?");
  });

  test("a press on the streaming turn's own chip, held across a repaint, reveals its passage", async ({ page }) => {
    test.setTimeout(120_000);
    await openPage(page, WIKI, OTHER_REL);
    await selectText(page, "Nothing here.");
    await page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`).click();
    const panel = page.locator(`#${DISCUSS_HANDOFF_PANEL_ID}`);
    await panel.locator("textarea.wiki-handoff-q").fill("What is here?");
    // The stream is held after its first delta, so the turn still runs when the press is released.
    await holdNextDiscussStream(page);
    await panel.locator("[data-handoff=ask-here]").click();
    const turn = page.locator(".wiki-discuss-turn").first();
    await expect(page.locator('.wiki-discuss-turn[data-turn-state="running"] .wiki-discuss-answer')).toContainText("R2 reads the frontmatter", { timeout: 90_000 });
    await page.evaluate(() => (globalThis as unknown as { CSS: { highlights?: Map<string, unknown> } }).CSS.highlights?.clear());
    const chip = turn.locator("[data-discuss-chip]");
    const box = (await chip.boundingBox())!;
    const [px, py] = [box.x + box.width / 2, box.y + box.height / 2];
    const turnHtml = () => page.evaluate(() => document.querySelector(".wiki-discuss-turn")?.outerHTML ?? "");
    const before = await turnHtml();
    await page.mouse.move(px, py);
    await page.mouse.down();
    await page.evaluate(() => (window as unknown as { __discussHold: { step(): void } }).__discussHold.step());
    await expect.poll(turnHtml, { timeout: 30_000 }).not.toBe(before);
    const stateAtRelease = await turn.getAttribute("data-turn-state");
    await page.mouse.up();
    expect(stateAtRelease, "the press was released while the turn still ran").toBe("running");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hl = (globalThis as unknown as { CSS: { highlights?: Map<string, Set<Range>> } }).CSS.highlights?.get("wiki-range-flash");
          return hl && hl.size ? [...hl][0]!.toString() : "";
        }),
      )
      .toContain("Nothing here.");
    await page.evaluate(() => (window as unknown as { __discussHold: { release(): void } }).__discussHold.release());
    await expect(turn).toHaveAttribute("data-turn-state", "done", { timeout: 90_000 });
  });

  // The pane does not follow the stream while a press is held in it (the
  // control under the pointer would move); a press that began at the bottom
  // resumes following after release, and a press whose pointerup never comes
  // (a context menu, the window losing focus) does not stop following for good.
  // The stream is stubbed in the page: many deltas on a timer, which the real
  // fake's three chunks cannot give, and only the client's scrolling is tested.
  test("follow-scroll resumes after a press held at the bottom, and after a press that ends in a context menu or a blur", async ({ page }) => {
    test.setTimeout(120_000);
    await openPage(page, WIKI, OTHER_REL);
    await page.locator("#wikiDiscussBtn").click();
    await expect(page.locator("#discussBody")).toBeVisible();
    await page.evaluate(() => {
      const b = document.getElementById("discussBody")!;
      b.style.flex = "none";
      b.style.height = "160px";
      const real = window.fetch.bind(window);
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) !== "/api/wiki/discuss") return real(input, init);
        const enc = new TextEncoder();
        const frame = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        let n = 0;
        let timer: ReturnType<typeof setInterval>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(frame("turn", { turnId: crypto.randomUUID(), seq: 1, discussionId: crypto.randomUUID() }));
            timer = setInterval(() => {
              n++;
              (window as unknown as { __deltas: number }).__deltas = n;
              c.enqueue(frame("delta", { text: `Delta ${n} carries a sentence long enough to wrap onto a second line in the pane. ` }));
              if (n === 40) {
                clearInterval(timer);
                c.enqueue(frame("done", { answer: "Done." }));
                c.close();
              }
            }, 400);
          },
          cancel() {
            clearInterval(timer);
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }) as typeof fetch;
    });
    const deltas = () => page.evaluate(() => (window as unknown as { __deltas?: number }).__deltas ?? 0);
    const fromBottom = () =>
      page.evaluate(() => {
        const b = document.getElementById("discussBody")!;
        return b.scrollHeight - b.scrollTop - b.clientHeight;
      });
    const nextDelta = async () => {
      const at = await deltas();
      await expect.poll(deltas, { timeout: 10_000 }).toBeGreaterThan(at);
      await page.waitForTimeout(100);
    };
    const turn = page.locator(".wiki-discuss-turn").first();
    await page.locator("#wikiDiscussInput").fill("Follow me?");
    await page.locator("#wikiDiscussInput").press("Enter");
    await expect.poll(deltas, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    await nextDelta();
    expect(await page.evaluate(() => document.getElementById("discussBody")!.scrollHeight > 300), "the answer overflows the pane").toBe(true);
    expect(await fromBottom()).toBeLessThan(40);

    // A 3 s press on the answer's text: the pane stays put meanwhile.
    const box = (await turn.locator(".wiki-discuss-answer").boundingBox())!;
    const [px, py] = [box.x + 20, Math.min(box.y + box.height - 10, 560)];
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest("#discussBody"), [px, py])).toBe(true);
    const topAtPress = await page.evaluate(() => document.getElementById("discussBody")!.scrollTop);
    await page.mouse.move(px, py);
    await page.mouse.down();
    await page.waitForTimeout(3000);
    expect(await page.evaluate(() => document.getElementById("discussBody")!.scrollTop), "no follow-scroll while the press is held").toBe(topAtPress);
    expect(await fromBottom(), "the answer grew past the margin during the press").toBeGreaterThan(40);
    await page.mouse.up();
    await nextDelta();
    expect(await turn.getAttribute("data-turn-state")).toBe("running");
    expect(await fromBottom(), "following resumed after the release").toBeLessThan(40);

    // A press that ends in a context menu, or in the window losing focus, with no pointerup.
    for (const end of ["contextmenu", "blur"] as const) {
      await page.evaluate((end) => {
        const a = document.querySelector("#discussBody .wiki-discuss-answer")!;
        a.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, button: end === "contextmenu" ? 2 : 0 }));
        if (end === "contextmenu") a.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
        else window.dispatchEvent(new FocusEvent("blur"));
      }, end);
      await nextDelta();
      await nextDelta();
      expect(await turn.getAttribute("data-turn-state")).toBe("running");
      expect(await fromBottom(), `following after a press ended by ${end}`).toBeLessThan(40);
    }

    // A press at the bottom during which the reader scrolled the pane up: no pull back down.
    await page.evaluate(() => {
      const b = document.getElementById("discussBody")!;
      const a = b.querySelector(".wiki-discuss-answer")!;
      a.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
      b.scrollTop = 0;
      a.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true }));
    });
    await nextDelta();
    expect(await turn.getAttribute("data-turn-state")).toBe("running");
    expect(await page.evaluate(() => document.getElementById("discussBody")!.scrollTop), "the reader's scroll during the press is kept").toBe(0);

    // A press that began away from the bottom does not pull the pane down after release.
    await page.evaluate(() => {
      const b = document.getElementById("discussBody")!;
      b.scrollTop = 0;
      const a = b.querySelector(".wiki-discuss-answer")!;
      a.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
      a.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true }));
    });
    await nextDelta();
    expect(await turn.getAttribute("data-turn-state")).toBe("running");
    expect(await page.evaluate(() => document.getElementById("discussBody")!.scrollTop), "a press away from the bottom leaves the pane where it was").toBe(0);
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
