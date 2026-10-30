/**
 * The effort page (plan `muninn-wiki-work-map`, P3): `?effort=<id>` in the
 * /wiki article pane over a seeded `.work-map.json`.
 *
 * The rendering rules are unit-tested (`wiki-effort-page.test.ts`); what only a
 * real page can hold:
 *
 *  1. **Reached from the Your work card** — an effort name is a link that
 *     opens the page in the reader (pushState), with In short, the pages in
 *     lineage order and the 28-day strip.
 *  2. **URL state** — Back returns to the start view, Forward reopens the
 *     effort, a reload and a pasted URL open the same effort.
 *  3. **Sub-efforts and page links** navigate in the reader.
 *  4. **An id the map does not hold** shows «no longer in the map», linking the
 *     effort whose alias slugifies to it; a wiki with no map says so.
 *  5. **Legible in every theme**: every element of the effort page and its
 *     Connections pane that paints text clears 4.5:1.
 *
 * One muninn on its own port over two temp wikis. `SCHEDULER_ENABLED=false`
 * keeps the work-map loop off. No model calls.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedMeasure } from "./contrast.ts";
import { WIKI_REFETCH_MIN_INTERVAL_MS } from "../src/dashboard/views/components/wiki-refresh.ts";
import { activityStrip, sessionsFromDay } from "../src/dashboard/views/components/wiki-effort-page.ts";

const PORT = e2ePort("wiki-effort-page");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-ef-map";
const NOMAP = "e2e-ef-nomap";
/** A third wiki whose map the listing-refresh tests rewrite mid-test. */
const LIVE = "e2e-ef-live";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function md(title: string, status?: string): string {
  return `---\ntitle: ${title}\n${status ? `plan_status: ${status}\n` : ""}---\n\nBody of ${title}.\n`;
}

function osloDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** The drift effort's stored days. */
function driftDaily(runAtMs: number) {
  return [
    // Sessions only, on the 8-day window's first (partial) Oslo day.
    { day: osloDay(runAtMs - 8 * DAY), commits: 0, sessions: 1 },
    { day: osloDay(runAtMs - 1 * DAY), commits: 3, sessions: 0 },
    { day: osloDay(runAtMs - 2 * DAY), commits: 1, sessions: 2 },
    { day: osloDay(runAtMs - 15 * DAY), commits: 2, sessions: 0 },
  ];
}

/** The seeded map's run time. The strip spans 28–30 Oslo days depending on it
 *  (DST), so every strip assertion derives its numbers from this value. */
let wikiRunAt = 0;

function mapJson(runAtMs: number, wiki = WIKI, driftName = "Drift check"): string {
  const e = (id: string, name: string, pages: { id: string; role: string; derivedFrom?: string }[], extra: Record<string, unknown> = {}) => ({
    id, name, aliases: [], oneLine: "", state: "active", pages, why: "", confidence: 0.9, next: "", related: [], daily: [], ...extra,
  });
  return JSON.stringify({
    version: 1,
    wiki,
    runAtMs,
    model: "test-model",
    coverage: { sessionsSinceMs: runAtMs - 8 * DAY, sessionsAsOfMs: runAtMs, touchWindowDays: 28, activePages: 5, threads: 1, logEntries: 1, digestChars: 1, warnings: [] },
    summary: "Drift work moves.",
    needsYou: [
      { title: "Decide on ⟦plans/drift.mdx⟧", kind: "decision", why: "Two drafts disagree.", action: "Pick one.", pages: [], effort: "drift" },
      { title: "Other item", kind: "followup", why: "", action: "", pages: [], effort: "grocery" },
    ],
    themes: [{ name: "Reader", efforts: ["drift", "grocery", "visuals"] }],
    efforts: [
      e("drift", driftName, [
        { id: "plans/drift.mdx", role: "plan" },
        { id: "archive/drift-report.mdx", role: "report", derivedFrom: "plans/drift.mdx" },
        { id: "plans/drift-followup.mdx", role: "followup", derivedFrom: "archive/drift-report.mdx" },
        { id: "plans/gone.mdx", role: "reference" },
      ], {
        aliases: ["Stale check"],
        oneLine: "Find what a page change made untrue, starting at ⟦plans/drift.mdx⟧.",
        next: "Land the follow-up ⟦plans/drift-followup.mdx⟧.",
        why: "The plan, its report and the follow-up grew from one another; ⟦plans/gone.mdx⟧ was removed.",
        related: [{ id: "visuals", why: "Shares the reader." }],
        daily: driftDaily(runAtMs),
      }),
      e("drift-ui", "Drift UI", [{ id: "plans/drift-ui.mdx", role: "plan" }], { parent: "drift", state: "proposed" }),
      e("grocery", "Grocery bot", [{ id: "plans/grocery.mdx", role: "plan" }], { state: "cooling" }),
      e("visuals", "Visual components", [{ id: "plans/visuals.mdx", role: "plan" }], { state: "shipped" }),
      // Every page gone, and a related effort a later run dropped.
      e("ghost", "Ghost work", [{ id: "plans/gone.mdx", role: "plan" }], { state: "quiet", related: [{ id: "vanished", why: "" }] }),
    ],
    loose: [],
  });
}

