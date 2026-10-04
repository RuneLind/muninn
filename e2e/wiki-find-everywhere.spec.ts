/**
 * The find palette's EVERYWHERE section — `GET /api/wiki/find-everywhere` as
 * the reader sees it.
 *
 * What the unit tests cannot reach, and the reason this file exists:
 *
 *  1. **The session leg end to end.** A page found ONLY because a claude-usage
 *     session that matched the query is stamped in its `sessions:` frontmatter
 *     — the real index parses the stamp, the real route joins it, the real
 *     palette renders the row with its session chip and title.
 *  2. **Another wiki's page.** Selecting the row leaves this wiki for the
 *     other one's reader URL.
 *  3. **Timing the shell owns.** The section lands after the local rows and
 *     must not move focus or selection; a response for a query the reader has
 *     since changed must never paint.
 *  4. **Degrade.** A dead claude-usage leaves the section working and says so.
 *
 * Fixture: two temp wikis registered through `WIKI_EXTRA` (the open one with a
 * huginn collection), and two in-process `node:http` stubs (Playwright runs
 * this file under node): huginn answering `/api/search`, claude-usage answering
 * `/api/search` and `/api/sessions-by-id`. The claude-usage stub can delay or
 * drop its answers per test.
 *
 * No model calls; nothing leaves the process. ENV PREREQUISITE / SPAWN ENV: a
 * working `.env` at the repo root, and `e2eEnv()` to keep this muninn off
 * Telegram/Slack and off the host's instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";

const PORT = e2ePort("wiki-find-everywhere");
const HUGINN_PORT = e2ePort("wiki-find-everywhere/huginn");
const LEDGER_PORT = e2ePort("wiki-find-everywhere/ledger");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-every";
const OTHER = "e2e-other";
const OPEN = "plans/open.mdx";

const S_SHARED = "11111111-1111-4111-8111-111111111111";
const S_UNSTAMPED = "99999999-9999-4999-8999-999999999999";

function md(title: string, fm: string[], body: string): string {
  return ["---", `title: ${title}`, SETTLED_CREATED_LINE, ...fm, "---", "", body, ""].join("\n");
}

/** The open wiki: `bucket-notes` says "felles" and carries the matched session,
 *  so it is a LOCAL row that also earns a session chip. */
const PAGES: Array<[string, string]> = [
  [OPEN, md("Open plan", [], "Nothing to see.")],
  ["plans/bucket-notes.mdx", md("Felles bucket notes", [`sessions: [claude-code:${S_SHARED}]`], "x")],
];
/** The other wiki: the target says neither "felles" nor "kode" anywhere — only
 *  the session that wrote it does. */
const OTHER_PAGES: Array<[string, string]> = [
  ["plans/shared-wiki.mdx", md("Shared wiki for the team", [`sessions: [claude-code:${S_SHARED}]`], "A bucket and a reader.")],
  ["plans/unrelated.mdx", md("Unrelated", [], "x")],
];

/** Per-test knobs for the claude-usage stub; `slowFor` delays one query alone. */
const ledger = { down: false, delayMs: 0, slowFor: {} as Record<string, number>, searches: [] as string[] };
const huginnQueries: string[] = [];

let server: ChildProcess | undefined;
let huginnStub: Server | undefined;
let ledgerStub: Server | undefined;
const roots: string[] = [];

function json(res: import("node:http").ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function listen(srv: Server, port: number): Promise<Server> {
  await new Promise<void>((resolve) => srv.listen(port, "127.0.0.1", resolve));
  return srv;
}

async function writeWiki(prefix: string, pages: Array<[string, string]>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  for (const [rel, body] of pages) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  await settleWikiMtimes(root);
  return root;
}

test.beforeAll(async () => {
  const root = await writeWiki("muninn-e2e-every-", PAGES);
  const otherRoot = await writeWiki("muninn-e2e-other-", OTHER_PAGES);

  huginnStub = await listen(
    createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/api/search") {
        huginnQueries.push(url.search);
        return json(res, { results: [] });
      }
      return json(res, {});
    }),
    HUGINN_PORT,
  );

  ledgerStub = await listen(
    createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (ledger.down) {
        req.socket.destroy();
        return;
      }
      setTimeout(() => {
        if (url.pathname === "/api/search") {
          const q = url.searchParams.get("q") ?? "";
          ledger.searches.push(q);
          const hit = /felles/i.test(q);
          return json(res, {
            sessions: hit
              ? [
                  { sessionId: S_UNSTAMPED, snippet: "\u0002felles\u0003 elsewhere", hits: 3, rank: -9 },
                  { sessionId: S_SHARED, snippet: "the \u0002felles\u0003 \u0002kode\u0003-wiki bucket", hits: 2, rank: -8 },
                ]
              : [],
          });
        }
        if (url.pathname === "/api/sessions-by-id") {
          return json(res, { sessions: [{ sessionId: S_SHARED, title: "Find the felles page" }] });
        }
        return json(res, {});
      }, ledger.slowFor[url.searchParams.get("q") ?? ""] ?? ledger.delayMs);
    }),
    LEDGER_PORT,
  );

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root}=every-coll,${OTHER}=${otherRoot}`,
      KNOWLEDGE_API_URL: `http://127.0.0.1:${HUGINN_PORT}`,
      CLAUDE_USAGE_URL: `http://127.0.0.1:${LEDGER_PORT}`,
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

