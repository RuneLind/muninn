/**
 * /wiki rail — `group by effort` (plan `muninn-wiki-work-map`, P4 + D14,
 * D2/D4/D8): Activity folds under the work map's efforts.
 *
 * What only a real page holds (the rule itself is `wiki-effort-rail.test.ts`):
 *  1. Activity shows one fold row per effort with a page in Activity, at its
 *     newest Activity page's slot; up to three of the moving efforts (active,
 *     blocked, proposed) start open, the most recent first; pages in no effort
 *     stay rows.
 *  2. D14: in the mode no Work threads section or label draws (Pick up stays);
 *     each fold lists every page of its effort in the listing, newest first,
 *     four shown and «+N more», with role chips, and an open fold starts with
 *     the effort's one-line summary and «Open effort →». Each page is ONE row.
 *  3. The name opens `?effort=<id>` (and clears the active row); the caret
 *     folds without navigating; both are keyboard stops with a focus ring,
 *     and Enter on the name keeps focus on it through the rail's repaint.
 *     The open page inside a closed fold forces it open (caret disabled) until
 *     the reader leaves the page.
 *     Caret, name, «Open effort →» and «+N more» are Tab stops, and focus stays
 *     on «+N more» (then «Show fewer») and «Open effort →» through the repaint.
 *     The open page behind «+N more» forces its fold open and is shown.
 *  4. Unchecking `group by effort` draws the pre-P4 rail — Work threads back,
 *     plain Activity — and stores `toggle:no-efforts`, through a reload;
 *     re-checking removes it.
 *     A failed map GET draws Work threads too (X1), and Pick up reads its card.
 *  5. A wiki with no map draws plain Activity, with no checkbox.
 *  6. Families still group the pages in no effort.
 *  7. One map cache: the start view's card, the rail and the effort page send
 *     one GET per run time, and a map the card's ↻ poll receives reaches the
 *     rail. Opening an effort from its own forced-open fold releases it.
 *
 * One muninn over two temp wikis (one with a seeded `.work-map.json`, one
 * without) and one fake `node:http` claude-usage with one session, so Work
 * threads and Pick up are on screen. Synthetic names only. No model calls;
 * the only writes are the reader's localStorage.
 *
 * SPAWN ENV: `e2eEnv()` blanks `CLAUDE_USAGE_URL`, so it is set AFTER it.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { assertPortFree, waitForOwnServer } from "./own-server.ts";

const PORT = e2ePort("wiki-rail-efforts");
const LEDGER_PORT = e2ePort("wiki-rail-efforts/ledger");
const BASE = `http://127.0.0.1:${PORT}`;
const LEDGER_BASE = `http://127.0.0.1:${LEDGER_PORT}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const MAP = "e2e-rail-efforts";
const NOMAP = "e2e-rail-efforts-nomap";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const FOLDS = (wiki: string) => `muninn.wiki.folds.v1:${wiki}`;

/** relPath, title, hours since its last change, effort, plan_status. */
const PAGES: [string, string, number, string | null, string?][] = [
  // Epsilon: one page in Activity, five older ones (20 days, out of
  // Activity) that only its fold lists — six in all, so «+2 more».
  ["plans/eps-1.md", "Epsilon one", 0.5, "epsilon", "in-flight"],
  ["plans/eps-2.md", "Epsilon two", 20 * 24 + 1, "epsilon"],
  ["plans/eps-3.md", "Epsilon three", 20 * 24 + 2, "epsilon"],
  ["plans/eps-4.md", "Epsilon four", 20 * 24 + 3, "epsilon"],
  ["plans/eps-5.md", "Epsilon five", 20 * 24 + 4, "epsilon"],
  ["plans/eps-6.md", "Epsilon six", 20 * 24 + 5, "epsilon"],
  ["plans/alpha-one.md", "Alpha one", 1, "alpha", "in-flight"],
  ["notes/plain-one.md", "Plain one", 1.5, null],
  ["plans/beta-one.md", "Beta one", 2, "beta"],
  ["plans/beta-thread.md", "Beta thread page", 2.5, "beta"],
  ["plans/gamma-one.md", "Gamma one", 3, "gamma"],
  ["plans/delta-one.md", "Delta one", 4, "delta"],
  ["plans/alpha-two.md", "Alpha two", 5, "alpha", "shipped"],
  ["plans/alpha-ui.md", "Alpha UI", 6, "alpha-ui"],
  // A stem family in no effort, old enough to stay out of Activity.
  ["notes/kit-tool-one.md", "Kit tool one", 20 * 24, null],
  ["notes/kit-tool-two.md", "Kit tool two", 20 * 24, null],
  ["notes/kit-tool-three.md", "Kit tool three", 20 * 24, null],
];
const THREAD_PAGE = "plans/beta-thread.md";
/** Efforts in Activity order, and which start open: the three newest among
 *  active, blocked and proposed (beta is cooling, delta quiet). */
