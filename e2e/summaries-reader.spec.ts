/**
 * `/summaries` — the doc panel as a reader: the Latest rail.
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
 * NO MODEL CALLS, NO DATABASE WRITES. Ports come from `e2e/ports.ts`.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";
import { railAddDays, railDayLabel } from "../src/summaries/latest-rail.ts";

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
};

/** collection -> id -> doc. Mutated by `put`/`drop` and reset per test. */
let listing: Record<string, Map<string, FakeDoc>> = {};

function put(source: string, id: string, date: string, mtime: string): void {
  const coll = COLLECTIONS[source]!;
  (listing[coll] ??= new Map()).set(id, {
    id,
    date,
    modifiedTime: `${date}T${mtime}.000000`,
    url: `https://example.com/${encodeURIComponent(id)}`,
  });
}

function drop(source: string, id: string): void {
  listing[COLLECTIONS[source]!]?.delete(id);
}

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

test.beforeAll(async () => {
  huginn = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = decodeURIComponent(url.pathname);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (p.startsWith("/api/collection/") && p.endsWith("/documents")) {
      const coll = p.slice("/api/collection/".length, -"/documents".length);
      return json({ documents: [...(listing[coll]?.values() ?? [])] });
    }
    if (p.startsWith("/api/document/")) {
      const rest = p.slice("/api/document/".length);
      const id = rest.slice(rest.indexOf("/") + 1);
      const body = `Body of ${title(id)}.`;
      if (url.searchParams.get("raw") === "1") {
        res.writeHead(200, { "content-type": "text/markdown" });
        return res.end(`---\ndate: "${TODAY}"\n---\n\n${body}\n`);
      }
      return json({ id, text: body });
    }
    if (p === "/api/search") return json({ results: [] });
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
  const stored = await page.evaluate(() => localStorage.getItem("muninn-summaries-read"));
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
  await expect(page.locator('[role="menu"]')).toBeVisible();
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
