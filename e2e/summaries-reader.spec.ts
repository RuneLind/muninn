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
import { RAIL_READ_STORAGE_KEY, railAddDays, railDayLabel } from "../src/summaries/latest-rail.ts";
import { paintedContrast } from "./contrast.ts";

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
      if (failing.has(coll) || failing.has("*")) return json({ error: "down" }, 500);
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
