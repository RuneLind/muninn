/**
 * Recently opened · Pinned · the Jira-key jump, in the /wiki reader's page rail.
 *
 * What the unit tests cannot reach, and the reason this file exists:
 *
 *  1. **The chain that records a recent.** `pushRecent` is a pure list splice;
 *     whether the reader ever calls it depends on a page load resolving a
 *     relPath, `recordRecent` reaching localStorage, and `renderList` repainting
 *     afterwards. Every unit test in that chain is green with the chain broken,
 *     and the symptom is a section that never appears.
 *  2. **It survives a reload.** That is the whole promise of "recently opened" —
 *     a section that only lives until the tab closes is not a recall aid.
 *  3. **The key is per WIKI.** Both wikis here are temp directories registered
 *     through `WIKI_EXTRA` in ONE process; a globally-keyed store would leak the
 *     first wiki's recents into the second and every single-root assertion above
 *     would still pass.
 *  4. **The ★ must not navigate.** The pin sits inside `.wiki-list-item`, which
 *     the body-level nav delegate opens on any click. Only the ordering of the
 *     two listeners plus `stopPropagation` keeps them apart, and that ordering
 *     is invisible from either module on its own.
 *
 * No model calls: nothing here leaves the process.
 *
 * ENV PREREQUISITE / SPAWN ENV: as every other spec in this directory — a
 * working `.env` at the repo root, and `e2eEnv()` to keep this muninn off
 * Telegram/Slack and off the host's instance-profile flags.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { RECENTS_KEY_PREFIX, PINS_KEY_PREFIX } from "../src/dashboard/views/components/wiki-recents.ts";

const PORT = e2ePort("wiki-rail-recents");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-rail";
const OTHER_WIKI = "e2e-rail-other";

function md(title: string, tags: string[] = [], body = "Body."): string {
  return ["---", `title: ${title}`, tags.length ? `tags: [${tags.join(", ")}]` : "", "---", "", body, ""]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * The fixture is the melosys shape in miniature: an issue page ADDRESSED by its
 * key, an archive page whose TITLE opens with the key (a reference, not an issue
 * page — the distinction the unit enumeration forced), one that carries the key
 * only as a tag, and two pages with no connection to it at all.
 */
const PAGES: Array<[string, string]> = [
  ["sources/jira/MELOSYS-7588.md", md("Utvid Trygdeavgiftsperiode med grunnlag", ["jira"])],
  ["archive/opprydding.md", md("MELOSYS-7588 — Opprydding av avrunding", ["rounding"])],
  ["flows/datamodel.md", md("Trygdeavgift datamodel", ["melosys-7588", "datamodel"])],
  ["concepts/arsavregning.md", md("Årsavregning", ["avregning"])],
  ["concepts/kildeskatt.md", md("Kildeskatt", ["skatt"])],
];
// mimir's shape, in miniature: dated filenames and a `<word>-<year>` tag, which
// is what a bare `2026` matched on the real corpus (121 of 485 pages).
const DATED: Array<[string, string]> = [
  ["archive/2026-08-27-seven-fix-rounds.md", md("Seven fix rounds", ["retro-2026"])],
  ["archive/2026-08-30-wikilinks.md", md("Wikilinks inside code", ["q1-2026"])],
  ["blogs/2026-08-27-fix-rounds.md", md("Fix rounds inject defects")],
];
// Enough rows that the list scrolls, for the pin mis-click case.
const FILLER: Array<[string, string]> = Array.from({ length: 30 }, (_, i) => [
  `concepts/filler-${String(i).padStart(2, "0")}.md`,
  md(`Filler page number ${i} with a reasonably long title`),
]);

const ISSUE = "sources/jira/MELOSYS-7588.md";
const ARCHIVE = "archive/opprydding.md";
const DATAMODEL = "flows/datamodel.md";
const ARSAVREGNING = "concepts/arsavregning.md";
const KILDESKATT = "concepts/kildeskatt.md";

const ALL_PAGES = PAGES.length + DATED.length + FILLER.length;

const OTHER_REL = "only-here.md";

let server: ChildProcess | undefined;
let root = "";
let otherRoot = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-rail-"));
  otherRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-rail-other-"));
  for (const [rel, body] of [...PAGES, ...DATED, ...FILLER]) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  await writeFile(path.join(otherRoot, OTHER_REL), md("Only Here"), "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root},${OTHER_WIKI}=${otherRoot}`,
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
  if (otherRoot) await rm(otherRoot, { recursive: true, force: true });
});