let server: ChildProcess | undefined;
const roots: Record<string, string> = {};

test.beforeAll(async () => {
  const now = Date.now();
  for (const name of [WIKI, NOMAP, LIVE]) {
    const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-${name}-`));
    roots[name] = root;
    await mkdir(path.join(root, "plans"), { recursive: true });
    await mkdir(path.join(root, "archive"), { recursive: true });
    await writeFile(path.join(root, "plans/drift.mdx"), md("Drift plan", "in-flight"), "utf8");
    await writeFile(path.join(root, "archive/drift-report.mdx"), md("Drift report"), "utf8");
    await writeFile(path.join(root, "plans/drift-followup.mdx"), md("Drift follow-up", "proposed"), "utf8");
    await writeFile(path.join(root, "plans/drift-ui.mdx"), md("Drift UI plan"), "utf8");
    await writeFile(path.join(root, "plans/grocery.mdx"), md("Grocery plan"), "utf8");
    await writeFile(path.join(root, "plans/visuals.mdx"), md("Visuals plan", "shipped"), "utf8");
  }
  wikiRunAt = now - 2 * HOUR;
  await writeFile(path.join(roots[WIKI]!, ".work-map.json"), mapJson(wikiRunAt), "utf8");
  // A project facet on the map wiki, for the facet-change test: two pages name
  // the project in frontmatter.
  await writeFile(path.join(roots[WIKI]!, ".wiki-reader.json"), JSON.stringify({ project: { frontmatter: ["project"] } }), "utf8");
  for (const [rel, title] of [["plans/drift-ui.mdx", "Drift UI plan"], ["plans/grocery.mdx", "Grocery plan"]] as const) {
    await writeFile(path.join(roots[WIKI]!, rel), `---\ntitle: ${title}\nproject: reader\n---\n\nBody of ${title}.\n`, "utf8");
  }
  await writeFile(path.join(roots[LIVE]!, ".work-map.json"), mapJson(now - 2 * HOUR, LIVE), "utf8");
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
      WIKI_EXTRA: [WIKI, NOMAP, LIVE].map((n) => `${n}=${roots[n]}`).join(","),
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${NOMAP}`);
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
  for (const r of Object.values(roots)) await rm(r, { recursive: true, force: true });
});

const effortParam = (page: Page) => new URL(page.url()).searchParams.get("effort");

