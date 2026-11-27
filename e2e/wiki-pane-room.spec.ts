/**
 * The /wiki right pane's room and the Trace card's follow-up box (mimir plan
 * muninn-wiki-discuss-pane-room-and-stream, PR 1).
 *
 * What the unit tests cannot reach:
 *  1. **A drag on the pane's left edge widens the grid's last column, and a
 *     reload brings it back**: the width is read off the pane's own box, never
 *     the variable. Double-click resets it, the arrow keys step it, a stored
 *     width too wide for the window is bounded, and the collapsed strip has no
 *     handle. A drag that loses its capture ends (the rail's trap), and a rail
 *     drag re-bounds the pane. `wiki-pane-width.test.ts` holds the rules, not the DOM chain.
 *  2. **A Discuss answer's list markers stay inside the pane**: each item's
 *     text starts at least 1.2em inside the pane (an outside marker hangs about
 *     that far left of it), a nested item another 1em in; and a long path in
 *     inline code wraps only after a `/` or `-`, measured per character.
 *  3. **The Trace follow-up box reads as a field and «Send» is off while it is
 *     empty**: its background is the resolved `--bg-inset` in the dark theme
 *     (a body probe, so the token is proven to resolve); a send refused before
 *     it starts keeps the question; one that starts clears the box.
 *
 * No model and no bot: the discuss POST and the thread reads are answered in
 * the page (`page.route`). Its own muninn with `e2eEnv()`, on a git wiki in a
 * temp dir (`WIKI_EXTRA`): the Discuss tab needs `.wiki-agent.md`, the key
 * marks and the Trace card a git work tree with a commit and a `keys` kind.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";
import { PANE_ARTICLE_RESERVE, PANE_WIDTH_DEFAULT, PANE_WIDTH_KEY, PANE_WIDTH_KEY_STEP } from "../src/dashboard/views/components/wiki-pane-width.ts";
import { RAIL_WIDTH_KEY } from "../src/dashboard/views/components/wiki-rail-width.ts";
import { stubBootLine } from "./wiki-work-card-fixture.ts";

const PORT = e2ePort("wiki-pane-room");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-pane-room";
const REL = "plans/ferry.mdx";
const KEY = "MEL-1029036";
const LONG_PATH = "plans/2026-10-28-melosys-gjenstaar-oppfolging-av-saker-som-venter.mdx";
/** Chromium breaks after `-` but never after `/`: without the <wbr>s this one
 *  broke `wik|i` in a 250px column (measured), its `/`-joined run being wider. */
const SLASH_PATH = "src/dashboard/views/components/wiki-discuss-tab-view.ts";
const PAGE = ["---", "title: Ferry plan", "---", "", "# Ferry plan", "", `The night route for ${KEY} is unchanged.`, "", "The harbour opens at six.", ""].join("\n");
const ANSWER = [
  `${KEY} is named in two files:`,
  "",
  `- **${LONG_PATH}** — the open row`,
  "  - a nested note under the first file",
  "- `" + SLASH_PATH + "` — the tab's styles",
  "- `log.md` — one line",
  "",
  `Read \`${LONG_PATH}\` first.`,
].join("\n");

let server: ChildProcess | undefined;
let root = "";
let scratch = "";

const GIT_IDENT = { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" };
function git(...args: string[]): void {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_IDENT } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

test.beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "muninn-e2e-pane-room-"));
  root = path.join(scratch, "wiki");
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, ".wiki-agent.md"), "# Rules\n\nAnswer the question first.\n", "utf8");
  await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ keys: [{ name: "case", pattern: "MEL-\\d+" }] }), "utf8");
  await writeFile(path.join(root, REL), PAGE, "utf8");
  const init = spawnSync("git", ["init", "-q", "-b", "main", root], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`git init: ${init.stderr}`);
  git("add", "-A");
  git("commit", "-q", "-m", "Ferry plan names the case");

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
      /* gone */
    }
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1600, height: 1000 } });

test.beforeEach(async ({ page }) => {
  await stubBootLine(page);
  // No thread on the server: every read says so.
  await page.route("**/api/wiki/discuss/thread?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ thread: null }) }));
});

const pane = (page: Page) => page.locator(".wiki-layout > .wiki-conn-pane");
const handle = (page: Page) => page.locator("#wikiPaneResizer");
const article = (page: Page) => page.locator("#articleWrap .wiki-article");
const paneWidth = async (page: Page) => Math.round((await pane(page).boundingBox())!.width);

async function openPage(page: Page): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(article(page)).toContainText("The harbour opens at six.");
}

