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

    await page.locator("#wikiFocusExit").waitFor({ state: "hidden" });
    await page.locator(".wiki-conn-tabs [data-pane-toggle='focus']").click();
    await expect(page.locator(RAIL)).toBeHidden();
    await page.reload();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Two");
    await expect(page.locator(RAIL)).toBeVisible();
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
