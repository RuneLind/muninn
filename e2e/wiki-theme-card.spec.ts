/**
 * What you're following (plan `muninn-wiki-theme-map`, P2): the start view's
 * card and the rail's folds over a `themes` map.
 *
 * The rendering rules are unit-tested (`wiki-work-card.test.ts`,
 * `wiki-effort-rail.test.ts`); what only a real page holds:
 *  1. A wiki whose `.work-map.json` is a themes map shows "What you're
 *     following" in What's new's slot, and asks for no digest.
 *  2. The card: Worth a look with a drift item's runner count, a Connected row
 *     `A ↔ B: why`, the four lanes in order (Fading closed) with a weekly strip
 *     per theme, the Life section after the AI lanes, the coverage line, and ✓
 *     dismissing an item through a reload.
 *  3. The rail folds Activity by theme: a `rising` and a `new` theme start
 *     open, a `steady` and a `fading` one start closed.
 *  4. Focus on a theme name, in its lane or in Connected (the same
 *     `data-effort-link` twice), stays on that link through a ↻ poll repaint.
 *  5. The rail's fold says theme and Worth a look, not effort and Needs you.
 *
 * One muninn on its own port over one temp wiki whose `.wiki-reader.json`
 * declares `workMap: {"kind": "themes"}` and whose map is seeded, not run.
 * `SCHEDULER_ENABLED=false` keeps the loop off. Synthetic names only; no model
 * calls; the only writes are the reader's localStorage.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { assertPortFree, waitForOwnServer } from "./own-server.ts";

const PORT = e2ePort("wiki-theme-card");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WIKI = "e2e-theme-card";
const HOUR = 3_600_000;
const NOW = Date.now();

/** relPath, title, hours since its last change. */
const PAGES: [string, string, number][] = [
  ["sources/rise-one.mdx", "Rise source one", 1],
  ["sources/rise-two.mdx", "Rise source two", 30],
  ["sources/new-one.mdx", "New source one", 2],
  ["sources/steady-one.mdx", "Steady source one", 3],
  ["sources/fade-one.mdx", "Fade source one", 4],
  ["life/sources/life-one.mdx", "Life source one", 5],
  ["concepts/Hub Kite.md", "Hub Kite", 24 * 40],
  ["concepts/Hub Lark.md", "Hub Lark", 24 * 40],
];

const week = (w: string, start: string, count: number, partial = false) => ({ week: w, start, count, ...(partial ? { partial } : {}) });
const WEEKLY = [week("2026-W41", "2026-10-05", 1, true), week("2026-W42", "2026-10-12", 0), week("2026-W43", "2026-10-19", 2), week("2026-W44", "2026-10-26", 3)];

function theme(id: string, name: string, state: string, pages: string[], extra: Record<string, unknown> = {}) {
  return {
    id, name, oneLine: `About ${name}.`, state, domain: "ai",
    pages: pages.map((p) => ({ id: p, role: "source" })),
    hubs: ["concepts/Hub Kite.md"], readFirst: [pages[0]], takeaway: "", disagreement: "", confidence: 0.8,
    related: [], weekly: WEEKLY, trend: { recent: 3, earlier: 1 }, ...extra,
  };
}

function mapJson(runAtMs: number): string {
  return JSON.stringify({
    version: 1, kind: "themes", wiki: WIKI, runAtMs, model: "test-model",
    coverage: { activeSources: 6, hubs: 2, driftHubs: 1, placed: 6, digestChars: 1000, windowDays: 28, warnings: [] },
    summary: "Mostly ⟦sources/rise-one.mdx⟧ this month.",
    needsYou: [
      { title: "Hub Kite is behind", kind: "drift", why: "Seven sources arrived since its update.", action: "Refresh Hub Kite.", pages: ["sources/rise-one.mdx"], effort: "rise", hubs: ["concepts/Hub Kite.md"], count: 7 },
      { title: "Nothing on fade's cost", kind: "gap", why: "", action: "", pages: ["sources/fade-one.mdx"], effort: "fade", hubs: [], count: 1 },
    ],
    themes: [{ name: "AI & tech", efforts: ["rise", "fresh", "steady", "fade"] }, { name: "Life", efforts: ["life"] }],
    efforts: [
      theme("rise", "Rising kites", "rising", ["sources/rise-one.mdx", "sources/rise-two.mdx"], { related: [{ id: "steady", why: "Both fly on Hub Kite." }] }),
      theme("fresh", "Fresh larks", "new", ["sources/new-one.mdx"], { hubs: ["concepts/Hub Lark.md"] }),
      theme("steady", "Steady winds", "steady", ["sources/steady-one.mdx"], { related: [{ id: "rise", why: "The other end." }] }),
      theme("fade", "Fading tides", "fading", ["sources/fade-one.mdx"]),
      theme("life", "Morning walks", "steady", ["life/sources/life-one.mdx"], { domain: "life" }),
    ],
    retired: [], loose: [],
  });
}

