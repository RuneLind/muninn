/**
 * `/summaries` — the doc panel as a reader: the Latest rail, and (PR 1b) the
 * header's ⋯ More menu, the article hero, the outline and the Similar cards.
 *
 * The rail lists the last 14 days of summaries under day headings, keeps its
 * state across opens (it is not part of the per-open rewrite of the panel
 * body), and rebuilds when the listing memo is force-refreshed or the domain
 * filter changes. A fake huginn serves a listing across three days inside the
 * window plus one older day, and the listing is MUTABLE (`listing` below), so
 * a spec can add or drop a document and drive the refresh the way a finished
 * capture or a delete does. Later reader PRs extend this file; add documents
 * with `put()`.
 *
 * Dates are relative to the real UTC today, and the browser runs in UTC, so
 * "Today" in a heading and the watermark's UTC day are the same day here.
 *
 * PR 2 adds Same story this week (the fake answers `/api/collections` and a
 * multi-collection `/api/search`) and In your wiki, which reads wiki_proposals:
 * this file's only database writes are its own proposal rows (`E2E_BOT`),
 * inserted and removed around the one test that needs them. The first of
 * those bots has a temp wiki of its own (`WIKI_EXTRA`), so the applied row's
 * link is followed to the page it names.
 *
 * NO MODEL CALLS. Ports come from `e2e/ports.ts`.
 */

import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";
import { RAIL_READ_STORAGE_KEY, railAddDays, railDayLabel } from "../src/summaries/latest-rail.ts";
import { paintedContrast } from "./contrast.ts";
import { SIMILAR_DEBOUNCE_MS } from "../src/dashboard/views/components/sum-reader.ts";

/** Long enough for the debounced Similar search to have gone out. */
const AFTER_SIMILAR_DEBOUNCE_MS = SIMILAR_DEBOUNCE_MS * 2 + 100;

const PORT = e2ePort("summaries-reader");
const HUGINN_PORT = e2ePort("summaries-reader/huginn");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

test.use({ timezoneId: "UTC" });

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = railAddDays(TODAY, -1);
const FIVE_BACK = railAddDays(TODAY, -5);
const OLD = railAddDays(TODAY, -40);

interface FakeDoc {
  id: string;
  date: string;
  modifiedTime: string;
  url: string;
}

const COLLECTIONS: Record<string, string> = {
  youtube: "youtube-summaries",
  "x-article": "x-articles",
  vimeo: "vimeo-summaries",
};

/** collection -> id -> doc. Mutated by `put`/`drop` and reset per test. */
let listing: Record<string, Map<string, FakeDoc>> = {};

function put(source: string, id: string, date: string, mtime: string, url?: string): void {
  const coll = COLLECTIONS[source]!;
  (listing[coll] ??= new Map()).set(id, {
    id,
    date,
    modifiedTime: `${date}T${mtime}.000000`,
    url: url ?? `https://example.com/${encodeURIComponent(id)}`,
  });
}

/** `<collection>/<id>` -> the stored text and metadata a document answers
 *  with. A document with no entry answers "Body of <title>." and no metadata. */
let bodies: Record<string, { text: string; metadata: Record<string, unknown> }> = {};

function putBody(source: string, id: string, text: string, metadata: Record<string, unknown>): void {
  bodies[`${COLLECTIONS[source]!}/${id}`] = { text, metadata };
}

/** What the fake /api/search answers (the Similar panel's query). */
let searchResults: unknown[] = [];

/** What the fake /api/search answers for a MULTI-collection search (the
 *  same-story route's), and the queries it was asked. */
let sameStoryResults: unknown[] = [];
let sameStoryQueries: string[] = [];

/** The collections the fake /api/collections serves: every summary source's
 *  but article-summaries, so the same-story route has one to leave out. A
 *  search listing an unserved collection answers 404, as huginn does. */
const SERVED = ["youtube-summaries", "x-articles", "anthropic-summaries", "tiktok-summaries", "vimeo-summaries", "wiki"];

function drop(source: string, id: string): void {
  listing[COLLECTIONS[source]!]?.delete(id);
}

/** Collections the fake huginn answers 500 for (`*`: every one), as a
 *  timed-out source does. The documents route still answers 200 while one
 *  source loads, and 503 when none does. */
let failing = new Set<string>();

const A1 = "ai/agents/Today first.md";
const A2 = "ai/agents/Today second.md";
const A3 = "ai/tools/Today third.md";
const B1 = "ai/agents/Yesterday one.md";
const B2 = "ai/tools/Yesterday two.md";
const C1 = "ai/tools/Five days back.md";
const D1 = "ai/agents/Forty days back.md";
const L1 = "health/sleep/Life today.md";

function seed(): void {
  listing = {};
  failing = new Set();
  bodies = {};
  searchResults = [];
  sameStoryResults = [];
  sameStoryQueries = [];
  // Today: A1 has the latest modifiedTime, so it leads its day.
  put("youtube", A1, TODAY, "12:00:00");
  put("youtube", A2, TODAY, "11:00:00");
  put("youtube", A3, TODAY, "10:00:00");
  put("youtube", B1, YESTERDAY, "09:00:00");
  put("youtube", B2, YESTERDAY, "08:00:00");
  put("youtube", C1, FIVE_BACK, "08:00:00");
  put("youtube", D1, OLD, "08:00:00");
  put("x-article", L1, TODAY, "09:30:00");
}

const title = (id: string) => id.split("/").pop()!.replace(/\.md$/, "");

let server: ChildProcess | undefined;
let huginn: Server | undefined;
let wikiRoot = "";

test.beforeAll(async () => {
  wikiRoot = mkdtempSync(path.join(tmpdir(), "muninn-e2e-reader-wiki-"));
  mkdirSync(path.join(wikiRoot, "sources"));
  writeFileSync(path.join(wikiRoot, APPLIED_PAGE), `---\ntitle: ${APPLIED_TITLE}\n---\n\n# ${APPLIED_TITLE}\n\nDrafted from a summary.\n`);
  huginn = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = decodeURIComponent(url.pathname);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (p.startsWith("/api/collection/") && p.endsWith("/documents")) {
      const coll = p.slice("/api/collection/".length, -"/documents".length);
      if (failing.has(coll) || failing.has("*")) return json({ error: "down" }, 500);
      return json({ documents: [...(listing[coll]?.values() ?? [])] });
    }
    if (p.startsWith("/api/document/")) {
      const rest = p.slice("/api/document/".length);
      const id = rest.slice(rest.indexOf("/") + 1);
      const stored = bodies[rest];
      const listed = listing[rest.slice(0, rest.indexOf("/"))]?.get(id);
      const body = stored ? stored.text : `Body of ${title(id)}.`;
      if (url.searchParams.get("raw") === "1") {
        res.writeHead(200, { "content-type": "text/markdown" });
        return res.end(`---\ndate: "${TODAY}"\n---\n\n${body}\n`);
      }
      return json({ id, text: body, ...(listed ? { url: listed.url } : {}), ...(stored ? { metadata: stored.metadata } : {}) });
    }
    if (p === "/api/collections") return json({ collections: SERVED.map((name) => ({ name })) });
    if (p === "/api/search") {
      const asked = url.searchParams.getAll("collection");
      const absent = asked.find((c) => !SERVED.includes(c));
      if (absent) return json({ detail: `Collection '${absent}' not found` }, 404);
      if (asked.length > 1) {
        sameStoryQueries.push(url.searchParams.get("q") ?? "");
        return json({ results: sameStoryResults });
      }
      return json({ results: searchResults });
    }
    return json({});
  });
  await new Promise<void>((resolve) => huginn!.listen(HUGINN_PORT, "127.0.0.1", resolve));

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      KNOWLEDGE_API_URL: `http://127.0.0.1:${HUGINN_PORT}`,
      WIKI_EXTRA: `${E2E_BOTS[0]}=${wikiRoot}`,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/live`)).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(() => {
  server?.kill("SIGTERM");
  huginn?.close();
  if (wikiRoot) rmSync(wikiRoot, { recursive: true, force: true });
});

test.beforeEach(() => seed());

const rail = (page: Page) => page.locator("#sumLatestRail");
const day = (page: Page, d: string) => page.locator(`#sumRailList .sum-latest-day[data-day="${d}"]`);
const row = (page: Page, id: string) => page.locator(`#sumRailList .sum-latest-row[data-doc-id="${id}"]`);
const current = (page: Page) => page.locator("#sumRailList .sum-latest-row.current");

async function openDeepLink(page: Page, id: string, source = "youtube"): Promise<void> {
  await page.goto(`${BASE}/summaries?doc=${encodeURIComponent(id)}&source=${source}`);
  await expect(page.locator("#sumArticleMain")).toContainText(`Body of ${title(id)}.`);
  await expect(row(page, id)).toHaveClass(/current/);
}

test("day groups with counts, newest first, and Show older", async ({ page }) => {
  await openDeepLink(page, A2);
  const days = page.locator("#sumRailList .sum-latest-day");
  await expect(days).toHaveCount(3);
  await expect(days.nth(0).locator("summary")).toHaveText(/^Today\s*4$/);
  await expect(days.nth(1).locator("summary")).toHaveText(/^Yesterday\s*2$/);
  await expect(days.nth(2).locator("summary")).toHaveText(new RegExp(`^${railDayLabel(FIVE_BACK, TODAY)}\\s*1$`));

  // Within a day: modifiedTime descending, across sources.
  await expect(day(page, TODAY).locator(".sum-latest-title")).toHaveText([
    title(A1), title(A2), title(A3), title(L1),
  ].map((t) => new RegExp(t)));
  // A row reads as text, the open one as the accent: the panel's markdown
  // link rule must not paint every row (measured: it did, before scoping).
  const token = (name: string) => page.evaluate((n) => {
    const el = document.createElement("span");
    el.style.color = `var(${n})`;
    document.body.appendChild(el);
    const c = getComputedStyle(el).color;
    el.remove();
    return c;
  }, name);
  await expect(row(page, B1)).toHaveCSS("color", await token("--text-secondary"));
  await expect(row(page, A2)).toHaveCSS("color", await token("--accent-light"));
  // Badge + last category segment.
  await expect(row(page, A3).locator(".sum-latest-cat")).toHaveText("tools");
  await expect(row(page, A3).locator(".source-badge")).toHaveAttribute("data-source", "youtube");

  // The older day is behind Show older, which reveals it.
  await expect(day(page, OLD)).toHaveCount(0);
  await rail(page).getByRole("button", { name: "Show older (1)" }).click();
  await expect(day(page, OLD)).toHaveCount(1);
  await expect(page.locator("#sumRailList .sum-rail-more")).toHaveCount(0);
});