type Page = import("@playwright/test").Page;

/**
 * Land on a wiki. Every test gets a fresh BrowserContext, so localStorage starts
 * empty without any clearing of our own — which matters: an `addInitScript` that
 * cleared the keys on every `goto` also cleared them on the reload, and the
 * "survives a reload" case then asserted a state it could not fail to see.
 */
async function openRail(page: Page, wiki = WIKI): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  await expect(page.locator(".wiki-list-item").first()).toBeVisible();
}

/** A second visit, in the same context — the store is whatever the first left. */
const reloadKeepingStore = openRail;

/** The section headers' LABELS — `.wiki-sec-label`, not the header element, so
 *  the `clear` button's own text does not ride along. */
const sectionLabels = (page: Page) => page.locator(".wiki-sec-label").allTextContents();

/** The rows under one section header, by relPath, in render order. */
function rowsIn(page: Page, section: string) {
  return page.locator(`.wiki-list-item[data-section="${section}"]`);
}

async function relPathsIn(page: Page, section: string): Promise<string[]> {
  return rowsIn(page, section).evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-relpath") || ""),
  );
}

test.describe("Wiki rail: recents, pins, key jump", () => {
  test("a fresh browser gets the rail it has always had — no headers", async ({ page }) => {
    await openRail(page);
    expect(await sectionLabels(page)).toEqual([]);
    expect(await page.locator(".wiki-list-item").count()).toBe(ALL_PAGES);
    // The ★ is on every row, and invisible until the row is hovered.
    expect(await page.locator(".wiki-pin").count()).toBe(ALL_PAGES);
    await expect(page.locator(".wiki-pin").first()).toHaveCSS("opacity", "0");
  });

  test("opening a page records it, and the record survives a reload", async ({ page }) => {
    await openRail(page);
    await page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"]`).click();
    await expect(page.locator(".wiki-article")).toContainText("Body.");

    expect(await sectionLabels(page)).toEqual(["Recently opened", "Other pages"]);
    expect(await relPathsIn(page, "recent")).toEqual([ARSAVREGNING]);

    // The section MOVED the row: every page is on screen exactly once, so the
    // count still describes the rows, `[data-relpath=…]` still names ONE
    // element, and the open page is highlighted in one place.
    expect(await relPathsIn(page, "all")).toHaveLength(ALL_PAGES - 1);
    expect(await page.locator(".wiki-list-item").count()).toBe(ALL_PAGES);
    await expect(page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"]`)).toHaveCount(1);
    await expect(page.locator(".wiki-list-item.active")).toHaveCount(1);
    await expect(page.locator("#wikiCount")).toHaveText(`${ALL_PAGES} / ${ALL_PAGES}`);

    // …and it is there on the next visit, which is the whole promise.
    await reloadKeepingStore(page);
    expect(await relPathsIn(page, "recent")).toEqual([ARSAVREGNING]);
  });

  test("the most recently opened page comes first, without duplicating", async ({ page }) => {
    await openRail(page);
    for (const rel of [ARSAVREGNING, KILDESKATT, ARSAVREGNING]) {
      await page.locator(`.wiki-list-item[data-relpath="${rel}"]`).click();
      await expect(page.locator(".wiki-article")).toBeVisible();
    }
    expect(await relPathsIn(page, "recent")).toEqual([ARSAVREGNING, KILDESKATT]);
  });

  test("clear empties the section and the store", async ({ page }) => {
    await openRail(page);
    await page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"]`).click();
    await expect(rowsIn(page, "recent")).toHaveCount(1);

    await page.locator(".wiki-sec-clear").click();
    expect(await sectionLabels(page)).toEqual([]);
    // Cleared in storage, not just on screen.
    await reloadKeepingStore(page);
    expect(await sectionLabels(page)).toEqual([]);
  });

  test("★ pins a page WITHOUT opening it", async ({ page }) => {
    await openRail(page);
    // Nothing is open: the start view is showing, and it must still be showing
    // after the click. This is the half the two listeners' ordering decides.
    await expect(page.locator(".wiki-start")).toBeVisible();

    const row = page.locator(`.wiki-list-item[data-relpath="${KILDESKATT}"]`);
    await row.hover();
    await row.locator(".wiki-pin").click();

    await expect(page.locator(".wiki-start")).toBeVisible();
    expect(await sectionLabels(page)).toEqual(["Pinned", "Other pages"]);
    expect(await relPathsIn(page, "pinned")).toEqual([KILDESKATT]);
    await expect(page.locator(`.wiki-list-item[data-relpath="${KILDESKATT}"]`)).toHaveCount(1);
    // A pinned row's ★ is visible with no hover, and says what it will do.
    const pinned = page.locator(`.wiki-list-item[data-section="pinned"] .wiki-pin`);
    await expect(pinned).toHaveCSS("opacity", "1");
    await expect(pinned).toHaveAttribute("aria-pressed", "true");

    await reloadKeepingStore(page);
    expect(await relPathsIn(page, "pinned")).toEqual([KILDESKATT]);
  });

  test("★ again un-pins", async ({ page }) => {
    await openRail(page);
    const row = page.locator(`.wiki-list-item[data-relpath="${KILDESKATT}"]`);
    await row.hover();
    await row.locator(".wiki-pin").click();
    await expect(rowsIn(page, "pinned")).toHaveCount(1);

    await page.locator(`.wiki-list-item[data-section="pinned"] .wiki-pin`).click();
    expect(await sectionLabels(page)).toEqual([]);
  });

  test("a pinned page is not repeated under Recently opened", async ({ page }) => {
    await openRail(page);
    await page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"]`).click();
    await expect(rowsIn(page, "recent")).toHaveCount(1);

    const row = page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"][data-section="recent"]`);
    await row.hover();
    await row.locator(".wiki-pin").click();

    expect(await sectionLabels(page)).toEqual(["Pinned", "Other pages"]);
    expect(await relPathsIn(page, "pinned")).toEqual([ARSAVREGNING]);
    expect(await rowsIn(page, "recent").count()).toBe(0);

    // …and un-pinning gives it back to the recents section.
    await page.locator(`.wiki-list-item[data-section="pinned"] .wiki-pin`).click();
    expect(await relPathsIn(page, "recent")).toEqual([ARSAVREGNING]);
  });

  test("the sections vanish while a search or a filter is active", async ({ page }) => {
    await openRail(page);
    await page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"]`).click();
    await expect(rowsIn(page, "recent")).toHaveCount(1);

    await page.fill("#wikiSearch", "kilde");
    expect(await sectionLabels(page)).toEqual([]);

    await page.fill("#wikiSearch", "");
    await expect(rowsIn(page, "recent")).toHaveCount(1);

    // A facet hides them too — the rail is no longer showing the whole wiki.
    await page.locator('#domainChips .wiki-chip[data-domain="ai"]').click();
    expect(await sectionLabels(page)).toEqual([]);
  });

  test("the store is per wiki — one wiki's recents never show on another", async ({ page }) => {
    await openRail(page);
    await page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"]`).click();
    await expect(rowsIn(page, "recent")).toHaveCount(1);

    await reloadKeepingStore(page, OTHER_WIKI);
    expect(await sectionLabels(page)).toEqual([]);

    // Both keys really are present, under two different names.
    const keys = await page.evaluate(
      ([r, p]: [string, string]) =>
        Object.keys(localStorage).filter((k) => k.startsWith(r) || k.startsWith(p)).sort(),
      [RECENTS_KEY_PREFIX, PINS_KEY_PREFIX] as [string, string],
    );
    expect(keys).toEqual([`${RECENTS_KEY_PREFIX}${WIKI}`]);

    // …and the first wiki still has it.
    await reloadKeepingStore(page, WIKI);
    expect(await relPathsIn(page, "recent")).toEqual([ARSAVREGNING]);
  });

  test("a bare Jira number jumps to the issue page, then what references it", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "7588");

    expect(await sectionLabels(page)).toEqual(["7588 · issue page + 2 referencing pages"]);
    // The ISSUE page leads; the references follow in the rail's current sort,
    // which is by mtime here — so their order is asserted as a SET, not a list.
    const jumped = await relPathsIn(page, "jump");
    expect(jumped[0]).toBe(ISSUE);
    expect(jumped.slice(1).sort()).toEqual([ARCHIVE, DATAMODEL].sort());
    // The jump found a page the substring search could not: `flows/datamodel.md`
    // carries the key only as a tag `melosys-7588`, which "7588" does not match.
    expect(await relPathsIn(page, "all")).toEqual([]);
    await expect(page.locator("#wikiCount")).toHaveText(`3 / ${ALL_PAGES}`);
  });

  test("the prefixed key finds the same pages", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "MELOSYS-7588");
    const jumped = await relPathsIn(page, "jump");
    expect(jumped[0]).toBe(ISSUE);
    expect(jumped.slice(1).sort()).toEqual([ARCHIVE, DATAMODEL].sort());
    expect(await sectionLabels(page)).toEqual(["MELOSYS-7588 · issue page + 2 referencing pages"]);
  });

  test("a jump row opens the page it names", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "7588");
    await page.locator(`.wiki-list-item[data-section="jump"][data-relpath="${DATAMODEL}"]`).click();
    await expect(page.locator(".wiki-bc-cur")).toContainText("Trygdeavgift datamodel");
  });

  test("a number that names no issue costs nothing — no header, ordinary results", async ({
    page,
  }) => {
    await openRail(page);
    // 4242 is key-shaped and names nothing here, so the jump renders nothing
    // rather than an empty block.
    await page.fill("#wikiSearch", "4242");
    expect(await sectionLabels(page)).toEqual([]);
    expect(await page.locator(".wiki-list-item").count()).toBe(0);
    await expect(page.locator("#wikiList .wiki-conn-empty")).toHaveText("No pages match.");
  });

  test("an ordinary search is untouched by the jump", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "kildeskatt");
    expect(await sectionLabels(page)).toEqual([]);
    expect(await relPathsIn(page, "all")).toEqual([KILDESKATT]);
  });

  /**
   * The mis-click a verify pass measured: `renderList` restored `scrollTop`
   * verbatim, so pinning — which inserts headers at the very top — moved the row
   * under the cursor ~96px (measured 119.8 → 216.3 at scrollTop 800), and a
   * second click at the same point pinned a page three rows away.
   *
   * The rule, and what is asserted here: **the only thing that moves is the row
   * that left.** The neighbours shift up by exactly one row height, never by the
   * inserted headers. The row height is measured at runtime from two adjacent
   * rows rather than hardcoded, so this pins the rule and not a layout.
   *
   * ⚠️ Residual, and it is inherent rather than a defect: the pinned row does
   * leave the cursor, so a second click at the same point lands on its
   * neighbour. Under the section semantics this replaced that was invisible —
   * the row stayed put and a duplicate appeared off-screen. Now the row visibly
   * flies to `Pinned`, which is where the undo is.
   */
  test("pinning shifts the rows around the cursor by exactly the row that left", async ({
    page,
  }) => {
    await openRail(page);
    // Title order, so filler-15 is deterministically ABOVE filler-20. The default
    // sort is by mtime and the fixture's files are written in a loop, so whether
    // 15 precedes 20 depends on filesystem timestamp granularity — which passed
    // in isolation and failed once under the full parallel suite.
    await page.selectOption("#wikiSort", "title");
    await page.locator("#wikiList").evaluate((el) => {
      el.scrollTop = 300;
    });

    const yOf = async (rel: string): Promise<number> =>
      (await page.locator(`.wiki-list-item[data-relpath="${rel}"]`).boundingBox())!.y;

    // `hover()` scrolls the row into view, so every baseline is taken AFTER it —
    // measuring before cost a debugging round on a 411px "shift" that was the
    // hover's own scroll.
    const target = page.locator(`.wiki-list-item[data-relpath="concepts/filler-15.md"]`);
    await target.hover();

    // The height of the row that is about to LEAVE — order-independent, unlike
    // the gap between two rows named in the fixture.
    const rowHeight = (await target.boundingBox())!.height;
    expect(rowHeight).toBeGreaterThan(10);
    const before = await yOf("concepts/filler-20.md");

    await target.locator(".wiki-pin").click();
    await expect(rowsIn(page, "pinned")).toHaveCount(1);

    // The rule: the content under the cursor never moves DOWN, and the most it
    // moves up is the one row that left. An exact figure would be a layout pin —
    // rows are not all the same height, since a long title wraps to two lines.
    // Without the anchored restore the two inserted headers pushed it down.
    const after = await yOf("concepts/filler-20.md");
    expect(after, "pinning must not push content down").toBeLessThanOrEqual(before + 1);
    expect(before - after, "…nor up by more than the row that left").toBeLessThanOrEqual(
      rowHeight + 2,
    );
  });

  /**
   * The regression a verify pass measured on the REAL mimir corpus: that wiki
   * files pages as `archive/<yyyy-mm-dd>-<topic>.mdx`, so a date is how a reader
   * finds one — and `2026` as a bare key resolved to 121 of 485 pages, burying
   * the query's single real match under eight unrelated ones.
   */
  test("a date query is a search, not a Jira jump", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "2026-08-27");
    expect(await sectionLabels(page)).toEqual([]);
    expect((await relPathsIn(page, "all")).sort()).toEqual([
      "archive/2026-08-27-seven-fix-rounds.md",
      "blogs/2026-08-27-fix-rounds.md",
    ]);

    // …and a bare year does not either, though `retro-2026` is a real tag here.
    await page.fill("#wikiSearch", "2026");
    expect(await sectionLabels(page)).toEqual([]);
  });

  /** A prefixed key in the year range is still a key — the project names it. */
  test("MELOSYS-2026 is still a key", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "MELOSYS-2026");
    // Nothing here carries it, so no header — the point is that it PARSED and
    // simply found nothing, which the date cases above can no longer distinguish.
    expect(await sectionLabels(page)).toEqual([]);
  });

  /**
   * The ★ must not join the tab order. As an ordinary tab stop it put ONE per
   * page ahead of the rail resizer PR #501 shipped for keyboard users — 485 on
   * mimir, measured — in a list whose rows are `div`s a keyboard cannot open
   * anyway. The rule asserted is the one that matters: the resizer is still a
   * few presses from the search box, whatever the page count.
   */
  test("the ★ does not bury the rail resizer in the tab order", async ({ page }) => {
    await openRail(page);
    await page.locator("#wikiSearch").focus();
    let presses = 0;
    for (; presses < 15; presses++) {
      await page.keyboard.press("Tab");
      if ((await page.evaluate(() => document.activeElement?.id)) === "wikiRailResizer") break;
    }
    expect(presses, `reached the resizer after ${presses} Tab presses`).toBeLessThan(12);
    // …and there are far more rows than that, so the bound is a real one.
    expect(await page.locator(".wiki-pin").count()).toBeGreaterThan(30);
  });

  /**
   * A response that lands after a newer navigation started must not write itself
   * to the head of a PERSISTENT list. The pre-existing clobber of `currentRelPath`
   * was transient; recording a recent from it would outlive the session.
   */
  test("a slow response that loses the race does not become the newest recent", async ({
    page,
  }) => {
    await openRail(page);
    // Hold the FIRST page's response until the second navigation has finished.
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`**/api/wiki/page?relPath=${encodeURIComponent(ARSAVREGNING)}*`, async (route) => {
      await held;
      await route.continue();
    });

    await page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"]`).click();
    await page.locator(`.wiki-list-item[data-relpath="${KILDESKATT}"]`).click();
    await expect(page.locator(".wiki-bc-cur")).toContainText("Kildeskatt");

    release!();
    await page.waitForTimeout(400);

    // The page the reader actually settled on is the newest recent.
    expect((await relPathsIn(page, "recent"))[0]).toBe(KILDESKATT);
  });

  /**
   * Two regressions the anchored scroll restore injected, both invisible to the
   * case it was written for because that one scrolls the list first.
   *
   * The anchor chases a row to its new position, which is right when a render
   * INSERTS above the reader and wrong when it REORDERS — and wrong at the top
   * of the list in both cases, where "keep the reader where they were" means
   * "stay at the top", not "follow row 1 wherever it went".
   */
  test("changing the sort at the top of the list leaves the reader at the top", async ({
    page,
  }) => {
    await openRail(page);
    expect(await page.locator("#wikiList").evaluate((el) => el.scrollTop)).toBe(0);
    await page.selectOption("#wikiSort", "title");
    expect(await page.locator("#wikiList").evaluate((el) => el.scrollTop)).toBe(0);
    // …and the first row of the new order is the one ON SCREEN. (Which page
    // that is depends on the collation of "Å", which is not what this pins.)
    await expect(page.locator(".wiki-list-item").first()).toBeInViewport();
  });

  test("pinning the top row leaves the Pinned header on screen", async ({ page }) => {
    await openRail(page);
    const row = page.locator(".wiki-list-item").first();
    await row.hover();
    await row.locator(".wiki-pin").click();

    // The whole confirmation that anything happened. Scrolled out of view, the
    // row just vanishes from where it was.
    const header = page.locator('.wiki-list-sec[data-section="pinned"]');
    await expect(header).toBeVisible();
    const headerBox = (await header.boundingBox())!;
    const listBox = (await page.locator("#wikiList").boundingBox())!;
    expect(headerBox.y).toBeGreaterThanOrEqual(listBox.y - 1);
  });

  /**
   * A navigation the reader ABANDONS must not write itself to the persistent
   * recents list. `loadExplainer` and `fetchAndRenderPage` bump the token; the
   * return-to-start path did not, so a slow response for a page the reader
   * backed out of still won the top of Recently opened.
   */
  test("backing out to the start view before the response lands records nothing", async ({
    page,
  }) => {
    await openRail(page);
    // One page opened for real first: a HELD navigation pushes no history entry,
    // so without this `goBack` leaves the reader page entirely and the popstate
    // path — the one that calls `renderStart` — is never exercised.
    await page.locator(`.wiki-list-item[data-relpath="${KILDESKATT}"]`).click();
    await expect(page.locator(".wiki-bc-cur")).toContainText("Kildeskatt");

    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`**/api/wiki/page?relPath=${encodeURIComponent(ARSAVREGNING)}*`, async (route) => {
      await held;
      await route.continue();
    });

    await page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"]`).click();
    await page.goBack();
    await expect(page.locator(".wiki-start")).toBeVisible();

    release!();
    await page.waitForTimeout(400);
    // The abandoned page is NOT at the head — only the one actually read is there.
    expect(await relPathsIn(page, "recent")).toEqual([KILDESKATT]);
  });
});