let root = "";
let server: ChildProcess | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-${WIKI}-`));
  await writeFile(
    path.join(root, ".wiki-reader.json"),
    JSON.stringify({ workMap: { kind: "themes" }, activity: { agePenalty: 0, hubPenalty: 0, planBoost: 0, rows: 12 } }),
    "utf8",
  );
  for (const [rel, title, hours] of PAGES) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, ["---", `title: ${title}`, "type: source", "created: 2025-01-01", "---", "", `Body of ${title}.`, ""].join("\n"), "utf8");
    const stamp = new Date(NOW - hours * HOUR);
    await utimes(abs, stamp, stamp);
  }
  await writeFile(path.join(root, ".work-map.json"), mapJson(NOW - HOUR / 2), "utf8");
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
      WIKI_EXTRA: `${WIKI}=${root}`,
    },
    stdio: "ignore",
  });
  await waitForOwnServer(server, `${BASE}/api/wiki/pages?wiki=${WIKI}`);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
});

async function openStart(page: Page): Promise<string[]> {
  const digests: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/wiki/digest") digests.push(r.url());
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await expect(page.locator(".wiki-start")).toBeVisible();
  return digests;
}

test("the start view shows What you're following over a themes map, not What's new", async ({ page }) => {
  const digests = await openStart(page);
  const card = page.locator("#wikiWorkCard");
  await expect(card).toBeVisible();
  await expect(card.locator(".wiki-wn-title")).toHaveText("What you’re following");
  await expect(page.locator("#wikiWhatsNew")).toBeHidden();

  // Worth a look: the drift item carries the runner's count and its hub chip.
  await expect(card.locator(".wiki-wm-section-title").first()).toHaveText("Worth a look");
  const drift = card.locator('.wiki-wm-need[data-wm-need="0"]');
  await expect(drift.locator(".wiki-wm-need-count")).toHaveText("7 new since update");
  await expect(drift.locator('.wiki-wm-hub a[data-relpath="concepts/Hub Kite.md"]')).toHaveText("Hub Kite");

  // Connected: one row for the pair stored on both ends, A ↔ B: why.
  const conns = card.locator(".wiki-wm-conn");
  await expect(conns).toHaveCount(1);
  await expect(conns.first()).toHaveText("Rising kites ↔ Steady winds: Both fly on Hub Kite.");

  // Lanes in order, Fading closed, then Life.
  const lanes = await card.locator("details.wiki-wm-lane").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-wm-lane")}${(e as HTMLDetailsElement).open ? "+" : ""}`));
  expect(lanes).toEqual(["new+", "rising+", "steady+", "fading", "life+"]);
  await expect(card.locator('[data-wm-lane="life"] .wiki-wm-lane-title')).toContainText("Life");
  await expect(card.locator('[data-wm-lane="life"] .wiki-wm-theme[data-effort-id="life"]')).toHaveCount(1);
  // A weekly strip per theme, four bars each, the partial week marked.
  await expect(card.locator(".wiki-wm-theme")).toHaveCount(5);
  await expect(card.locator(".wiki-wm-theme .wiki-wm-weeks")).toHaveCount(5);
  const rise = card.locator('.wiki-wm-theme[data-effort-id="rise"]');
  await expect(rise.locator(".wiki-wm-week")).toHaveCount(4);
  await expect(rise.locator(".wiki-wm-slot.partial")).toHaveCount(1);
  // «this week so far» only while W44 holds the map's run (NOW).
  await expect(rise.locator(".wiki-wm-weeks")).toHaveAttribute("aria-label", /^6 sources over the last 4 weeks(, this week so far)?, 1 week may miss days$/);
  // The partial week (W41) is framed; the full empty week (W42) is not.
  const outline = (i: number) => rise.locator(".wiki-wm-slot").nth(i).evaluate((el) => { const cs = getComputedStyle(el); return `${cs.outlineStyle} ${cs.outlineWidth}`; });
  expect(await outline(0)).toBe("dotted 1px");
  expect(await outline(1)).toMatch(/^none /);
  // The bars have height: a busy week is taller than an empty one.
  const heights = await rise.locator(".wiki-wm-week").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  expect(heights[3]!).toBeGreaterThan(heights[1]!);

  await expect(card.locator(".wiki-wm-coverage")).toHaveText("6 sources in 28 days · 2 hubs");

  // ✓ dismisses an item, and the dismissal lasts through a reload.
  await drift.locator(".wiki-wm-done").click();
  await expect(card.locator(".wiki-wm-need-count", { hasText: "7 new since update" })).toHaveCount(0);
  await expect(card.locator("#wikiWorkMapRestore")).toHaveText("1 done · show");
  await page.reload();
  await expect(page.locator("#wikiWorkCard .wiki-wn-title")).toHaveText("What you’re following");
  await expect(page.locator("#wikiWorkCard #wikiWorkMapRestore")).toHaveText("1 done · show");

  await page.waitForTimeout(500);
  expect(digests).toEqual([]);
});

