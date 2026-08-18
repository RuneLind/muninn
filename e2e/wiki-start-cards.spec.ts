/**
 * /wiki start cards — the seam between the reader shell and `wiki-start-cards.ts`.
 *
 * This spec exists because of what the extraction's own checks could NOT see:
 * deleting `mountStartCards()` from `wiki-browser.ts` leaves `tsc --noEmit`
 * clean and all ~819 component unit tests green, and the only symptom is a
 * start view with two silently empty cards. The unit tests drive the module's
 * exports directly, so they hold the cards' behaviour but cannot hold the fact
 * that the SHELL still calls them; only a real page can. NB: this pins
 * `mountStartCards` only — `initStartCards(...)` is NOT pinned here (measured:
 * deleting it keeps all three tests green), because the module's default
 * `withWiki` now derives the same `?wiki=` from the page and the only observable
 * loss is `resolvePageName` (missing-page entries stop being reader links).
 *
 * What is pinned here, in order:
 *   1. both cards mount with content on the start view (the shell calls
 *      `mountStartCards`), and every card fetch carries the active `?wiki=` (true
 *      whether or not the shell's `withWiki` is wired — see the NB above);
 *   2. clicking [Reindex now] POSTs `/api/wiki/reindex` exactly once, disables
 *      the button for the poll cycle and re-enables it on settle (the shell's
 *      click delegate reaches `startReindex`, and the poller inside the module
 *      still runs);
 *   3. navigating into an article and back REMOUNTS both cards from the module's
 *      cache — no second `/api/wiki/digest` fetch (the cached-render path, which
 *      is the reason the state had to move whole rather than be re-created).
 *
 * huginn and the digest's model call are stubbed at muninn's own `/api/wiki/*`
 * boundary via route interception — everything above that line (the shell wiring,
 * the click delegate, the poll cycle, the cached remount) is the real thing, and
 * nothing below it is what this spec claims. No model calls anywhere.
 *
 * ENV PREREQUISITE / PLATFORM TOKENS: identical to `wiki-refresh.spec.ts` — a
 * working `.env` at the repo root, and `blankBotTokens()` so this muninn never
 * opens a second Telegram long-poller against the production bot's token.
 *
 * HARNESS CAVEAT: on the machine this was written on, `bunx playwright test`
 * cannot launch a browser at all — the installed `@playwright/test` wants
 * chromium build 1208 and the local `~/Library/Caches/ms-playwright` cache holds
 * only 1223/1234, so every spec in this directory fails with
 * `browserType.launch: Executable doesn't exist`. It was verified through a
 * throwaway config that only adds `launchOptions.executablePath` pointing at the
 * present `chromium_headless_shell-1234`. Nothing in the spec depends on that
 * (it sets no `executablePath` of its own) — an "Executable doesn't exist" here
 * is the host, and `bunx playwright install chromium` is the fix.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { blankBotTokens } from "./blank-bot-tokens.ts";

const PORT = 3042;
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI = "e2e-startcards";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

function wikiPage(title: string): string {
  return ["---", `title: ${title}`, "type: concept", "---", "", `# ${title}`, "", "Body.", ""].join(
    "\n",
  );
}

const PAGES: Record<string, string> = {
  "alpha.md": wikiPage("Alpha"),
  "beta.md": wikiPage("Beta"),
};

/** What `/api/wiki/digest` would return for a wiki with a `log.md` — served here
 *  as a fixture so the card renders without a connector run. */
const DIGEST = {
  digest: {
    bullets: "- landed the start cards",
    html: "<ul><li>landed the start cards</li></ul>",
    generatedAt: 0,
    logMtimeMs: 0,
    entryCount: 1,
    fromDate: "2026-08-10",
    toDate: "2026-08-17",
  },
};

/** What `/api/wiki/index-coverage` would return for a wiki with one backing
 *  huginn collection — one missing page, so the card has a body to assert. */
const COVERAGE = {
  collections: ["e2e"],
  totalMd: 2,
  indexed: 1,
  missing: ["beta.md"],
  excludedByRule: [],
  ghosts: [],
  htmlPages: 0,
  generatedAt: 0,
  dirtyCount: 0,
};

interface Seen {
  path: string;
  search: string;
  method: string;
}

/** Stub the four card routes at muninn's boundary and record every `/api/wiki/*`
 *  request the page makes. Everything not stubbed (the page listing, a page read)
 *  goes to the real server. */
async function stubCardRoutes(page: Page): Promise<Seen[]> {
  const seen: Seen[] = [];
  let polls = 0;
  await page.route("**/api/wiki/**", async (route) => {
    const url = new URL(route.request().url());
    seen.push({ path: url.pathname, search: url.search, method: route.request().method() });
    switch (url.pathname) {
      case "/api/wiki/digest":
        return route.fulfill({ json: DIGEST });
      case "/api/wiki/index-coverage":
        return route.fulfill({ json: COVERAGE });
      case "/api/wiki/reindex":
        return route.fulfill({ json: { collections: [{ name: "e2e", state: "started" }] } });
      case "/api/wiki/reindex-status":
        // First poll still running, then settled — so "the button stays disabled
        // for the cycle" is asserted with a whole poll interval of margin rather
        // than in the gap before the first poll returns.
        return route.fulfill({
          json: { collections: [{ name: "e2e", status: polls++ === 0 ? "running" : "succeeded" }] },
        });
      // The right rail's Similar section hits huginn; nothing here is about it.
      case "/api/wiki/similar":
        return route.fulfill({ json: { results: [] } });
      default:
        return route.continue();
    }
  });
  return seen;
}

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-startcards-"));
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

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
});