async function expectDriftPage(page: Page): Promise<void> {
  const ef = page.locator("#wikiEffortPage");
  await expect(ef).toHaveAttribute("data-effort", "drift");
  await expect(ef.locator("h1")).toHaveText("Drift check");
  await expect(ef.locator(".wiki-ef-tldr")).toContainText("Find what a page change made untrue");
  await expect(ef.locator(".wiki-ef-tldr")).toContainText("Next: Land the follow-up Drift follow-up.");
  // Lineage order, each page with its role; a gone page is counted, not listed.
  await expect(ef.locator(".wiki-ef-plink")).toHaveText(["Drift plan", "Drift report", "Drift follow-up"]);
  await expect(ef.locator(".wiki-ef-page").nth(2)).toHaveAttribute("data-depth", "2");
  await expect(ef.locator(".wiki-ef-page").first().locator(".wiki-ef-role")).toHaveText("plan");
  await expect(ef.locator(".wiki-ef-page").first().locator(".wiki-status")).toHaveText("in-flight");
  await expect(ef.locator(".wiki-ef-metarow")).toContainText("3 pages (1 no longer in the wiki)");
  await expect(ef.locator(".wiki-ef-crumbs")).toContainText("Efforts");
  await expect(ef.locator(".wiki-ef-crumb-theme")).toHaveText("Reader");
  await expect(ef.locator(".wiki-ef-need")).toHaveCount(1);
  const sessionsSince = wikiRunAt - 8 * DAY;
  await expect(ef.locator(".wiki-ef-day")).toHaveCount(activityStrip(driftDaily(wikiRunAt), wikiRunAt, sessionsSince).length);
  const from = sessionsFromDay(driftDaily(wikiRunAt), wikiRunAt, sessionsSince);
  await expect(ef.locator(".wiki-ef-strip-sum")).toHaveText(`6 commits on 4 days · 3 sessions since ${from}`);
  await expect(ef.locator(".wiki-ef-run:not(.old) .wiki-ef-day").first()).toHaveAttribute("title", new RegExp(`^${from}:`));
  await expect(ef.locator(".wiki-ef-sess")).toHaveCount(2);
  await expect(ef).not.toContainText("0 sessions");
  const conn = page.locator("#connBody");
  await expect(conn).toContainText("Related efforts (1)");
  await expect(conn.locator('[data-effort-link="visuals"]')).toBeVisible();
  await expect(conn).toContainText("Also in Reader (1)");
  await expect(conn.locator('[data-effort-link="grocery"]')).toBeVisible();
}

test("an effort opens from the Your work card; Back, Forward, reload and a pasted URL keep it", async ({ page }) => {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
  const card = page.locator("#wikiWorkCard");
  await expect(card).toBeVisible();
  const link = card.locator('a.wiki-wm-effort-name[data-effort-link="drift"]');
  await expect(link).toHaveText("Drift check");
  await link.click();
  await expectDriftPage(page);
  expect(effortParam(page)).toBe("drift");
  expect(new URL(page.url()).searchParams.get("wiki")).toBe(WIKI);
  await expect(page.locator(".wiki-start")).toHaveCount(0);

  await page.goBack();
  await expect(page.locator(".wiki-start")).toBeVisible();
  await expect(page.locator("#wikiWorkCard")).toBeVisible();
  await expect(page.locator("#wikiEffortPage")).toHaveCount(0);
  expect(effortParam(page)).toBeNull();

  await page.goForward();
  await expectDriftPage(page);

  await page.reload();
  await expectDriftPage(page);

  const fresh = await page.context().newPage();
  await fresh.goto(`${BASE}/wiki?wiki=${WIKI}&effort=drift`);
  await expectDriftPage(fresh);
  await fresh.close();
});

