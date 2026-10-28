/**
 * The Stale check's counts everywhere (plan muninn-wiki-drift-check, PR 2b),
 * end to end.
 *
 * What no unit test can prove, and this spec exists for:
 *
 *   1. **Every surface shows the STALE tab's two numbers (D26, D31)**: the
 *      rail badge and the home's line and Stale tab read the wiki-wide
 *      summary route, the article pill reads the page report, and all of
 *      them equal what the tab shows.
 *   2. **Marks land in the browser on the said words (D21)**: in a list item,
 *      in a paragraph line (bare text: the reader emits no `<p>`) and in a
 *      table row (the link in one cell, the word in the next). A hit two
 *      identical lines share, and a hit whose words another line also holds,
 *      get no mark while the tab still lists them.
 *   3. **Navigation paints no other page's counts**: a page's report that is
 *      still in flight shows no pill and no marks, and a report for a page
 *      the reader left that answers late paints nothing.
 *   4. **Not a status drops every surface with the tab.**
 *   5. **A read-only instance shows none of it (D25)** and never asks for the
 *      summary.
 *
 * **What is stubbed and why.** Nothing reaches a model: the confirm loop's
 * one output, a `status-line` verdict row, is inserted under the key D22
 * defines (sha256 over `status-line/v3`, the page, the line's text, its
 * status words, the target, its `plan_status` and its own title, NUL-joined),
 * as `wiki-stale-tab.spec.ts` does.
 *
 * Ports from `e2e/ports.ts`; `e2eEnv()` blanks the platform tokens and the
 * instance-profile flags; the bot lives under a temp `MUNINN_BOTS_DIR`.
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-stale-counts");
const RO_PORT = e2ePort("wiki-stale-counts/readonly");
const BASE = `http://127.0.0.1:${PORT}`;
const RO_BASE = `http://127.0.0.1:${RO_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2estalecounts";
const BOT = "e2estalecountsbot";
const DAY = 86_400_000;

const LI_LINE = "- [[p]] is in-flight, two PRs open";
const PARA_LINE = "The plan [[q]] pågår fortsatt i år.";
const ROW_LINE = "| [[p]] | blokkert |";
/** Two identical lines: one key, two hits, no unique mark for either. */
const TWIN_LINE = "- [[q]] is a draft still";
const UNCONFIRMED_LINE = "- [[p]] is proposed per the old note";
/** A confirmed line and, before it, an unconfirmed line holding all its words:
 *  two candidates that tie, so no mark (the first in the page is the wrong one). */
const NEAR_DECOY_LINE = "- [[p]] is a draft still, per the review";
const NEAR_LINE = "- [[p]] is a draft still";
const HUB2_LINE = "- [[p]] is blocked now";

/** hub.md: 6 confirmed stale lines (the twins count twice) and 1 page to check. */
const HUB_TEXT = "⚠ 6 stale status lines · 1 linking page to check";
const HUB2_TEXT = "⚠ 1 stale status line · 0 linking pages to check";

const page = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;

let root = "";
let botsRoot = "";
let server: ChildProcess | undefined;
let roServer: ChildProcess | undefined;
let sql: ReturnType<typeof postgres> | null = null;

function git(args: string[], atMs?: number): void {
  const date = atMs === undefined ? undefined : new Date(atMs).toISOString();
  execFileSync("git", ["-C", root, ...args], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e2e@example.invalid",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.invalid",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  });
}

async function write(rel: string, body: string): Promise<void> {
  await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
  await writeFile(path.join(root, rel), body, "utf8");
}

/** D22's status-line key, spelled out independently of the server. */
const statusLineKey = (pageRel: string, text: string, said: string[], target: string, now: string, title: string) =>
  createHash("sha256")
    .update(["status-line/v3", pageRel, text, said.join(","), target, now, title].join("\0"))
    .digest("hex");

function boot(port: number, extra: Record<string, string>): ChildProcess {
  return spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      MUNINN_BOTS_DIR: botsRoot,
      WIKI_EXTRA: `${WIKI}=${root}=${WIKI}=${BOT}`,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      HAIKU_BACKEND: "",
      ...extra,
    },
    stdio: "ignore",
  });
}