test.describe("Wiki reader: start cards", () => {
  test("both cards mount with content on the start view, on the active wiki", async ({ page }) => {
    const seen = await stubCardRoutes(page);
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(2);

    // What's new: the shell's `renderStart` left an empty, display:none div — the
    // card module is what fills and reveals it.
    const whatsNew = page.locator("#wikiWhatsNew");
    await expect(whatsNew).toBeVisible();
    await expect(whatsNew.locator(".wiki-wn-title")).toHaveText("What’s new");
    await expect(whatsNew).toContainText("landed the start cards");
    await expect(whatsNew).toContainText("2026-08-10 – 2026-08-17");

    // Index coverage: summary line, the missing-page list, and the trigger.
    const indexCard = page.locator("#wikiIndexCard");
    await expect(indexCard).toBeVisible();
    await expect(indexCard.locator(".wiki-ix-summary")).toContainText("1 of 2 pages indexed");
    await expect(indexCard.locator(".wiki-ix-details summary")).toContainText(
      "1 missing (not in search)",
    );
    await expect(page.locator("#wikiIndexReindex")).toBeEnabled();

    // Every card fetch carried the active wiki — an un-parameterised fetch would
    // have read the DEFAULT wiki's digest and coverage and still looked fine.
    // (`index-coverage` is fetched twice on boot: the shell renders its own
    // one-line coverage footer under the page list from the same route.)
    const cardCalls = seen.filter(
      (s) => s.path === "/api/wiki/digest" || s.path === "/api/wiki/index-coverage",
    );
    expect(cardCalls.filter((s) => s.path === "/api/wiki/digest")).toHaveLength(1);
    expect(cardCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of cardCalls) {
      expect(new URLSearchParams(call.search).get("wiki")).toBe(WIKI);
    }
  });

  test("[Reindex now] POSTs once, disables the button, and re-enables it on settle", async ({
    page,
  }) => {
    const seen = await stubCardRoutes(page);
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    const button = page.locator("#wikiIndexReindex");
    await expect(button).toBeEnabled();

    await button.click();

    const status = page.locator("#wikiIndexReindexStatus");
    await expect(status).toContainText("rebuild started");
    await expect(button).toBeDisabled();
    await expect(status).toContainText("rebuilding…"); // first poll landed
    await expect(button).toBeDisabled();

    // Settles on the second poll: rows flip to "rebuilt", the button comes back,
    // and coverage is re-fetched so missing/ghosts reflect the fresh index.
    await expect(status).toContainText("rebuilt", { timeout: 15_000 });
    await expect(button).toBeEnabled();

    const posts = seen.filter((s) => s.path === "/api/wiki/reindex");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.method).toBe("POST");
    expect(new URLSearchParams(posts[0]!.search).get("wiki")).toBe(WIKI);
    expect(seen.filter((s) => s.path === "/api/wiki/reindex-status").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(
      seen.filter((s) => s.path === "/api/wiki/index-coverage" && s.search.includes("refresh=1")),
    ).toHaveLength(1);
  });

  test("navigating into an article and back remounts the cards without a second digest fetch", async ({
    page,
  }) => {
    const seen = await stubCardRoutes(page);
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await expect(page.locator("#wikiWhatsNew")).toContainText("landed the start cards");
    await expect(page.locator("#wikiIndexCard")).toContainText("1 of 2 pages indexed");
    expect(seen.filter((s) => s.path === "/api/wiki/digest")).toHaveLength(1);
    const before = seen.filter(
      (s) => s.path === "/api/wiki/digest" || s.path === "/api/wiki/index-coverage",
    ).length;

    await page.locator('.wiki-list-item[data-page="alpha"]').click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Alpha");
    await expect(page.locator("#wikiWhatsNew")).toHaveCount(0); // start view gone

    await page.goBack();

    // Remounted from the module's cached render — content is back…
    await expect(page.locator("#wikiWhatsNew")).toBeVisible();
    await expect(page.locator("#wikiWhatsNew")).toContainText("landed the start cards");
    await expect(page.locator("#wikiIndexCard")).toContainText("1 of 2 pages indexed");
    // …and the round trip cost no new card fetches at all.
    expect(seen.filter((s) => s.path === "/api/wiki/digest")).toHaveLength(1);
    expect(
      seen.filter((s) => s.path === "/api/wiki/digest" || s.path === "/api/wiki/index-coverage")
        .length,
    ).toBe(before);
  });
});