test("sub-efforts and page links navigate in the reader", async ({ page }) => {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=drift`);
  const ef = page.locator("#wikiEffortPage");
  await ef.locator('.wiki-ef-subs [data-effort-link="drift-ui"]').click();
  await expect(ef).toHaveAttribute("data-effort", "drift-ui");
  expect(effortParam(page)).toBe("drift-ui");
  // The child's crumbs link back to its parent.
  await ef.locator('.wiki-ef-crumbs [data-effort-link="drift"]').click();
  await expect(ef).toHaveAttribute("data-effort", "drift");
  // A related effort in the Connections pane.
  await page.locator('#connBody [data-effort-link="visuals"]').click();
  await expect(ef).toHaveAttribute("data-effort", "visuals");
  await page.goBack();
  await expect(ef).toHaveAttribute("data-effort", "drift");
  // A page link opens the page.
  await ef.locator('.wiki-ef-plink[data-relpath="archive/drift-report.mdx"]').click();
  await expect(page.locator("#wikiEffortPage")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("relPath")).toBe("archive/drift-report.mdx");
  await page.goBack();
  await expect(page.locator("#wikiEffortPage")).toHaveAttribute("data-effort", "drift");
  // The Efforts crumb returns to the start view.
  await page.locator("#wikiEffortPage [data-effort-home]").first().click();
  await expect(page.locator("#wikiWorkCard")).toBeVisible();
  expect(effortParam(page)).toBeNull();
});

test("a project chip clicked on the effort page rewrites its links to carry the new facet", async ({ page }) => {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=drift`);
  const ef = page.locator("#wikiEffortPage");
  await expect(ef.locator("h1")).toHaveText("Drift check");
  const home = ef.locator("[data-effort-home]").first();
  const sibling = page.locator('#connBody [data-effort-link="grocery"]');
  const sub = ef.locator('.wiki-ef-subs [data-effort-link="drift-ui"]');
  const wikiCrumb = ef.locator(".wiki-ef-crumbs .wiki-bc-wiki");
  await expect(home).not.toHaveAttribute("href", /project=/);
  await page.locator("#wikiFiltersBtn").click();
  await page.locator('#projectChips [data-project="reader"]').click();
  await expect.poll(() => new URL(page.url()).searchParams.get("project")).toBe("reader");
  await expect(ef).toHaveAttribute("data-effort", "drift");
  for (const link of [home, sibling, sub, wikiCrumb]) await expect(link).toHaveAttribute("href", /[?&]project=reader(&|$)/);
  // Clearing the chip takes the facet off again.
  await page.locator('#projectChips [data-project=""]').click();
  for (const link of [home, sibling, sub, wikiCrumb]) await expect(link).not.toHaveAttribute("href", /project=/);
});

/** Click the `reader` project chip and wait for the URL to carry it. */
async function pickReaderChip(page: Page): Promise<void> {
  await page.locator("#wikiFiltersBtn").click();
  await page.locator('#projectChips [data-project="reader"]').click();
  await expect.poll(() => new URL(page.url()).searchParams.get("project")).toBe("reader");
}

test("a project chip clicked while the map GET is in flight: one GET, and the error pane's crumbs carry the facet", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", async (route) => {
    gets++;
    await held;
    await route.fulfill({ status: 500, json: { error: "down" } });
  });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=drift`);
  await expect(page.locator('#wikiEffortPage[data-effort-status="loading"]')).toBeVisible();
  await pickReaderChip(page);
  release();
  const ef = page.locator('#wikiEffortPage[data-effort-status="error"]');
  await expect(ef).toBeVisible();
  for (const sel of ["[data-effort-home]", ".wiki-bc-wiki"]) await expect.soft(ef.locator(sel)).toHaveAttribute("href", /[?&]project=reader(&|$)/);
  await page.waitForTimeout(300);
  expect.soft(gets).toBe(1);
});

test("a project chip clicked on the error pane rewrites both crumbs", async ({ page }) => {
  await page.route("**/api/wiki/work-map?*", (route) => route.fulfill({ status: 500, json: { error: "down" } }));
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=drift`);
  const ef = page.locator('#wikiEffortPage[data-effort-status="error"]');
  await expect(ef).toBeVisible();
  await pickReaderChip(page);
  for (const sel of ["[data-effort-home]", ".wiki-bc-wiki"]) await expect(ef.locator(sel)).toHaveAttribute("href", /[?&]project=reader(&|$)/);
});