async function waitUp(base: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/live`)).ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`muninn did not start at ${base}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-stale-counts-"));
  botsRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-stale-counts-bots-"));
  await mkdir(path.join(botsRoot, BOT), { recursive: true });
  await writeFile(path.join(botsRoot, BOT, "CLAUDE.md"), "# e2e stale counts bot\n");
  await writeFile(path.join(botsRoot, BOT, "config.json"), JSON.stringify({ connector: "claude-cli" }));

  const now = Date.now();
  git(["init", "-q", "-b", "main"]);
  await write("plans/p.md", page("P", "The plan.", "plan_status: shipped\n"));
  await write("plans/q.md", page("Q", "The other plan.", "plan_status: shipped\n"));
  await write("notes/old.md", page("Old", "The pin in [[hub]] landed on 23.05."));
  await write("hub.md", page("Hub", "First."));
  await write("hub2.md", page("Hub two", `${HUB2_LINE}\n\nThe second hub.`));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"], now - 30 * DAY);
  await write(
    "hub.md",
    page(
      "Hub",
      [
        LI_LINE,
        "- another item",
        "",
        PARA_LINE,
        "A second line of the same paragraph.",
        "",
        "| Plan | State |",
        "|---|---|",
        ROW_LINE,
        "",
        TWIN_LINE,
        TWIN_LINE,
        "",
        UNCONFIRMED_LINE,
        "",
        NEAR_DECOY_LINE,
        NEAR_LINE,
        "",
        "The pin moved.",
      ].join("\n"),
    ),
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "hub: the pin moves"], now - DAY);

  sql = postgres(TEST_DB, { max: 2 });
  await sql`DELETE FROM wiki_stale_verdicts WHERE wiki = ${WIKI}`;
  const rows: [string, string, string, string, string][] = [
    ["hub.md", LI_LINE, "in-flight", "plans/p.md", "P"],
    ["hub.md", PARA_LINE, "in-flight", "plans/q.md", "Q"],
    ["hub.md", ROW_LINE, "blocked", "plans/p.md", "P"],
    ["hub.md", TWIN_LINE, "proposed", "plans/q.md", "Q"],
    ["hub.md", NEAR_LINE, "proposed", "plans/p.md", "P"],
    ["hub2.md", HUB2_LINE, "blocked", "plans/p.md", "P"],
  ];
  for (const [pg, text, said, target, title] of rows) {
    await sql`
      INSERT INTO wiki_stale_verdicts (wiki, kind, page, key_hash, verdict, reason, checked_by)
      VALUES (${WIKI}, 'status-line', ${pg}, ${statusLineKey(pg, text, [said], target, "shipped", title)}, 'stale', 'E2E: the plan shipped', 'model:e2e')
    `;
  }

  server = boot(PORT, {});
  roServer = boot(RO_PORT, { MUNINN_WIKI_READONLY: "1" });
  await Promise.all([waitUp(BASE), waitUp(RO_BASE)]);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  roServer?.kill("SIGTERM");
  try {
    if (sql) await sql`DELETE FROM wiki_stale_verdicts WHERE wiki = ${WIKI}`;
  } finally {
    await sql?.end();
  }
  await rm(root, { recursive: true, force: true });
  await rm(botsRoot, { recursive: true, force: true });
});

