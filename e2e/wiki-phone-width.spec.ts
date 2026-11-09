/**
 * The /wiki reader at phone and tablet widths (issue #623), in a real browser
 * over a temp wiki.
 *
 * Before the fix the rail kept its column at every width: at 390 px the
 * article was 0 px wide and the document scrolled sideways. Column widths,
 * `scrollWidth` and what a toggle shows are layout outcomes no unit test sees.
 *  1. At 390, 430, 600 and 768 px the article pane spans the viewport less a
 *     16 px gutter each side, the rail and the right pane take no column, and
 *     neither the document nor the layout scrolls sideways — on a page with a
 *     wide table, a long code line and an unbroken URL, which breaks.
 *  2. The Pages toggle shows the rail in the article's place and hides it
 *     again (Esc, the toggle, and opening a page from it); the article keeps
 *     its scroll position underneath.
 *  3. At 1440 px the three columns measure what they did before the fix, and
 *     the toggle is not on screen.
 *
 * `WIKI_PHONE_SHOTS=<dir>` also writes a screenshot per width and theme (the
 * PR's pictures); unset, the spec takes none.
 *
 * One muninn on its own port (the shared 3011 server's wikis are the
 * developer's). No model calls, no DB writes. ENV / SPAWN ENV: the spawn
 * inherits `DATABASE_URL` and `e2eEnv()` blanks the platform tokens and the
 * host's instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { assertPortFree, waitForOwnServer } from "./own-server.ts";
import { e2ePort } from "./ports.ts";
import { RAIL_WIDTH_DEFAULT } from "../src/dashboard/views/components/wiki-rail-width.ts";

const PORT = e2ePort("wiki-phone-width");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-phone";
const SHOTS = process.env.WIKI_PHONE_SHOTS ?? "";

const NARROW = [390, 430, 600, 768] as const;
const GUTTER = 16;

const para = (n: number) =>
  Array.from({ length: n }, (_, k) => `Paragraph ${k + 1}: a reader on a phone reads this text in one column, and it wraps inside the viewport.`).join("\n\n");

const REPORT = [
  "---",
  "title: Phone report",
  "type: report",
  "---",
  "",
  "# Phone report",
  "",
  "## Summary",
  "",
  para(3),
  "",
  "See [[notes/second-page]] and https://example.com/a/very/long/path/that/does/not/break/anywhere/at/all/in/the/middle/of/the/line/because/it/has/no/spaces.",
  "",
  "## Numbers",
  "",
  "| Width | Rail before | Article before | Document scroll width | Right pane | Verdict | Note |",
  "|---|---|---|---|---|---|---|",
  "| 390 | 301 | 0 | 439 | hidden | broken | the article has no width |",
  "| 430 | 301 | 40 | 430 | hidden | broken | a sliver |",
  "| 600 | 301 | 210 | 600 | hidden | cramped | under a readable measure |",
  "",
  "```ts",
  "const aVeryLongLine = someFunction(withManyArguments, thatKeepGoing, pastTheEdge, ofAnyPhone, everMade, andThenSome, more);",
  "```",
  "",
  "## Detail",
  "",
  para(8),
  "",
].join("\n");

const SECOND = ["---", "title: Second page", "type: concept", "---", "", "# Second page", "", "Back to [[phone-report]].", "", para(2), ""].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-phone-"));
  await mkdir(path.join(root, "notes"), { recursive: true });
  await writeFile(path.join(root, "phone-report.md"), REPORT, "utf8");
  await writeFile(path.join(root, "notes", "second-page.md"), SECOND, "utf8");
  if (SHOTS) await mkdir(SHOTS, { recursive: true });

  await assertPortFree(PORT);
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
  await waitForOwnServer(server, `${BASE}/api/wiki/pages?wiki=${WIKI}`);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
});

const RAIL = ".wiki-layout > .wiki-pane:first-child";
const ARTICLE_PANE = ".wiki-layout > .wiki-pane:nth-child(2)";
const CONN = ".wiki-layout > .wiki-conn-pane";
const TOGGLE = "#wikiRailToggle";

async function open(page: Page, width: number, height = 844): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=phone-report.md`);
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Phone report");
  await expect(page.locator(".wiki-article table")).toBeVisible();
}

type Measure = {
  docScroll: number;
  docClient: number;
  layoutScroll: number;
  layoutClient: number;
  rail: { x: number; w: number; shown: boolean };
  pane: { x: number; w: number };
  wrap: { x: number; w: number };
  article: { x: number; w: number };
  conn: { x: number; w: number; shown: boolean };
};

/** Bounding boxes, never classes: a class the grid does not read still toggles. */
async function measure(page: Page): Promise<Measure> {
  return page.evaluate(
    ([railSel, paneSel, connSel]) => {
      const box = (el: Element | null) => {
        const r = el?.getBoundingClientRect();
        return { x: Math.round(r?.x ?? -1), w: Math.round(r?.width ?? -1) };
      };
      const shown = (el: Element | null) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
      const layout = document.querySelector(".wiki-layout")!;
      const rail = document.querySelector(railSel!);
      const conn = document.querySelector(connSel!);
      return {
        docScroll: document.documentElement.scrollWidth,
        docClient: document.documentElement.clientWidth,
        layoutScroll: layout.scrollWidth,
        layoutClient: layout.clientWidth,
        rail: { ...box(rail), shown: shown(rail) },
        pane: box(document.querySelector(paneSel!)),
        wrap: box(document.querySelector("#articleWrap")),
        article: box(document.querySelector(".wiki-article")),
        conn: { ...box(conn), shown: shown(conn) },
      };
    },
    [RAIL, ARTICLE_PANE, CONN],
  );
}