test("unread dots: today is unread on a first visit, opening marks read, and it persists", async ({ page }) => {
  await openDeepLink(page, A1);
  const dot = (id: string) => row(page, id).locator(".sum-latest-dot");
  // The watermark is today's UTC day: today's rows are unread, older rows read.
  const stored = await page.evaluate((k) => localStorage.getItem(k), RAIL_READ_STORAGE_KEY);
  expect(JSON.parse(stored!).watermark).toBe(TODAY);
  await expect(dot(A1)).toHaveCount(0); // opened by the deep link
  await expect(dot(A2)).toHaveCount(1);
  await expect(dot(A3)).toHaveCount(1);
  await expect(dot(B1)).toHaveCount(0);

  await row(page, A2).click();
  await expect(page.locator("#sumArticleMain")).toContainText(`Body of ${title(A2)}.`);
  await expect(dot(A2)).toHaveCount(0);

  // The Unread chip shows only what is left.
  await rail(page).locator('.sum-rail-chip[data-chip="unread"]').click();
  await expect(page.locator("#sumRailList .sum-latest-row")).toHaveCount(2);
  await expect(row(page, A3)).toHaveCount(1);
  await expect(row(page, L1)).toHaveCount(1);

  // A reload keeps both reads; a backfill that bumps modifiedTime does not
  // mark a read row unread again.
  put("youtube", A2, TODAY, "23:59:59");
  await openDeepLink(page, B1);
  await expect(dot(A1)).toHaveCount(0);
  await expect(dot(A2)).toHaveCount(0);
  await expect(dot(A3)).toHaveCount(1);
});

test("a storage failure shows every row as read and drops the Unread chip", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error("blocked"); };
  });
  await openDeepLink(page, A1);
  await expect(page.locator("#sumRailList .sum-latest-dot")).toHaveCount(0);
  await expect(rail(page).locator('.sum-rail-chip[data-chip="unread"]')).toHaveCount(0);
  await expect(rail(page).locator('.sum-rail-chip[data-chip="all"]')).toHaveCount(1);
});

test("j and k step through the rows, and do nothing from the filter box or an open menu", async ({ page }) => {
  await openDeepLink(page, A1);
  await page.locator("#docPanelTitle").click();
  await page.keyboard.press("j");
  await expect(current(page)).toHaveAttribute("data-doc-id", A2);
  await expect(page.locator("#sumArticleMain")).toContainText(`Body of ${title(A2)}.`);
  await page.keyboard.press("j");
  await expect(current(page)).toHaveAttribute("data-doc-id", A3);
  await page.keyboard.press("k");
  await expect(current(page)).toHaveAttribute("data-doc-id", A2);

  // A closed day is skipped: close Yesterday, step off the end of Today.
  await day(page, YESTERDAY).locator("summary").click();
  await page.keyboard.press("j"); // A3
  await expect(current(page)).toHaveAttribute("data-doc-id", A3);
  await page.keyboard.press("j"); // L1
  await expect(current(page)).toHaveAttribute("data-doc-id", L1);
  await page.keyboard.press("j"); // C1, past the closed Yesterday
  await expect(current(page)).toHaveAttribute("data-doc-id", C1);
  await page.keyboard.press("k");
  await expect(current(page)).toHaveAttribute("data-doc-id", L1);

  // Focus in the filter box: j is a character, not a step.
  const filter = page.locator("#sumRailFilter");
  await filter.click();
  await page.keyboard.press("j");
  await expect(filter).toHaveValue("j");
  await expect(page.locator("#docPanelTitle")).toHaveText(title(L1));
  await filter.fill("");

  // An open role="menu" popup (the Re-run menu) holds the keys too.
  await page.locator("#docPanelRerun").click();
  await expect(page.locator("#docPanelRerunMenu")).toBeVisible();
  await page.keyboard.press("j");
  await expect(page.locator("#docPanelTitle")).toHaveText(title(L1));
});

test("the rail rebuilds on a listing refresh and a domain change, keeping .current, closed days and scroll", async ({ page }) => {
  // Short enough that the rail column scrolls.
  await page.setViewportSize({ width: 1280, height: 420 });
  await openDeepLink(page, A2);
  await day(page, YESTERDAY).locator("summary").click();
  await expect(day(page, YESTERDAY)).not.toHaveAttribute("open", "");
  const scrollTop = () => rail(page).evaluate((el) => el.scrollTop);
  await rail(page).evaluate((el) => { el.scrollTop = 40; });
  expect(await scrollTop()).toBe(40);

  // A finished capture: the job card force-refreshes through loadShelf(true).
  const NEW = "ai/agents/Just captured.md";
  put("youtube", NEW, TODAY, "13:00:00");
  await page.evaluate(() => (window as unknown as { loadShelf: (f: boolean) => Promise<void> }).loadShelf(true));
  await expect(row(page, NEW)).toHaveCount(1);
  await expect(day(page, TODAY).locator("summary")).toHaveText(/^Today\s*5$/);
  await expect(current(page)).toHaveAttribute("data-doc-id", A2);
  await expect(day(page, YESTERDAY)).not.toHaveAttribute("open", "");
  expect(await scrollTop()).toBe(40);

  // A delete: the delete flow refetches through getSummaryDocuments(true).
  drop("youtube", A3);
  await page.evaluate(() =>
    (window as unknown as { getSummaryDocuments: (f: boolean) => Promise<unknown> }).getSummaryDocuments(true),
  );
  await expect(row(page, A3)).toHaveCount(0);
  await expect(day(page, TODAY).locator("summary")).toHaveText(/^Today\s*4$/);
  await expect(current(page)).toHaveAttribute("data-doc-id", A2);

  // Opening another summary moves .current without rebuilding the rail: a
  // marker on a row element survives the open (a rebuild replaces the rows).
  await row(page, A1).evaluate((el) => { (el as HTMLElement).dataset.marker = "kept"; });
  await row(page, NEW).click();
  await expect(current(page)).toHaveAttribute("data-doc-id", NEW);
  await expect(row(page, A1)).toHaveAttribute("data-marker", "kept");

  // The domain filter narrows the rail as it does the Shelf.
  await page.keyboard.press("Escape");
  await page.locator('#domainFilter .source-chip[data-domain="life"]').click();
  await expect(page.locator("#sumRailList .sum-latest-row")).toHaveCount(1);
  await expect(row(page, L1)).toHaveCount(1);
});

test("By category keeps the old accordion one toggle away", async ({ page }) => {
  await openDeepLink(page, A3);
  await rail(page).getByRole("button", { name: "By category" }).click();
  await expect(page.locator("#sumCatPanel")).toBeVisible();
  await expect(page.locator("#sumRailList")).toBeHidden();
  await expect(page.locator("#sumCatPanel .sum-cat-row.active .sum-cat-name")).toHaveText("ai/tools");
  await expect(page.locator("#sumCatPanel .sum-cat-article.current")).toHaveText(title(A3));
  await rail(page).getByRole("button", { name: "Latest", exact: true }).click();
  await expect(page.locator("#sumRailList")).toBeVisible();
});

test("below 1000px the article comes first and the rail sits behind a Latest toggle", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await openDeepLink(page, A1);
  const toggle = page.locator("#sumRailToggle");
  await expect(toggle).toBeVisible();
  await expect(page.locator("#sumRailList")).toBeHidden();
  await expect(page.locator("#sumArticleMain")).toBeVisible();
  // The article sits right under the collapsed rail: grid rows must not
  // stretch to the panel height (measured: a ~150px gap before the fix).
  const railBox = (await rail(page).boundingBox())!;
  const mainBox = (await page.locator("#sumArticleMain").boundingBox())!;
  expect(mainBox.y - (railBox.y + railBox.height)).toBeLessThan(40);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#sumRailList")).toBeVisible();
  // Opened, the rail pushes the article down rather than overlapping it.
  const openRail = (await rail(page).boundingBox())!;
  const openMain = (await page.locator("#sumArticleMain").boundingBox())!;
  expect(openMain.y).toBeGreaterThanOrEqual(openRail.y + openRail.height);
});

// --- Fix round 1 -----------------------------------------------------------

type PageWindow = Record<string, (...args: unknown[]) => unknown> & { docsByCategory: unknown; __gates: Array<() => void> };

test("narrow: opening a row from the expanded rail collapses it and shows the article", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await openDeepLink(page, A1);
  const toggle = page.locator("#sumRailToggle");
  const main = page.locator("#sumArticleMain");
  await toggle.click();
  await row(page, C1).click();
  await expect(main).toContainText(`Body of ${title(C1)}.`);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => (await main.boundingBox())!.y).toBeLessThan(200);

  // k from the expanded rail does the same.
  await toggle.click();
  await page.locator("#docPanelTitle").click();
  await page.keyboard.press("k");
  await expect(main).toContainText(`Body of ${title(B2)}.`);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => (await main.boundingBox())!.y).toBeLessThan(200);
});

test("narrow: opening the Latest toggle scrolls the current row into view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await openDeepLink(page, C1);
  await page.locator("#sumRailToggle").click();
  await expect(row(page, C1)).toBeInViewport();
});

test("narrow: j and k do nothing while the rail is collapsed", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await openDeepLink(page, A1);
  await page.locator("#docPanelTitle").click();
  await page.keyboard.press("j");
  await page.waitForTimeout(300);
  await expect(page.locator("#docPanelTitle")).toHaveText(title(A1));
  await expect(current(page)).toHaveAttribute("data-doc-id", A1);
});

test("a delete keeps the day counts right, whether huginn's listing lags or not", async ({ page }) => {
  await openDeepLink(page, A1);
  const today = day(page, TODAY);
  const w = (fn: string, id: string) =>
    page.evaluate(([f, i]) => (window as unknown as PageWindow)[f]!(i, "youtube"), [fn, id] as const);
  // Caught up: huginn no longer lists A3, and the delete flow pulls its rows.
  drop("youtube", A3);
  await w("removeDocRows", A3);
  await expect(today.locator(".sum-latest-row")).toHaveCount(3);
  await expect(today.locator(".sum-latest-day-count")).toHaveText("3");
  // Lagging: huginn still lists A2 after its delete. The flow pulls the rows,
  // refetches (which re-lists A2), then pulls them again.
  await w("removeDocRows", A2);
  await page.evaluate(() => (window as unknown as PageWindow).getSummaryDocuments!(true));
  await w("removeDocRows", A2);
  await expect(today.locator(".sum-latest-row")).toHaveCount(2);
  await expect(today.locator(".sum-latest-day-count")).toHaveText("2");
  // A day whose only row goes loses its heading.
  await w("removeDocRows", C1);
  await expect(day(page, FIVE_BACK)).toHaveCount(0);
});