async function open(p: Page, rel: string, text: string, base = BASE): Promise<void> {
  await p.goto(`${base}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(p.locator(".wiki-article")).toContainText(text);
}

const pill = (p: Page) => p.locator("#wikiStalePill [data-stale-pill]");
const marks = (p: Page) => p.locator(".wiki-article mark.wiki-stale-mark");
const railBadge = (p: Page, rel: string) => p.locator(`.wiki-list-item[data-relpath="${rel}"] .wiki-stale-rail`);

/** Each mark's text and where it sits: its list item, table row, or neither (a paragraph line). */
async function markPlaces(p: Page): Promise<string[]> {
  return marks(p).evaluateAll((els) =>
    els.map((m) => `${m.textContent}@${m.closest("tr") ? "tr" : m.closest("li") ? "li" : "text"}`),
  );
}

/** Hold the page report for `rel` until the returned release is called. */
async function holdReport(p: Page, rel: string): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await p.route(
    (u) => u.pathname === "/api/wiki/stale" && u.searchParams.get("page") === rel,
    async (route: Route) => {
      await gate;
      await route.continue().catch(() => {});
    },
  );
  return release;
}

test("the pill, the rail badge, the marks and the home show the STALE tab's numbers (D26, D21)", async ({ page: p }) => {
  await open(p, "hub.md", "The pin moved.");
  await expect(p.locator("#wikiStaleCount")).toHaveText("6 · 1");
  await p.locator('.wiki-conn-tab[data-conntab="stale"]').click();
  const head = p.locator("#staleBody .wiki-stale-head");
  await expect(head).toHaveText(HUB_TEXT);
  // The tab lists all six confirmed lines, the unmarked ones included.
  await expect(p.locator("#staleBody [data-stale-hit]")).toHaveCount(6);
  await expect(pill(p)).toHaveText(HUB_TEXT);
  await expect(railBadge(p, "hub.md")).toHaveText("⚠ 6 · 1");
  await expect(railBadge(p, "hub2.md")).toHaveText("⚠ 1 · 0");
  // Three marks: a list item, a paragraph line and a table row. The twins and
  // the near line tie, so none of them is marked; nor are unconfirmed lines.
  await expect(marks(p)).toHaveCount(3);
  expect((await markPlaces(p)).sort()).toEqual(["blokkert@tr", "in-flight@li", "pågår@text"]);
  // The pill opens the tab.
  await p.locator('.wiki-conn-tab[data-conntab="conn"]').click();
  await pill(p).click();
  await expect(p.locator('.wiki-conn-tab[data-conntab="stale"]')).toHaveClass(/\bactive\b/);

  // The home: the line's totals and the Stale tab's rows say the same.
  await p.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await expect(p.locator("#wikiStaleHome [data-stale-home-totals]")).toHaveText("⚠ 7 stale status lines · 1 linking page to check on 2 pages");
  await p.locator("#wikiStaleHome [data-stale-home-open]").click();
  await expect(p.locator('.wiki-tab[data-tab="stale"]')).toHaveClass(/\bactive\b/);
  await expect(p.locator('.wiki-stale-home-row[data-relpath="hub.md"] .wiki-stale-home-counts')).toHaveText(HUB_TEXT);
  await expect(p.locator('.wiki-stale-home-row[data-relpath="hub2.md"] .wiki-stale-home-counts')).toHaveText(HUB2_TEXT);
  // A row opens its page.
  await p.locator('.wiki-stale-home-row[data-relpath="hub2.md"]').click();
  await expect(p.locator(".wiki-article")).toContainText("The second hub.");
  await expect(pill(p)).toHaveText(HUB2_TEXT);
});

test("navigating away and back paints no other page's counts or marks", async ({ page: p }) => {
  await open(p, "hub.md", "The pin moved.");
  await expect(pill(p)).toHaveText(HUB_TEXT);
  await expect(marks(p)).toHaveCount(3);

  // hub2's report is in flight: no pill, no marks, never hub's.
  const releaseHub2 = await holdReport(p, "hub2.md");
  await p.locator('.wiki-list-item[data-relpath="hub2.md"]').click();
  await expect(p.locator(".wiki-article")).toContainText("The second hub.");
  await expect(p.locator("#wikiStalePill")).toBeEmpty();
  await expect(marks(p)).toHaveCount(0);
  releaseHub2();
  await expect(pill(p)).toHaveText(HUB2_TEXT);
  await expect(marks(p)).toHaveCount(1);
  await p.unroute((u) => u.pathname === "/api/wiki/stale" && u.searchParams.get("page") === "hub2.md");

  // hub's report answers after the reader has moved on to hub2: it paints nothing.
  const releaseHub = await holdReport(p, "hub.md");
  await p.locator('.wiki-list-item[data-relpath="hub.md"]').click();
  await expect(p.locator(".wiki-article")).toContainText("The pin moved.");
  await expect(p.locator("#wikiStalePill")).toBeEmpty();
  await p.locator('.wiki-list-item[data-relpath="hub2.md"]').click();
  await expect(p.locator(".wiki-article")).toContainText("The second hub.");
  await expect(pill(p)).toHaveText(HUB2_TEXT);
  const late = p.waitForResponse((r) => r.url().includes("/api/wiki/stale?") && r.url().includes("page=hub.md"));
  releaseHub();
  await late;
  // Give the late answer a turn to (wrongly) paint.
  await p.waitForTimeout(300);
  await expect(pill(p)).toHaveText(HUB2_TEXT);
  await expect(marks(p)).toHaveCount(1);
  await expect(p.locator("#wikiStaleCount")).toHaveText("1 · 0");
  await expect(railBadge(p, "hub.md")).toHaveText("⚠ 6 · 1");
});

test("the open page's rail row follows its own report when the summary is older", async ({ page: p }) => {
  await open(p, "hub.md", "The pin moved.");
  await expect(railBadge(p, "hub2.md")).toHaveText("⚠ 1 · 0");
  // hub2's confirmation goes after the summary was read: its report says so,
  // and its rail row must agree with its pill, not with the older summary.
  const [row] = await sql!`DELETE FROM wiki_stale_verdicts WHERE wiki = ${WIKI} AND page = 'hub2.md' RETURNING *`;
  try {
    await p.locator('.wiki-list-item[data-relpath="hub2.md"]').click();
    await expect(p.locator(".wiki-article")).toContainText("The second hub.");
    await expect(pill(p)).toHaveText("✓ nothing stale");
    await expect(railBadge(p, "hub2.md")).toHaveCount(0);
    await expect(railBadge(p, "hub.md")).toHaveText("⚠ 6 · 1");
  } finally {
    await sql!`INSERT INTO wiki_stale_verdicts ${sql!(row!)}`;
  }
});

test("a read-only instance shows no pill, badge, mark or home line (D25)", async ({ page: p }) => {
  const staleGets: string[] = [];
  p.on("request", (r) => {
    if (r.url().includes("/api/wiki/stale")) staleGets.push(r.url());
  });
  await open(p, "hub.md", "The pin moved.", RO_BASE);
  await expect(p.locator(".wiki-list-item[data-relpath='hub.md']")).toBeVisible();
  await expect(p.locator("#wikiStalePill")).toHaveCount(0);
  await expect(p.locator(".wiki-stale-rail")).toHaveCount(0);
  await expect(marks(p)).toHaveCount(0);
  await p.goto(`${RO_BASE}/wiki?wiki=${WIKI}&view=stale`);
  await expect(p.locator('.wiki-tab[data-tab="hubs"]')).toHaveClass(/\bactive\b/);
  await expect(p.locator("#wikiStaleHome")).toHaveCount(0);
  await expect(p.locator('.wiki-tab[data-tab="stale"]')).toHaveCount(0);
  expect(staleGets).toEqual([]);
});

// Last: it writes a reader row the tests above must not see.
test("Not a status drops the tab, the pill, the rail badge, the mark and the home together", async ({ page: p }) => {
  await open(p, "hub.md", "The pin moved.");
  await p.locator('.wiki-conn-tab[data-conntab="stale"]').click();
  await expect(pill(p)).toHaveText(HUB_TEXT);
  await expect(marks(p)).toHaveCount(3);
  await p.locator('[data-stale-hit="5"] [data-stale-verdict="not-status"]').click();
  const dropped = "⚠ 5 stale status lines · 1 linking page to check";
  await expect(p.locator("#staleBody .wiki-stale-head")).toHaveText(dropped);
  await expect(p.locator("#wikiStaleCount")).toHaveText("5 · 1");
  await expect(pill(p)).toHaveText(dropped);
  await expect(railBadge(p, "hub.md")).toHaveText("⚠ 5 · 1");
  await expect(marks(p)).toHaveCount(2);
  expect((await markPlaces(p)).sort()).toEqual(["blokkert@tr", "pågår@text"]);
  // Off the page, its row reads the summary again: refreshed, not the old count.
  await p.locator('.wiki-list-item[data-relpath="hub2.md"]').click();
  await expect(pill(p)).toHaveText(HUB2_TEXT);
  await expect(railBadge(p, "hub.md")).toHaveText("⚠ 5 · 1");
  await p.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await expect(p.locator("#wikiStaleHome [data-stale-home-totals]")).toHaveText("⚠ 6 stale status lines · 1 linking page to check on 2 pages");
});
