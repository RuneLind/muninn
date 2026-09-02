/**
 * Remember the wiki · return to the overview · the start tab survives — the
 * /wiki reader's "where was I" rules (`components/wiki-home.ts`) as wired.
 *
 * The pure rules are unit-tested; what only a real page can hold:
 *
 *  1. **A bare `/wiki` lands on the wiki last opened by URL.** The store write,
 *     the picker-options check and the `location.replace` are three DOM steps
 *     the unit test cannot see, and a fresh context must still land on the
 *     server's default — so both wikis here are temp roots in ONE process, and
 *     the remembered one is the SECOND registered (never the default).
 *  2. **The breadcrumb's wiki crumb returns to the overview** and pushes the
 *     overview URL (the coverage footer used to call `renderStart` and leave
 *     the article's URL in the address bar).
 *  3. **The start tab is in the URL and remembered per wiki**: a reload and Back
 *     from an article both land on the tab the reader left, and the other wiki
 *     opens on Hubs.
 *
 * No model calls. ENV: as every spec here — a working `.env`, plus `e2eEnv()`.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-home");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-home";
const OTHER = "e2e-home-other";
const ARTICLE = "concepts/alpha.md";

function md(title: string): string {
  return `---\ntitle: ${title}\n---\n\nBody of ${title}.\n`;
}

let server: ChildProcess | undefined;
let root = "";
let otherRoot = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-home-"));
  otherRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-home-other-"));
  await mkdir(path.join(root, "concepts"), { recursive: true });
  await writeFile(path.join(root, ARTICLE), md("Alpha"), "utf8");
  await writeFile(path.join(root, "concepts/beta.md"), md("Beta"), "utf8");
  await writeFile(path.join(otherRoot, "only-here.md"), md("Only Here"), "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_DIR: "",
      WIKI_EXTRA: `${WIKI}=${root},${OTHER}=${otherRoot}`,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${OTHER}`);
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
  if (otherRoot) await rm(otherRoot, { recursive: true, force: true });
});

const renderedWiki = (page: Page) => page.evaluate(() => (window as unknown as { __WIKI_NAME__: string }).__WIKI_NAME__);
const activeTab = (page: Page) => page.locator(".wiki-tab.active").getAttribute("data-tab");

async function openStart(page: Page, wiki: string): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  await expect(page.locator(".wiki-start")).toBeVisible();
}

test("a bare /wiki opens the wiki last opened by URL; a fresh context does not", async ({ browser }) => {
  const fresh = await browser.newContext();
  const p0 = await fresh.newPage();
  await p0.goto(`${BASE}/wiki`);
  await expect(p0.locator(".wiki-start")).toBeVisible();
  // Nothing remembered: the server's default, whatever it is, is not OTHER —
  // OTHER is the second registered wiki and no bot claims it.
  expect(await renderedWiki(p0)).not.toBe(OTHER);
  expect(p0.url()).not.toContain(`wiki=${OTHER}`);
  await fresh.close();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await openStart(page, OTHER);
  await page.goto(`${BASE}/wiki`);
  await page.waitForURL((u) => u.searchParams.get("wiki") === OTHER);
  await expect(page.locator(".wiki-start")).toBeVisible();
  expect(await renderedWiki(page)).toBe(OTHER);
  // The site nav's "Wiki" link carries the remembered wiki on every page.
  await page.goto(`${BASE}/traces`);
  await expect(page.locator('a.nav-link[href="/wiki?wiki=' + OTHER + '"]')).toHaveCount(1);
  // A URL that names its wiki is never redirected away from.
  await openStart(page, WIKI);
  expect(await renderedWiki(page)).toBe(WIKI);
  await ctx.close();
});

test("the breadcrumb's wiki crumb returns to the overview and pushes its URL", async ({ page }) => {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(ARTICLE)}`);
  const crumb = page.locator("a.wiki-bc-wiki");
  await expect(crumb).toBeVisible();
  await expect(crumb).toHaveAttribute("href", `/wiki?wiki=${WIKI}`);
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  await crumb.click();
  await expect(page.locator(".wiki-start")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("relPath")).toBeNull();
  expect(new URL(page.url()).searchParams.get("wiki")).toBe(WIKI);
  // Back returns to the article: the overview was PUSHED, not swapped in.
  await page.goBack();
  await expect(page.locator("a.wiki-bc-wiki")).toBeVisible();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
});

test("the start tab lives in the URL, survives reload and Back, and is per wiki", async ({ page }) => {
  await openStart(page, WIKI);
  expect(await activeTab(page)).toBe("hubs");
  await page.locator('.wiki-tab[data-tab="timeline"]').click();
  expect(await activeTab(page)).toBe("timeline");
  expect(new URL(page.url()).searchParams.get("view")).toBe("timeline");

  await page.reload();
  await expect(page.locator(".wiki-start")).toBeVisible();
  expect(await activeTab(page)).toBe("timeline");

  // Stored, not just in the URL: the bare wiki URL opens on the remembered tab.
  await openStart(page, WIKI);
  expect(await activeTab(page)).toBe("timeline");

  await page.locator(`.wiki-list-item[data-relpath="${ARTICLE}"]`).click();
  await expect(page.locator("a.wiki-bc-wiki")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".wiki-start")).toBeVisible();
  expect(await activeTab(page)).toBe("timeline");

  // A shared link names the tab; the OTHER wiki has its own memory (Hubs).
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&view=hubs`);
  await expect(page.locator(".wiki-start")).toBeVisible();
  expect(await activeTab(page)).toBe("hubs");
  await openStart(page, OTHER);
  expect(await activeTab(page)).toBe("hubs");
});