test("a prune merges over what another tab stored", async ({ page }) => {
  const KEY = RAIL_READ_STORAGE_KEY;
  const GONE = "ai/agents/Gone soon.md";
  put("youtube", GONE, TODAY, "07:00:00");
  await page.goto(`${BASE}/summaries`);
  await page.evaluate(([k, g, t]) => localStorage.setItem(k, JSON.stringify({ watermark: t, opened: ["youtube|" + g] })), [KEY, GONE, TODAY] as const);
  await openDeepLink(page, A1);
  // Another tab opens A2 while this one is up.
  await page.evaluate(([k, id]) => {
    const s = JSON.parse(localStorage.getItem(k)!);
    s.opened.push("youtube|" + id);
    localStorage.setItem(k, JSON.stringify(s));
  }, [KEY, A2] as const);
  drop("youtube", GONE);
  await page.evaluate(() => (window as unknown as PageWindow).getSummaryDocuments!(true));
  const stored = JSON.parse((await page.evaluate((k) => localStorage.getItem(k), KEY))!);
  expect(stored.opened).toContain("youtube|" + A2);
  expect(stored.opened).not.toContain("youtube|" + GONE);
  await expect(row(page, A2).locator(".sum-latest-dot")).toHaveCount(0);
});

test("focus stays on a chip or moves to the revealed day after a rebuild", async ({ page }) => {
  await openDeepLink(page, A1);
  const chip = (id: string) => rail(page).locator(`.sum-rail-chip[data-chip="${id}"]`);
  await chip("unread").focus();
  await page.keyboard.press("Enter");
  await expect(chip("unread")).toHaveAttribute("aria-pressed", "true");
  await expect(chip("unread")).toBeFocused();
  await chip("all").focus();
  await page.keyboard.press("Enter");
  await expect(chip("all")).toBeFocused();
  await rail(page).locator(".sum-rail-more").focus();
  await page.keyboard.press("Enter");
  await expect(row(page, D1)).toBeFocused();
});

test("Show older scrolls the rail to the first row of the day it revealed", async ({ page }) => {
  // Short enough that Show older sits at the rail's bottom edge once focused:
  // the revealed day's heading takes its place and the row lands below it.
  await page.setViewportSize({ width: 1280, height: 420 });
  for (let i = 10; i < 16; i++) put("youtube", `ai/agents/Filler ${i}.md`, YESTERDAY, `07:${i}:00`);
  await openDeepLink(page, A1);
  await rail(page).locator(".sum-rail-more").focus();
  await page.keyboard.press("Enter");
  await expect(row(page, D1)).toBeFocused();
  const inView = await page.evaluate((id) => {
    const r = document.querySelector(`#sumRailList .sum-latest-row[data-doc-id="${CSS.escape(id)}"]`)!.getBoundingClientRect();
    const col = document.getElementById("sumLatestRail")!.getBoundingClientRect();
    return r.top >= col.top - 0.5 && r.bottom <= col.bottom + 0.5;
  }, D1);
  expect(inView).toBe(true);
});

test("the sticky rail head never covers the current row", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await openDeepLink(page, C1);
  await page.locator("#docPanelTitle").click();
  const clear = () => page.evaluate(() => {
    const cur = document.querySelector("#sumRailList .sum-latest-row.current")!.getBoundingClientRect();
    const head = document.querySelector("#sumLatestRail .sum-rail-head")!.getBoundingClientRect();
    const col = document.getElementById("sumLatestRail")!.getBoundingClientRect();
    return cur.top >= head.bottom - 0.5 && cur.bottom <= col.bottom + 0.5;
  });
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("k");
    expect(await clear(), `after k #${i + 1}`).toBe(true);
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("j");
    expect(await clear(), `after j #${i + 1}`).toBe(true);
  }
});

test("Escape in the filter clears it and leaves the panel open", async ({ page }) => {
  await openDeepLink(page, A1);
  const filter = page.locator("#sumRailFilter");
  await filter.fill("zz");
  await expect(page.locator("#sumRailList .sum-latest-row")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(page.locator("#sumRailList .sum-latest-row")).toHaveCount(7);
  await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
});

test("j from a focused row moves focus with .current", async ({ page }) => {
  await openDeepLink(page, A1);
  await row(page, A1).focus();
  await page.keyboard.press("j");
  await expect(current(page)).toHaveAttribute("data-doc-id", A2);
  await expect(row(page, A2)).toBeFocused();
});

test("a hovered row paints a background of its own, and its text still reads at AA", async ({ page }) => {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await openDeepLink(page, A1);
    await row(page, B1).hover();
    const [rowBg, colBg] = await row(page, B1).evaluate((el) => [
      getComputedStyle(el).backgroundColor,
      getComputedStyle(document.getElementById("sumLatestRail")!).backgroundColor,
    ]);
    expect(rowBg, scheme).not.toBe(colBg);
    expect(rowBg, scheme).not.toBe("rgba(0, 0, 0, 0)");
    expect(await paintedContrast(row(page, B1).locator(".sum-latest-title")), scheme).toBeGreaterThanOrEqual(4.5);
  }
});

test("a held j opens one summary, not one per auto-repeat", async ({ page }) => {
  await openDeepLink(page, A1);
  await page.locator("#docPanelTitle").click();
  await page.keyboard.down("j");
  await page.keyboard.down("j");
  await page.keyboard.down("j");
  await page.keyboard.up("j");
  await expect(current(page)).toHaveAttribute("data-doc-id", A2);
  await expect(page.locator("#docPanelTitle")).toHaveText(title(A2));
});

test("By category: an older open's category render never lands over a newer one", async ({ page }) => {
  await openDeepLink(page, A1);
  await rail(page).getByRole("button", { name: "By category" }).click();
  await expect(page.locator("#sumCatPanel .sum-cat-article.current")).toHaveText(title(A1));
  await page.evaluate(([a, b]) => {
    const w = window as unknown as PageWindow;
    const real = w.getSummaryDocuments!;
    w.__gates = [];
    w.getSummaryDocuments = (force: unknown) =>
      (real(force) as Promise<unknown>).then((docs) => new Promise((res) => w.__gates.push(() => res(docs))));
    w.docsByCategory = {};
    w.openSummaryDoc!(a, "", "youtube");
    w.openSummaryDoc!(b, "", "youtube");
  }, [B1, B2] as const);
  await page.waitForFunction(() => (window as unknown as PageWindow).__gates.length >= 2);
  // Release the newer open's fetch first, the older one's last.
  await page.evaluate(() => (window as unknown as PageWindow).__gates.slice().reverse().forEach((g) => g()));
  await page.waitForTimeout(300);
  await expect(page.locator("#sumCatPanel .sum-cat-article.current")).toHaveText(title(B2));
});

test("an older forced refresh that settles last does not rebuild the rail", async ({ page }) => {
  await openDeepLink(page, A2);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let fetched!: () => void;
  const fetchedP = new Promise<void>((r) => { fetched = r; });
  let n = 0;
  await page.route("**/api/summaries/documents**", async (route) => {
    n++;
    if (n !== 1) return route.continue();
    const resp = await route.fetch();
    fetched();
    await gate;
    await route.fulfill({ response: resp });
  });
  const first = page.evaluate(() => (window as unknown as PageWindow).getSummaryDocuments!(true));
  await fetchedP; // the older response still lists A3
  drop("youtube", A3);
  await page.evaluate(() => (window as unknown as PageWindow).getSummaryDocuments!(true));
  await expect(row(page, A3)).toHaveCount(0);
  release();
  await first;
  await page.waitForTimeout(200);
  await expect(row(page, A3)).toHaveCount(0);
});

for (const [zone, instant] of [
  ["America/Los_Angeles", "T03:00:00Z"], // 20:00 the evening before, local
  ["Pacific/Auckland", "T20:00:00Z"], // 08:00 the morning after, local
] as const) {
  test.describe(`in ${zone}`, () => {
    test.use({ timezoneId: zone });
    test("Today and the window are the UTC day, the day rows are filed under", async ({ page }) => {
      await page.clock.setFixedTime(new Date(`${TODAY}${instant}`));
      await openDeepLink(page, A1);
      const days = page.locator("#sumRailList .sum-latest-day");
      await expect(days).toHaveCount(3);
      await expect(days.nth(0).locator("summary")).toHaveText(/^Today\s*4$/);
      await expect(days.nth(1).locator("summary")).toHaveText(/^Yesterday\s*2$/);
    });
  });
}

