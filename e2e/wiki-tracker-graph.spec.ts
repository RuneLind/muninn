/**
 * /wiki reader — graph mode, lanes only, end to end (plan "Tracker links in
 * the wiki reader", PR 4).
 *
 * Two temp wikis in ONE muninn, invented pages and synthetic keys (project
 * `DEMO`, host `example.invalid`, repo `example-org/demo-repo`), because muninn
 * is a public repo:
 *
 *   - `e2e-graph` declares a `trackers` block. Its created-keys page (the PR 3
 *     anchor) stamps two sessions and names one PR; two other pages count its
 *     keys and stamp a session each; a mention-only, a link-only and a
 *     mention-key page must stay out of its graph. No session or PR is shared
 *     between two pages.
 *   - `e2e-graph-plain` declares none: no toggle, `g` inert, the route 404s.
 *
 * ONE `node:http` stub plays huginn's `jira-issues` listing and claude-usage's
 * `/api/sessions-by-id`, `/api/merges` and `/api/jira`, counting every call.
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

const PORT = e2ePort("wiki-tracker-graph");
const STUB_PORT = e2ePort("wiki-tracker-graph/stub");
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI = "e2e-graph";
const WIKI_PLAIN = "e2e-graph-plain";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const READER_CONFIG = JSON.stringify({
  typeMap: { plans: "plan" },
  trackers: [
    {
      id: "jira",
      projects: ["DEMO"],
      hosts: ["example.invalid"],
      planTitle: "plan(er|en)?(?!\\p{L})",
      createdMarkers: ["opprettet", "created"],
    },
  ],
});

const url = (k: string) => `https://example.invalid/browse/${k}`;
const md = (fm: string[], body: string) => ["---", ...fm, SETTLED_CREATED_LINE, "---", "", body, ""].join("\n");
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const S1 = sid(31);
const S2 = sid(32);
const S3 = sid(33);
const S4 = sid(34);
const S_OTHER = sid(35);

const ANCHOR = "archive/2026-01-10-rotaarsak.mdx";
const PLAN_A = "plans/arbeidsplan.md";
const TAGGED = "notes/tagget.md";
const MENTIONED = "notes/nevnt.md";
const LINKED = "notes/lenket.md";
const BACKGROUND = "notes/demo-122-bakgrunn.md";
const OTHER = "notes/annen.md";
const MANY = "notes/mange.md";

const PAGES: Record<string, string> = {
  // Created ×3, tag ×2, one mention; two sessions, one PR.
  [ANCHOR]: md(
    [
      "title: Hvorfor mangler radene metadata?",
      "tags: [demo-api, demo-120, demo-121]",
      `sessions: [claude-code:${S1}, claude-code:${S2}]`,
      "prs: [example-org/demo-repo#11]",
    ],
    "# Hvorfor mangler radene metadata?\n\n" +
      "Status: ferdig · Jira opprettet: " +
      `[DEMO-101](${url("DEMO-101")}) (A1), [DEMO-102](${url("DEMO-102")}) (A2) og [DEMO-103](${url("DEMO-103")}) (B).\n\n` +
      "Se også DEMO-122 for bakgrunn.",
  ),
  // Two hops out through DEMO-101 and DEMO-120, each with a session (three hops).
  [PLAN_A]: md(
    ["title: DEMO-101 — arbeidsplan", "type: plan", `sessions: [claude-code:${S3}]`, "prs: [example-org/demo-repo#12]"],
    "# Arbeidsplan",
  ),
  [TAGGED]: md(["title: Tagget side", "tags: [demo-120]", `sessions: [claude-code:${S4}]`], "# Tagget"),
  // Relate to the anchor's keys only through a mention and a link: no edge.
  [MENTIONED]: md(["title: Nevnt side"], "# Nevnt\n\nDEMO-102 nevnes her."),
  [LINKED]: md(["title: Lenket side"], `# Lenket\n\nEpic: [DEMO-103](${url("DEMO-103")}).`),
  // Counts the anchor's MENTION key: reached only if a mention were an edge.
  [BACKGROUND]: md(["title: DEMO-122 bakgrunn"], "# Bakgrunn"),
  [OTHER]: md(["title: DEMO-160 annen side", `sessions: [claude-code:${S_OTHER}]`], "# Annen side"),
  // Past the 400-session cap.
  [MANY]: md(
    ["title: DEMO-170 mange økter", `sessions: [${Array.from({ length: 401 }, (_, i) => sid(1000 + i)).join(", ")}]`],
    "# Mange",
  ),
};

/** Which PR each session merged (`/api/merges?sessions=`). */
const MERGES: Record<string, number> = { [S1]: 21, [S2]: 22, [S3]: 31, [S4]: 41 };

