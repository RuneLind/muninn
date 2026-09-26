/**
 * The issue board, `/wiki/issues?wiki=`, end to end (plan "Tracker links in
 * the wiki reader", PR 5).
 *
 * Two temp wikis in ONE muninn, invented pages and synthetic keys (project
 * `DEMO`, host `example.invalid`, repo `example-org/demo-repo`), because muninn
 * is a public repo:
 *
 *   - `e2e-board` declares a `trackers` block: five counting keys, one covered
 *     by a plan, one huginn does not hold, one the ledger does not track, one
 *     done; three pages with no counting key and two bookkeeping pages.
 *   - `e2e-board-plain` declares none: no board link, and the board 404s.
 *
 * ONE `node:http` stub plays huginn's `jira-issues` listing and claude-usage's
 * `GET /api/jira/keys` (claude-usage #217's shape), counting every call, and
 * answers that route 404 on demand — the shape a claude-usage without it gives.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";

const PORT = e2ePort("wiki-tracker-board");
const STUB_PORT = e2ePort("wiki-tracker-board/stub");
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI = "e2e-board";
const WIKI_PLAIN = "e2e-board-plain";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const READER_CONFIG = JSON.stringify({
  typeMap: { plans: "plan" },
  trackers: [{ id: "jira", projects: ["DEMO"], hosts: ["example.invalid"], ledgerProjects: ["DEMO"] }],
});

const url = (k: string) => `https://example.invalid/browse/${k}`;
const md = (fm: string[], body: string) => ["---", ...fm, SETTLED_CREATED_LINE, "---", "", body, ""].join("\n");
/** Two days ago: inside the board's 14-day "active" window. */
const RECENT = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

const KEYLESS = ["notes/lenket.md", "notes/lost.md", "notes/nevnt.md"];
const PAGES: Record<string, string> = {
  // DEMO-101: covered by a stamped plan, touched two days ago.
  "plans/demo-101-plan.md": md(
    ["title: DEMO-101 arbeidsplan", "type: plan", "jira: [DEMO-101]", `updated: ${RECENT}`, "prs: [example-org/demo-repo#11]"],
    "# Plan",
  ),
  // DEMO-101 and DEMO-102 by tag only.
  "notes/tagget.md": md(["title: Tagget", "tags: [demo-101, demo-102]", "prs: [example-org/demo-repo#12]"], "# Tagget"),
  // DEMO-103: stamped, and huginn does not hold it.
  "notes/stemplet.md": md(["title: DEMO-103 notat", "jira: [DEMO-103]"], "# Notat"),
  // DEMO-104: done.
  "notes/ferdig.md": md(["title: DEMO-104 ferdig"], "# Ferdig"),
  // DEMO-150: the ledger answers tracked:false for it.
  "notes/utenfor.md": md(["title: DEMO-150 utenfor"], "# Utenfor"),
  // No counting key: plain, link-only and mention-only.
  "notes/lost.md": md(["title: Løs side", "prs: [example-org/demo-repo#19]"], "# Løs"),
  "notes/lenket.md": md(["title: Lenket side"], `# Lenket\n\nEpic: [DEMO-199](${url("DEMO-199")}).`),
  "notes/nevnt.md": md(["title: Nevnt side"], "# Nevnt\n\nDEMO-102 nevnes her."),
  // Bookkeeping: never a row, never keyless.
  "log.md": md(["title: Logg", "prs: [example-org/demo-repo#77]"], "# Logg\n\nDEMO-101 i loggen."),
  "index.md": md(["title: Indeks"], "# Indeks"),
};

const ISSUES: Record<string, { title: string; status: string }> = {
  "DEMO-101": { title: "Grunnfeilen", status: "In Progress" },
  "DEMO-102": { title: "Følgefeilen", status: "To Do" },
  "DEMO-104": { title: "Opprydding", status: "Done" },
  "DEMO-150": { title: "Utenfor", status: "In Review" },
};
/** The ledger's sessions and cost per key. */
const LEDGER: Record<string, { n: number; cost: number }> = {
  "DEMO-101": { n: 3, cost: 4.5 },
  "DEMO-102": { n: 1, cost: 0.75 },
  "DEMO-103": { n: 0, cost: 0 },
  "DEMO-104": { n: 2, cost: 1.2 },
};