test("rail text and source badges read at AA in both themes", async ({ page }) => {
  const TALK = "ai/talks/A talk.md";
  put("vimeo", TALK, TODAY, "06:00:00");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await openDeepLink(page, A1);
    await page.mouse.move(0, 0);
    const checks = {
      "current title": row(page, A1).locator(".sum-latest-title"),
      "row title": row(page, B1).locator(".sum-latest-title"),
      "meta text": row(page, B1).locator(".sum-latest-cat"),
      "youtube badge": row(page, B1).locator(".sum-latest-meta .source-badge"),
      "x-article badge": row(page, L1).locator(".sum-latest-meta .source-badge"),
      "default badge": row(page, TALK).locator(".sum-latest-meta .source-badge"),
    };
    for (const [name, loc] of Object.entries(checks)) {
      expect(await paintedContrast(loc), `${scheme} ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("rows and controls carry names a screen reader can use", async ({ page }) => {
  await openDeepLink(page, A1);
  await expect(row(page, A2)).toHaveAttribute("title", title(A2));
  await expect(row(page, A2).locator(".sum-latest-dot")).toHaveAttribute("role", "img");
  await expect(day(page, TODAY).locator("summary")).toHaveAttribute("aria-label", "Today, 4 summaries");
  await expect(page.locator("#sumRailChips")).toHaveAttribute("role", "group");
  await expect(page.locator("#sumRailChips")).toHaveAttribute("aria-label", /.+/);
  // Narrow, with the rail open, the toggle and the view button are both on
  // screen: they need different names.
  await page.setViewportSize({ width: 800, height: 900 });
  await page.locator("#sumRailToggle").click();
  await expect(page.locator("#sumRailList")).toBeVisible();
  await expect(page.getByRole("button", { name: "Latest", exact: true })).toHaveCount(1);
});

// --- Fix round 2 -----------------------------------------------------------

const forceRefresh = (page: Page) =>
  page.evaluate(() => (window as unknown as PageWindow).getSummaryDocuments!(true));

test("a rebuild keeps the rail's scroll position while a clicked row has focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  for (let i = 10; i < 22; i++) put("youtube", `ai/agents/Filler ${i}.md`, YESTERDAY, `07:${i}:00`);
  await openDeepLink(page, A2);
  await row(page, A1).click();
  await expect(current(page)).toHaveAttribute("data-doc-id", A1);
  await expect(row(page, A1)).toBeFocused();
  const scrollTop = () => rail(page).evaluate((el) => el.scrollTop);
  const bottom = await rail(page).evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
  expect(bottom).toBeGreaterThan(200);
  await forceRefresh(page);
  expect(await scrollTop()).toBe(bottom);
  await expect(row(page, A1)).toBeFocused();
});

// A deleted doc's key holds the deleted row's modifiedTime. Each row is one
// state of that rule: the delete lands while huginn still lists the doc, then
// the steps run, each followed by a forced refresh; after the first one the
// rows are pulled again, as deleteSummaryDoc does after its refetch. The row
// stays hidden after every step but the last, and the last decides `shown`.
type DeleteStep = "lag" | "drop" | "fail" | "same" | "new";
const DELETE_STATES: Array<{ name: string; source: string; id: string; unlisted?: boolean; steps: DeleteStep[]; shown: boolean }> = [
  { name: "(a) a lagging listing with the same modifiedTime hides it", source: "youtube", id: A3, steps: ["lag"], shown: false },
  { name: "(b) caught up, then a lagging listing again: still hidden", source: "youtube", id: A3, steps: ["drop", "same"], shown: false },
  { name: "(c) its source fails, then lags: still hidden", source: "youtube", id: A3, steps: ["fail", "lag"], shown: false },
  { name: "(d) the only doc of its source, re-captured: shown", source: "x-article", id: L1, steps: ["drop", "new"], shown: true },
  { name: "(e) a doc beside others in its source, re-captured: shown", source: "youtube", id: A3, steps: ["drop", "new"], shown: true },
  { name: "(f) the only doc of its source, re-listed with the same modifiedTime: hidden", source: "x-article", id: L1, steps: ["drop", "same"], shown: false },
  { name: "(g) deleted before the rail listed it: adopts the first listing, then a re-capture shows", source: "youtube", id: "ai/agents/Unlisted.md", unlisted: true, steps: ["lag", "new"], shown: true },
];

for (const c of DELETE_STATES) {
  test(`a deleted doc: ${c.name}`, async ({ page }) => {
    const MTIME = "10:30:00";
    if (!c.unlisted) {
      // Pin the target's modifiedTime so "same" and "new" are unambiguous.
      put(c.source, c.id, TODAY, MTIME);
    }
    await openDeepLink(page, A1);
    // Listed after the rail's listing, so the rail never saw its modifiedTime.
    if (c.unlisted) put(c.source, c.id, TODAY, MTIME);
    const todayCount = day(page, TODAY).locator(".sum-latest-day-count");
    const base = Number(await todayCount.textContent());
    const removeRows = () =>
      page.evaluate(([i, s]) => (window as unknown as PageWindow).removeDocRows!(i, s), [c.id, c.source] as const);
    await removeRows();
    await expect(row(page, c.id)).toHaveCount(0);
    for (const [n, step] of c.steps.entries()) {
      if (step === "drop") drop(c.source, c.id);
      if (step === "fail") failing.add(COLLECTIONS[c.source]!);
      if (step === "same") put(c.source, c.id, TODAY, MTIME);
      if (step === "new") put(c.source, c.id, TODAY, "13:00:00");
      await forceRefresh(page);
      failing.clear();
      if (n === 0) await removeRows();
      const last = n === c.steps.length - 1;
      const shown = last && c.shown;
      await expect(row(page, c.id), `after ${step}`).toHaveCount(shown ? 1 : 0);
      if (step !== "fail") {
        // A hidden row leaves the day count; unlisted, the base never had it.
        const expected = (c.unlisted ? base : base - 1) + (shown ? 1 : 0);
        await expect(todayCount, `count after ${step}`).toHaveText(String(expected));
      }
    }
  });
}

test("j does nothing while the prompt modal is up", async ({ page }) => {
  await openDeepLink(page, A1);
  await page.locator("#docPanelTitle").click();
  const backdrop = (on: boolean) => page.evaluate((v) => {
    document.getElementById("promptModalBackdrop")!.classList.toggle("visible", v);
  }, on);
  await backdrop(true);
  await page.keyboard.press("j");
  await page.waitForTimeout(300);
  await expect(current(page)).toHaveAttribute("data-doc-id", A1);
  await expect(page.locator("#docPanelTitle")).toHaveText(title(A1));
  // Control: with the modal gone, the same j steps.
  await backdrop(false);
  await page.keyboard.press("j");
  await expect(current(page)).toHaveAttribute("data-doc-id", A2);
});

test("By category follows a forced refresh and a domain change", async ({ page }) => {
  await openDeepLink(page, A3);
  await rail(page).getByRole("button", { name: "By category" }).click();
  const article = (id: string) => page.locator("#sumCatPanel .sum-cat-article", { hasText: title(id) });
  await expect(article(A2)).toHaveCount(1);
  drop("youtube", A2);
  await forceRefresh(page);
  await expect(article(A2)).toHaveCount(0);
  await expect(article(A1)).toHaveCount(1);

  await page.keyboard.press("Escape");
  await page.locator('#domainFilter .source-chip[data-domain="life"]').click();
  await expect(page.locator("#sumCatPanel .sum-cat-name")).toHaveText(["health/sleep"]);
});

test("narrow: folding the rail on an open moves focus to the Latest toggle", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await openDeepLink(page, A1);
  const toggle = page.locator("#sumRailToggle");
  await toggle.click();
  await row(page, C1).click();
  await expect(page.locator("#sumArticleMain")).toContainText(`Body of ${title(C1)}.`);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
});

test("a rail whose first listing load failed builds on the next open", async ({ page }) => {
  failing.add("*");
  await page.goto(`${BASE}/summaries?doc=${encodeURIComponent(A1)}&source=youtube`);
  await expect(page.locator("#sumArticleMain")).toContainText(`Body of ${title(A1)}.`);
  await expect(page.locator("#sumRailList")).toContainText("Failed to load");
  failing.clear();
  await page.evaluate((id) => (window as unknown as PageWindow).openSummaryDoc!(id, "", "youtube"), B1);
  await expect(page.locator("#sumArticleMain")).toContainText(`Body of ${title(B1)}.`);
  await expect(page.locator("#sumRailList .sum-latest-row")).toHaveCount(7);
  await expect(current(page)).toHaveAttribute("data-doc-id", B1);
});

// --- PR 1b: header, article hero, outline, Similar cards ---------------------

const YT_URL = "https://www.youtube.com/watch?v=rmr-LdARqHE";
const VIMEO_THUMB = "https://i.vimeocdn.com/video/e2e-295x166.jpg";

/** A new-shape YouTube summary: italic lede, `## Key takeaways`, `##`
 *  sections, the closing 💬 Takeaway, a windowed transcript. */
const NEW_DOC = "ai/general/New shape talk.md";
const NEW_TEXT = [
  "*A short talk arguing that AI already beats humans at every task.*",
  "",
  "## Key takeaways",
  "- 🧠 Machine learning lets AI build its own intelligence.",
  "- 🏆 AI is the world champion at every task so far.",
  "",
  "## From instructions to learned intelligence",
  "Telling versus showing. " + "Words fill the section. ".repeat(40),
  "",
  "### Collective learning",
  "Cars learn from each other.",
  "",
  "```",
  "const aVeryLongIdentifierThatDoesNotWrap = someFunctionWithALongName(argumentOne, argumentTwo);",
  "```",
  "",
  "## Why it doesn't matter",
  "Twice as smart is the turning point. " + "More words here. ".repeat(60),
  "",
  "## 💬 Takeaway",
  "The closer stays where the model put it.",
  "",
  "## Transcript",
  "",
  "### [00:00:00]",
  "so today I want to talk about machines",
  "",
  "### [00:02:00]",
  "and that is why it does not matter",
].join("\n");

/** An old-shape summary: `###` sections, no lede, no kind, no transcript. */
const OLD_DOC = "ai/claude-code/Old shape tips.md";
const OLD_TEXT = [
  "### 🎯 Main Thesis",
  "- **Claude Code** has a print mode.",
  "",
  "### 🏗️ The Four Zones",
  "Zones of an agent.",
  "",
  "### 💡 Key Takeaways",
  "- Keep it simple.",
].join("\n");

/** A Vimeo-shaped talk: author, `upload_date` as `YYYY-MM-DD HH:MM:SS`,
 *  `duration_sec`, a poster frame. */
const VIMEO_DOC = "ai/talks/Vimeo shaped talk.md";
const VIMEO_TEXT = "*A conference talk.*\n\n## Opening\nHello.\n\n## Transcript\n\n### [00:00:00]\nhi\n\n### [00:12:00]\nbye";

/** A frames-off capture: a flat transcript under a bare `## Transcript`. */
const FLAT_DOC = "ai/general/Flat transcript talk.md";
const FLAT_TEXT = "## Summary\nShort summary.\n\n## Transcript\n\nflat words with no window headings";

function seedReaderDocs(): void {
  put("youtube", NEW_DOC, TODAY, "05:00:00", YT_URL);
  putBody("youtube", NEW_DOC, NEW_TEXT, { date: TODAY, url: YT_URL, summary_kind: "deep", category: "ai/general" });
  put("youtube", OLD_DOC, OLD, "05:00:00");
  putBody("youtube", OLD_DOC, OLD_TEXT, { date: OLD, category: "ai/claude-code" });
  put("vimeo", VIMEO_DOC, YESTERDAY, "05:00:00", "https://vimeo.com/424242");
  putBody("vimeo", VIMEO_DOC, VIMEO_TEXT, {
    date: YESTERDAY,
    url: "https://vimeo.com/424242",
    summary_kind: "deep",
    category: "ai/talks",
    author: "JavaZone",
    upload_date: "2026-09-03 06:49:18",
    duration_sec: 3220,
    thumbnail_url: VIMEO_THUMB,
  });
  put("youtube", FLAT_DOC, FIVE_BACK, "05:00:00", YT_URL);
  putBody("youtube", FLAT_DOC, FLAT_TEXT, { date: FIVE_BACK, category: "ai/general" });
}

/** Thumbnails come from real CDNs; the spec answers them itself. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
async function stubImages(page: Page): Promise<void> {
  for (const host of ["https://i.ytimg.com/**", "https://i.vimeocdn.com/**"]) {
    await page.route(host, (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG_1PX }));
  }
}

async function openReaderDoc(page: Page, id: string, source = "youtube", expectText?: string): Promise<void> {
  await stubImages(page);
  await page.goto(`${BASE}/summaries?doc=${encodeURIComponent(id)}&source=${source}`);
  await expect(page.locator("#sumArticleBody")).toContainText(expectText ?? "");
}

const pills = (page: Page) => page.locator("#sumArticleMain .sum-pill");
const pillKeys = (page: Page) => pills(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-pill")));
const pill = (page: Page, key: string) => page.locator(`#sumArticleMain .sum-pill[data-pill="${key}"] .sum-pill-v`);

test("new shape: pills, TL;DR, takeaways card, outline and transcript links", async ({ page }) => {
  seedReaderDocs();
  await openReaderDoc(page, NEW_DOC, "youtube", "Telling versus showing");
  expect(await pillKeys(page)).toEqual(["source", "captured", "kind", "category", "length", "read"]);
  await expect(pill(page, "source")).toHaveText("YouTube");
  await expect(pill(page, "captured")).toHaveText(`${TODAY} · today`);
  await expect(pill(page, "kind")).toHaveText("deep");
  await expect(pill(page, "category")).toHaveText("ai/general");
  // The length is estimated from the transcript: the last window's start plus
  // its words at the earlier window's rate (8 words per 120 s), so 240 s.
  await expect(pill(page, "length")).toHaveText("~4 min");
  await expect(page.locator('.sum-pill[data-pill="length"] .sum-pill-est')).toHaveText("est.");
  await expect(pill(page, "read")).toHaveText("2 min read"); // the words before ## Transcript only
  await expect(page.locator(".sum-hero-thumb")).toHaveAttribute("src", "https://i.ytimg.com/vi/rmr-LdARqHE/mqdefault.jpg");
  await expect(page.locator(".sum-hero-thumb")).toHaveAttribute("referrerpolicy", "no-referrer");

  // The lede is the TL;DR, and is not repeated in the body.
  await expect(page.locator(".sum-tldr")).toContainText("A short talk arguing");
  await expect(page.locator("#sumArticleBody")).not.toContainText("A short talk arguing");
  // Key takeaways is a card; the closing 💬 Takeaway is not.
  await expect(page.locator(".sum-takeaways h2")).toHaveText("Key takeaways");
  await expect(page.locator(".sum-takeaways")).not.toContainText("From instructions");
  await expect(page.locator("#sumArticleBody > h2", { hasText: "💬 Takeaway" })).toHaveCount(1);

  // The outline: the ## headings, then the transcript.
  const outline = page.locator("#sumOutline a.sum-outline-link");
  await expect(outline).toHaveText([
    "Key takeaways", "From instructions to learned intelligence", "Why it doesn't matter", "💬 Takeaway", "Transcript",
  ]);
  // The transcript <details> stays in the article column, closed.
  const details = page.locator("#sumArticleMain details.sum-transcript");
  await expect(details).not.toHaveAttribute("open", "");
  await page.locator("#sumOutline a.sum-outline-transcript").click();
  await expect(details).toHaveAttribute("open", "");
  await expect(details.locator("summary")).toBeInViewport();
  // Window headings link to that second of the video, in a new tab.
  const stamp = details.locator("h3 a", { hasText: "[00:02:00]" });
  await expect(stamp).toHaveAttribute("href", `${YT_URL}&t=120s`);
  await expect(stamp).toHaveAttribute("target", "_blank");
});

test("old shape: a ### outline, no TL;DR, no card, and no empty pill", async ({ page }) => {
  seedReaderDocs();
  await openReaderDoc(page, OLD_DOC, "youtube", "print mode");
  expect(await pillKeys(page)).toEqual(["source", "captured", "category", "read"]);
  for (const text of await pills(page).locator(".sum-pill-v").allTextContents()) expect(text.trim()).not.toBe("");
  await expect(page.locator(".sum-tldr")).toHaveCount(0);
  await expect(page.locator(".sum-takeaways")).toHaveCount(0);
  await expect(page.locator("#sumOutline a.sum-outline-link")).toHaveText([
    "🎯 Main Thesis", "🏗️ The Four Zones", "💡 Key Takeaways",
  ]);
  await expect(page.locator("#sumOutline a.sum-outline-transcript")).toHaveCount(0);
  await expect(page.locator("#sumArticleMain details.sum-transcript")).toHaveCount(0);
});

test("Vimeo shape: author, published from upload_date's day, measured length, poster frame", async ({ page }) => {
  seedReaderDocs();
  await openReaderDoc(page, VIMEO_DOC, "vimeo", "Hello.");
  expect(await pillKeys(page)).toEqual(["source", "captured", "kind", "category", "author", "published", "length", "read"]);
  await expect(pill(page, "author")).toHaveText("JavaZone");
  await expect(pill(page, "published")).toHaveText("2026-09-03");
  await expect(pill(page, "length")).toHaveText("54 min");
  await expect(page.locator('.sum-pill[data-pill="length"] .sum-pill-est')).toHaveCount(0);
  await expect(page.locator(".sum-hero-thumb")).toHaveAttribute("src", VIMEO_THUMB);
  // The Vimeo window headings still link through linkVimeoTimestamps.
  await expect(page.locator("#sumArticleMain a[href='https://vimeo.com/424242#t=720s']")).toHaveCount(1);
});

test("a frames-off capture: a transcript link, but no length pill", async ({ page }) => {
  seedReaderDocs();
  await openReaderDoc(page, FLAT_DOC, "youtube", "Short summary.");
  expect(await pillKeys(page)).toEqual(["source", "captured", "category", "read"]);
  await expect(page.locator("#sumOutline a.sum-outline-transcript")).toHaveCount(1);
});

test("a document with no metadata and no data renders no hero pill it cannot fill", async ({ page }) => {
  await openDeepLink(page, A1);
  // Default fixture docs carry no metadata and an example.com url; the
  // captured day comes from the listing row.
  expect(await pillKeys(page)).toEqual(["source", "captured", "read"]);
  await expect(pill(page, "captured")).toHaveText(`${TODAY} · today`);
  await expect(page.locator(".sum-hero-thumb")).toHaveCount(0);
  await expect(page.locator(".sum-tldr")).toHaveCount(0);
  await expect(page.locator("#sumOutline")).toBeHidden();
});

test("⋯ More: Escape closes it and returns focus; a click elsewhere closes it; Copy link copies the deep link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openDeepLink(page, A2);
  const more = page.locator("#docPanelMore");
  const menu = page.locator("#docPanelMoreMenu");
  await more.click();
  await expect(menu).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(menu.locator('[role="menuitem"]:visible')).toHaveText([/Export/, /Copy link/, /Delete/]);
  // Focus is in the menu; the arrow keys walk it.
  await expect(menu.locator("#docPanelExport")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.locator("#docPanelCopyLink")).toBeFocused();
  // Escape closes the menu, not the panel, and focus goes back to ⋯ More.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  // A second Escape closes the panel as before.
  await page.keyboard.press("Escape");
  await expect(page.locator("#docOverlay")).not.toHaveClass(/visible/);

  await openDeepLink(page, A2);
  await more.click();
  await page.locator("#docPanelTitle").click();
  await expect(menu).toBeHidden();

  await more.click();
  await page.locator("#docPanelCopyLink").click();
  await expect(page.locator("#docPanelCopyLink")).toHaveText(/Link copied/);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`${BASE}/summaries?doc=${encodeURIComponent(A2)}&source=youtube`);
  // The copied link opens that summary.
  await page.goto(copied);
  await expect(page.locator("#sumArticleMain")).toContainText(`Body of ${title(A2)}.`);
});

test("Export is a menu item carrying the export href", async ({ page }) => {
  await openDeepLink(page, A2);
  await page.locator("#docPanelMore").click();
  await expect(page.locator("#docPanelExport")).toHaveAttribute(
    "href",
    `/api/summaries/export?source=youtube&docId=${encodeURIComponent(A2)}`,
  );
});

test("Similar cards: why line, transcript mark, relevance bar and an amber age past 60 days", async ({ page }) => {
  seedReaderDocs();
  const OLD_DAY = railAddDays(TODAY, -90);
  searchResults = [
    { id: NEW_DOC, title: `${title(NEW_DOC)}.md`, url: YT_URL, relevance: 0.9, metadata: { date: TODAY }, matchedChunks: [{ heading: "Key takeaways" }] },
    {
      id: "ai/general/Summary match.md", title: "Summary match.md", url: "https://www.youtube.com/watch?v=4B4R2T4w7Kg",
      relevance: 0.75, metadata: { date: TODAY },
      matchedChunks: [{ heading: null }, { heading: "Why it doesn't matter" }, { heading: "[00:06:00]" }],
    },
    {
      id: "ai/general/Transcript match.md", title: "Transcript match.md", url: "https://www.youtube.com/watch?v=6xQ8LQfkBg4",
      relevance: 0.6, metadata: { date: OLD_DAY }, matchedChunks: [{ heading: "[00:06:00]" }],
    },
    { id: "ai/general/Flat match.md", title: "Flat match.md", url: "", relevance: 0.4, matchedChunks: [{ heading: "Transcript" }] },
    { id: "ai/general/No heading.md", title: "No heading.md", relevance: 0.3, matchedChunks: [{ heading: null }] },
  ];
  await openReaderDoc(page, NEW_DOC, "youtube", "Telling versus showing");
  const card = (id: string) => page.locator(`#docSimilarPanel .sum-sim-card[data-doc-id="${id}"]`);
  // The open document is not its own neighbour.
  await expect(page.locator("#docSimilarPanel .sum-sim-card")).toHaveCount(4);
  await expect(card(NEW_DOC)).toHaveCount(0);
  await expect(card("ai/general/Summary match.md").locator(".sum-sim-why")).toHaveText("Matched: Why it doesn't matter");
  await expect(card("ai/general/Summary match.md").locator(".sum-sim-thumb")).toHaveAttribute("src", "https://i.ytimg.com/vi/4B4R2T4w7Kg/mqdefault.jpg");
  const tx = card("ai/general/Transcript match.md");
  await expect(tx.locator(".sum-sim-why .sum-sim-tag")).toHaveText("transcript");
  await expect(tx.locator(".sum-sim-why")).toHaveText("transcript[00:06:00]");
  await expect(tx.locator(".sum-sim-age")).toHaveClass(/stale/);
  await expect(card("ai/general/Summary match.md").locator(".sum-sim-age")).not.toHaveClass(/stale/);
  await expect(card("ai/general/Flat match.md").locator(".sum-sim-why")).toHaveText("transcript");
  // No heading, no date, no url: no why line, no age, no thumbnail.
  const bare = card("ai/general/No heading.md");
  await expect(bare.locator(".sum-sim-why")).toHaveCount(0);
  await expect(bare.locator(".sum-sim-age")).toHaveCount(0);
  await expect(bare.locator(".sum-sim-thumb")).toHaveCount(0);
  const bar = await card("ai/general/Summary match.md").locator(".sum-sim-bar > span").evaluate((el) => (el as HTMLElement).style.width);
  expect(bar).toBe("75%");
});

test("j stepping through the rail searches once, for the summary it stops on", async ({ page }) => {
  await openDeepLink(page, A1);
  await page.waitForTimeout(AFTER_SIMILAR_DEBOUNCE_MS); // A1's own search has gone out
  const searches: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/similar?")) searches.push(new URL(r.url()).searchParams.get("q")!); });
  await page.locator("#docPanelTitle").click();
  // Each step waits for its article, so every open's fetch has landed: only
  // the wait before the search keeps the passed rows from searching.
  for (const id of [A2, A3, L1]) {
    await page.keyboard.press("j");
    await expect(page.locator("#sumArticleMain")).toContainText(`Body of ${title(id)}.`);
  }
  await page.waitForTimeout(AFTER_SIMILAR_DEBOUNCE_MS);
  // Similar searches the summary's opening, not its title.
  expect(searches).toEqual([`Body of ${title(L1)}.`]);
});

test("Similar searches the summary's opening without the transcript; the title only when there is none", async ({ page }) => {
  seedReaderDocs();
  const calls: URL[] = [];
  page.on("request", (r) => { if (r.url().includes("/similar?")) calls.push(new URL(r.url())); });
  await openReaderDoc(page, NEW_DOC, "youtube", "Telling versus showing");
  await expect.poll(() => calls.length).toBe(1);
  const q = calls[0]!.searchParams.get("q")!;
  expect(q.startsWith("*A short talk arguing")).toBe(true);
  expect(q.length).toBe(2000);
  expect(q).not.toContain("so today I want to talk about machines");
  expect(calls[0]!.searchParams.get("corrective")).toBe("off");
  expect(calls[0]!.searchParams.get("max_chunk_chars")).toBe("200");

  // A summary that is all transcript has no opening: the title goes out, on
  // huginn's default corrective mode.
  const ONLY_TX = "ai/general/Only transcript.md";
  put("youtube", ONLY_TX, TODAY, "04:30:00");
  putBody("youtube", ONLY_TX, "## Transcript\n\nspoken words only", { date: TODAY });
  await page.evaluate((id) => (window as unknown as PageWindow).openSummaryDoc!(id, "", "youtube"), ONLY_TX);
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]!.searchParams.get("q")).toBe(title(ONLY_TX));
  expect(calls[1]!.searchParams.has("corrective")).toBe(false);
});

test("the outline marks the section in view", async ({ page }) => {
  seedReaderDocs();
  await page.setViewportSize({ width: 1440, height: 600 });
  await openReaderDoc(page, NEW_DOC, "youtube", "Telling versus showing");
  const active = page.locator("#sumOutline a.sum-outline-link.active");
  await expect(active).toHaveText("Key takeaways");
  await page.locator("#sumOutline a.sum-outline-link", { hasText: "Why it doesn't matter" }).click();
  await expect(active).toHaveText("Why it doesn't matter");
  await expect(active).toHaveAttribute("aria-current", "location");
  await expect(page.locator("#sumArticleBody h2", { hasText: "Why it doesn't matter" })).toBeFocused();
});

test("newer and older follow the rail's order and its filter", async ({ page }) => {
  await openDeepLink(page, A2);
  const nav = page.locator("#sumArticleNav");
  await expect(nav.locator(".sum-nav-newer")).toHaveAttribute("data-doc-id", A1);
  await expect(nav.locator(".sum-nav-older")).toHaveAttribute("data-doc-id", A3);
  // Filter the rail to the "tools" category: A2 (agents) stays as the anchor,
  // its neighbours are the tools rows around it.
  await rail(page).locator('.sum-rail-chip[data-chip="cat:ai/tools"]').click();
  await expect(nav.locator(".sum-nav-newer")).toHaveCount(0);
  await expect(nav.locator(".sum-nav-older")).toHaveAttribute("data-doc-id", A3);
  await nav.locator(".sum-nav-older").click();
  await expect(page.locator("#docPanelTitle")).toHaveText(title(A3));
  await expect(nav.locator(".sum-nav-older")).toHaveAttribute("data-doc-id", B2);
  // The oldest summary in the listing has no older link.
  await rail(page).locator('.sum-rail-chip[data-chip="all"]').click();
  await page.evaluate((id) => (window as unknown as PageWindow).openSummaryDoc!(id, "", "youtube"), D1);
  await expect(nav.locator(".sum-nav-newer")).toHaveCount(1);
  await expect(nav.locator(".sum-nav-older")).toHaveCount(0);
});

test("x-article labels its source link by transcript presence", async ({ page }) => {
  const POST = "ai/agents/Pasted post.md";
  const VIDEO = "ai/agents/X video.md";
  put("x-article", POST, TODAY, "04:00:00", "https://x.com/a/status/1");
  put("x-article", VIDEO, TODAY, "03:00:00", "https://x.com/a/status/2");
  putBody("x-article", VIDEO, "Summary.\n\n## Transcript\n\nwords", { date: TODAY });
  await openDeepLink(page, POST, "x-article");
  await expect(page.locator("#docPanelLinks a")).toHaveText("Read on X ↗");
  await page.evaluate((id) => (window as unknown as PageWindow).openSummaryDoc!(id, "https://x.com/a/status/2", "x-article"), VIDEO);
  await expect(page.locator("#docPanelLinks a")).toHaveText("Watch on X ↗");
  await expect(page.locator("#docPanelLinks a")).toHaveCount(1);
  await expect(page.locator("#docPanelLinks a")).toHaveAttribute("href", "https://x.com/a/status/2");
});

test("header, pills, TL;DR, cards and the menu read at AA in both themes", async ({ page }) => {
  seedReaderDocs();
  searchResults = [
    { id: "ai/general/Old match.md", title: "Old match.md", relevance: 0.6, metadata: { date: railAddDays(TODAY, -90) }, matchedChunks: [{ heading: "[00:06:00]" }] },
  ];
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await openReaderDoc(page, NEW_DOC, "youtube", "Telling versus showing");
    await page.mouse.move(0, 0);
    await expect(page.locator(".sum-sim-age.stale")).toHaveCount(1);
    await page.locator("#docPanelMore").click();
    const checks = {
      "primary action": page.locator("#docPanelFollowUp"),
      "pill value": pill(page, "kind"),
      "pill key": page.locator('.sum-pill[data-pill="kind"] .sum-pill-k'),
      "estimate mark": page.locator(".sum-pill-est"),
      "TL;DR label": page.locator(".sum-tldr-k"),
      "TL;DR text": page.locator(".sum-tldr p"),
      "outline link": page.locator("#sumOutline a.sum-outline-link").nth(1),
      "outline active": page.locator("#sumOutline a.sum-outline-link.active"),
      "similar age (stale)": page.locator(".sum-sim-age.stale"),
      "similar why": page.locator(".sum-sim-why"),
      "menu item": page.locator("#docPanelCopyLink"),
      "newer/older label": page.locator("#sumArticleNav .sum-nav-k").first(),
      "outline title": page.locator("#sumOutline .sum-side-title"),
      "similar title": page.locator("#docSimilarPanel h4"),
    };
    for (const [name, loc] of Object.entries(checks)) {
      expect(await paintedContrast(loc), `${scheme} ${name}`).toBeGreaterThanOrEqual(4.5);
    }
    await page.locator("#docPanelDelete").hover();
    expect(await paintedContrast(page.locator("#docPanelDelete")), `${scheme} menu danger (hover)`).toBeGreaterThanOrEqual(4.5);
    await page.mouse.move(0, 0);
    await page.keyboard.press("Escape");
  }
});

test("narrow (390px): the header wraps inside the viewport and the article starts near the top", async ({ page }) => {
  seedReaderDocs();
  // Long nowrap titles in the newer/older links and a Similar card: their
  // min-content must not widen the one-column grid.
  const LONG = "ai/general/" + "A very long neighbouring summary title that keeps going ".repeat(3).trim() + ".md";
  put("youtube", LONG, TODAY, "05:30:00");
  searchResults = [{ id: LONG, title: `${title(LONG)}.md`, relevance: 0.5, metadata: { date: TODAY }, matchedChunks: [{ heading: "A section heading that is also rather long for a card" }] }];
  await page.setViewportSize({ width: 390, height: 844 });
  await openReaderDoc(page, NEW_DOC, "youtube", "Telling versus showing");
  // The panel slides in; measure once it has landed.
  await expect.poll(async () => (await page.locator(".doc-panel").boundingBox())!.x).toBe(0);
  const overflow = await page.evaluate(() => {
    const h = document.querySelector(".doc-panel-header")!;
    return { scroll: h.scrollWidth, client: h.clientWidth, doc: document.documentElement.scrollWidth };
  });
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
  await expect(page.locator("#sumArticleNav .sum-nav-newer")).toHaveAttribute("data-doc-id", LONG);
  await expect(page.locator("#docSimilarPanel .sum-sim-card")).toHaveCount(1);
  const body = await page.locator("#docPanelBody").evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(body[0], "panel body scrolls sideways").toBeLessThanOrEqual(body[1]!);
  expect(overflow.doc).toBeLessThanOrEqual(390);
  for (const id of ["docPanelMore", "docPanelFollowUp", "docPanelShare"]) {
    const box = (await page.locator(`#${id}`).boundingBox())!;
    expect(box.x + box.width, id).toBeLessThanOrEqual(390);
  }
  // The hero and TL;DR are on the first screen, not below the rail or outline.
  await expect(page.locator(".sum-tldr")).toBeInViewport();
  await expect(page.locator("#sumOutline")).toBeHidden();
  // The menu opens inside the viewport.
  await page.locator("#docPanelMore").click();
  const menu = (await page.locator("#docPanelMoreMenu").boundingBox())!;
  expect(menu.x).toBeGreaterThanOrEqual(0);
  expect(menu.x + menu.width).toBeLessThanOrEqual(390);
});

// --- Fix round 1 ------------------------------------------------------------

test("⋯ More and ↻ Re-run ▾ are never open together, and one Escape closes the open one", async ({ page }) => {
  await openDeepLink(page, A2);
  const moreBtn = page.locator("#docPanelMore");
  const more = page.locator("#docPanelMoreMenu");
  const rerun = page.locator("#docPanelRerunMenu");
  await moreBtn.click();
  await expect(more).toBeVisible();
  await page.locator("#docPanelRerun").click();
  await expect(rerun).toBeVisible();
  await expect(more).toBeHidden();
  await expect(moreBtn).toHaveAttribute("aria-expanded", "false");
  await moreBtn.click();
  await expect(more).toBeVisible();
  await expect(rerun).toBeHidden();
  await expect(page.locator("#docPanelRerun")).toHaveAttribute("aria-expanded", "false");
  // One Escape: the menu goes, the panel stays, focus is back on ⋯ More.
  await page.keyboard.press("Escape");
  await expect(more).toBeHidden();
  await expect(rerun).toBeHidden();
  await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
  await expect(moreBtn).toBeFocused();
});

test("narrow (390px): the Re-run menu opens inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeepLink(page, A2);
  await expect.poll(async () => (await page.locator(".doc-panel").boundingBox())!.x).toBe(0);
  await page.locator("#docPanelRerun").click();
  const rerun = page.locator("#docPanelRerunMenu");
  await expect(rerun).toBeVisible();
  await expect(rerun).not.toContainText("Loading");
  const box = (await rerun.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});

test("the outline at a normal viewport: the clicked entry is active, and scrolling down reaches every section", async ({ page }) => {
  seedReaderDocs();
  await page.setViewportSize({ width: 1440, height: 900 });
  const active = page.locator("#sumOutline a.sum-outline-link.active");
  const entry = (text: string) => page.locator("#sumOutline a.sum-outline-link", { hasText: text });

  await openReaderDoc(page, NEW_DOC, "youtube", "Telling versus showing");
  await entry("💬 Takeaway").click();
  await expect(active).toHaveText("💬 Takeaway");
  await entry("Why it doesn't matter").click();
  await expect(active).toHaveText("Why it doesn't matter");
  // From the top, in steps, to the bottom: every section is marked on the way.
  const seen = await page.locator("#docPanelBody").evaluate(async (el) => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out: string[] = [];
    el.scrollTop = 0;
    await frame();
    for (let y = 0; ; y += 40) {
      el.scrollTop = y;
      await frame();
      const a = document.querySelector("#sumOutline a.sum-outline-link.active");
      const t = a ? (a.textContent || "").trim() : "";
      if (out[out.length - 1] !== t) out.push(t);
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) break;
    }
    return out;
  });
  expect(seen).toEqual(["Key takeaways", "From instructions to learned intelligence", "Why it doesn't matter", "💬 Takeaway", "Transcript"]);

  await openReaderDoc(page, OLD_DOC, "youtube", "print mode");
  await entry("💡 Key Takeaways").click();
  await expect(active).toHaveText("💡 Key Takeaways");
  await entry("🏗️ The Four Zones").click();
  await expect(active).toHaveText("🏗️ The Four Zones");
});

test("Copy link without navigator.clipboard keeps focus on the item and the menu open", async ({ page }) => {
  // An http:// page off loopback: no secure context, no navigator.clipboard.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined, configurable: true });
  });
  page.on("dialog", (d) => void d.dismiss());
  await openDeepLink(page, A2);
  await page.locator("#docPanelMore").click();
  const copy = page.locator("#docPanelCopyLink");
  await copy.click();
  await expect(copy).toHaveText(/Link copied|Copy failed/);
  await expect(page.locator("#docPanelMoreMenu")).toBeVisible();
  await expect(copy).toBeFocused();
});

test("an unregistered source: no Copy link, and no ⋯ More with nothing in it", async ({ page }) => {
  await page.goto(`${BASE}/summaries?doc=${encodeURIComponent(A2)}&source=bogus`);
  await expect(page.locator("#sumArticleMain")).toContainText(`Body of ${title(A2)}.`);
  await expect(page.locator("#docPanelCopyLink")).toHaveAttribute("hidden", "");
  await expect(page.locator("#docPanelMore")).toBeHidden();
});

test("Newer and Older keep keyboard focus in the article", async ({ page }) => {
  await openDeepLink(page, A2);
  const older = page.locator("#sumArticleNav .sum-nav-older");
  await expect(older).toHaveAttribute("data-doc-id", A3);
  await older.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#docPanelTitle")).toHaveText(title(A3));
  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? "")).toBe("sumArticleMain");
  // Tab continues inside the panel, not from the top of the page.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("#docPanelBody"))).toBe(true);
});

test("narrow (390px): a wide table and a long inline code span do not scroll the page sideways", async ({ page }) => {
  const WIDE_DOC = "ai/general/Wide table talk.md";
  put("youtube", WIDE_DOC, TODAY, "06:00:00", YT_URL);
  putBody("youtube", WIDE_DOC, [
    "## Comparison",
    "| Model | Memory bandwidth | Unified memory | Neural engine cores | Price in NOK | Verdict for local models |",
    "| --- | --- | --- | --- | --- | --- |",
    "| M6 Mac Mini 32GB | 273 GB/s measured | 32 GB LPDDR5X | 16 cores | 14 990 kr | wins on tokens per second |",
    "",
    // No space and no hyphen: the browser has no break opportunity in it.
    "Set `ANTHROPIC_VERTEX_PROJECT_ID_AND_CLOUD_ML_REGION_AND_VERTEX_REGION_CLAUDE_4_5_SONNET_OVERRIDE` first.",
  ].join("\n"), { date: TODAY });
  await page.setViewportSize({ width: 390, height: 844 });
  await openReaderDoc(page, WIDE_DOC, "youtube", "first.");
  await expect.poll(async () => (await page.locator(".doc-panel").boundingBox())!.x).toBe(0);
  const body = await page.locator("#docPanelBody").evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(body[0], "panel body scrolls sideways").toBeLessThanOrEqual(body[1]!);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // The table keeps its columns and scrolls inside its own box.
  const table = await page.locator("#sumArticleBody table").evaluate((t) => {
    const box = t.parentElement!;
    return { box: box.scrollWidth > box.clientWidth, overflow: getComputedStyle(box).overflowX };
  });
  expect(table).toEqual({ box: true, overflow: "auto" });
});

test("a Similar card is one link: the thumbnail and the why line open it too", async ({ page }) => {
  seedReaderDocs();
  const ID = "ai/general/Summary match.md";
  searchResults = [{
    id: ID, title: "Summary match.md", url: "https://www.youtube.com/watch?v=4B4R2T4w7Kg",
    relevance: 0.75, metadata: { date: TODAY }, matchedChunks: [{ heading: "Why it doesn't matter" }],
  }];
  await openReaderDoc(page, NEW_DOC, "youtube", "Telling versus showing");
  const card = page.locator(`#docSimilarPanel .sum-sim-card[data-doc-id="${ID}"]`);
  expect(await card.evaluate((el) => el.tagName)).toBe("A");
  await expect(card.locator("a, button, input")).toHaveCount(0);
  await card.locator(".sum-sim-why").click();
  await expect(page.locator("#docPanelTitle")).toHaveText("Summary match");

  await openReaderDoc(page, NEW_DOC, "youtube", "Telling versus showing");
  await card.locator(".sum-sim-thumb").click();
  await expect(page.locator("#docPanelTitle")).toHaveText("Summary match");

  await openReaderDoc(page, NEW_DOC, "youtube", "Telling versus showing");
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#docPanelTitle")).toHaveText("Summary match");
});

test("x-article: the header names no source link until the document says which kind it is", async ({ page }) => {
  const POST = "ai/agents/Slow pasted post.md";
  const FAILS = "ai/agents/Failing post.md";
  put("x-article", POST, TODAY, "04:00:00", "https://x.com/a/status/1");
  put("x-article", FAILS, TODAY, "03:00:00", "https://x.com/a/status/3");
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route(/\/api\/x-articles\/document\/.*Slow/, async (route) => { await gate; await route.continue(); });
  await page.route(/\/api\/x-articles\/document\/.*Failing/, (route) => route.fulfill({ status: 500, body: "{}" }));
  await openDeepLink(page, A1);
  const link = page.locator("#docPanelLinks a");
  await page.evaluate((id) => void (window as unknown as PageWindow).openSummaryDoc!(id, "https://x.com/a/status/1", "x-article"), POST);
  await expect(page.locator("#docPanelTitle")).toHaveText(title(POST));
  await page.waitForTimeout(300);
  await expect(link).toHaveCount(0);
  release();
  await expect(link).toHaveText("Read on X ↗");
  // A document that cannot be read keeps the registry's neutral label.
  await page.evaluate((id) => void (window as unknown as PageWindow).openSummaryDoc!(id, "https://x.com/a/status/3", "x-article"), FAILS);
  await expect(page.locator("#sumArticleMain")).toContainText("Failed to load");
  await expect(link).toHaveText("View on X ↗");
});

// --- Fix round 2 ------------------------------------------------------------

test("Older: focus the reader moved while the summary loaded stays where it went", async ({ page }) => {
  await openDeepLink(page, A2);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route(/\/document\/.*third/, async (route) => { await gate; await route.continue(); });
  const older = page.locator("#sumArticleNav .sum-nav-older");
  await expect(older).toHaveAttribute("data-doc-id", A3);
  await older.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#docPanelTitle")).toHaveText(title(A3));
  const filter = page.locator("#sumRailFilter");
  await filter.focus();
  release();
  await expect(page.locator("#sumArticleMain")).toContainText(`Body of ${title(A3)}.`);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => document.activeElement?.id ?? "")).toBe("sumRailFilter");
});

test("a modified click on a Similar card opens a new page and leaves the panel alone", async ({ page, context }) => {
  seedReaderDocs();
  const ID = "ai/general/Summary match.md";
  searchResults = [{ id: ID, title: "Summary match.md", url: YT_URL, relevance: 0.75, metadata: { date: TODAY } }];
  await openReaderDoc(page, NEW_DOC, "youtube", "Telling versus showing");
  const titleEl = page.locator("#docPanelTitle");
  const before = await titleEl.textContent();
  const card = page.locator(`#docSimilarPanel .sum-sim-card[data-doc-id="${ID}"]`);
  for (const modifiers of [["ControlOrMeta"], ["Shift"]] as const) {
    const popup = context.waitForEvent("page", { timeout: 5000 });
    await card.click({ modifiers: [...modifiers] });
    await page.waitForTimeout(300);
    await expect(titleEl, `${modifiers[0]}-click`).toHaveText(before!);
    await (await popup).close();
  }
});

test("the header menus: Home and End jump to the first and last item, Tab closes the menu", async ({ page }) => {
  // Re-run's options, answered here so its items are enabled (this spec has no bot to run one on).
  await page.route("**/api/summaries/rerun/options**", (r) => r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ hasTranscript: true, storedKind: "standard", kinds: [{ id: "deep", label: "Deep" }], promptUrl: YT_URL }),
  }));
  await openDeepLink(page, A2);
  for (const [btnId, popId] of [["docPanelMore", "docPanelMoreMenu"], ["docPanelRerun", "docPanelRerunMenu"]]) {
    const pop = page.locator(`#${popId}`);
    await page.locator(`#${btnId}`).click();
    await expect(pop).toBeVisible();
    await expect(pop).not.toContainText("Loading");
    const focusedIndex = () => page.evaluate((id) => {
      const items = Array.from(document.querySelectorAll<HTMLElement & { disabled?: boolean }>(`#${id} .doc-panel-menu-item`))
        .filter((el) => !el.hidden && !el.disabled);
      return { at: items.indexOf(document.activeElement as HTMLElement), n: items.length };
    }, popId);
    const { n } = await focusedIndex();
    expect(n, `${popId} has items to walk`).toBeGreaterThan(1);
    await page.keyboard.press("End");
    expect((await focusedIndex()).at, `${popId} End`).toBe(n - 1);
    await page.keyboard.press("Home");
    expect((await focusedIndex()).at, `${popId} Home`).toBe(0);
    await page.keyboard.press("Tab");
    await expect(pop, `${popId} Tab`).toBeHidden();
    await expect(page.locator(`#${btnId}`)).toHaveAttribute("aria-expanded", "false");
  }
});

