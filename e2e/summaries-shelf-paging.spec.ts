/**
 * `/summaries` Shelf — the paging window over a large archive.
 *
 * The shelf renders the newest 10 summaries, then grows by 50 on "Show more" or
 * to everything on "Show all"; a filter change starts over at 10. A fake huginn
 * serves 75 YouTube docs + 5 X docs, so every step is visible: 10 → 60 → 75 of
 * one source, and the X filter (5 docs) needs no footer at all. The X docs sit
 * under `health/`, which maps to the Life domain, so the domain chips and a
 * second category render and both resets can be driven.
 *
 * NO MODEL CALLS, NO DATABASE WRITES. Ports come from `e2e/ports.ts`.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("summaries-shelf-paging");
const HUGINN_PORT = e2ePort("summaries-shelf-paging/huginn");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const YOUTUBE_DOCS = 75;
const X_DOCS = 5;

/** Day `i` back from 2026-09-01, so doc 0 is the newest. */
function dayBack(i: number): string {
  const d = new Date(Date.UTC(2026, 8, 1) - i * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function docs(prefix: string, category: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${category}/${prefix} ${String(i).padStart(2, "0")}.md`,
    title: `${prefix} ${i}`,
    date: dayBack(i),
    url: `https://example.com/${prefix}/${i}`,
  }));
}

/** Extra YouTube docs the listing serves — an "ingest" the refetch picks up. */
let ingested = 0;

let server: ChildProcess | undefined;
let huginn: Server | undefined;

test.beforeAll(async () => {
  huginn = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    res.writeHead(200, { "content-type": "application/json" });
    if (p.startsWith("/api/collection/") && p.endsWith("/documents")) {
      const collection = p.slice("/api/collection/".length, -"/documents".length);
      const list =
        collection === "youtube-summaries" ? docs("Video", "ai/e2e", YOUTUBE_DOCS + ingested)
        : collection === "x-articles" ? docs("Post", "health/e2e", X_DOCS)
        : [];
      return res.end(JSON.stringify({ documents: list }));
    }
    res.end("{}");
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

test.beforeEach(() => { ingested = 0; });

test("the shelf shows the newest 10, grows on demand, and resets on a filter change", async ({ page }) => {
  const total = YOUTUBE_DOCS + X_DOCS;
  await page.goto(`${BASE}/summaries#shelf`);
  const rows = page.locator("#shelfList .recent-item");
  const more = page.locator("#shelfMore");

  await expect(rows).toHaveCount(10);
  await expect(page.locator("#shelfCount")).toHaveText(`${total} articles`);
  await expect(more).toContainText(`Showing 10 of ${total}`);
  // Newest first: both sources' day-0 docs lead the list.
  await expect(rows.first().locator(".recent-item-title")).toHaveText(/ 00$/);

  await more.getByRole("button", { name: "Show 50 more" }).click();
  await expect(rows).toHaveCount(60);
  await expect(more).toContainText(`Showing 60 of ${total}`);
  // 20 left: one step covers it, so there is no separate Show all. Keyboard
  // focus moves to the new footer rather than falling to <body>.
  await expect(more.getByRole("button", { name: "Show 20 more" })).toBeFocused();
  await expect(more.getByRole("button", { name: "Show all" })).toHaveCount(0);

  // The refetch after an ingest re-renders under the same filters: the window stays.
  ingested = 1;
  await page.evaluate(() => (window as unknown as { loadShelf: (f: boolean) => Promise<void> }).loadShelf(true));
  await expect(page.locator("#shelfCount")).toHaveText(`${total + 1} articles`);
  await expect(rows).toHaveCount(60);
  ingested = 0;
  await page.evaluate(() => (window as unknown as { loadShelf: (f: boolean) => Promise<void> }).loadShelf(true));

  // A source filter starts over at 10.
  await page.locator('#sourceFilter .source-chip[data-source="youtube"]').click();
  await expect(rows).toHaveCount(10);
  await expect(more).toContainText(`Showing 10 of ${YOUTUBE_DOCS}`);
  await more.getByRole("button", { name: "Show all" }).click();
  await expect(rows).toHaveCount(YOUTUBE_DOCS);
  await expect(more).toHaveCount(0);

  // A filter with fewer than 10 docs renders them all and no footer.
  await page.locator('#sourceFilter .source-chip[data-source="x-article"]').click();
  await expect(rows).toHaveCount(X_DOCS);
  await expect(more).toHaveCount(0);
});

test("a domain or category change starts the window over at 10", async ({ page }) => {
  await page.goto(`${BASE}/summaries#shelf`);
  const rows = page.locator("#shelfList .recent-item");
  const expand = () => page.locator("#shelfMore").getByRole("button", { name: "Show 50 more" }).click();

  await expand();
  await expect(rows).toHaveCount(60);
  await page.locator('#domainFilter .source-chip[data-domain="ai"]').click();
  await expect(rows).toHaveCount(10);

  await page.locator('#domainFilter .source-chip[data-domain=""]').click();
  await expand();
  await expect(rows).toHaveCount(60);
  await page.locator("#shelfCategoryFilter").selectOption("ai/e2e");
  await expect(rows).toHaveCount(10);
});

test("a date bucket the window cuts off reads 'n of N'", async ({ page }) => {
  await page.goto(`${BASE}/summaries#shelf`);
  await page.locator('#sourceFilter .source-chip[data-source="youtube"]').click();
  // Docs run from 2026-09-01 back 75 days. September holds 1 doc (09-01, "This
  // month" or "September 2026" depending on the run date), August holds 31, so
  // the window of 10 cuts August after 9.
  await expect(page.locator(".date-bucket").filter({ hasText: "August 2026" }))
    .toContainText("9 of 31");
});