let server: ChildProcess | undefined;
let stub: Server | undefined;
let root = "";
let plainRoot = "";
/** Every ledger call the stub answered, by path. */
const ledgerCalls: string[] = [];

async function writeWiki(pages: Record<string, string>, config?: string): Promise<string> {
  const r = await mkdtemp(path.join(tmpdir(), "muninn-e2e-graph-"));
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
  plainRoot = await writeWiki({ [ANCHOR]: PAGES[ANCHOR]!, [OTHER]: PAGES[OTHER]! });

  stub = createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://127.0.0.1:${STUB_PORT}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === "/api/collection/jira-issues/documents") return json(200, { documents: [] });
    if (u.pathname.startsWith("/api/")) ledgerCalls.push(u.pathname);
    if (u.pathname === "/api/sessions-by-id") {
      const ids = (u.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      return json(200, {
        sessions: ids.map((sessionId) => ({ sessionId, title: `Økt ${sessionId.slice(-2)}`, cost: 1.25, provider: "claude" })),
        limit: 200,
        truncated: false,
      });
    }
    if (u.pathname === "/api/merges") {
      const ids = (u.searchParams.get("sessions") ?? "").split(",").filter(Boolean);
      return json(200, {
        merges: ids
          .filter((id) => MERGES[id])
          .map((sessionId) => ({
            sessionId,
            repo: "/src/demo-repo",
            prNumber: MERGES[sessionId],
            url: `https://github.com/example-org/demo-repo/pull/${MERGES[sessionId]}`,
            subject: `PR ${MERGES[sessionId]}`,
            mergedAt: "2026-01-05T10:00:00Z",
            mergeOk: true,
          })),
        truncated: false,
        limit: 200,
      });
    }
    if (u.pathname === "/api/jira") return json(200, { key: u.searchParams.get("key"), sessions: [], totalCost: 0, costedSessions: 0, truncated: false });
    if (u.pathname === "/api/session-handoff") return json(404, { error: "no such session" });
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

const pageUrl = (wiki: string, rel: string, extra = "") =>
  `${BASE}/wiki?wiki=${wiki}&relPath=${encodeURIComponent(rel)}${extra}`;

async function openPage(page: Page, wiki: string, rel: string, extra = ""): Promise<void> {
  await page.goto(pageUrl(wiki, rel, extra));
  await expect(page.locator(".wiki-article-head h1")).toBeVisible();
}

const graph = (page: Page) => page.locator("#wikiGraph");
const laneCount = (page: Page, lane: string) => page.locator(`#wikiGraph [data-lane-count="${lane}"]`);
const node = (page: Page, id: string) => page.locator(`#wikiGraph [data-graph-node="${id}"]`);
/** The graph has landed (the lanes, not the loading note). */
const drawn = (page: Page) => expect(page.locator("#wikiGraph .wiki-graph-lanes")).toBeVisible();
const article = (page: Page) => page.locator("#articleWrap > .wiki-article");

test.describe("Wiki reader: graph mode", () => {
  test("9: the created-keys page at depth 2, level 3 draws 5 issues, 3 pages, 2 sessions and 3 PRs", async ({ page }) => {
    await openPage(page, WIKI, ANCHOR, "&display=graph");
    await drawn(page);
    await expect(laneCount(page, "issue")).toHaveText("5");
    await expect(laneCount(page, "page")).toHaveText("3");
    await expect(laneCount(page, "session")).toHaveText("2");
    await expect(laneCount(page, "pr")).toHaveText("3");
    for (const key of ["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-120", "DEMO-121"]) {
      await expect(node(page, `issue:jira:${key}`)).toHaveCount(1);
    }
    // The mention key and the pages reached only through a mention or a link.
    await expect(node(page, "issue:jira:DEMO-122")).toHaveCount(0);
    for (const rel of [MENTIONED, LINKED, BACKGROUND]) await expect(node(page, `page:${rel}`)).toHaveCount(0);
    for (const rel of [ANCHOR, PLAN_A, TAGGED]) await expect(node(page, `page:${rel}`)).toHaveCount(1);
    // S3/S4 sit three hops out, and so do #12 (PLAN_A's prRef) and #31/#41.
    for (const s of [S1, S2]) await expect(node(page, `session:${s}`)).toHaveCount(1);
    for (const s of [S3, S4]) await expect(node(page, `session:${s}`)).toHaveCount(0);
    for (const n of [11, 21, 22]) await expect(node(page, `pr:example-org/demo-repo#${n}`)).toHaveCount(1);
    for (const n of [12, 31, 41]) await expect(node(page, `pr:example-org/demo-repo#${n}`)).toHaveCount(0);
    await expect(node(page, `page:${ANCHOR}`)).toHaveClass(/root/);
    await expect(article(page)).toBeHidden();
    // The edges are drawn: 5 + 2 issue–page, 2 page–session, 1 page–PR, 2 session–PR.
    await expect(page.locator("#wikiGraph .wiki-graph-edge")).toHaveCount(12);
    const res = await page.request.get(`${BASE}/api/wiki/graph?wiki=${WIKI}&scope=page&root=${encodeURIComponent(ANCHOR)}`);
    const body = await res.json();
    expect([body.depth, body.level]).toEqual([2, 3]);
  });

  test("9: at wiki scope level defaults to 1 and the ledger receives no call", async ({ page }) => {
    const before = ledgerCalls.length;
    const res = await page.request.get(`${BASE}/api/wiki/graph?wiki=${WIKI}&scope=wiki`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.level).toBe(1);
    expect(body.lanes).toEqual(["issue", "page"]);
    expect(ledgerCalls.length).toBe(before);
    // The board's fields ride every page node at every level.
    const anchor = body.nodes.find((n: { id: string }) => n.id === `page:${ANCHOR}`);
    expect(anchor.prRefs).toEqual(["example-org/demo-repo#11"]);
    expect(anchor.pageTimeMs).toBeGreaterThan(0);
  });

  test("8: a wiki with no trackers block renders no graph toggle, ignores g and the route 404s", async ({ page }) => {
    await openPage(page, WIKI_PLAIN, ANCHOR, "&display=graph");
    await expect(page.locator("#wikiGraphToggle")).toHaveCount(0);
    await expect(graph(page)).toHaveCount(0);
    await expect(article(page)).toBeVisible();
    await page.locator("body").press("g");
    await expect(graph(page)).toHaveCount(0);
    const res = await page.request.get(`${BASE}/api/wiki/graph?wiki=${WIKI_PLAIN}&scope=page&root=${encodeURIComponent(ANCHOR)}`);
    expect(res.status()).toBe(404);
  });

  test("g toggles graph mode; a modifier or the Ask box leaves it alone", async ({ page }) => {
    await openPage(page, WIKI, ANCHOR);
    const toggle = page.locator("#wikiGraphToggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await page.locator("body").press("g");
    await drawn(page);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(new URL(page.url()).searchParams.get("display")).toBe("graph");
    await page.locator("body").press("g");
    await expect(graph(page)).toHaveCount(0);
    await expect(article(page)).toBeVisible();
    expect(new URL(page.url()).searchParams.get("display")).toBeNull();
    for (const chord of ["Control+g", "Meta+g", "Alt+g", "Shift+G"]) {
      await page.locator("body").press(chord);
      await expect(graph(page), chord).toHaveCount(0);
    }
    await page.locator('.wiki-conn-tab[data-conntab="ask"]').click();
    await page.locator("#wikiAskInput").click();
    await page.keyboard.type("g");
    await expect(page.locator("#wikiAskInput")).toHaveValue("g");
    await expect(graph(page)).toHaveCount(0);
    // The toggle button does the same as g.
    await toggle.click();
    await drawn(page);
  });

  test("?display=graph&issue=jira:DEMO-102 opens rooted at the issue, with or without a page", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&display=graph&issue=jira:DEMO-102`);
    await expect(page.locator(".wiki-article-head h1")).toHaveText("DEMO-102");
    await drawn(page);
    await expect(node(page, "issue:jira:DEMO-102")).toHaveClass(/root/);
    // Its one counting page, and that page's other keys two hops out.
    await expect(node(page, `page:${ANCHOR}`)).toHaveCount(1);
    await expect(node(page, `page:${MENTIONED}`)).toHaveCount(0);
    await expect(laneCount(page, "issue")).toHaveText("5");

    await openPage(page, WIKI, OTHER, "&display=graph&issue=jira%3ADEMO-102");
    await drawn(page);
    await expect(node(page, "issue:jira:DEMO-102")).toHaveClass(/root/);
    await expect(node(page, `page:${OTHER}`)).toHaveCount(0);
  });

  test("Back and Forward restore graph mode from the URL", async ({ page }) => {
    await openPage(page, WIKI, ANCHOR);
    await page.locator("body").press("g");
    await drawn(page);
    await page.goBack();
    await expect(graph(page)).toHaveCount(0);
    await expect(article(page)).toBeVisible();
    await page.goForward();
    await drawn(page);
    await expect(article(page)).toBeHidden();
  });

  test("a rail click in graph mode keeps graph mode and re-roots on the page it opens", async ({ page }) => {
    await openPage(page, WIKI, ANCHOR, "&display=graph&issue=jira%3ADEMO-101");
    await drawn(page);
    await expect(node(page, "issue:jira:DEMO-101")).toHaveClass(/root/);
    await page.locator(`.wiki-list-item[data-relpath="${OTHER}"]`).click();
    await expect(page.locator(".wiki-article-head h1")).toContainText("annen side");
    await drawn(page);
    await expect(node(page, `page:${OTHER}`)).toHaveClass(/root/);
    const params = new URL(page.url()).searchParams;
    expect(params.get("display")).toBe("graph");
    expect(params.get("issue")).toBeNull();
    expect(params.get("relPath")).toBe(OTHER);
  });

  test("the side card offers Focus here and the tracker link; Focus here re-roots at the issue", async ({ page }) => {
    await openPage(page, WIKI, ANCHOR, "&display=graph");
    await drawn(page);
    await node(page, "issue:jira:DEMO-101").click();
    const card = page.locator("#wikiGraphCard");
    await expect(card).toBeVisible();
    await expect(card.locator("[data-graph-tracker]")).toHaveAttribute("href", url("DEMO-101"));
    await card.locator('[data-graph-focus="issue:jira:DEMO-101"]').click();
    await expect(node(page, "issue:jira:DEMO-101")).toHaveClass(/root/);
    expect(new URL(page.url()).searchParams.get("issue")).toBe("jira:DEMO-101");
    // A page node's card opens that page in reading mode.
    await node(page, `page:${PLAN_A}`).click();
    await card.locator(`[data-graph-open="${PLAN_A}"]`).click();
    await expect(page.locator(".wiki-article-head h1")).toContainText("arbeidsplan");
    await expect(graph(page)).toHaveCount(0);
    await expect(article(page)).toBeVisible();
  });

  test("hover lights the connected path", async ({ page }) => {
    await openPage(page, WIKI, ANCHOR, "&display=graph");
    await drawn(page);
    await node(page, "pr:example-org/demo-repo#21").hover();
    await expect(graph(page)).toHaveClass(/hovering/);
    await expect(node(page, `session:${S1}`)).toHaveClass(/lit/);
    await expect(node(page, `page:${ANCHOR}`)).toHaveClass(/lit/);
    await expect(node(page, `session:${S2}`)).not.toHaveClass(/lit/);
    await expect(page.locator("#wikiGraph .wiki-graph-edge.lit")).toHaveCount(2);
  });

  test("past 400 session refs the graph says it is cut short", async ({ page }) => {
    await openPage(page, WIKI, MANY, "&display=graph");
    await drawn(page);
    await expect(page.locator("#wikiGraph [data-graph-truncated]")).toContainText("first 400 sessions");
    await expect(laneCount(page, "session")).toHaveText("400");
  });
});