test.beforeEach(() => {
  ledger.down = false;
  ledger.delayMs = 0;
  ledger.slowFor = {};
  ledger.searches.length = 0;
  huginnQueries.length = 0;
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await Promise.all([huginnStub, ledgerStub].map((s) => new Promise((r) => (s ? s.close(r) : r(null)))));
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

const palette = (page: Page) => page.locator("#wikiFind");
const input = (page: Page) => page.locator("#wikiFindInput");
const localRows = (page: Page) => page.locator("#wikiFindList .wiki-find-row:not(.wiki-find-every-row)");
const everyRows = (page: Page) => page.locator("#wikiFindEvery .wiki-find-every-row");
const target = (page: Page) => everyRows(page).filter({ hasText: "Shared wiki for the team" });

async function openReader(page: Page): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(OPEN)}`);
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Open plan");
  await expect(page.locator("#wikiList .wiki-list-item").first()).toBeVisible();
}

async function find(page: Page, query: string): Promise<void> {
  await page.locator("body").press("/");
  await expect(palette(page)).toBeVisible();
  await input(page).fill(query);
}

test("a page reached only through a matched session shows under Everywhere, with its session chip", async ({ page }) => {
  await openReader(page);
  await find(page, "felles kode");

  const row = target(page);
  await expect(row).toHaveCount(1);
  await expect(row.locator(".wiki-find-wiki")).toHaveText(OTHER);
  const chip = row.locator(".wiki-find-reason.session");
  await expect(chip).toHaveText("session 11111111 #2");
  await expect(chip).toHaveAttribute("title", "Session: Find the felles page");
  await expect(row.locator(".wiki-find-snippet mark")).toHaveText(["felles", "kode"]);
  // No text leg found it: the session chip is its only reason besides the head mark.
  await expect(row.locator(".wiki-find-reason:not(.session):not(.head)")).toHaveCount(0);

  // The local row the same session wrote gets the chip too, in place.
  const local = localRows(page).filter({ hasText: "Felles bucket notes" });
  await expect(local.locator(".wiki-find-reason.session")).toHaveText("session 11111111 #2");
  // ...and is not repeated under Everywhere.
  await expect(everyRows(page).filter({ hasText: "Felles bucket notes" })).toHaveCount(0);

  expect(ledger.searches).toContain("felles kode");
  expect(huginnQueries.some((q) => q.includes("brief=true") && q.includes("collection=every-coll"))).toBe(true);
});

test("selecting an Everywhere row opens that wiki's page", async ({ page }) => {
  await openReader(page);
  await find(page, "felles kode");
  await expect(target(page)).toHaveCount(1);
  // Arrow keys walk the local rows, then the Everywhere rows.
  const index = Number(await target(page).getAttribute("data-find-row"));
  for (let i = 0; i < index; i++) await page.keyboard.press("ArrowDown");
  await expect(target(page)).toHaveAttribute("aria-selected", "true");
  await expect(input(page)).toHaveAttribute("aria-activedescendant", `wikiFindRow-${index}`);
  await page.keyboard.press("Enter");
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Shared wiki for the team");
  const url = new URL(page.url());
  expect(url.searchParams.get("wiki")).toBe(OTHER);
  expect(url.searchParams.get("relPath")).toBe("plans/shared-wiki.mdx");
});

test("the section lands without moving focus or the selection", async ({ page }) => {
  ledger.delayMs = 1200;
  await openReader(page);
  await find(page, "felles kode");
  await expect(page.locator("#wikiFindEvery")).toContainText("Searching everywhere…");
  await expect(localRows(page).first()).toBeVisible();
  await page.keyboard.press("Tab");
  const focused = localRows(page).first();
  await expect(focused).toBeFocused();
  await expect(focused).toHaveAttribute("aria-selected", "true");
  await expect(target(page)).toHaveCount(1);
  await expect(focused).toBeFocused();
  await expect(focused).toHaveAttribute("aria-selected", "true");
  await expect(target(page)).toHaveAttribute("aria-selected", "false");
});

test("an answer for a query the reader has since changed never paints", async ({ page }) => {
  // The old query answers ~0.6 s after its fetch, the new one ~1.8 s after its
  // own (inside the 2 s server budget), so between the
  // two a dropped-or-not old answer is the only thing that could paint.
  ledger.slowFor = { "felles kode": 600, zzqq: 1_800 };
  await openReader(page);
  await find(page, "felles kode");
  // Past the 250 ms debounce, so the first fetch is in flight.
  await page.waitForTimeout(500);
  await input(page).fill("zzqq");
  await expect(page.locator("#wikiFindEvery")).toContainText("Searching everywhere…");
  await page.waitForTimeout(1500);
  await expect(target(page)).toHaveCount(0);
  await expect(page.locator("#wikiFindEvery")).toContainText("Searching everywhere…");
  await expect(page.locator("#wikiFindEvery")).toContainText("Nothing more", { timeout: 5000 });
  expect(ledger.searches).toEqual(expect.arrayContaining(["zzqq"]));
});

test("a dead claude-usage leaves the section up and names the missing leg", async ({ page }) => {
  ledger.down = true;
  await openReader(page);
  await find(page, "felles kode");
  await expect(page.locator("#wikiFindEvery [data-find-degrade]")).toHaveText(
    "Partial results — session search unavailable.",
  );
  await expect(target(page)).toHaveCount(0);
  await expect(localRows(page).filter({ hasText: "Felles bucket notes" })).toHaveCount(1);
});

test("short free text asks only the local listing", async ({ page }) => {
  await openReader(page);
  await find(page, "fe type:plan");
  await page.waitForTimeout(600);
  await expect(page.locator("#wikiFindEvery")).toBeEmpty();
  expect(ledger.searches).toEqual([]);
});