test("an unknown id says it is no longer in the map and links the alias match", async ({ page }) => {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=stale-check`);
  const ef = page.locator("#wikiEffortPage");
  await expect(ef.locator(".wiki-ef-gone")).toContainText("no longer in the map");
  await ef.locator('[data-effort-link="drift"]').click();
  await expectDriftPage(page);

  await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=never-was`);
  await expect(ef.locator(".wiki-ef-gone")).toContainText("no longer in the map");
  await expect(ef.locator("[data-effort-link]")).toHaveCount(0);
  await ef.locator(".wiki-ef-gone-home [data-effort-home]").click();
  await expect(page.locator("#wikiWorkCard")).toBeVisible();
});

test("an empty or blank ?effort= opens the start view and drops the param in place", async ({ page }) => {
  for (const blank of ["", "%20"]) {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    const before = await page.evaluate(() => history.length);
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=${blank}`);
    await expect(page.locator(".wiki-start")).toBeVisible();
    await expect(page.locator("#wikiEffortPage")).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("effort")).toBe(false);
    expect(new URL(page.url()).searchParams.get("wiki")).toBe(WIKI);
    // One entry for the goto, none for the clean-up.
    expect(await page.evaluate(() => history.length)).toBe(before + 1);
  }
  // Reached by popstate: the same, and the entry is replaced in place, so the
  // one after it is still there for Forward.
  await page.evaluate((w) => {
    history.pushState({}, "", `/wiki?wiki=${w}&effort=`);
    history.pushState({ mark: "after" }, "", `/wiki?wiki=${w}`);
  }, WIKI);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.has("effort")).toBe(false);
  await expect(page.locator(".wiki-start")).toBeVisible();
  await expect(page.locator("#wikiEffortPage")).toHaveCount(0);
  await page.goForward();
  await expect.poll(() => page.evaluate(() => (history.state as { mark?: string } | null)?.mark)).toBe("after");
});

test("a case variant of an effort id opens the effort and corrects the URL in place", async ({ page }) => {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
  const before = await page.evaluate(() => history.length);
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=Drift`);
  await expectDriftPage(page);
  expect(effortParam(page)).toBe("drift");
  // One entry for the goto, none for the correction.
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
});

test("Back from a page to its effort leaves no rail row active", async ({ page }) => {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=drift`);
  await expectDriftPage(page);
  await page.locator('#wikiEffortPage .wiki-ef-plink[data-relpath="archive/drift-report.mdx"]').click();
  await expect(page.locator("#articleWrap")).toContainText("Body of Drift report.");
  await expect(page.locator('#wikiList .wiki-list-item.active[data-relpath="archive/drift-report.mdx"]').first()).toBeVisible();
  await page.goBack();
  await expectDriftPage(page);
  await expect(page.locator("#wikiList .wiki-list-item.active")).toHaveCount(0);
});

test("a wiki with no map says so instead of a blank pane", async ({ page }) => {
  await page.goto(`${BASE}/wiki?wiki=${NOMAP}&effort=drift`);
  await expect(page.locator("#wikiEffortPage .wiki-ef-status")).toHaveText("This wiki has no work map, so it has no effort pages.");
});

test("a slow map GET shows the loading state first, then the effort", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/work-map?*", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=drift`);
  await expect(page.locator('#wikiEffortPage[data-effort-status="loading"]')).toBeVisible();
  release();
  await expectDriftPage(page);
});

/** The strip's geometry at a viewport width: every session dot is painted
 *  (the topmost element at its centre), no run label is clipped, and the strip
 *  itself scrolls sideways or not. */