async function shots(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`) });
  }
}

test.describe("Wiki reader at phone width", () => {
  for (const w of NARROW) {
    test(`${w}px: the article takes the viewport with a 16px gutter and nothing scrolls sideways`, async ({ page }) => {
      await open(page, w);
      const m = await measure(page);
      console.log(`measure ${w}: ${JSON.stringify(m)}`);
      // Prose never runs past the pane: the unbroken URL breaks. (A wide table
      // and a long code line still scroll inside the pane, by design.)
      const proseOver = await page.evaluate(() => {
        const edge = document.querySelector("#articleWrap")!.getBoundingClientRect().right;
        return Array.from(document.querySelectorAll(".wiki-article p, .wiki-article p a")).filter((e) => e.getBoundingClientRect().right > edge).length;
      });
      expect(proseOver, "paragraphs past the pane's right edge").toBe(0);
      await shots(page, `w${w}`);

      expect(m.docScroll, "document scrollWidth").toBe(w);
      expect(m.layoutScroll, "layout scrollWidth").toBe(m.layoutClient);
      expect(m.rail.shown, "rail takes no column").toBe(false);
      expect(m.conn.shown, "right pane takes no column").toBe(false);
      expect(m.pane.x, "left gutter").toBe(GUTTER);
      expect(m.pane.w, "article pane width").toBe(w - 2 * GUTTER);
      // The article: the pane less its 1px border and 16px padding, each side.
      expect(m.article.x, "article left edge").toBe(GUTTER + 1 + 16);
      expect(m.article.w, "article width").toBe(w - 2 * (GUTTER + 1 + 16));
      await expect(page.locator(TOGGLE)).toBeVisible();
    });
  }

  test("390px: the Pages toggle shows the rail over the article, and Esc, the toggle and opening a page hide it", async ({ page }) => {
    await open(page, 390);
    const toggle = page.locator(TOGGLE);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(RAIL)).toBeHidden();

    await page.locator("#articleWrap").evaluate((el) => el.scrollTo(0, 300));
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(RAIL)).toBeVisible();
    await expect(page.locator(".wiki-list-item")).toHaveCount(2);
    const open1 = await measure(page);
    // In the article's cell, over it: the article keeps its box underneath.
    expect(open1.rail).toEqual({ x: GUTTER, w: 390 - 2 * GUTTER, shown: true });
    expect(open1.pane).toEqual({ x: GUTTER, w: 390 - 2 * GUTTER });
    const top = await page.evaluate((sel) => document.elementFromPoint(195, 400)?.closest(sel) !== null, RAIL);
    expect(top, "the rail is what a tap in the middle reaches").toBe(true);
    expect(open1.docScroll).toBe(390);
    await shots(page, "w390-rail-open");

    await page.keyboard.press("Escape");
    await expect(page.locator(RAIL)).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(await page.locator("#articleWrap").evaluate((el) => el.scrollTop)).toBe(300);

    await toggle.click();
    await expect(page.locator(RAIL)).toBeVisible();
    await toggle.click();
    await expect(page.locator(RAIL)).toBeHidden();

    // Opening a page from the rail closes it: the reader asked for the page.
    await toggle.click();
    await page.locator(".wiki-list-item", { hasText: "Second page" }).click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Second page");
    await expect(page.locator(RAIL)).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect((await measure(page)).docScroll).toBe(390);
  });

  // Review finding 1: the Atlas's nodes carry their own z-index (5 to 7) and
  // the article pane makes no stacking context, so a selected node was drawn
  // over the open page list and took its taps.
  test("390px, Atlas tab: nothing of the Atlas shows through the open rail", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&view=atlas`);
    const node = page.locator('.wiki-atlas-canvas[data-view="types"] .wiki-atlas-node').first();
    await expect(node).toBeVisible();
    await node.click();
    await expect(page.locator(".wiki-atlas-node.on")).toHaveCount(1);
    const at = await page.locator(".wiki-atlas-node.on").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.locator(TOGGLE).click();
    await expect(page.locator(RAIL)).toBeVisible();
    const hit = await page.evaluate(([p, sel]) => document.elementFromPoint((p as { x: number }).x, (p as { y: number }).y)?.closest(sel as string) !== null, [at, RAIL] as const);
    expect(hit, "the rail is what a tap on the selected node's place reaches").toBe(true);
    await expect(page.locator(".wiki-atlas-node.on")).toBeHidden();
  });

  // Review finding 2: the covered article stayed in the tab order, Tab from
  // the button left the page, and a closed panel dropped focus on <body>.
  test("390px: focus goes into the open rail, the covered article takes none, and closing returns it to the button", async ({ page }) => {
    await open(page, 390);
    const toggle = page.locator(TOGGLE);
    const inRail = () => page.evaluate((sel) => document.activeElement?.closest(sel) !== null, RAIL);
    const railId = await page.locator(RAIL).getAttribute("id");
    expect(railId).toBeTruthy();
    await expect(toggle).toHaveAttribute("aria-controls", railId!);

    await toggle.click();
    expect(await inRail(), "focus is in the rail after opening").toBe(true);
    // The article under the panel is not rendered to the reader or to Tab.
    await expect(page.locator("#articleWrap")).toBeHidden();
    await page.keyboard.press("Tab");
    expect(await inRail(), "Tab stays in the rail").toBe(true);

    await page.locator(".wiki-list-item", { hasText: "Second page" }).click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Second page");
    await expect(toggle, "opening a page returns focus to the button").toBeFocused();
    await expect(page.locator("#articleWrap")).toBeVisible();

    // Show in list is pressed from the article, which the panel then covers.
    await page.locator("#wikiLocateBtn").click();
    await expect(page.locator(RAIL)).toBeVisible();
    expect(await inRail(), "focus is in the rail after Show in list").toBe(true);
    await page.keyboard.press("Escape");
    await expect(toggle, "Escape returns focus to the button").toBeFocused();
  });

  // Review finding 5: with a menu open and focus on <body>, the panel's Escape
  // ran first and prevented the menu's own. The menu here is a stand-in with
  // the role the rail's Group menu and the reader's popovers carry: the rule
  // under test is "a rendered menu or dialog owns Escape", whoever drew it.
  test("390px: Escape belongs to an open menu, wherever focus is", async ({ page }) => {
    await open(page, 390);
    await page.locator(TOGGLE).click();
    await expect(page.locator(RAIL)).toBeVisible();
    await page.locator("#wikiList").evaluate((el) => {
      el.insertAdjacentHTML("afterbegin", '<div role="menu" id="e2eMenu">menu</div>');
      (document.activeElement as HTMLElement | null)?.blur();
    });
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    const prevented = await page.evaluate(() => new Promise<boolean>((resolve) => {
      document.addEventListener("keydown", (e) => resolve(e.defaultPrevented), { once: true });
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    }));
    expect(prevented, "the panel left the menu's Escape alone").toBe(false);
    await expect(page.locator(RAIL)).toBeVisible();
    // With the menu gone, Escape is the panel's again.
    await page.locator("#e2eMenu").evaluate((el) => el.remove());
    await page.keyboard.press("Escape");
    await expect(page.locator(RAIL)).toBeHidden();
  });

  test("an open rail does not follow the reader to a wide window", async ({ page }) => {
    await open(page, 390);
    await page.locator(TOGGLE).click();
    await expect(page.locator(RAIL)).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    const m = await measure(page);
    expect(m.rail).toEqual({ x: 24, w: RAIL_WIDTH_DEFAULT, shown: true });
    expect(m.pane.x).toBe(24 + RAIL_WIDTH_DEFAULT + 16);
  });

  test("1440px: the three columns measure what they did before the fix and the toggle is not on screen", async ({ page }) => {
    await open(page, 1440, 900);
    const m = await measure(page);
    console.log(`measure 1440: ${JSON.stringify(m)}`);
    await shots(page, "w1440");

    // Measured on main 379e67d4 before the fix, this fixture, 1440×900.
    expect(m).toEqual(DESKTOP_BEFORE);
    await expect(page.locator(TOGGLE)).toBeHidden();
  });
});

const DESKTOP_BEFORE: Measure = {
  docScroll: 1440,
  docClient: 1440,
  layoutScroll: 1440,
  layoutClient: 1440,
  rail: { x: 24, w: 300, shown: true },
  pane: { x: 340, w: 760 },
  wrap: { x: 341, w: 758 },
  article: { x: 373, w: 694 },
  conn: { x: 1116, w: 300, shown: true },
};