let server: ChildProcess | undefined;
let stub: Server | undefined;
let root = "";
let plainRoot = "";
/** Every `/api/jira/keys` call the stub answered, as its `keys` value. */
const keysCalls: string[] = [];
let keysRoute404 = false;

async function writeWiki(pages: Record<string, string>, config?: string): Promise<string> {
  const r = await mkdtemp(path.join(tmpdir(), "muninn-e2e-board-"));
  for (const [rel, body] of Object.entries(pages)) {
    await mkdir(path.dirname(path.join(r, rel)), { recursive: true });
    await writeFile(path.join(r, rel), body, "utf8");
  }
  if (config) await writeFile(path.join(r, ".wiki-reader.json"), config, "utf8");
  await settleWikiMtimes(r);
  return r;
}

test.beforeAll(async () => {
  root = await writeWiki(PAGES, READER_CONFIG);
  plainRoot = await writeWiki({ "notes/stemplet.md": PAGES["notes/stemplet.md"]! });

  stub = createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://127.0.0.1:${STUB_PORT}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === "/api/collection/jira-issues/documents") {
      return json(200, {
        documents: Object.entries(ISSUES).map(([key, f]) => ({
          id: `${key}_${f.title}.md`,
          url: url(key),
          title: f.title,
          status: f.status,
          updated: "2026-01-04T10:00:00.000+0100",
        })),
      });
    }
    if (u.pathname === "/api/jira/keys") {
      const keys = u.searchParams.get("keys") ?? "";
      keysCalls.push(keys);
      if (keysRoute404) return json(404, { error: "not found" });
      return json(200, {
        keys: keys.split(",").map((key) => {
          const tracked = key !== "DEMO-150";
          const l = LEDGER[key] ?? { n: 0, cost: 0 };
          return {
            key,
            tracked,
            sessionCount: tracked ? l.n : 0,
            totalCost: tracked ? l.cost : 0,
            costedSessions: tracked ? l.n : 0,
            lastSeen: tracked && l.n ? "2026-01-06T10:00:00Z" : null,
            truncated: false,
          };
        }),
        limit: 200,
        truncated: false,
        sessionsLimit: 2000,
      });
    }
    json(404, { error: "not stubbed" });
  });
  await new Promise<void>((r) => stub!.listen(STUB_PORT, "127.0.0.1", r));

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      KNOWLEDGE_API_URL: `http://127.0.0.1:${STUB_PORT}`,
      WIKI_EXTRA: `${WIKI}=${root},${WIKI_PLAIN}=${plainRoot}`,
      // AFTER `e2eEnv()`, which blanks it.
      CLAUDE_USAGE_URL: `http://127.0.0.1:${STUB_PORT}`,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise<void>((r) => (stub ? stub.close(() => r()) : r()));
  for (const r of [root, plainRoot]) if (r) await rm(r, { recursive: true, force: true });
});

test.beforeEach(() => {
  keysRoute404 = false;
});

/** Open the board and wait for its rows. Returns every URL the browser asked for. */
async function openBoard(page: Page, extra = ""): Promise<string[]> {
  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));
  await page.goto(`${BASE}/wiki/issues?wiki=${WIKI}${extra}`);
  await expect(page.locator("#boardTable")).toBeVisible();
  return requested;
}

const row = (page: Page, key: string) => page.locator(`#boardTable tr[data-board-key="${key}"]`);
const rowKeys = async (page: Page) =>
  (await page.locator("#boardTable tr[data-board-key]").evaluateAll((trs) => trs.map((tr) => (tr as HTMLElement).dataset.boardKey!))).sort();