/**
 * The ★ on a device that never hovers.
 *
 * `pointer-events: none` alone was INERT here, and only a real tap showed it:
 * Chromium applies `:hover` on touchstart, so the invisible star became
 * clickable before the click dispatched and a tap in that slot pinned instead of
 * opening the page (measured: pinned 1, article 0). The rule is that nothing
 * INVISIBLE is hit-testable — which on a device that cannot hover means the star
 * has to be visible, so a tap on it is a choice rather than an accident.
 *
 * Asserting the CSS declaration would restate the stylesheet; these tap.
 */
test.describe("Wiki rail: the ★ on a touch device", () => {
  test.use({ hasTouch: true });

  test("the ★ is VISIBLE, so a tap on it is deliberate", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await expect(page.locator(".wiki-list-item").first()).toBeVisible();

    const row = page.locator(`.wiki-list-item[data-relpath="${KILDESKATT}"]`);
    // `boundingBox()` reports the LAYOUT position, which for a row further down
    // a scrolling rail is outside the viewport — a tap there lands on nothing
    // and the test passes or fails for reasons that have nothing to do with the
    // ★ (measured: y=1767 in a 720px viewport, `elementFromPoint` → null).
    await row.scrollIntoViewIfNeeded();
    await expect(row.locator(".wiki-pin")).toHaveCSS("opacity", "1");

    const pinBox = (await row.locator(".wiki-pin").boundingBox())!;
    await page.touchscreen.tap(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height / 2);
    await expect(rowsIn(page, "pinned")).toHaveCount(1);
    // …and it pinned, rather than also opening the page.
    expect(await page.locator(".wiki-article").count()).toBe(0);
  });

  test("a tap on the row still opens the page", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await expect(page.locator(".wiki-list-item").first()).toBeVisible();

    const row = page.locator(`.wiki-list-item[data-relpath="${KILDESKATT}"]`);
    await row.scrollIntoViewIfNeeded();
    const titleBox = (await row.locator(".wiki-list-title").boundingBox())!;
    await page.touchscreen.tap(titleBox.x + 5, titleBox.y + 5);

    await expect(page.locator(".wiki-bc-cur")).toContainText("Kildeskatt");
    expect(await page.locator('.wiki-list-sec[data-section="pinned"]').count()).toBe(0);
  });
});
