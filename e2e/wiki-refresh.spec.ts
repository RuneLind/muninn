/**
 * /wiki reader — the listing refresh, end-to-end.
 *
 * The claim this PR makes is "a long-open tab stops filtering a page set frozen at
 * load time". Nothing below the browser can prove it, because it has three legs
 * that only meet in a real page:
 *
 *   1. **the server's 5-minute index TTL** (`CACHE_TTL_MS` in `src/wiki/store.ts`).
 *      A plain refetch of `/api/wiki/pages` usually returns the very listing the
 *      tab already has, so the feature has to send `?refresh=1` or it delivers
 *      nothing for up to five minutes — exactly the bug it claims to fix. The
 *      first test asserts the plain route STILL cannot see the new page at the
 *      moment the reader does.
 *   2. **the 30 s client throttle**, driven here by Playwright's fake clock rather
 *      than a real 30-second sleep.
 *   3. **the defer-while-reading rule** — a fresh set must not re-sort the left
 *      list under an open article, and must land at the next navigation.
 *
 * The focus event is dispatched on `window` rather than driven through real tab
 * activation (headless Chromium's focus/blur is not reliably steerable), so what
 * is exercised is the production listener and everything downstream of it — not
 * Chromium's delivery of the event itself.
 *
 * No model calls anywhere: the whole feature is client-side rendering over the
 * `/api/wiki/pages` payload.
 *
 * ENV PREREQUISITE / PLATFORM TOKENS: identical to `wiki-status-facet.spec.ts` —
 * a working `.env` at the repo root, and `blankBotTokens()` so this muninn never
 * opens a second Telegram long-poller against the production bot's token.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { blankBotTokens } from "./blank-bot-tokens.ts";
import { WIKI_REFETCH_MIN_INTERVAL_MS } from "../src/dashboard/views/components/wiki-refresh.ts";

const PORT = 3024;
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI = "e2e-refresh";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

function wikiPage(title: string, type: string): string {
  return ["---", `title: ${title}`, `type: ${type}`, "---", "", `# ${title}`, "", "Body.", ""].join(
    "\n",
  );
}

/** Two types so a type filter is a real filter, not a no-op. */
const PAGES: Record<string, string> = {
  "alpha.md": wikiPage("Alpha", "concept"),
  "beta.md": wikiPage("Beta", "concept"),
  "gamma.md": wikiPage("Gamma", "source"),
};

/** The page written AFTER the reader has loaded — the whole point of the feature. */
const LATE_PAGE = { file: "delta.md", name: "delta", body: wikiPage("Delta", "concept") };

let server: ChildProcess | undefined;
let root = "";

/** Put the wiki back to its three-page baseline between tests (each test writes
 *  the late page itself) and drop the server's cached index so the next test's
 *  boot load starts from the truth on disk. */