async function stripGeometry(page: Page) {
  return page.locator("#wikiEffortPage .wiki-ef-strip").evaluate((strip) => {
    // Scroll the page to the strip, never the strip itself: a dot's own
    // scrollIntoView scrolls the clipping strip to it and hides the clip.
    strip.scrollIntoView({ block: "center" });
    const dots = Array.from(strip.querySelectorAll<HTMLElement>(".wiki-ef-sess")).map((d) => {
      // Where the strip scrolls, bring the dot's CELL into view sideways.
      d.parentElement!.scrollIntoView({ block: "nearest", inline: "nearest" });
      const box = strip.getBoundingClientRect();
      const r = d.getBoundingClientRect();
      const inside = r.top >= box.top && r.bottom <= box.bottom && r.left >= box.left && r.right <= box.right;
      return inside && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === d;
    });
    const clippedLabels = Array.from(strip.querySelectorAll<HTMLElement>(".wiki-ef-run-label"))
      .filter((l) => l.scrollWidth > l.clientWidth)
      .map((l) => `${l.textContent} ${l.scrollWidth}>${l.clientWidth}`);
    return { dots, clippedLabels, scrolls: strip.scrollWidth > strip.clientWidth, tabindex: strip.getAttribute("tabindex"), name: strip.getAttribute("aria-label") };
  });
}

test("the activity strip paints its session dots, clips no label, and fits at desktop widths", async ({ page }) => {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=drift`);
  await expect(page.locator("#wikiEffortPage .wiki-ef-strip")).toBeVisible();
  for (const width of [1024, 1280, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    const g = await stripGeometry(page);
    expect(g.dots.length, `${width}px: session dots`).toBeGreaterThan(0);
    expect(g.dots, `${width}px: each dot is painted`).toEqual(g.dots.map(() => true));
    expect(g.clippedLabels, `${width}px: clipped run labels`).toEqual([]);
    expect(g.scrolls, `${width}px: the strip scrolls sideways`).toBe(false);
  }
  // A narrow article (600 px viewport) scrolls; the scroll region is then a
  // named tab stop. (Below ~600 px the reader has no article column at all.)
  await page.setViewportSize({ width: 600, height: 800 });
  const narrow = await stripGeometry(page);
  expect(narrow.scrolls).toBe(true);
  expect(narrow.dots).toEqual(narrow.dots.map(() => true));
  expect(narrow.clippedLabels).toEqual([]);
  expect(narrow.tabindex).toBe("0");
  expect(narrow.name).toMatch(/\. Days before \d{4}-\d\d-\d\d count commits only\.$/);
});

// ── The effort page against a background listing refresh ──────────────
// Each test starts the LIVE wiki from the base map, then rewrites the map
// and/or adds a page on disk and forces a listing refetch (throttle passed,
// tab focus), the way an organize run or a page edit lands under a reader.

let liveN = 0;
async function writeLiveMap(runAtMs: number, driftName = "Drift check"): Promise<void> {
  await writeFile(path.join(roots[LIVE]!, ".work-map.json"), mapJson(runAtMs, LIVE, driftName), "utf8");
}
async function addLivePage(): Promise<string> {
  const title = `Live page ${++liveN}`;
  await writeFile(path.join(roots[LIVE]!, `live-${liveN}.md`), md(title), "utf8");
  return title;
}
/** Pass the client throttle and focus the tab; resolves once the listing GET answered. */
async function refetchListing(page: Page): Promise<void> {
  const answered = page.waitForResponse((r) => r.url().includes("/api/wiki/pages"));
  await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await answered;
}
async function openLiveDrift(page: Page, name = "Drift check"): Promise<void> {
  await writeLiveMap(Date.now() - 2 * HOUR);
  await page.clock.install();
  await page.goto(`${BASE}/wiki?wiki=${LIVE}&effort=drift`);
  await expect(page.locator("#wikiEffortPage h1")).toHaveText(name);
}

test("Back to an effort page after a run landed under an open page shows the new run", async ({ page }) => {
  await openLiveDrift(page);
  await page.locator('#wikiEffortPage .wiki-ef-plink[data-relpath="archive/drift-report.mdx"]').click();
  await expect(page.locator("#wikiEffortPage")).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("relPath")).toBe("archive/drift-report.mdx");
  await expect(page.locator("#articleWrap")).toContainText("Body of Drift report.");
  // The run lands while the page is open: the listing is stashed, not adopted.
  await writeLiveMap(Date.now() - 1 * HOUR, "Drift check v2");
  await refetchListing(page);
  await page.goBack();
  await expect(page.locator("#wikiEffortPage h1")).toHaveText("Drift check v2");
});

test("an adopt that changes nothing on the effort page keeps its DOM and the focus on a page link", async ({ page }) => {
  await openLiveDrift(page);
  const link = page.locator("#wikiEffortPage .wiki-ef-plink").first();
  await link.focus();
  await page.evaluate(() => document.querySelector("#wikiEffortPage")!.setAttribute("data-before-adopt", ""));
  const title = await addLivePage();
  await refetchListing(page);
  // The adopt landed (the list carries the new page) …
  await expect(page.locator("#wikiList")).toContainText(title);
  await page.waitForTimeout(300);
  // … and wrote nothing over the effort page.
  await expect(page.locator("#wikiEffortPage[data-before-adopt]")).toHaveCount(1);
  await expect(link).toBeFocused();
});

test("an adopt that brings a new run repaints the effort page and keeps focus on the same page link", async ({ page }) => {
  await openLiveDrift(page);
  const link = page.locator('#wikiEffortPage .wiki-ef-plink[data-relpath="archive/drift-report.mdx"]');
  await link.focus();
  await writeLiveMap(Date.now() - 1 * HOUR, "Drift check v2");
  await refetchListing(page);
  await expect(page.locator("#wikiEffortPage h1")).toHaveText("Drift check v2");
  await expect(link).toBeFocused();
});

for (const [what, sel] of [["the activity strip", ".wiki-ef-strip"], ["the wiki crumb", ".wiki-ef-crumbs .wiki-bc-wiki"]] as const) {
  test(`an adopt that brings a new run keeps focus on ${what}`, async ({ page }) => {
    await openLiveDrift(page);
    await page.locator(`#wikiEffortPage ${sel}`).focus();
    await writeLiveMap(Date.now() - 1 * HOUR, "Drift check v2");
    await refetchListing(page);
    await expect(page.locator("#wikiEffortPage h1")).toHaveText("Drift check v2");
    expect(await page.evaluate((s) => document.activeElement === document.querySelector(`#wikiEffortPage ${s}`), sel)).toBe(true);
  });
}