/** Answer the next discuss POST in the page: a turn, the answer in two deltas, done. */
async function stubTurn(page: Page, answer: string): Promise<void> {
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const ids = { turnId: "00000000-0000-4000-8000-000000000001", discussionId: "00000000-0000-4000-8000-000000000002" };
  const half = Math.floor(answer.length / 2);
  const body =
    frame("turn", { ...ids, seq: 1, location: null }) +
    frame("delta", { text: answer.slice(0, half) }) +
    frame("delta", { text: answer.slice(half) }) +
    frame("done", { ...ids, endState: "done", answer, toolCalls: [] }) +
    frame("end", {});
  await page.route("**/api/wiki/discuss", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body }), { times: 1 });
}

test("a drag on the pane's left edge widens it, a reload keeps it, double-click resets it; arrows step it, a stored width is bounded, the strip has no handle", async ({ page }) => {
  await openPage(page);
  await page.evaluate((k) => localStorage.removeItem(k), PANE_WIDTH_KEY);
  await page.reload();
  await expect(article(page)).toContainText("The harbour opens at six.");
  expect(await paneWidth(page)).toBe(PANE_WIDTH_DEFAULT);

  // The handle lies in the gap: right of the article pane, not over it.
  const h = (await handle(page).boundingBox())!;
  const art = (await page.locator(".wiki-layout > .wiki-pane:nth-child(2)").boundingBox())!;
  expect(h.x).toBeGreaterThanOrEqual(art.x + art.width);

  await page.mouse.move(h.x + h.width / 2, h.y + 200);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 150, h.y + 200, { steps: 10 });
  await page.mouse.up();
  const dragged = await paneWidth(page);
  expect(Math.abs(dragged - (PANE_WIDTH_DEFAULT + 150))).toBeLessThanOrEqual(10);
  await expect(page.locator("body.wiki-rail-dragging")).toHaveCount(0);
  const stored = Number(await page.evaluate((k) => localStorage.getItem(k), PANE_WIDTH_KEY));
  expect(Math.abs(stored - dragged)).toBeLessThanOrEqual(1);

  await page.reload();
  await expect(article(page)).toContainText("The harbour opens at six.");
  expect(Math.abs((await paneWidth(page)) - dragged)).toBeLessThanOrEqual(1);

  await handle(page).focus();
  await page.keyboard.press("ArrowLeft");
  expect(Math.abs((await paneWidth(page)) - (dragged + PANE_WIDTH_KEY_STEP))).toBeLessThanOrEqual(1);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  expect(Math.abs((await paneWidth(page)) - (dragged - PANE_WIDTH_KEY_STEP))).toBeLessThanOrEqual(1);

  await handle(page).dblclick();
  expect(await paneWidth(page)).toBe(PANE_WIDTH_DEFAULT);
  expect(await page.evaluate((k) => localStorage.getItem(k), PANE_WIDTH_KEY)).toBeNull();

  // A width stored on a wide screen is bounded in a narrower window: at
  // 1300px, 40% is 520 and the default rail leaves 1300 − 300 − 500 = 500.
  await page.evaluate((k) => localStorage.setItem(k, "720"), PANE_WIDTH_KEY);
  await page.setViewportSize({ width: 1300, height: 1000 });
  await page.reload();
  await expect(article(page)).toContainText("The harbour opens at six.");
  expect(await paneWidth(page)).toBe(500);
  // Widening the window gives the stored width back (it was never rewritten).
  await page.setViewportSize({ width: 2000, height: 1000 });
  await expect.poll(() => paneWidth(page)).toBe(720);
  expect(await page.evaluate((k) => localStorage.getItem(k), PANE_WIDTH_KEY)).toBe("720");

  // Collapsed to the strip: no handle, and the strip keeps its own width.
  await page.locator('.wiki-conn-tools [data-pane-toggle="right"]').click();
  await expect(page.locator(".wiki-layout.right-collapsed")).toHaveCount(1);
  await expect(handle(page)).toBeHidden();
  expect(await paneWidth(page)).toBeLessThan(60);
  await page.locator('.wiki-conn-strip [data-pane-toggle="right"]').click();
  await page.evaluate((k) => localStorage.removeItem(k), PANE_WIDTH_KEY);
});