const flags = async (page: Page, key: string) =>
  (await row(page, key).locator("[data-flag]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.flag!))).sort();

test.describe("Wiki issue board", () => {
  test("10: every key with its status, coverage, pages, PRs, last activity, flags, sessions and cost; no total", async ({ page }) => {
    const before = keysCalls.length;
    const requested = await openBoard(page);
    expect(await rowKeys(page)).toEqual(["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-104", "DEMO-150"]);

    const r101 = row(page, "DEMO-101");
    await expect(r101.locator(".board-title")).toHaveText("Grunnfeilen");
    await expect(r101.locator("[data-status-cat]")).toHaveAttribute("data-status-cat", "active");
    await expect(r101.locator("[data-status-cat]")).toHaveText("In Progress");
    await expect(r101.locator(".board-plan")).toContainText("DEMO-101 arbeidsplan");
    await expect(r101.locator("[data-pages]")).toHaveText("2");
    await expect(r101.locator("[data-prs]")).toHaveText("demo-repo#11 demo-repo#12");
    // The viewer's day for an `updated:` two days back (midnight, so ±1 by timezone).
    await expect(r101.locator("[data-last]")).toHaveText(/^2\d{3}-\d{2}-\d{2}$/);
    await expect(r101.locator("[data-last]")).not.toHaveText("2024-01-02");
    await expect(r101.locator("[data-sessions]")).toHaveText("3");
    await expect(r101.locator('[data-cost="priced"]')).toHaveText("$4.50");
    expect(await flags(page, "DEMO-101")).toEqual([]);

    await expect(row(page, "DEMO-102").locator("[data-prs]")).toHaveText("demo-repo#12");
    await expect(row(page, "DEMO-102").locator('[data-cost="priced"]')).toHaveText("$0.75");
    await expect(row(page, "DEMO-102").locator("[data-last]")).toHaveText("2024-01-02");
    await expect(row(page, "DEMO-104").locator("[data-status-cat]")).toHaveAttribute("data-status-cat", "done");
    await expect(row(page, "DEMO-104").locator('[data-cost="priced"]')).toHaveText("$1.20");
    // A tracked key with no session is priced but costs nothing to show.
    await expect(row(page, "DEMO-103").locator("[data-sessions]")).toHaveText("0");
    await expect(row(page, "DEMO-103").locator('[data-cost="priced"]')).toHaveText("—");

    // Flags.
    expect(await flags(page, "DEMO-102")).toEqual(["0 stamped", "no plan"]);
    expect(await flags(page, "DEMO-103")).toEqual(["no plan", "unknown key"]);
    await expect(row(page, "DEMO-103")).toContainText("not in huginn");
    expect(await flags(page, "DEMO-150")).toEqual(["0 stamped", "no plan"]);

    // An untracked key: "not tracked", never $0.
    await expect(row(page, "DEMO-150").locator('[data-cost="not-tracked"]')).toHaveText("not tracked");

    // No total across keys, anywhere on the page.
    await expect(page.locator("#boardKpis")).not.toContainText("$");
    await expect(page.locator("body")).not.toContainText("$6.45");

    // One ledger call for five keys, made by the server; the browser asked claude-usage and huginn nothing.
    expect(keysCalls.slice(before)).toEqual(["DEMO-101,DEMO-102,DEMO-103,DEMO-104,DEMO-150"]);
    expect(requested.filter((u) => u.includes(`:${STUB_PORT}`))).toEqual([]);
    expect(requested.filter((u) => u.includes("/api/wiki/graph"))).toHaveLength(1);
  });

  test("the keyless table lists exactly the pages with no counting key, and no bookkeeping page", async ({ page }) => {
    await openBoard(page);
    const rels = await page.locator("#boardKeyless tr[data-keyless]").evaluateAll((trs) => trs.map((tr) => (tr as HTMLElement).dataset.keyless!));
    expect(rels.sort()).toEqual(KEYLESS);
    await expect(page.locator('[data-kpi="keyless"] b')).toHaveText("3");
    await expect(page.locator('#boardKeyless tr[data-keyless="notes/lost.md"]')).toContainText("demo-repo#19");
  });

  test("a ledger that answers 404 shows no cost values and says so — never $0", async ({ page }) => {
    keysRoute404 = true;
    const before = keysCalls.length;
    await openBoard(page);
    expect(keysCalls.length - before).toBe(1);
    await expect(page.locator("[data-board-note]")).toContainText(["Session ledger unavailable"]);
    await expect(page.locator('#boardTable [data-cost="priced"]')).toHaveCount(0);
    await expect(page.locator("#boardTable")).not.toContainText("$");
    // Every key is unpriced — DEMO-150 included, since only the answer said it was untracked.
    await expect(page.locator('#boardTable [data-cost="unpriced"]')).toHaveCount(5);
    await expect(row(page, "DEMO-101").locator('[data-cost="unpriced"]')).toHaveText("—");
    await expect(row(page, "DEMO-101").locator("[data-sessions]")).toHaveCount(0);
  });

  test("each filter narrows the rows, and lives in the URL", async ({ page }) => {
    await openBoard(page);
    const cases: [string, string[]][] = [
      ["open", ["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-150"]],
      ["noplan", ["DEMO-102", "DEMO-103", "DEMO-150"]],
      ["active", ["DEMO-101"]],
      ["flagged", ["DEMO-102", "DEMO-103", "DEMO-104", "DEMO-150"]],
      ["all", ["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-104", "DEMO-150"]],
    ];
    for (const [show, keys] of cases) {
      await page.locator(`[data-board-show="${show}"]`).click();
      await expect(page.locator(`[data-board-show="${show}"]`)).toHaveAttribute("aria-pressed", "true");
      expect(await rowKeys(page), show).toEqual(keys);
      expect(new URL(page.url()).searchParams.get("show")).toBe(show === "all" ? null : show);
    }
    await page.locator("#boardQuery").fill("følge");
    expect(await rowKeys(page)).toEqual(["DEMO-102"]);
    await page.locator("#boardQuery").fill("demo-10");
    expect(await rowKeys(page)).toEqual(["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-104"]);
    // A reload keeps the filter.
    await page.locator('[data-board-show="noplan"]').click();
    await page.reload();
    await expect(page.locator("#boardTable")).toBeVisible();
    await expect(page.locator("#boardQuery")).toHaveValue("demo-10");
    expect(await rowKeys(page)).toEqual(["DEMO-102", "DEMO-103"]);
  });

  test("a row click opens the graph rooted at its key", async ({ page }) => {
    await openBoard(page);
    await row(page, "DEMO-102").locator(".board-title").click();
    await page.waitForURL(/\/wiki\?/);
    const u = new URL(page.url());
    expect([u.searchParams.get("wiki"), u.searchParams.get("display"), u.searchParams.get("issue")]).toEqual([WIKI, "graph", "jira:DEMO-102"]);
    await expect(page.locator(".wiki-article-head h1")).toHaveText("DEMO-102");
    await expect(page.locator("#wikiGraph .wiki-graph-lanes")).toBeVisible();
    await expect(page.locator('#wikiGraph [data-graph-node="issue:jira:DEMO-102"]')).toHaveClass(/root/);
  });

  test("the reader links the board on a tracker wiki", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    const link = page.locator("#wikiBoardLink");
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(`${BASE}/wiki/issues?wiki=${WIKI}`);
    await expect(page.locator("#boardTable")).toBeVisible();
  });

  test("8: a wiki with no trackers block renders no board link, and the board URL refuses", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI_PLAIN}&relPath=${encodeURIComponent("notes/stemplet.md")}`);
    await expect(page.locator(".wiki-article-head h1")).toBeVisible();
    await expect(page.locator("#wikiBoardLink")).toBeHidden();
    const before = keysCalls.length;
    const res = await page.goto(`${BASE}/wiki/issues?wiki=${WIKI_PLAIN}`);
    expect(res!.status()).toBe(404);
    await expect(page.locator("#boardRefusal")).toContainText("names no tracker");
    await expect(page.locator("#boardTable")).toHaveCount(0);
    expect(keysCalls.length).toBe(before);
  });
});

test.describe("Wiki issue board: fix round 1", () => {
  const GRAPH = "**/api/wiki/graph?*";

  test("C1: after a load error, a filter click or typing leaves the error in place", async ({ page }) => {
    await page.route(GRAPH, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }));
    await page.goto(`${BASE}/wiki/issues?wiki=${WIKI}`);
    const err = page.locator("#boardTableWrap .board-error");
    await expect(err).toContainText("boom");
    await page.locator('[data-board-show="open"]').click();
    await page.locator("#boardQuery").fill("demo");
    await expect(err).toContainText("boom");
    await expect(page.locator("#boardTable")).toHaveCount(0);
    await expect(page.locator("#boardShown")).not.toContainText("keys");
  });

  test("C2: typing while the graph call is in flight keeps Loading…, then the rows arrive filtered", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(GRAPH, async (r) => {
      await held;
      await r.continue();
    });
    await page.goto(`${BASE}/wiki/issues?wiki=${WIKI}`);
    await page.locator("#boardQuery").fill("følge");
    await expect(page.locator("#boardTableWrap")).toContainText("Loading…");
    await expect(page.locator("#boardShown")).not.toContainText("0 keys");
    release();
    await expect(page.locator("#boardTable")).toBeVisible();
    expect(await rowKeys(page)).toEqual(["DEMO-102"]);
  });

  test("C3: a non-JSON error body shows the HTTP status", async ({ page }) => {
    await page.route(GRAPH, (r) => r.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad gateway</html>" }));
    await page.goto(`${BASE}/wiki/issues?wiki=${WIKI}`);
    await expect(page.locator("#boardTableWrap .board-error")).toContainText("HTTP 502");
  });

  test("C10: column headers are scoped, the key table is named, and the count is a polite live region", async ({ page }) => {
    await openBoard(page);
    for (const t of ["#boardTable", "#boardKeyless"]) {
      const ths = page.locator(`${t} thead th`);
      await expect(page.locator(`${t} thead th[scope="col"]`)).toHaveCount(await ths.count());
    }
    await expect(page.locator("#boardTable caption")).toHaveCount(1);
    await expect(page.getByRole("table", { name: /keys/i })).toHaveCount(1);
    await expect(page.locator("#boardShown")).toHaveAttribute("aria-live", "polite");
  });

  test("C12: a modifier click on a row opens the graph in a new tab and leaves this one; Enter on the key link still navigates", async ({ page, context }) => {
    await openBoard(page);
    const boardUrl = page.url();
    const opened = context.waitForEvent("page", { timeout: 5_000 });
    await row(page, "DEMO-102").locator(".board-title").click({ modifiers: ["ControlOrMeta"] });
    const tab = await opened;
    await tab.waitForLoadState();
    expect(new URL(tab.url()).searchParams.get("issue")).toBe("jira:DEMO-102");
    await tab.close();
    expect(page.url()).toBe(boardUrl);
    await row(page, "DEMO-102").locator(".board-key a").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/wiki\?/);
    expect(new URL(page.url()).searchParams.get("issue")).toBe("jira:DEMO-102");
  });

  test("C13: a throwing replaceState never skips the render; the URL write is debounced and keeps the hash", async ({ page }) => {
    await page.addInitScript(() => {
      const orig = history.replaceState.bind(history);
      (window as unknown as { __rs: number }).__rs = 0;
      history.replaceState = (...a: Parameters<History["replaceState"]>) => {
        const w = window as unknown as { __rs: number; __rsThrow?: boolean };
        w.__rs++;
        if (w.__rsThrow) throw new DOMException("too many calls", "SecurityError");
        return orig(...a);
      };
    });
    await page.goto(`${BASE}/wiki/issues?wiki=${WIKI}#top`);
    await expect(page.locator("#boardTable")).toBeVisible();
    await page.locator("#boardQuery").pressSequentially("demo-10", { delay: 20 });
    await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("demo-10");
    expect(new URL(page.url()).hash).toBe("#top");
    expect(await page.evaluate(() => (window as unknown as { __rs: number }).__rs)).toBeLessThan(3);
    await page.evaluate(() => ((window as unknown as { __rsThrow: boolean }).__rsThrow = true));
    // A click writes the URL at once; a throwing write must not skip its render.
    await page.locator('[data-board-show="noplan"]').click();
    expect(await rowKeys(page)).toEqual(["DEMO-102", "DEMO-103"]);
    await page.locator("#boardQuery").fill("følge");
    expect(await rowKeys(page)).toEqual(["DEMO-102"]);
  });

  test("C14: a capped keyless list reads as capped on its KPI", async ({ page }) => {
    await page.route(GRAPH, async (r) => {
      const res = await r.fetch();
      const body = await res.json();
      const one = body.keylessPages[0];
      body.keylessPages = Array.from({ length: 1500 }, (_, i) => ({ ...one, id: `page:x${i}.md`, relPath: `x${i}.md` }));
      body.keylessTruncated = true;
      await r.fulfill({ response: res, json: body });
    });
    await openBoard(page);
    await expect(page.locator('[data-kpi="keyless"] b')).toHaveText("1500+");
  });
});