test("a failed map GET during a background re-join keeps the effort on screen", async ({ page }) => {
  await openLiveDrift(page);
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", (route) => {
    gets++;
    return route.fulfill({ status: 503, json: { error: "down" } });
  });
  await writeLiveMap(Date.now() - 1 * HOUR, "Drift check v2");
  await refetchListing(page);
  await expect.poll(() => gets).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await expect(page.locator("#wikiEffortPage h1")).toHaveText("Drift check");
  await expect(page.locator("#wikiEffortRetry")).toHaveCount(0);
});

test("scrolling during a slow background map GET is kept when the new run paints", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await openLiveDrift(page);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", async (route) => {
    gets++;
    await held;
    await route.continue();
  });
  await writeLiveMap(Date.now() - 1 * HOUR, "Drift check v2");
  await refetchListing(page);
  await expect.poll(() => gets).toBeGreaterThan(0);
  const wrap = page.locator("#articleWrap");
  expect(await wrap.evaluate((w) => w.scrollHeight - w.clientHeight)).toBeGreaterThan(150);
  await wrap.evaluate((w) => (w.scrollTop = 120));
  release();
  await expect(page.locator("#wikiEffortPage h1")).toHaveText("Drift check v2");
  expect(await wrap.evaluate((w) => w.scrollTop)).toBe(120);
});