const EFFORT_ORDER = ["epsilon", "alpha", "beta", "gamma", "delta", "alpha-ui"];
const OPEN_DEFAULT = ["epsilon", "alpha", "gamma"];
const EPS_ONELINE = "Ship ⟦plans/eps-1.md⟧ and then the long tail of every follow-up the effort has collected over a very long time";

function mapJson(runAtMs: number, rename: Record<string, string> = {}): string {
  const e = (id: string, name: string, pages: string[], extra: Record<string, unknown> = {}) => ({
    id, name: rename[id] ?? name, aliases: [], oneLine: "", state: "active", pages: pages.map((p, i) => ({ id: p, role: i === 0 ? "plan" : "report" })),
    why: "", confidence: 0.9, next: "", related: [], daily: [], ...extra,
  });
  const of = (id: string) => PAGES.filter((p) => p[3] === id).map((p) => p[0]);
  return JSON.stringify({
    version: 1, wiki: MAP, runAtMs, model: "test-model",
    coverage: { sessionsSinceMs: runAtMs - 8 * DAY, sessionsAsOfMs: runAtMs, touchWindowDays: 28, activePages: 8, threads: 1, logEntries: 0, digestChars: 1, warnings: [] },
    summary: "", themes: [],
    needsYou: [{ title: "Pick a shape", kind: "decision", why: "", action: "", pages: [], effort: "alpha" }],
    efforts: [
      e("epsilon", "Epsilon work with a rather long name that has to ellipsize", of("epsilon"), { oneLine: EPS_ONELINE }),
      e("alpha", "Alpha work", of("alpha")),
      e("alpha-ui", "Alpha UI work", of("alpha-ui"), { parent: "alpha", state: "proposed" }),
      e("beta", "Beta work", of("beta"), { state: "cooling" }),
      e("gamma", "Gamma work", of("gamma")),
      e("delta", "Delta work", of("delta"), { state: "quiet" }),
    ],
    loose: [],
  });
}

const roots: Record<string, string> = {};
let server: ChildProcess | undefined;
let ledger: Server | undefined;

function startLedger(): Promise<Server> {
  const at = NOW - 2.5 * HOUR;
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname !== "/api/files") {
      res.writeHead(404).end();
      return;
    }
    const root = roots[MAP]!;
    if (url.searchParams.get("sessions") === "1") {
      return json({
        form: "sessions", root, since: Number(url.searchParams.get("since")), until: Date.now(), limit: 200, truncated: false,
        sessions: [{
          id: "t1", provider: "claude", title: "session t1", first: at - 30 * 60_000, last: at, bulk: false,
          text: { from: "prompt", paths: [THREAD_PAGE], links: [], files: [] },
          files: [{ p: THREAD_PAGE, edits: 3, firstMs: at - 30 * 60_000, lastMs: at }],
        }],
      });
    }
    if (url.searchParams.get("until")) return json({ root, pages: [], pageCount: 0, bulk: 10, limit: 5000, truncated: false, until: Number(url.searchParams.get("until")) });
    json({ root, pages: [{ p: THREAD_PAGE, w: at, s: 1 }], pageCount: 1, bulk: 10, limit: 5000, truncated: false });
  });
  return new Promise((resolve) => srv.listen(LEDGER_PORT, "127.0.0.1", () => resolve(srv)));
}

