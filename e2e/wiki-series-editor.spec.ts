/**
 * The SERIES EDITOR — campaign 2 PR D's acceptance 11, end to end.
 *
 * What only a browser can prove, and the reason this file exists:
 *
 *  1. **The click reaches the file.** A menu whose model is perfect is still
 *     dead if the opener is not rendered, the delegate does not claim it, the
 *     CAS base is never fetched or the POST body names a key the route does not
 *     read. The assertions here are on the BYTES on disk.
 *  2. **The rail re-renders.** The write refreshes the wiki index server-side,
 *     but nothing on screen moves unless the client refetches AND applies — and
 *     `receivePages` defers an applied listing while an article is open, which
 *     is exactly the state the reader header's `edit series` acts from.
 *  3. **`#wikiCount` is unchanged.** A series claims its members before the
 *     family and month rules see the list; a page joining one must move, not
 *     appear twice or vanish.
 *  4. **The read-only refusal is ABSENT, not dimmed** — and the POST behind it
 *     really 403s, against a muninn actually booted in that mode.
 *
 * No model calls: nothing here leaves the process.
 *
 * ENV PREREQUISITE / SPAWN ENV: as every other spec in this directory — a
 * working `.env` at the repo root, and `e2eEnv()` to keep these muninns off
 * Telegram/Slack and off the host's instance-profile flags. That second half
 * matters most here: the writable instance is only writable if the host's own
 * `MUNINN_WIKI_READONLY` does not reach it, and the two servers are deliberately
 * in DIFFERENT write modes.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";

const PORT = e2ePort("wiki-series-editor");
const RO_PORT = e2ePort("wiki-series-editor/readonly");
const BASE = `http://127.0.0.1:${PORT}`;
const RO_BASE = `http://127.0.0.1:${RO_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-series-edit";
/** A SECOND wiki on the writable server, registered read-only per root — the
 *  mini's exact shape, where the instance owns writes and this root is one it
 *  only reads. */
const RO_WIKI = "e2e-series-edit-ro";
const LABEL = "Wiki provenance";
const KEY = "prov";
const FOLD = `series:${KEY}`;

const HEAD = "plans/prov-plan.mdx";
const SHIPPED = "plans/prov-strip.mdx";
const BLOG = "blogs/prov-explained.mdx";
/** The page acceptance 11 adds to the series. */
const JOINER = "plans/recall.mdx";
const OUTSIDER = "plans/solo.mdx";

function md(title: string, extra: string[] = []): string {
  return ["---", `title: ${title}`, SETTLED_CREATED_LINE, ...extra, "---", "", "Body.", ""].join(
    "\n",
  );
}

const PAGES: Array<[string, string]> = [
  [
    HEAD,
    md("Wiki provenance plan", [
      `series: ${KEY}`,
      `series_label: ${LABEL}`,
      "plan_status: in-flight",
      "status_date: 2026-09-02",
    ]),
  ],
  [
    SHIPPED,
    md("Provenance chain strip", [`series: ${KEY}`, "plan_status: shipped", "status_date: 2026-05-01"]),
  ],
  [BLOG, md("Provenance campaign explained", [`series: ${KEY}`, "status_date: 2026-03-01"])],
  [JOINER, md("Search recall plan", ["plan_status: proposed", "status_date: 2026-09-03"])],
  [OUTSIDER, md("Solo page", ["plan_status: shipped", "status_date: 2026-01-01"])],
];

let server: ChildProcess | undefined;
let roServer: ChildProcess | undefined;
let root = "";
let roRoot = "";
let roServerRoot = "";

async function writeWiki(dir: string): Promise<void> {
  for (const [rel, body] of PAGES) {
    await mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body, "utf8");
  }
  await settleWikiMtimes(dir);
}

function boot(port: number, extra: string, env: Record<string, string> = {}): ChildProcess {
  return spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: extra,
      ...env,
    },
    stdio: "ignore",
  });
}