test("Copy link: a failed copy says so, and asks nothing", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "clipboard", {
      get: () => ({ writeText: () => Promise.reject(new Error("denied")) }),
      configurable: true,
    });
    Document.prototype.execCommand = () => false;
    (window as unknown as { __prompts: number }).__prompts = 0;
    window.prompt = () => { (window as unknown as { __prompts: number }).__prompts++; return null; };
  });
  await openDeepLink(page, A2);
  await page.locator("#docPanelMore").click();
  const copy = page.locator("#docPanelCopyLink");
  await copy.click();
  await expect(copy).toHaveText("✕ Copy failed");
  expect(await page.evaluate(() => (window as unknown as { __prompts: number }).__prompts)).toBe(0);
  await expect(page.locator("#docPanelMoreMenu")).toBeVisible();
});

// --- PR 2: Same story this week, In your wiki --------------------------------

/** The bot names this file's proposal rows are filed under: no real bot has
 *  them, so the cleanup cannot touch a developer's rows. */
const E2E_BOTS = ["e2e-reader-wiki", "e2e-reader-wiki-2"];

/** The applied proposal's page, present in E2E_BOTS[0]'s temp wiki. */
const APPLIED_PAGE = "sources/e2e-reader-applied.mdx";
const APPLIED_TITLE = "E2E applied source page";

