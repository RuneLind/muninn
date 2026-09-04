/**
 * The /wiki reader's pane toggles: collapse Connections/Ask to an icon strip
 * (remembered), and a focus mode that drops both side panes (not remembered).
 *
 * What the unit tests (`wiki-panes.test.ts`) cannot reach — every assertion here
 * is on a BOUNDING BOX, never on a class: a class the grid does not read would
 * still "toggle".
 *  1. Collapse → the pane is the strip width and the article gained the
 *     difference; a reload keeps it (localStorage).
 *  2. A strip icon expands the pane AND selects that tab.
 *  3. F → rail and pane gone, article spans the layout; Esc restores; a reload
 *     does NOT bring focus back.
 *  4. `]` typed into the Ask textarea is a character, not a toggle.
 *
 * No model calls. ENV / SPAWN: as every spec here — `e2eEnv()` keeps this
 * muninn off Telegram/Slack and off the host's instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { PANES_KEY, STRIP_WIDTH } from "../src/dashboard/views/components/wiki-panes.ts";

const PORT = e2ePort("wiki-pane-toggles");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-panes";

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-panes-"));
  await writeFile(path.join(root, "one.md"), ["---", "title: One", "---", "", "# One", "", "Links to [[Two]].", ""].join("\n"), "utf8");
  await writeFile(path.join(root, "two.md"), ["---", "title: Two", "---", "", "# Two", "", "Body.", ""].join("\n"), "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root}`,
    },
    stdio: "ignore",
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
  server?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
});

const LAYOUT = ".wiki-layout";
const RAIL = ".wiki-layout > .wiki-pane:first-child";
const ARTICLE = ".wiki-layout > .wiki-pane:nth-child(2)";
const CONN = ".wiki-layout > .wiki-conn-pane";

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=one.md`);
  await expect(page.locator(".wiki-list-item")).toHaveCount(2);
  await expect(page.locator(".wiki-article-head h1")).toHaveText("One");
}

async function width(page: Page, sel: string): Promise<number> {
  const box = await page.locator(sel).boundingBox();
  if (!box) throw new Error(`${sel} not laid out`);
  return Math.round(box.width);
}

test.describe("Wiki pane toggles", () => {
  test("collapse folds the pane to the strip, widens the article, and a reload keeps it", async ({ page }) => {
    await open(page);
    const connBefore = await width(page, CONN);
    const artBefore = await width(page, ARTICLE);
    expect(connBefore).toBeGreaterThan(STRIP_WIDTH + 100);

    await page.locator(".wiki-conn-tabs [data-pane-toggle='right']").click();
    expect(await width(page, CONN)).toBe(STRIP_WIDTH);
    // The article gets exactly what the pane gave up (the grid gap is unchanged).
    expect(await width(page, ARTICLE)).toBe(artBefore + (connBefore - STRIP_WIDTH));
    await expect(page.locator(".wiki-conn-tabs")).toBeHidden();
    await expect(page.locator("#wikiConnStrip")).toBeVisible();
    expect(await page.evaluate((k) => localStorage.getItem(k), PANES_KEY)).toBe("collapsed");

    await page.reload();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("One");
    expect(await width(page, CONN)).toBe(STRIP_WIDTH);

    // ] brings it back, and forgets the preference.
    await page.locator("body").press("]");
    expect(await width(page, CONN)).toBe(connBefore);
    expect(await page.evaluate((k) => localStorage.getItem(k), PANES_KEY)).toBeNull();
  });

  test("a strip icon expands the pane and selects that tab", async ({ page }) => {
    await open(page);
    await page.locator("body").press("]");
    await expect(page.locator("#wikiConnStrip")).toBeVisible();
    await page.locator("#wikiConnStrip [data-pane-open='ask']").click();
    await expect(page.locator(".wiki-conn-tabs")).toBeVisible();
    await expect(page.locator(".wiki-conn-tab[data-conntab='ask']")).toHaveClass(/active/);
    await expect(page.locator("#askBody")).toBeVisible();
    await expect(page.locator("#connBody")).toBeHidden();
  });

  test("F drops both side panes, Esc restores, a reload does not remember focus", async ({ page }) => {
    await open(page);
    const layoutW = await width(page, LAYOUT);
    await page.locator("body").press("f");
    await expect(page.locator(RAIL)).toBeHidden();
    await expect(page.locator(CONN)).toBeHidden();
    await expect(page.locator("#wikiFocusExit")).toBeVisible();
    // The article is the whole layout minus its padding (24px each side).
    expect(await width(page, ARTICLE)).toBe(layoutW - 48);

    // Following a wikilink keeps focus — it is the reading focus was entered for.
    await page.locator(".wiki-article a", { hasText: "Two" }).click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Two");
    await expect(page.locator(RAIL)).toBeHidden();

    await page.locator("body").press("Escape");
    await expect(page.locator(RAIL)).toBeVisible();
    await expect(page.locator(CONN)).toBeVisible();
    await expect(page.locator("#wikiFocusExit")).toBeHidden();

    await page.locator(".wiki-conn-tabs [data-pane-toggle='focus']").click();
    await expect(page.locator(RAIL)).toBeHidden();
    await page.reload();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Two");
    await expect(page.locator(RAIL)).toBeVisible();
  });

  test("a remembered collapse does not squeeze the Atlas (fix round 1)", async ({ page }) => {
    await open(page);
    await page.locator("body").press("]");
    expect(await width(page, CONN)).toBe(STRIP_WIDTH);
    // The start view's Atlas tab collapses BOTH side panes; with the collapse
    // stored, the article must still take the whole layout (minus 24px padding).
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await page.locator(".wiki-tab[data-tab='atlas']").click();
    await expect(page.locator(LAYOUT)).toHaveClass(/atlas-full/);
    expect(await width(page, ARTICLE)).toBe((await width(page, LAYOUT)) - 48);
  });

  test("collapsing FROM the Ask tab hides the Ask form too (fix round 1)", async ({ page }) => {
    await open(page);
    await page.locator(".wiki-conn-tab[data-conntab='ask']").click();
    await expect(page.locator("#askBody")).toBeVisible();
    await page.locator(".wiki-conn-tabs [data-pane-toggle='right']").click();
    expect(await width(page, CONN)).toBe(STRIP_WIDTH);
    await expect(page.locator("#askBody")).toBeHidden();
    await expect(page.locator("#wikiAskInput")).toBeHidden();
    // …and expanding again brings the Ask tab back as it was.
    await page.locator("body").press("]");
    await expect(page.locator("#askBody")).toBeVisible();
    await expect(page.locator(".wiki-conn-tab[data-conntab='ask']")).toHaveClass(/active/);
  });

  // One test per width (the copy-path sweep's shape): a second setViewportSize
  // inside one test trips Chromium's window-bounds protocol error.
  for (const w of [1000, 1400]) {
    test(`the exit pill does not cover the breadcrumb actions in focus mode at ${w}px (fix round 1)`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=one.md`);
      await expect(page.locator(".wiki-article-head h1")).toHaveText("One");
      await page.locator("body").press("f");
      const pill = await page.locator("#wikiFocusExit").boundingBox();
      const share = await page.locator("#wikiShareBtn").boundingBox();
      if (!pill || !share) throw new Error("pill or share button not laid out");
      const overlap = pill.x < share.x + share.width && share.x < pill.x + pill.width && pill.y < share.y + share.height && share.y < pill.y + pill.height;
      expect(overlap, `pill overlaps Share at ${w}px`).toBe(false);
      // The click must LAND on Share, not on the pill: the element at Share's centre is Share.
      const hit = await page.evaluate(() => {
        const b = document.getElementById("wikiShareBtn")!.getBoundingClientRect();
        return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest("#wikiShareBtn")?.id ?? null;
      });
      expect(hit).toBe("wikiShareBtn");
      // Single-line pill.
      expect(pill.height).toBeLessThan(30);
      // In FLOW above the breadcrumb, not floated over it: the pill's bottom is
      // at or above the breadcrumb's top. A floated pill with a small enough
      // icon clears Share by geometry and passed the two asserts above.
      const crumb = await page.locator("#wikiBreadcrumb").boundingBox();
      if (!crumb) throw new Error("breadcrumb not laid out");
      expect(pill.y + pill.height).toBeLessThanOrEqual(crumb.y + 0.5);
    });
  }

  test("a remembered collapse does not squeeze the Atlas below 1100px either (fix round 2)", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(2);
    await page.evaluate((k) => localStorage.setItem(k, "collapsed"), PANES_KEY);
    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(2);
    await page.locator(".wiki-tab[data-tab='atlas']").click();
    await expect(page.locator(LAYOUT)).toHaveClass(/atlas-full/);
    expect(await width(page, ARTICLE)).toBe((await width(page, LAYOUT)) - 48);
    await page.evaluate((k) => localStorage.removeItem(k), PANES_KEY);
  });

  test("Explain reveals a collapsed pane for THIS sitting and keeps the stored collapse (fix round 2)", async ({ page }) => {
    // The stream is stubbed: the reveal happens before the connection opens, so
    // one terminal app_error event is all the server needs to say.
    await page.route("**/api/wiki/explain*", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: 'event: app_error\ndata: {"message":"stubbed"}\n\n',
      }),
    );
    await open(page);
    await page.locator("body").press("]");
    expect(await width(page, CONN)).toBe(STRIP_WIDTH);
    // Select a passage the way a reader does: a range over the paragraph, then
    // the mouseup the article pane listens for.
    await page.evaluate(() => {
      // A one-line body renders as bare text inside .wiki-article (no <p>), so
      // select the body container's contents.
      const body = document.querySelector("#articleWrap .wiki-article");
      if (!body) throw new Error("no article body");
      const r = document.createRange();
      r.selectNodeContents(body);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
      document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const explain = page.locator("#wikiExplainBtn");
    await expect(explain).toBeVisible();
    await explain.dispatchEvent("mousedown");
    // The pane is back on screen, on the Ask tab, with the answer streaming…
    await expect(page.locator(".wiki-conn-tabs")).toBeVisible();
    expect(await width(page, CONN)).toBeGreaterThan(STRIP_WIDTH + 100);
    await expect(page.locator(".wiki-conn-tab[data-conntab='ask']")).toHaveClass(/active/);
    // …and the reader's stored preference is untouched: a reload folds it again.
    expect(await page.evaluate((k) => localStorage.getItem(k), PANES_KEY)).toBe("collapsed");
    await page.reload();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("One");
    expect(await width(page, CONN)).toBe(STRIP_WIDTH);
    await page.evaluate((k) => localStorage.removeItem(k), PANES_KEY);
  });

  test("] is inert where the pane is not on screen: below 1100px and in focus mode (fix round 1)", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=one.md`);
    await expect(page.locator(".wiki-article-head h1")).toHaveText("One");
    await expect(page.locator(CONN)).toBeHidden();
    await page.locator("body").press("]");
    expect(await page.evaluate((k) => localStorage.getItem(k), PANES_KEY)).toBeNull();
    // A collapse stored on a wide screen folds into the two-column grid here:
    // the article reaches the layout's right padding, no dead 40px column.
    await page.evaluate((k) => localStorage.setItem(k, "collapsed"), PANES_KEY);
    await page.reload();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("One");
    const layout = await page.locator(LAYOUT).boundingBox();
    const art = await page.locator(ARTICLE).boundingBox();
    if (!layout || !art) throw new Error("not laid out");
    expect(Math.round(art.x + art.width)).toBe(Math.round(layout.x + layout.width) - 24);
    await page.evaluate((k) => localStorage.removeItem(k), PANES_KEY);

    await open(page);
    await page.locator("body").press("f");
    await page.locator("body").press("]");
    expect(await page.evaluate((k) => localStorage.getItem(k), PANES_KEY)).toBeNull();
    await page.locator("body").press("Escape");
    expect(await width(page, CONN)).toBeGreaterThan(STRIP_WIDTH + 100);
  });

  test("the strip's expand button is not announced as pressed; the tab-row collapse button is (fix round 1)", async ({ page }) => {
    await open(page);
    const hide = page.locator(".wiki-conn-tabs [data-pane-toggle='right']");
    await expect(hide).toHaveAttribute("aria-pressed", "false");
    await hide.click();
    await expect(hide).toHaveAttribute("aria-pressed", "true");
    const show = page.locator("#wikiConnStrip [data-pane-toggle='right']");
    await expect(show).toBeVisible();
    expect(await show.getAttribute("aria-pressed")).toBeNull();
    // The focus buttons are toggles on both surfaces.
    await page.locator("body").press("f");
    await expect(page.locator("#wikiFocusExit")).toBeVisible();
    await page.locator("body").press("Escape");
    await expect(page.locator("#wikiConnStrip [data-pane-toggle='focus']")).toHaveAttribute("aria-pressed", "false");
  });

  test("] typed into the Ask box is a character, not a toggle", async ({ page }) => {
    await open(page);
    await page.locator(".wiki-conn-tab[data-conntab='ask']").click();
    const input = page.locator("#wikiAskInput");
    await input.click();
    await input.press("]");
    await input.press("f");
    await expect(input).toHaveValue("]f");
    await expect(page.locator(".wiki-conn-tabs")).toBeVisible();
    await expect(page.locator(RAIL)).toBeVisible();
  });
});