async function waitUp(base: string, wiki: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/wiki/pages?wiki=${wiki}`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`muninn did not start on ${base}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

const read = (dir: string, rel: string) => readFile(path.join(dir, rel), "utf8");

/** The page's frontmatter lines — what every byte assertion here is about. */
async function fence(dir: string, rel: string): Promise<string[]> {
  const lines = (await read(dir, rel)).split("\n");
  const close = lines.indexOf("---", 1);
  return lines.slice(1, close === -1 ? 1 : close);
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-sered-"));
  await writeWiki(root);
  // The writable server's SECOND wiki, registered read-only by root.
  roRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-sered-roroot-"));
  await writeWiki(roRoot);
  // The read-only INSTANCE gets a corpus of its own, so a refused write there
  // can never be confused with one that landed on the writable server's copy.
  roServerRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-sered-ro-"));
  await writeWiki(roServerRoot);

  server = boot(PORT, `${WIKI}=${root},${RO_WIKI}=${roRoot}`, {
    WIKI_READONLY_ROOTS: roRoot,
  });
  roServer = boot(RO_PORT, `${WIKI}=${roServerRoot}`, { MUNINN_WIKI_READONLY: "1" });
  await Promise.all([waitUp(BASE, WIKI), waitUp(RO_BASE, WIKI)]);
});

/**
 * Reset the writable corpus between cases — every case here writes.
 *
 * The `?refresh=1` is load-bearing: the store's index is a 5-minute TTL cache
 * and these files are rewritten BEHIND the server, so without it the next case's
 * boot fetch (a plain one, by design) serves the previous case's frontmatter —
 * which reads as this editor leaking a write across tests.
 */
test.beforeEach(async () => {
  await writeWiki(root);
  await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}&refresh=1`);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  roServer?.kill("SIGTERM");
  for (const dir of [root, roRoot, roServerRoot]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function openRail(page: Page, base = BASE, wiki = WIKI): Promise<void> {
  await page.goto(`${base}/wiki?wiki=${wiki}`);
  await expect(page.locator(".wiki-list-item").first()).toBeAttached();
}

async function openPage(page: Page, rel: string, title: string, base = BASE): Promise<void> {
  await page.goto(`${base}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(page.locator(".wiki-article-head h1")).toHaveText(title);
}

const row = (page: Page, rel: string) => page.locator(`.wiki-list-item[data-relpath="${rel}"]`);
const menu = (page: Page) => page.locator("#wikiSeriesMenu");
const countText = async (page: Page) => (await page.locator("#wikiCount").textContent()) ?? "";

/** Open the rail row's ⋯ menu. The control is hover-revealed, so the click is
 *  forced rather than preceded by a hover that Playwright would have to hold. */
async function openRowMenu(page: Page, rel: string): Promise<void> {
  await row(page, rel).locator("[data-series-menu]").click({ force: true });
  await expect(menu(page)).toBeVisible();
}

/**
 * Open the Series fold.
 *
 * Load-bearing, not setup noise: a CLOSED fold renders none of its member rows
 * at all, so with it shut a member has no `⋯` to click and a page that JOINS the
 * series leaves the DOM entirely — and `#wikiCount` drops by exactly one, which
 * is the fold's own documented arithmetic rather than anything this editor did.
 * Open, the count is the claim acceptance 11 makes.
 */
async function openSeriesFold(page: Page): Promise<void> {
  const fold = page.locator(`.wiki-list-group[data-group="${FOLD}"] .wiki-group-fold`);
  if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  await expect(page.locator(".wiki-list-item.member").first()).toBeVisible();
}