test.beforeAll(async () => {
  for (const name of [MAP, NOMAP]) {
    const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-${name}-`));
    roots[name] = root;
    // Activity ranks by change recency alone, so the hours above are its order.
    await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ activity: { agePenalty: 0, hubPenalty: 0, planBoost: 0, rows: 12 } }), "utf8");
    for (const [rel, title, hours, , status] of PAGES) {
      const abs = path.join(root, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, ["---", `title: ${title}`, "created: 2025-01-01", ...(status ? [`plan_status: ${status}`] : []), "---", "", `Body of ${title}.`, ""].join("\n"), "utf8");
      const stamp = new Date(NOW - hours * HOUR);
      await utimes(abs, stamp, stamp);
    }
  }
  await writeFile(path.join(roots[MAP]!, ".work-map.json"), mapJson(NOW - HOUR / 2), "utf8");
  ledger = await startLedger();
  await assertPortFree(PORT);
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WORK_MAP_WIKIS: "",
      WIKI_DIR: "",
      WIKI_EXTRA: `${MAP}=${roots[MAP]},${NOMAP}=${roots[NOMAP]}`,
      CLAUDE_USAGE_URL: LEDGER_BASE,
    },
    stdio: "ignore",
  });
  await waitForOwnServer(server, `${BASE}/api/wiki/pages?wiki=${MAP}`);
  const warm = Date.now() + 20_000;
  for (;;) {
    const b = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${MAP}&refresh=1`)).json()) as { work?: { threads: unknown[] } };
    if (b.work?.threads.length === 1) break;
    if (Date.now() > warm) throw new Error("the work-sessions memo never warmed");
    await new Promise((r) => setTimeout(r, 300));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise<void>((resolve) => (ledger ? ledger.close(() => resolve()) : resolve()));
  for (const r of Object.values(roots)) await rm(r, { recursive: true, force: true });
});

const effortRows = (page: Page) => page.locator("#wikiList .wiki-list-group.effort");
const effortRow = (page: Page, id: string) => page.locator(`#wikiList .wiki-list-group.effort[data-effort="${id}"]`);
const caret = (page: Page, id: string) => effortRow(page, id).locator(".wiki-effort-fold");
const nameLink = (page: Page, id: string) => effortRow(page, id).locator("a.wiki-effort-name");
const pageRow = (page: Page, rel: string) => page.locator(`#wikiList .wiki-list-item[data-relpath="${rel}"]`);

/** Open the wiki; `threads` says whether the Work threads section draws
 *  (off in `group by effort`, D14). */
async function open(page: Page, wiki = MAP, folds?: string[], threads = wiki !== MAP): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  if (folds) await page.addInitScript(([k, v]) => localStorage.setItem(k as string, v as string), [FOLDS(wiki), JSON.stringify(folds)] as const);
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  await expect(page.locator('.wiki-list-sec[data-section="activity"]')).toHaveCount(1);
  if (wiki === MAP) await expect(effortRows(page).first()).toBeVisible();
  await expect(page.locator('.wiki-list-sec[data-section="threads"]')).toHaveCount(threads ? 1 : 0);
}

/** Tab forward until `target` holds focus, at most `max` presses. */
async function tabTo(page: Page, target: ReturnType<Page["locator"]>, max = 25): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function relPathsOnRail(page: Page): Promise<string[]> {
  return page.locator("#wikiList .wiki-list-item[data-relpath]").evaluateAll((els) => els.map((e) => e.getAttribute("data-relpath")!));
}