test("focus on a theme name in a lane, or in Connected, stays on that same link through a ↻ poll repaint", async ({ page }) => {
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", async (route) => {
    gets++;
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - 60 * 60_000 } });
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } }));
  await page.clock.install();
  await openStart(page);
  const card = page.locator("#wikiWorkCard");
  await card.locator("#wikiWorkMapRefresh").click();
  await expect(page.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
  const repaint = async () => {
    await page.evaluate(() => document.querySelector("#wikiWorkCard .wiki-wm-coverage")!.setAttribute("data-before-repaint", ""));
    const n = gets;
    await expect
      .poll(async () => {
        await page.clock.runFor(1_000);
        return gets;
      })
      .toBeGreaterThan(n);
    await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
  };
  // "Steady winds" is a link twice: in the Connected row (first) and in its lane.
  const inLane = card.locator('.wiki-wm-theme[data-effort-id="steady"] [data-effort-link="steady"]');
  const inConn = card.locator('.wiki-wm-conn [data-effort-link="steady"]');
  await expect(inConn).toHaveCount(1);
  await inLane.focus();
  await repaint();
  await expect(inLane).toBeFocused();
  await inConn.focus();
  await repaint();
  await expect(inConn).toBeFocused();
});

test("the rail speaks of themes on a themes map", async ({ page }) => {
  await openStart(page);
  const fold = page.locator('#wikiList .wiki-list-group.effort[data-effort="rise"]');
  await expect(fold.locator(".wiki-effort-name")).toHaveAttribute("title", "Open the theme page: Rising kites");
  await expect(fold.locator(".wiki-effort-moves")).toHaveAttribute("title", "1 item in Worth a look");
  const intro = page.locator('#wikiList .wiki-effort-intro[data-effort="rise"]');
  await expect(intro.locator(".wiki-effort-open")).toHaveText("Open theme →");
  const member = page.locator('#wikiList .wiki-list-item[data-relpath="sources/rise-one.mdx"]');
  await expect(member).toHaveAttribute("title", /In the Rising kites theme/);
  await expect(member.locator(".wiki-effort-role")).toHaveAttribute("title", "Role in the theme: source");
});

test("the rail folds Activity by theme: rising and new start open, steady and fading closed", async ({ page }) => {
  await openStart(page);
  const fold = (id: string) => page.locator(`#wikiList .wiki-list-group.effort[data-effort="${id}"]`);
  await expect(fold("rise")).toBeVisible();
  await expect(fold("rise").locator(".wiki-effort-fold")).toHaveAttribute("aria-expanded", "true");
  await expect(fold("fresh").locator(".wiki-effort-fold")).toHaveAttribute("aria-expanded", "true");
  await expect(fold("steady").locator(".wiki-effort-fold")).toHaveAttribute("aria-expanded", "false");
  await expect(fold("fade").locator(".wiki-effort-fold")).toHaveAttribute("aria-expanded", "false");
  // An open fold draws its sources; a closed one draws none.
  await expect(page.locator('#wikiList .wiki-list-item[data-relpath="sources/rise-one.mdx"]')).toHaveClass(/member/);
  await expect(page.locator('#wikiList .wiki-list-item[data-relpath="sources/steady-one.mdx"]')).toHaveCount(0);
  // The fold's ✋ counts the theme's Worth-a-look item.
  await expect(fold("rise").locator(".wiki-effort-meta")).toContainText("rising");
  await expect(fold("rise").locator(".wiki-effort-meta")).toContainText("✋ 1");
});