const THEMES: { label: string; stored: string | null; scheme: "light" | "dark" }[] = [
  { label: "Light", stored: "light", scheme: "dark" },
  { label: "Dark", stored: "dark", scheme: "light" },
  { label: "Reading mode", stored: "reading", scheme: "light" },
  { label: "Light reading mode", stored: "paper-light", scheme: "dark" },
  { label: "System light", stored: null, scheme: "light" },
  { label: "System dark", stored: null, scheme: "dark" },
];

async function sweep(page: Page, selector: string, label: string): Promise<{ low: string[]; min: number; classes: string[] }> {
  const measure = await paintedMeasure(page);
  const { what, ratios, classes } = await page.locator(selector).evaluate((root, measure) => {
    const what: string[] = [];
    const ratios: number[] = [];
    const classes: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      classes.push(...Array.from(el.classList));
      if (!Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())) continue;
      what.push(`${el.tagName.toLowerCase()}.${Array.from(el.classList).join(".")} "${el.textContent!.trim().slice(0, 30)}"`);
      ratios.push(measure(el, false, false));
    }
    return { what, ratios, classes };
  }, measure);
  expect(what.length, `${label}: nothing to measure`).toBeGreaterThan(0);
  return { low: ratios.flatMap((r, i) => (r < 4.5 ? [`${label}: ${what[i]} ${r.toFixed(2)}`] : [])), min: Math.min(...ratios), classes };
}

/** The `.wiki-ef-*` classes the stylesheet styles: each must be painted in a
 *  swept state, or the sweep never measured it. */
async function styledEffortClasses(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        const sel = (rule as CSSStyleRule).selectorText;
        if (sel) for (const m of sel.matchAll(/\.(wiki-ef-[\w-]+)/g)) out.add(m[1]!);
      }
    }
    return [...out].sort();
  });
}

/** Classes that paint no text of their own, or only in a state this sweep
 *  reaches through another test. */
const UNSWEPT = new Set(["wiki-ef-day", "wiki-ef-cells", "wiki-ef-run", "wiki-ef-strip"]);

for (const theme of THEMES) {
  test(`the effort page is legible in the ${theme.label} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme.scheme });
    await page.addInitScript((v) => {
      if (v === null) localStorage.removeItem("muninn-theme");
      else localStorage.setItem("muninn-theme", v);
    }, theme.stored);
    const low: string[] = [];
    const seen = new Set<string>();
    const mins: string[] = [];
    const run = async (label: string) => {
      for (const [sel, part] of [["#articleWrap", "article"], ["#connBody", "connections"]] as const) {
        const r = await sweep(page, sel, `${label} ${part}`);
        low.push(...r.low);
        r.classes.forEach((c) => seen.add(c));
        mins.push(`${label} ${part} ${r.min.toFixed(2)}`);
      }
    };
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=drift`);
    await expectDriftPage(page);
    await run("effort");
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=ghost`);
    await expect(page.locator(".wiki-ef-conn-gone")).toHaveText("vanished");
    await expect(page.locator("#wikiEffortPage .wiki-ef-note")).toContainText("None of this effort’s pages");
    await run("no pages");
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=stale-check`);
    await expect(page.locator(".wiki-ef-gone")).toBeVisible();
    await run("dropped");
    await page.route("**/api/wiki/work-map?*", (route) => route.fulfill({ status: 503, json: { error: "down" } }));
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=drift`);
    await expect(page.locator("#wikiEffortRetry")).toBeVisible();
    await run("error");
    await page.goto(`${BASE}/wiki?wiki=${NOMAP}&effort=drift`);
    await expect(page.locator(".wiki-ef-status")).toBeVisible();
    await run("no map");
    expect((await styledEffortClasses(page)).filter((c) => !seen.has(c) && !UNSWEPT.has(c))).toEqual([]);
    console.log(`contrast min ${theme.label}: ${mins.join(", ")}`);
    expect(low).toEqual([]);
  });
}