test("a drag that loses its pointer capture ends: the width it reached is stored and later moves resize nothing", async ({ page }) => {
  await openPage(page);
  await page.evaluate((k) => localStorage.removeItem(k), PANE_WIDTH_KEY);
  await page.reload();
  await expect(article(page)).toContainText("The harbour opens at six.");
  const h = (await handle(page).boundingBox())!;
  const x0 = h.x + h.width / 2;
  const y0 = h.y + 200;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 - 80, y0, { steps: 4 });
  await expect(page.locator("body")).toHaveClass(/wiki-rail-dragging/);
  // The rail spec's gesture: a context menu drops the capture with no pointerup,
  // which Playwright's mouse cannot make, so the browser's event is dispatched.
  await handle(page).evaluate((el) => el.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1, bubbles: true })));
  await expect(page.locator("body")).not.toHaveClass(/wiki-rail-dragging/);
  const settled = await paneWidth(page);
  expect(settled).toBeGreaterThan(PANE_WIDTH_DEFAULT);
  await page.mouse.move(x0 - 160, y0, { steps: 3 });
  expect(await paneWidth(page)).toBe(settled);
  await page.mouse.up();
  expect(Math.abs(Number(await page.evaluate((k) => localStorage.getItem(k), PANE_WIDTH_KEY)) - settled)).toBeLessThanOrEqual(1);
  await page.evaluate((k) => localStorage.removeItem(k), PANE_WIDTH_KEY);
});

test("a wider rail narrows the pane to what it leaves the article, and a narrower one gives the stored width back", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await openPage(page);
  await page.evaluate(({ p, r }) => {
    localStorage.setItem(p, "720");
    localStorage.removeItem(r);
  }, { p: PANE_WIDTH_KEY, r: RAIL_WIDTH_KEY });
  await page.reload();
  await expect(article(page)).toContainText("The harbour opens at six.");
  // 40% of 1400 is 560; the 300px rail leaves 1400 − 300 − 500 = 600.
  expect(await paneWidth(page)).toBe(560);
  // Drag the rail to 560: the pane may take 1400 − 560 − 500 = 340.
  const rh = (await page.locator("#wikiRailResizer").boundingBox())!;
  await page.mouse.move(rh.x + rh.width / 2, rh.y + 200);
  await page.mouse.down();
  await page.mouse.move(rh.x + rh.width / 2 + 300, rh.y + 200, { steps: 8 });
  await page.mouse.up();
  const rail = async () => Math.round((await page.locator(".wiki-layout > .wiki-pane:first-child").boundingBox())!.width);
  expect(await rail()).toBe(560);
  await expect.poll(() => paneWidth(page)).toBe(1400 - 560 - PANE_ARTICLE_RESERVE);
  // The rail reset: the stored 720 is bounded by the window again.
  await page.locator("#wikiRailResizer").dblclick();
  await expect.poll(() => paneWidth(page)).toBe(560);
  await page.evaluate(({ p, r }) => {
    localStorage.removeItem(p);
    localStorage.removeItem(r);
  }, { p: PANE_WIDTH_KEY, r: RAIL_WIDTH_KEY });
});