test.describe("adding a page to a series from the rail", () => {
  test("writes exactly one line and the rail re-renders with the page inside the fold", async ({
    page,
  }) => {
    await openRail(page);
    await openSeriesFold(page);
    const before = await countText(page);
    const bytesBefore = await read(root, JOINER);
    // The joiner starts OUTSIDE the series fold. The fixture has exactly one
    // group, so `.member` names that fold's rows and nothing else.
    await expect(page.locator(".wiki-list-item.member")).toHaveCount(3);
    await expect(row(page, JOINER)).not.toHaveClass(/member/);

    await openRowMenu(page, JOINER);
    await page.locator(`#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="${KEY}"]`).click();
    await expect(menu(page)).toHaveCount(0);

    // ── the file ──
    await expect
      .poll(async () => (await read(root, JOINER)).split("\n").length)
      .toBe(bytesBefore.split("\n").length + 1);
    const added = (await read(root, JOINER))
      .split("\n")
      .filter((l) => !bytesBefore.split("\n").includes(l));
    expect(added).toEqual([`series: ${KEY}`]);

    // ── the rail ──
    await expect(row(page, JOINER)).toHaveClass(/member/);
    await expect(page.locator(".wiki-list-item.member")).toHaveCount(4);
    // The page MOVED: the rail still accounts for every page exactly once.
    expect(await countText(page)).toBe(before);
  });

  test("the page's own header then names the series", async ({ page }) => {
    await openRail(page);
    await openRowMenu(page, JOINER);
    await page.locator(`#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="${KEY}"]`).click();
    await expect(menu(page)).toHaveCount(0);
    await expect.poll(async () => (await fence(root, JOINER)).join("|")).toContain("series: prov");

    await openPage(page, JOINER, "Search recall plan");
    await expect(page.locator(".wiki-series-head .wiki-series-name")).toHaveText(LABEL);
    await expect(page.locator(".wiki-series-head .wiki-series-count")).toHaveText("4 pages");
  });

  test("the series the page is already in is inert, not a second join", async ({ page }) => {
    await openRail(page);
    await openSeriesFold(page);
    await openRowMenu(page, HEAD);
    await expect(
      page.locator(`#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="${KEY}"]`),
    ).toHaveCount(0);
    await expect(page.locator("#wikiSeriesMenu .wiki-series-menu-row.is-current")).toHaveCount(1);
  });

  test("a new key from the field creates a series of one", async ({ page }) => {
    await openRail(page);
    await openRowMenu(page, OUTSIDER);
    await page.locator('#wikiSeriesMenu [data-series-form="new"] [data-series-input]').fill("recall");
    await page.locator('#wikiSeriesMenu [data-series-form="new"] button[type="submit"]').click();
    await expect(menu(page)).toHaveCount(0);
    await expect.poll(async () => (await fence(root, OUTSIDER)).join("|")).toContain("series: recall");
    // One member is not a fold — the rail renders no group for it, and the page
    // is still an ordinary row.
    await expect(page.locator('.wiki-list-group[data-group="series:recall"]')).toHaveCount(1);
  });
});