test.describe("Wiki rail: group by effort", () => {
  test("Activity folds by effort, three moving efforts open, no Work threads, one row per page across Pick up and Activity", async ({ page }) => {
    await open(page);
    await expect(effortRows(page)).toHaveCount(EFFORT_ORDER.length);
    expect(await effortRows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-effort")))).toEqual(EFFORT_ORDER);
    for (const id of EFFORT_ORDER) {
      await expect(caret(page, id)).toHaveAttribute("aria-expanded", OPEN_DEFAULT.includes(id) ? "true" : "false");
    }
    // Row furniture: the name, the state, the roll-up and the age.
    await expect(nameLink(page, "alpha")).toHaveText("Alpha work");
    // ✋ counts the map's Needs-you items for the effort.
    await expect(effortRow(page, "alpha").locator(".wiki-effort-meta")).toHaveText(/active\s·\s✋ 1\s·\s1 in-flight\s·\s1 shipped/);
    await expect(effortRow(page, "beta").locator(".wiki-effort-meta")).toContainText("cooling");
    await expect(effortRow(page, "alpha").locator(".wiki-effort-age")).toHaveText("1h");
    // Open folds draw their pages as members; closed ones draw none.
    await expect(pageRow(page, "plans/alpha-one.md")).toHaveClass(/member/);
    await expect(pageRow(page, "plans/alpha-two.md")).toHaveClass(/member/);
    await expect(pageRow(page, "plans/delta-one.md")).toHaveCount(0);
    await expect(pageRow(page, "plans/alpha-ui.md")).toHaveCount(0);
    // A page in no effort stays an ordinary Activity row.
    await expect(pageRow(page, "notes/plain-one.md")).toHaveAttribute("data-section", "activity");
    await expect(pageRow(page, "notes/plain-one.md")).not.toHaveClass(/member/);
    // No Work threads section or label: the card that would claim beta's
    // thread page draws nowhere, so the (closed) beta fold holds it. Pick up stays.
    await expect(page.locator("#wikiList .wiki-thread-card")).toHaveCount(0);
    await expect(page.locator("#wikiList [data-work-group-menu]")).toHaveCount(0);
    await expect(pageRow(page, THREAD_PAGE)).toHaveCount(0);
    await caret(page, "beta").click();
    await expect(pageRow(page, THREAD_PAGE)).toHaveAttribute("data-section", "activity");
    await expect(pageRow(page, THREAD_PAGE)).toHaveClass(/member/);
    await expect(page.locator(`#wikiList .wiki-pickup-row[data-pickup="${THREAD_PAGE}"]`)).toHaveCount(1);
    // One row per page over the whole rail (Pick up rows are pointers).
    const rels = await relPathsOnRail(page);
    expect(rels.length).toBe(new Set(rels).size);
    expect(rels.filter((r) => r === "plans/beta-one.md")).toHaveLength(1);
  });

  test("D14: an open fold lists all its pages newest first, four shown and «+N more» that expands, with summary and role chips", async ({ page }) => {
    await open(page);
    const body = (id: string) =>
      page.locator(`#wikiList .wiki-list-item.member`).evaluateAll(
        (els, name) => els.filter((e) => (e.getAttribute("title") ?? "").includes(`In the ${name} effort`)).map((e) => e.getAttribute("data-relpath")),
        id,
      );
    const EPS_NAME = "Epsilon work with a rather long name that has to ellipsize";
    // Every listed page of the effort is in the fold: 6 = the joined pages present.
    expect(await body(EPS_NAME)).toEqual(["plans/eps-1.md", "plans/eps-2.md", "plans/eps-3.md", "plans/eps-4.md"]);
    const more = page.locator('#wikiList .wiki-effort-more[data-fold-key="effort-all:epsilon"]');
    await expect(more).toHaveText("+2 more");
    // The roll-up counts every page of the fold, hidden ones too.
    await expect(effortRow(page, "epsilon").locator(".wiki-effort-meta")).toContainText("1 in-flight");
    // Summary with its page marker as a link, never raw, then «Open effort →».
    const intro = page.locator('#wikiList .wiki-effort-intro[data-effort="epsilon"]');
    await expect(intro).toContainText("Ship Epsilon one and then the long tail");
    await expect(intro).not.toContainText("⟦");
    await expect(intro.locator('a.wiki-wm-link[data-relpath="plans/eps-1.md"]')).toHaveText("Epsilon one");
    await expect(intro.locator("a.wiki-effort-open")).toHaveText("Open effort →");
    // Role chips on the fold's rows.
    await expect(pageRow(page, "plans/eps-1.md").locator(".wiki-effort-role")).toHaveText("plan");
    await expect(pageRow(page, "plans/eps-2.md").locator(".wiki-effort-role")).toHaveText("report");
    await expect(pageRow(page, "notes/plain-one.md").locator(".wiki-effort-role")).toHaveCount(0);
    // «+N more» expands in place and stays as «Show fewer».
    await more.click();
    expect(await body(EPS_NAME)).toEqual(["plans/eps-1.md", "plans/eps-2.md", "plans/eps-3.md", "plans/eps-4.md", "plans/eps-5.md", "plans/eps-6.md"]);
    await expect(more).toHaveText("Show fewer");
    await more.click();
    await expect(more).toHaveText("+2 more");
    // Every page once across the rail.
    const rels = await relPathsOnRail(page);
    expect(rels.length).toBe(new Set(rels).size);
    // «Open effort →» opens the effort page.
    await intro.locator("a.wiki-effort-open").click();
    await expect(page.locator("#wikiEffortPage")).toHaveAttribute("data-effort", "epsilon");
  });

  test("D14: the open page behind «+N more» forces its fold open and is shown", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${MAP}&relPath=${encodeURIComponent("plans/eps-6.md")}`);
    await expect(caret(page, "epsilon")).toBeDisabled();
    await expect(pageRow(page, "plans/eps-6.md")).toHaveClass(/active/);
    await expect(page.locator('#wikiList .wiki-effort-more[data-fold-key="effort-all:epsilon"]')).toHaveText("+1 more");
  });

  test("keyboard: caret, name, «Open effort →» and «+N more» are Tab stops; focus stays through the repaint", async ({ page }) => {
    await open(page);
    await caret(page, "epsilon").focus();
    await page.keyboard.press("Tab");
    await expect(nameLink(page, "epsilon")).toBeFocused();
    const openLink = page.locator('#wikiList .wiki-effort-intro[data-effort="epsilon"] a.wiki-effort-open');
    await tabTo(page, openLink);
    const more = page.locator('#wikiList .wiki-effort-more[data-fold-key="effort-all:epsilon"]');
    await tabTo(page, more);
    await page.keyboard.press("Enter");
    await expect(more).toHaveText("Show fewer");
    await expect(more).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(more).toHaveText("+2 more");
    await expect(more).toBeFocused();
    // Enter on «Open effort →» opens the effort and keeps focus on that link.
    await openLink.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#wikiEffortPage")).toHaveAttribute("data-effort", "epsilon");
    expect(await page.evaluate(() => {
      const a = document.activeElement;
      return a ? `${a.tagName}:${a.className}:${a.getAttribute("data-effort-link")}` : null;
    })).toBe("A:wiki-effort-open:epsilon");
  });

  test("the name opens the effort page and clears the active row; the caret folds without navigating", async ({ page }) => {
    await open(page);
    const before = page.url();
    await caret(page, "delta").click();
    await expect(caret(page, "delta")).toHaveAttribute("aria-expanded", "true");
    await expect(pageRow(page, "plans/delta-one.md")).toBeVisible();
    expect(page.url()).toBe(before);
    await caret(page, "delta").click();
    await expect(caret(page, "delta")).toHaveAttribute("aria-expanded", "false");
    await expect(pageRow(page, "plans/delta-one.md")).toHaveCount(0);
    // Open a page, then the effort: the page's highlight goes.
    await pageRow(page, "plans/gamma-one.md").click();
    await expect(pageRow(page, "plans/gamma-one.md")).toHaveClass(/active/);
    await nameLink(page, "alpha").click();
    await expect(page.locator("#wikiEffortPage")).toHaveAttribute("data-effort", "alpha");
    expect(new URL(page.url()).searchParams.get("effort")).toBe("alpha");
    await expect(page.locator("#wikiList .wiki-list-item.active")).toHaveCount(0);
  });

  test("the open page inside a CLOSED fold forces it open, caret disabled; leaving the page lets it close again", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    // delta is the 4th newest effort, so it starts closed.
    await page.goto(`${BASE}/wiki?wiki=${MAP}&relPath=${encodeURIComponent("plans/delta-one.md")}`);
    await expect(caret(page, "delta")).toHaveAttribute("aria-expanded", "true");
    await expect(caret(page, "delta")).toBeDisabled();
    await expect(pageRow(page, "plans/delta-one.md")).toBeVisible();
    await expect(pageRow(page, "plans/delta-one.md")).toHaveClass(/active/);
    await expect(pageRow(page, "plans/delta-one.md")).toHaveClass(/member/);
    // A fold the open page does not force keeps its own caret.
    await expect(caret(page, "alpha")).toBeEnabled();
    await pageRow(page, "plans/gamma-one.md").click();
    await expect(pageRow(page, "plans/gamma-one.md")).toHaveClass(/active/);
    await expect(caret(page, "delta")).toHaveAttribute("aria-expanded", "false");
    await expect(caret(page, "delta")).toBeEnabled();
    await expect(pageRow(page, "plans/delta-one.md")).toHaveCount(0);
  });

  test("keyboard: the caret and the name are separate stops with a visible ring; Enter and Space toggle the caret", async ({ page }) => {
    await open(page);
    await caret(page, "gamma").focus();
    await page.keyboard.press("Tab");
    await expect(nameLink(page, "gamma")).toBeFocused();
    const ring = await nameLink(page, "gamma").evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }));
    expect(ring).toEqual({ style: "solid", width: "2px" });
    await page.keyboard.press("Shift+Tab");
    await expect(caret(page, "gamma")).toBeFocused();
    expect(await caret(page, "gamma").evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
    await page.keyboard.press("Enter");
    await expect(caret(page, "gamma")).toHaveAttribute("aria-expanded", "false");
    await expect(caret(page, "gamma")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(caret(page, "gamma")).toHaveAttribute("aria-expanded", "true");
    await expect(caret(page, "gamma")).toBeFocused();
    expect(new URL(page.url()).searchParams.get("effort")).toBeNull();
  });

  test("keyboard: Enter on an effort name opens the effort page and keeps focus on that name", async ({ page }) => {
    await open(page);
    await caret(page, "gamma").focus();
    await page.keyboard.press("Tab");
    await expect(nameLink(page, "gamma")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#wikiEffortPage")).toHaveAttribute("data-effort", "gamma");
    expect(await page.evaluate(() => {
      const a = document.activeElement;
      return a ? `${a.tagName}:${a.className}:${a.getAttribute("data-effort-link")}` : null;
    })).toBe("A:wiki-effort-name:gamma");
  });

  test("unchecking group by effort draws plain Activity and stores toggle:no-efforts through a reload; re-checking removes it", async ({ page }) => {
    await open(page);
    await page.locator("#wikiOptionsBtn").click();
    const box = page.locator("#wikiGroupEfforts");
    await expect(box).toBeVisible();
    await expect(box).toBeChecked();
    await box.uncheck();
    await expect(effortRows(page)).toHaveCount(0);
    // The pre-P4 rail: Work threads back (its card claims its page), no fold furniture.
    await expect(page.locator('.wiki-list-sec[data-section="threads"]')).toHaveCount(1);
    await expect(pageRow(page, THREAD_PAGE)).toHaveAttribute("data-section", "threads");
    await expect(page.locator("#wikiList .wiki-effort-intro, #wikiList .wiki-effort-more, #wikiList .wiki-effort-role")).toHaveCount(0);
    await expect(pageRow(page, "plans/delta-one.md")).toHaveAttribute("data-section", "activity");
    await expect(pageRow(page, "plans/alpha-one.md")).not.toHaveClass(/member/);
    const stored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "[]") as string[], FOLDS(MAP));
    expect(await stored()).toContain("toggle:no-efforts");
    await page.reload();
    await expect(page.locator('.wiki-list-sec[data-section="activity"]')).toHaveCount(1);
    await expect(page.locator('.wiki-list-sec[data-section="threads"]')).toHaveCount(1);
    await expect(effortRows(page)).toHaveCount(0);
    await page.locator("#wikiOptionsBtn").click();
    await expect(page.locator("#wikiGroupEfforts")).not.toBeChecked();
    await page.locator("#wikiGroupEfforts").check();
    await expect(effortRows(page)).toHaveCount(EFFORT_ORDER.length);
    await expect(page.locator('.wiki-list-sec[data-section="threads"]')).toHaveCount(0);
    expect(await stored()).not.toContain("toggle:no-efforts");
  });

  test("X1: a failed map GET draws Work threads, and Pick up rows read their card again", async ({ page }) => {
    await page.route("**/api/wiki/work-map?*", (route) => route.fulfill({ status: 500, json: { error: "boom" } }));
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${MAP}`);
    await expect(page.locator('.wiki-list-sec[data-section="threads"]')).toHaveCount(1);
    await expect(pageRow(page, THREAD_PAGE)).toHaveAttribute("data-section", "threads");
    await expect(effortRows(page)).toHaveCount(0);
    const pick = page.locator(`#wikiList .wiki-pickup-row[data-pickup="${THREAD_PAGE}"]`);
    await expect(pick).toHaveCount(1);
    await expect(pick).not.toContainText("not in Work threads");
    await expect(pick).toContainText(" in ");
  });

  test("a wiki with no map draws plain Activity, with no checkbox, whatever is stored", async ({ page }) => {
    for (const folds of [[], ["effort:alpha"]]) {
      await open(page, NOMAP, folds);
      await expect(pageRow(page, "plans/alpha-one.md")).toHaveAttribute("data-section", "activity");
      await expect(effortRows(page)).toHaveCount(0);
      // Open the options pane first: a closed pane hides the label whatever
      // the toggle's own `hidden` says.
      await page.locator("#wikiOptionsBtn").click();
      await expect(page.locator("#wikiGroupFamilies")).toBeVisible();
      await expect(page.locator("#wikiEffortsToggle")).toBeHidden();
      await page.locator("#wikiOptionsBtn").click();
      const rels = await relPathsOnRail(page);
      expect(rels.length).toBe(new Set(rels).size);
    }
  });

  test("pages in no effort stay plain rows, and families still group them", async ({ page }) => {
    await open(page, MAP, ["toggle:families"]);
    await expect(effortRows(page)).toHaveCount(EFFORT_ORDER.length);
    const fam = page.locator('#wikiList .wiki-list-group[data-section="all"][data-group^="family:"]');
    await expect(fam).toHaveCount(1);
    await expect(fam.locator(".wiki-group-name")).toHaveText("kit-tool-*");
    await expect(pageRow(page, "notes/plain-one.md")).toHaveAttribute("data-section", "activity");
  });

  test("one map GET serves the card, the rail and the effort page", async ({ page }) => {
    const gets: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "GET" && new URL(r.url()).pathname === "/api/wiki/work-map") gets.push(r.url());
    });
    await open(page);
    await expect(effortRows(page)).toHaveCount(EFFORT_ORDER.length);
    await expect(page.locator("#wikiWorkCard")).toBeVisible();
    await nameLink(page, "alpha").click();
    await expect(page.locator("#wikiEffortPage")).toHaveAttribute("data-effort", "alpha");
    await expect(page.locator("#wikiEffortPage")).toContainText("Alpha one");
    expect(gets).toHaveLength(1);
  });

  test("opening an effort from its own forced-open fold releases the fold's caret", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${MAP}&relPath=${encodeURIComponent("plans/delta-one.md")}`);
    await expect(caret(page, "delta")).toBeDisabled();
    await nameLink(page, "delta").click();
    await expect(page.locator("#wikiEffortPage")).toHaveAttribute("data-effort", "delta");
    await expect(caret(page, "delta")).toBeEnabled();
  });

  test("a new map the card's ↻ poll receives reaches the rail", async ({ page }) => {
    let next = false;
    await page.route("**/api/wiki/work-map?*", async (route) => {
      if (next) return route.fulfill({ json: { map: JSON.parse(mapJson(Date.now(), { alpha: "Alpha renamed" })), organizable: true } });
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - HOUR } });
    });
    await page.route("**/api/wiki/work-map/refresh*", (route) => {
      next = true;
      return route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } });
    });
    await open(page);
    await expect(nameLink(page, "alpha")).toHaveText("Alpha work");
    await page.locator("#wikiWorkMapRefresh").click();
    // The poll runs every 5 s.
    await expect(page.locator("#wikiWorkCard")).toContainText("Alpha renamed", { timeout: 15_000 });
    await expect(nameLink(page, "alpha")).toHaveText("Alpha renamed");
  });
});