for (const theme of ["light", "dark"] as const) {
  test(`a Discuss answer keeps its list markers inside the pane and breaks a long path only after / or - (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("muninn-theme", t), theme);
    await openPage(page);
    await page.locator('[data-conntab="discuss"]').click();
    await stubTurn(page, ANSWER);
    await page.locator("#wikiDiscussInput").fill(`where else is ${KEY}?`);
    await page.locator("#wikiDiscussAskBtn").click();
    const answer = page.locator(".wiki-discuss-turns .wiki-discuss-answer").last();
    await expect(answer).toContainText("Read");
    expect(await paneWidth(page)).toBe(PANE_WIDTH_DEFAULT);

    const m = await answer.evaluate((el) => {
      const paneLeft = el.closest(".wiki-conn-pane")!.getBoundingClientRect().left;
      const em = parseFloat(getComputedStyle(el).fontSize);
      const items = Array.from(el.querySelectorAll("li")).map((li) => {
        const parent = li.parentElement!.closest("li");
        return { inset: li.getBoundingClientRect().left - paneLeft, nested: parent ? li.getBoundingClientRect().left - parent.getBoundingClientRect().left : null };
      });
      // Where each inline code's text wraps: the character before each new line.
      const wraps: string[] = [];
      for (const code of Array.from(el.querySelectorAll("li code, :scope > code"))) {
        let prevTop: number | null = null;
        let prevChar = "";
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
          for (let i = 0; i < t.data.length; i++) {
            const r = document.createRange();
            r.setStart(t, i);
            r.setEnd(t, i + 1);
            const top = Math.round(r.getBoundingClientRect().top);
            if (prevTop !== null && top > prevTop + 2) wraps.push(prevChar);
            prevTop = top;
            prevChar = t.data[i]!;
          }
        }
      }
      return { em, items, wraps, codes: el.querySelectorAll("code").length };
    });
    expect(m.items).toHaveLength(4);
    for (const it of m.items) expect(it.inset).toBeGreaterThanOrEqual(1.2 * m.em);
    const nested = m.items.filter((it) => it.nested !== null);
    expect(nested).toHaveLength(1);
    expect(nested[0]!.nested).toBeGreaterThanOrEqual(m.em);
    // Neither path fits a 300px pane on one line: each wraps, and only after a separator.
    expect(m.wraps.length).toBeGreaterThan(0);
    for (const c of m.wraps) expect(["/", "-"]).toContain(c);
    // A copy of the answer reads the path as written (the <wbr>s add no text).
    expect(await answer.textContent()).toContain(LONG_PATH);
    expect(await answer.textContent()).toContain(SLASH_PATH);
    await answer.screenshot({ path: test.info().outputPath(`pane-answer-${theme}.png`) });
  });
}

test("the Trace follow-up box reads as a field in the dark theme; «Send» is off while it is empty; a refused send keeps the question and a started one clears it", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("muninn-theme", "dark"));
  await openPage(page);
  await article(page).locator(`.wiki-key[data-wiki-key="${KEY}"]`).hover();
  await page.locator("#wikiKeyPeek [data-key-trace]").click();
  const card = page.locator('#articleWrap .wiki-sel-card[data-sel-card="trace"]');
  await stubTurn(page, "TRACE-SUMMARY: named on one plan.");
  await card.locator("[data-trace-summarize]").click();
  await expect(card.locator('.wiki-trace-turn[data-trace-state="done"]')).toHaveCount(1);

  const input = card.locator(".wiki-trace-input");
  const send = card.locator(".wiki-trace-follow button[type=submit]");
  await expect(input).toBeVisible();
  await expect(send).toBeDisabled();
  await input.fill("   ");
  await expect(send).toBeDisabled();
  await input.fill("Which plan named it first?");
  await expect(send).toBeEnabled();

  // The field look, unfocused (focused, the border is the accent): the token
  // resolved on a probe, then compared.
  await input.blur();
  const look = await input.evaluate((el) => {
    const probe = document.createElement("div");
    probe.style.background = "var(--bg-inset)";
    probe.style.borderColor = "var(--border-secondary)";
    probe.style.borderStyle = "solid";
    document.body.appendChild(probe);
    const want = { bg: getComputedStyle(probe).backgroundColor, border: getComputedStyle(probe).borderTopColor };
    probe.remove();
    const cs = getComputedStyle(el);
    return { want, bg: cs.backgroundColor, border: cs.borderTopColor, theme: document.documentElement.dataset.theme };
  });
  expect(look.theme).toBe("dark");
  expect(look.want.bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(look.bg).toBe(look.want.bg);
  expect(look.border).toBe(look.want.border);
  await card.screenshot({ path: test.info().outputPath("trace-box-dark.png") });

  // Refused before it starts (a read-only wiki's lock): the question stays, nothing is posted.
  let posts = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/wiki/discuss") && r.method() === "POST") posts++;
  });
  await page.evaluate(() => document.body.classList.add("wiki-readonly-wiki"));
  await input.press("Enter");
  await page.waitForTimeout(200);
  expect(posts).toBe(0);
  await expect(input).toHaveValue("Which plan named it first?");

  // Started: the box clears and the turn runs.
  await page.evaluate(() => document.body.classList.remove("wiki-readonly-wiki"));
  await stubTurn(page, "FOLLOW-UP: the ferry plan.");
  await send.click();
  await expect(card.locator('.wiki-trace-turn[data-trace-state="done"]')).toHaveCount(2);
  expect(posts).toBe(1);
  await expect(input).toHaveValue("");
  await expect(send).toBeDisabled();
});