async function resetWiki(): Promise<void> {
  await rm(path.join(root, LATE_PAGE.file), { force: true });
  await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}&refresh=1`);
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-refresh-"));
  for (const [name, body] of Object.entries(PAGES)) {
    await writeFile(path.join(root, name), body, "utf8");
  }

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...blankBotTokens(),
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

test.afterEach(async () => {
  if (root) await resetWiki();
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
});

test.describe("Wiki reader: listing refresh", () => {
  test("a focus refetch surfaces a page written after load, without waiting out the server's index TTL", async ({
    page,
  }) => {
    const listingRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/wiki/pages")) listingRequests.push(r.url());
    });

    await page.clock.install();
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(3);

    // A gardener (or anything else) writes a page while the tab sits open.
    await writeFile(path.join(root, LATE_PAGE.file), LATE_PAGE.body, "utf8");

    // The server's index cache is warm and 5 minutes from expiry, so the PLAIN
    // route genuinely cannot see the new page yet. Without `?refresh=1` the
    // feature would deliver nothing here — this assertion is what makes the next
    // one mean something.
    const plain = await (await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`)).json();
    expect(plain.pages).toHaveLength(3);

    // Past the client throttle, the tab comes back to the foreground.
    await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    await expect(page.locator(`.wiki-list-item[data-page="${LATE_PAGE.name}"]`)).toBeVisible();
    await expect(page.locator(".wiki-list-item")).toHaveCount(4);
    await expect(page.locator("#wikiCount")).toHaveText("4 / 4");

    // …and it got there by asking the server to re-scan, not by luck.
    expect(listingRequests.some((u) => u.includes("refresh=1"))).toBe(true);
    // The boot load is deliberately NOT a refresh — it has nothing stale to beat.
    expect(listingRequests[0]).not.toContain("refresh=1");
  });

  test("the throttle blocks a second refetch inside the window", async ({ page }) => {
    const listingRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/wiki/pages")) listingRequests.push(r.url());
    });

    await page.clock.install();
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(3);
    expect(listingRequests).toHaveLength(1); // the boot load

    // Alt-tabbing in and out repeatedly must not hammer the route — and the boot
    // load itself opens the window.
    await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS - 2_000);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForTimeout(200);
    expect(listingRequests).toHaveLength(1);
  });

  test("a fresh set is stashed under an open article and applied on the next navigation, once", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(3);

    await page.locator('.wiki-list-item[data-page="alpha"]').click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Alpha");

    await writeFile(path.join(root, LATE_PAGE.file), LATE_PAGE.body, "utf8");
    await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    // The refetch has landed (the request went out and resolved), but the list a
    // reader is using to navigate must NOT re-sort under the article they opened.
    await page.waitForResponse((r) => r.url().includes("/api/wiki/pages"));
    await expect(page.locator(".wiki-list-item")).toHaveCount(3);

    // Count how many times the row list is actually replaced by the next click:
    // the deferred apply used to repaint all rows and then the navigation repainted
    // them again — two full renders for one user action.
    await page.evaluate(() => {
      const w = window as unknown as { __listRenders: number };
      w.__listRenders = 0;
      new MutationObserver((recs) => {
        w.__listRenders += recs.length;
      }).observe(document.getElementById("wikiList")!, { childList: true });
    });

    await page.locator('.wiki-list-item[data-page="beta"]').click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Beta");
    await expect(page.locator(`.wiki-list-item[data-page="${LATE_PAGE.name}"]`)).toBeVisible();
    await expect(page.locator(".wiki-list-item")).toHaveCount(4);

    const renders = await page.evaluate(
      () => (window as unknown as { __listRenders: number }).__listRenders,
    );
    expect(renders).toBe(1);
  });

  test("a background adopt preserves the filters and does not re-open a collapsed Filters stack", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(3);

    const filters = page.locator("#wikiFilters");
    await filters.locator("summary").click();
    await page.locator('#typeChips [data-type="concept"]').click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(2); // alpha + beta
    // A search term too — it lives in the DOM input, outside the adopt's render path.
    await page.locator("#wikiSearch").fill("a");

    // Deliberately collapse the stack again. A gardener write must not spring it
    // back open: only a user action may do that.
    await filters.locator("summary").click();
    await expect(filters).not.toHaveAttribute("open", /.*/);

    await writeFile(path.join(root, LATE_PAGE.file), LATE_PAGE.body, "utf8");
    await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    // Delta is a `concept` matching "a" — it joins the filtered list rather than
    // resetting it.
    await expect(page.locator(`.wiki-list-item[data-page="${LATE_PAGE.name}"]`)).toBeVisible();
    await expect(page.locator(".wiki-list-item")).toHaveCount(3);
    await expect(page.locator("#wikiCount")).toHaveText("3 / 4");
    await expect(page.locator('#typeChips [data-type="concept"]')).toHaveClass(/active/);
    await expect(page.locator("#wikiSearch")).toHaveValue("a");
    await expect(page.locator("#wikiFilterCount")).toHaveText("1");
    await expect(filters).not.toHaveAttribute("open", /.*/);
  });
});