test.describe("edit series, from the reader header", () => {
  test("renaming the label changes the HEAD's bytes and no other member's", async ({ page }) => {
    const shippedBefore = await read(root, SHIPPED);
    const blogBefore = await read(root, BLOG);
    await openPage(page, SHIPPED, "Provenance chain strip");
    await page.locator("[data-series-edit]").click();
    await expect(menu(page)).toBeVisible();
    await page.locator('#wikiSeriesMenu [data-series-form="label"] [data-series-input]').fill("Renamed series");
    await page.locator('#wikiSeriesMenu [data-series-form="label"] button[type="submit"]').click();
    await expect(menu(page)).toHaveCount(0);

    await expect
      .poll(async () => (await fence(root, HEAD)).find((l) => l.startsWith("series_label:")))
      .toBe("series_label: Renamed series");
    // The label lives on ONE page; the other two members are byte-identical.
    expect(await read(root, SHIPPED)).toBe(shippedBefore);
    expect(await read(root, BLOG)).toBe(blogBefore);
    // And the header the reader is looking at repaints without a navigation.
    await expect(page.locator(".wiki-series-head .wiki-series-name")).toHaveText("Renamed series");
  });

  test("moving the head changes TWO files, in the order that leaves a reportable state", async ({
    page,
  }) => {
    const blogBefore = await read(root, BLOG);
    await openPage(page, SHIPPED, "Provenance chain strip");
    await page.locator("[data-series-edit]").click();
    await expect(menu(page)).toBeVisible();
    await page.locator(`#wikiSeriesMenu [data-series-cmd="head"][data-series-arg="${SHIPPED}"]`).click();
    await expect(menu(page)).toHaveCount(0);

    await expect
      .poll(async () => (await fence(root, SHIPPED)).find((l) => l.startsWith("series_label:")))
      .toBe(`series_label: ${LABEL}`);
    // The old head lost it, and kept everything else.
    const headFence = await fence(root, HEAD);
    expect(headFence.some((l) => l.startsWith("series_label:"))).toBe(false);
    expect(headFence).toContain(`series: ${KEY}`);
    expect(headFence).toContain("plan_status: in-flight");
    // The third member is untouched — a head move is two files, not three.
    expect(await read(root, BLOG)).toBe(blogBefore);
  });

  test("removing the page drops the line and the page leaves the fold", async ({ page }) => {
    await openPage(page, BLOG, "Provenance campaign explained");
    await expect(page.locator(".wiki-series-head")).toHaveCount(1);
    await page.locator("[data-series-edit]").click();
    await page.locator('#wikiSeriesMenu [data-series-cmd="remove"]').click();
    await expect(menu(page)).toHaveCount(0);

    await expect
      .poll(async () => (await fence(root, BLOG)).some((l) => l.startsWith("series:")))
      .toBe(false);
    // The header goes with the membership, in place.
    await expect(page.locator(".wiki-series-head")).toHaveCount(0);
    // And the rail's fold lost its blog: the roll-up counts the two plans left,
    // and the removed page is an ordinary row again rather than a member.
    await expect(
      page.locator(`.wiki-list-group[data-group="${FOLD}"] .wiki-fold-chip-label`),
    ).toHaveText("1 in-flight · 1 shipped");
    await expect(row(page, BLOG)).not.toHaveClass(/member/);
  });
});

test.describe("read-only", () => {
  test("a read-only INSTANCE renders neither opener and 403s the POST", async ({ page }) => {
    await openRail(page, RO_BASE);
    await expect(page.locator("[data-series-menu]")).toHaveCount(0);
    await page.goto(`${RO_BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(HEAD)}`);
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Wiki provenance plan");
    await expect(page.locator(".wiki-series-head")).toHaveCount(1);
    await expect(page.locator("[data-series-edit]")).toHaveCount(0);

    const before = await read(roServerRoot, JOINER);
    const res = await fetch(`${RO_BASE}/api/wiki/series`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki: WIKI, relPath: JOINER, baseHash: "x", series: KEY }),
    });
    expect(res.status).toBe(403);
    expect(await read(roServerRoot, JOINER)).toBe(before);
  });

  test("a read-only ROOT on the writable instance behaves the same", async ({ page }) => {
    await openRail(page, BASE, RO_WIKI);
    await expect(page.locator("[data-series-menu]")).toHaveCount(0);
    await page.goto(`${BASE}/wiki?wiki=${RO_WIKI}&relPath=${encodeURIComponent(HEAD)}`);
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Wiki provenance plan");
    await expect(page.locator("[data-series-edit]")).toHaveCount(0);

    const before = await read(roRoot, JOINER);
    const res = await fetch(`${BASE}/api/wiki/series`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki: RO_WIKI, relPath: JOINER, baseHash: "x", series: KEY }),
    });
    expect(res.status).toBe(403);
    expect(await read(roRoot, JOINER)).toBe(before);
    // The SAME instance still edits its writable wiki — the refusal is per root.
    await openRail(page, BASE, WIKI);
    await expect(page.locator("[data-series-menu]").first()).toBeAttached();
  });
});