async function withProposals(rows: Array<{ bot: string; topic: string; status: string; docId: string; target?: string }>, fn: () => Promise<void>): Promise<void> {
  const sql = postgres(TEST_DB, { max: 1, onnotice: () => {} });
  const clean = () => sql`DELETE FROM wiki_proposals WHERE bot_name IN ${sql(E2E_BOTS)}`;
  try {
    await clean();
    for (const r of rows) {
      const docs = [{ collection: "youtube-summaries", docId: r.docId, title: title(r.docId), url: YT_URL }];
      await sql`INSERT INTO wiki_proposals (bot_name, topic_key, kind, mode, target_path, draft, source_docs, status)
                VALUES (${r.bot}, ${r.topic}, 'source', 'create', ${r.target ?? "sources/" + r.topic + ".mdx"}, '# x', ${sql.json(docs as never)}, ${r.status})`;
    }
    await fn();
  } finally {
    await clean();
    await sql.end();
  }
}

test("Same story this week and In your wiki: filtered, deduped, linked, in rail order, at AA and 390px", async ({ page }) => {
  seedReaderDocs();
  const DUP = "ai/general/Also in Similar.md";
  const CROSS = "ai/claude/Claude Opus 5.5.md";
  const X_POST = "ai/general/X post.md";
  const YT_WEEK = "ai/general/Five days back on YouTube.md";
  // A title with no break opportunity must wrap, not widen the panel.
  const UNBROKEN = "ai/general/" + "Unbroken".repeat(20) + ".md";
  searchResults = [
    { id: DUP, title: `${title(DUP)}.md`, relevance: 0.6, metadata: { date: TODAY } },
    { id: UNBROKEN, title: `${title(UNBROKEN)}.md`, relevance: 0.55, metadata: { date: TODAY } },
  ];
  sameStoryResults = [
    { collection: "youtube-summaries", source: "youtube", id: NEW_DOC, title: `${title(NEW_DOC)}.md`, relevance: 0.75, metadata: { date: TODAY } },
    { collection: "youtube-summaries", source: "youtube", id: DUP, title: `${title(DUP)}.md`, relevance: 0.67, metadata: { date: TODAY } },
    { collection: "anthropic-summaries", source: "anthropic", id: CROSS, title: `${title(CROSS)}.md`, relevance: 0.605, metadata: { date: YESTERDAY }, matchedChunks: [{ heading: "Key takeaways" }] },
    { collection: "youtube-summaries", source: "youtube", id: "ai/general/Weak.md", title: "Weak.md", relevance: 0.3, metadata: { date: TODAY } },
    { collection: "youtube-summaries", source: "youtube", id: "ai/general/Last month.md", title: "Last month.md", relevance: 0.55, metadata: { date: railAddDays(TODAY, -10) } },
    { collection: "x-articles", source: "x-article", id: X_POST, title: `${title(X_POST)}.md`, relevance: 0.5, modifiedTime: `${TODAY}T08:00:00.000000` },
    { collection: "youtube-summaries", source: "youtube", id: YT_WEEK, title: `${title(YT_WEEK)}.md`, url: YT_URL, relevance: 0.469, metadata: { date: FIVE_BACK } },
  ];
  // The fake's served set has no article-summaries: the route must leave it
  // out, or the whole search 404s and the section never renders.
  await withProposals([
    { bot: E2E_BOTS[0]!, topic: "e2e-reader-applied", status: "applied", docId: NEW_DOC },
    // A second draft of the page that was applied: still one row.
    { bot: E2E_BOTS[0]!, topic: "e2e-reader-applied-again", status: "draft", docId: NEW_DOC, target: APPLIED_PAGE },
    { bot: E2E_BOTS[1]!, topic: "e2e-reader-draft", status: "draft", docId: NEW_DOC },
    { bot: E2E_BOTS[0]!, topic: "e2e-reader-rejected", status: "rejected", docId: NEW_DOC },
    { bot: E2E_BOTS[0]!, topic: "e2e-reader-other", status: "draft", docId: OLD_DOC },
  ], async () => {
    await openReaderDoc(page, NEW_DOC, "youtube", "Telling versus showing");
    const same = page.locator("#sumSameStory");
    await expect(same).toBeVisible();
    await expect(same.locator("h4")).toHaveText("Same story this week");
    // Each section is a region named by its own heading, not a second copy.
    await expect(page.getByRole("region", { name: "Same story this week" })).toBeVisible();
    await expect(same).not.toHaveAttribute("aria-label", /./);
    await expect(same).toHaveAttribute("aria-labelledby", (await same.locator("h4").getAttribute("id")) ?? "missing-id");
    await expect(same.locator(".sum-sim-card")).toHaveCount(3);
    await expect(same.locator(".sum-sim-card").nth(0)).toHaveAttribute("data-doc-id", CROSS);
    await expect(same.locator(".sum-sim-card").nth(1)).toHaveAttribute("data-doc-id", X_POST);
    await expect(same.locator(".sum-sim-card").nth(2)).toHaveAttribute("data-doc-id", YT_WEEK);
    const cross = same.locator(`.sum-sim-card[data-doc-id="${CROSS}"]`);
    await expect(cross).toHaveAttribute("data-source", "anthropic");
    await expect(cross).toHaveAttribute("href", `/summaries?doc=${encodeURIComponent(CROSS)}&source=anthropic`);
    await expect(cross.locator(".sum-sim-src")).toHaveText("Claude");
    // The age stays on one line beside the bar, percentage and badge, in the
    // ~270 px rail of a 1440 window.
    await page.setViewportSize({ width: 1440, height: 900 });
    const week = same.locator(`.sum-sim-card[data-doc-id="${YT_WEEK}"]`);
    await expect(week.locator(".sum-sim-thumb")).toBeVisible();
    await expect(week.locator(".sum-sim-age")).toHaveText("5 days ago");
    const age = await week.locator(".sum-sim-age").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { height: r.height, line: parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.2 };
    });
    expect(age.height, "the age wraps").toBeLessThan(age.line * 1.5);
    await expect(page.locator(`#docSimilarPanel .sum-sim-card[data-doc-id="${DUP}"]`)).toHaveCount(1);
    expect(sameStoryQueries).toEqual([title(NEW_DOC)]);

    const wiki = page.locator("#sumInWiki");
    await expect(wiki).toBeVisible();
    await expect(wiki.locator("h4")).toHaveText("In your wiki");
    await expect(page.getByRole("region", { name: "In your wiki" })).toBeVisible();
    await expect(wiki).not.toHaveAttribute("aria-label", /./);
    await expect(wiki).toHaveAttribute("aria-labelledby", (await wiki.locator("h4").getAttribute("id")) ?? "missing-id");
    const links = wiki.locator("a.sum-wiki-link");
    await expect(links).toHaveCount(2);
    await expect(wiki.locator('a[data-status="applied"]')).toHaveAttribute("href", `/wiki?wiki=${E2E_BOTS[0]}&relPath=${encodeURIComponent(APPLIED_PAGE)}`);
    await expect(wiki.locator('a[data-status="draft"]')).toHaveAttribute("href", `/wiki/gardener?wiki=${E2E_BOTS[1]}`);
    await expect(wiki.locator('a[data-status="draft"] .sum-wiki-meta')).toHaveText(`Draft to review · ${E2E_BOTS[1]}`);

    // Rail order: On this page, Similar, Same story, In your wiki.
    const order = await page.locator("#sumRightRail > *").evaluateAll((els) => els.map((e) => e.id));
    expect(order).toEqual(["sumOutline", "docSimilarPanel", "sumSameStory", "sumInWiki"]);

    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.mouse.move(0, 0);
      const checks = {
        "same story title": same.locator("h4"),
        "same story source badge": cross.locator(".sum-sim-src"),
        "wiki page": wiki.locator(".sum-wiki-page").first(),
        "wiki meta": wiki.locator(".sum-wiki-meta").first(),
      };
      for (const [name, loc] of Object.entries(checks)) {
        expect(await paintedContrast(loc), `${scheme} ${name}`).toBeGreaterThanOrEqual(4.5);
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(same).toBeVisible();
    const body = await page.locator("#docPanelBody").evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(body[0], "panel body scrolls sideways").toBeLessThanOrEqual(body[1]!);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1440, height: 900 });

    // A card opens its own source's document in place.
    await cross.click();
    await expect(page.locator("#docPanelTitle")).toHaveText(title(CROSS));
    await expect(page.locator("#sumArticleMain")).toContainText(`Body of ${title(CROSS)}.`);

    // Nothing left to show: both sections are absent, not empty.
    sameStoryResults = [];
    await page.evaluate((id) => (window as unknown as PageWindow).openSummaryDoc!(id, "", "youtube"), OLD_DOC);
    await expect(page.locator("#sumArticleMain")).toContainText("print mode");
    await page.waitForTimeout(AFTER_SIMILAR_DEBOUNCE_MS);
    await expect(page.locator("#sumInWiki")).toBeVisible(); // OLD_DOC's own draft
    await expect(page.locator("#sumInWiki a.sum-wiki-link")).toHaveCount(1);
    await expect(same).toBeHidden();
    await expect(same.locator("*")).toHaveCount(0);

    // The applied row's link opens that page in the wiki reader, not the
    // wiki's start page.
    await page.evaluate((id) => (window as unknown as PageWindow).openSummaryDoc!(id, "", "youtube"), NEW_DOC);
    const applied = page.locator('#sumInWiki a[data-status="applied"]');
    await expect(applied).toBeVisible();
    await applied.click();
    await expect(page).toHaveURL(/\/wiki\?/);
    await expect(page.locator("#articleWrap").getByRole("heading", { level: 1, name: APPLIED_TITLE })).toBeVisible();
    await expect(page.locator("#articleWrap")).toContainText("Drafted from a summary.");
  });
});

test("a failed summary body still searches, on the title", async ({ page }) => {
  seedReaderDocs();
  const MISSING = "ai/general/Gone body.md";
  put("youtube", MISSING, TODAY, "04:00:00");
  const searches: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/similar?")) searches.push(new URL(r.url()).searchParams.get("q")!); });
  await page.route(`**/api/youtube/document/**`, (route) => route.fulfill({ status: 500, body: "{}" }));
  await stubImages(page);
  await page.goto(`${BASE}/summaries?doc=${encodeURIComponent(MISSING)}&source=youtube`);
  await expect(page.locator("#sumArticleMain")).toContainText("Failed to load");
  await expect.poll(() => searches).toEqual([title(MISSING)]);
  await expect(page.locator("#docSimilarPanel")).not.toContainText("Searching");
});
