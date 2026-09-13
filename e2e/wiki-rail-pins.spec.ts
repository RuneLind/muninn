/**
 * Pinned · the Jira-key jump, in the /wiki reader's page rail. (Named for the
 * pins; the key jump rides along because it is the rail's other head-of-list
 * rule and the two share this fixture — an issue page, its references, and 50
 * filler rows past the pin cap.)
 *
 * What the unit tests cannot reach, and the reason this file exists:
 *
 *  1. **The chain that records a pin.** `togglePin` is a pure list splice;
 *     whether the reader ever calls it depends on the ★ click reaching
 *     `togglePinned`, localStorage accepting the write, and the next render
 *     rebuilding the section. Every unit test in that chain is green with the
 *     chain broken, and the symptom is a section that never appears.
 *  2. **It survives a reload.** That is the whole promise of a pin — a star that
 *     only lives until the tab closes keeps nothing.
 *  3. **The key is per WIKI.** Both wikis here are temp directories registered
 *     through `WIKI_EXTRA` in ONE process; a globally-keyed store would leak the
 *     first wiki's pins into the second and every single-root assertion above
 *     would still pass.
 *  4. **The ★ must not navigate.** The pin sits inside `.wiki-list-item`, which
 *     the body-level nav delegate opens on any click. Only the ordering of the
 *     two listeners plus the delegate's own skip keeps them apart, and that
 *     ordering is invisible from either module on its own.
 *  5. **The dead recents keys are purged.** `Recently opened` is gone; the one
 *     thing left of it is a boot-time cleanup, and whether it reaches the
 *     browser's own storage is not a question a unit test can answer.
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
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";
import {
  RECENTS_KEY_PREFIX,
  PINS_KEY_PREFIX,
  PINS_MAX,
} from "../src/dashboard/views/components/wiki-recents.ts";
import { LAST_WIKI_KEY } from "../src/dashboard/views/components/wiki-home.ts";

const PORT = e2ePort("wiki-rail-pins");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-rail";
const OTHER_WIKI = "e2e-rail-other";

/** Every fixture page carries a `created:` in the past and (via `beforeAll`) a
 *  backdated mtime, so the rail's Activity section is EMPTY on this wiki. Left
 *  fresh, the ranking would claim six of these rows and this file's Pinned
 *  assertions would be about whatever it left behind. See `settled-wiki.ts`. */
function md(title: string, tags: string[] = [], body = "Body."): string {
  return [
    "---",
    `title: ${title}`,
    SETTLED_CREATED_LINE,
    tags.length ? `tags: [${tags.join(", ")}]` : "",
    "---",
    "",
    body,
    "",
  ]
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
// Enough rows that the list scrolls, and more than PINS_MAX so the cap's
// displacement behaviour is reachable at all.
const FILLER: Array<[string, string]> = Array.from({ length: 50 }, (_, i) => [
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
  await settleWikiMtimes(root);
  await settleWikiMtimes(otherRoot);

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
  await expect(page.locator(".wiki-list-item").first()).toBeAttached();
}

/** A second visit, in the same context — the store is whatever the first left. */
const reloadKeepingStore = openRail;

/** The section headers' LABELS — `.wiki-sec-label`, not the header element. */
const sectionLabels = (page: Page) => page.locator(".wiki-sec-label").allTextContents();

/** Pin one row by its ★, hovering first — the star is hidden until the row is
 *  hovered on a pointer device. The click paints the star and nothing else, so
 *  the caller asks for the next render itself (`rerender`). */
async function pinRow(page: Page, rel: string): Promise<void> {
  const row = page.locator(`.wiki-list-item[data-relpath="${rel}"]`);
  await row.hover();
  await row.locator(".wiki-pin").click();
  await expect(row.locator(".wiki-pin")).toHaveAttribute("aria-pressed", "true");
}

/** Cause a render without changing what is on screen. The ★ toggle deliberately
 *  paints buttons and nothing else, so a section appears at the reader's NEXT
 *  render; in a test that moment has to be explicit rather than implied. */
async function rerender(page: Page): Promise<void> {
  await page.fill("#wikiSearch", "zzz-no-such-page");
  await page.fill("#wikiSearch", "");
}

/** The rows under one section header, by relPath, in render order. */
function rowsIn(page: Page, section: string) {
  return page.locator(`.wiki-list-item[data-section="${section}"]`);
}

async function relPathsIn(page: Page, section: string): Promise<string[]> {
  return rowsIn(page, section).evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-relpath") || ""),
  );
}

test.describe("Wiki rail: pins, key jump", () => {
  test("a fresh browser gets the rail it has always had — no headers", async ({ page }) => {
    await openRail(page);
    expect(await sectionLabels(page)).toEqual([]);
    expect(await page.locator(".wiki-list-item").count()).toBe(ALL_PAGES);
    // The ★ is on every row, and invisible until the row is hovered.
    expect(await page.locator(".wiki-pin").count()).toBe(ALL_PAGES);
    await expect(page.locator(".wiki-pin").first()).toHaveCSS("opacity", "0");
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
    // The ★ itself is the immediate confirmation; the section is the next render's.
    await expect(row.locator(".wiki-pin")).toHaveAttribute("aria-pressed", "true");
    await rerender(page);
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
    await rerender(page);
    await expect(rowsIn(page, "pinned")).toHaveCount(1);

    await page.locator(`.wiki-list-item[data-section="pinned"] .wiki-pin`).click();
    await rerender(page);
    expect(await sectionLabels(page)).toEqual([]);
  });

  test("a search hides the section; a facet NARROWS it to the filtered pages", async ({ page }) => {
    await openRail(page);
    await pinRow(page, KILDESKATT);
    await pinRow(page, ARSAVREGNING);
    await rerender(page);
    await expect(rowsIn(page, "pinned")).toHaveCount(2);

    await page.fill("#wikiSearch", "kilde");
    expect(await sectionLabels(page)).toEqual([]);

    await page.fill("#wikiSearch", "");
    await expect(rowsIn(page, "pinned")).toHaveCount(2);

    // A facet keeps the section and drops the pin that is outside it: the reader
    // who picked a tag still has the pages they pinned IN it.
    await page.locator("#wikiFilters summary").click();
    await page.locator('#tagChips .wiki-chip[data-tag="avregning"]').click();
    expect(await relPathsIn(page, "pinned")).toEqual([ARSAVREGNING]);
    expect(await sectionLabels(page)).toEqual(["Pinned"]);
  });

  test("the store is per wiki — one wiki's pins never show on another", async ({ page }) => {
    await openRail(page);
    await pinRow(page, ARSAVREGNING);
    await rerender(page);
    await expect(rowsIn(page, "pinned")).toHaveCount(1);

    await reloadKeepingStore(page, OTHER_WIKI);
    expect(await sectionLabels(page)).toEqual([]);

    // The key really is per wiki, and it is the ONLY rail key in the store.
    const keys = await page.evaluate(
      ([r, p]: [string, string]) =>
        Object.keys(localStorage).filter((k) => k.startsWith(r) || k.startsWith(p)).sort(),
      [RECENTS_KEY_PREFIX, PINS_KEY_PREFIX] as [string, string],
    );
    expect(keys).toEqual([`${PINS_KEY_PREFIX}${WIKI}`]);

    // …and the first wiki still has it.
    await reloadKeepingStore(page, WIKI);
    expect(await relPathsIn(page, "pinned")).toEqual([ARSAVREGNING]);
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
   * The class fix for a surface that produced a defect in each of two rounds.
   *
   * The ★ used to re-render the whole list, which moved content under the
   * reader: a numeric scroll restore shifted the row at the cursor ~96px (so a
   * second click pinned a different page), and the anchored restore that
   * replaced it threw the reader down the list on a sort change and hid the new
   * `Pinned` header when pinning at the top. Three cells of one state space —
   * (render cause × scroll position × whether the list reorders) — wrong in
   * three different ways.
   *
   * So the toggle does not re-render at all: it repaints the ★ of every row from
   * the stored pin list — every row, because a toggle at `PINS_MAX` displaces a
   * second page — and the sections rebuild at the reader's next render.
   *
   * ⚠️ "Nothing moves" is true of the CLICK, not of every later render: the one
   * that first paints a new section can be the BACKGROUND listing refresh, which
   * then shifts content by the section headers' height on a repaint nothing on
   * screen explains. Bounded, named in `src/wiki/CLAUDE.md`, and only on a
   * render that already repaints the list.
   */
  test("pinning moves nothing under the reader", async ({ page }) => {
    await openRail(page);
    await page.selectOption("#wikiSort", "title");
    await page.locator("#wikiList").evaluate((el) => {
      el.scrollTop = 300;
    });

    const yOf = async (rel: string): Promise<number> =>
      (await page.locator(`.wiki-list-item[data-relpath="${rel}"]`).boundingBox())!.y;

    const target = page.locator(`.wiki-list-item[data-relpath="concepts/filler-15.md"]`);
    await target.hover();
    const before = await yOf("concepts/filler-20.md");
    const selfBefore = await yOf("concepts/filler-15.md");
    const scrollBefore = await page.locator("#wikiList").evaluate((el) => el.scrollTop);

    await target.locator(".wiki-pin").click();
    await expect(target.locator(".wiki-pin")).toHaveAttribute("aria-pressed", "true");

    // The VISIBLE half of the confirmation, with the cursor moved away so the
    // hover reveal is not what is being read: a pinned ★ stays lit, an unpinned
    // neighbour goes back to invisible.
    await page.mouse.move(4, 4);
    await expect(target.locator(".wiki-pin")).toHaveCSS("opacity", "1");
    await expect(
      page.locator(`.wiki-list-item[data-relpath="concepts/filler-20.md"] .wiki-pin`),
    ).toHaveCSS("opacity", "0");

    // Nothing moved — not the neighbours, not the row itself, not the scroll.
    expect(await yOf("concepts/filler-20.md")).toBe(before);
    expect(await yOf("concepts/filler-15.md")).toBe(selfBefore);
    expect(await page.locator("#wikiList").evaluate((el) => el.scrollTop)).toBe(scrollBefore);

    // …so a second click at the same place acts on the same page: it un-pins.
    await target.locator(".wiki-pin").click();
    await expect(target.locator(".wiki-pin")).toHaveAttribute("aria-pressed", "false");
  });

  test("the pin is honoured by the next render the reader causes", async ({ page }) => {
    await openRail(page);
    const row = page.locator(`.wiki-list-item[data-relpath="${KILDESKATT}"]`);
    await row.hover();
    await row.locator(".wiki-pin").click();
    // Not yet — the toggle deliberately paints no sections.
    expect(await sectionLabels(page)).toEqual([]);

    // Any render does it. A search and back is the cheapest.
    await page.fill("#wikiSearch", "kilde");
    await page.fill("#wikiSearch", "");
    expect(await sectionLabels(page)).toEqual(["Pinned", "Other pages"]);
    expect(await relPathsIn(page, "pinned")).toEqual([KILDESKATT]);

    // …and it survived a reload, so the click really wrote through.
    await reloadKeepingStore(page);
    expect(await relPathsIn(page, "pinned")).toEqual([KILDESKATT]);
  });

  test("changing the sort leaves the reader where they were", async ({ page }) => {
    await openRail(page);
    // At the top AND scrolled: the anchored restore this replaced was wrong at
    // the top, and its replacement was unpinned when scrolled.
    expect(await page.locator("#wikiList").evaluate((el) => el.scrollTop)).toBe(0);
    await page.selectOption("#wikiSort", "title");
    expect(await page.locator("#wikiList").evaluate((el) => el.scrollTop)).toBe(0);
    await expect(page.locator(".wiki-list-item").first()).toBeInViewport();

    await page.locator("#wikiList").evaluate((el) => {
      el.scrollTop = 300;
    });
    await page.selectOption("#wikiSort", "created");
    expect(await page.locator("#wikiList").evaluate((el) => el.scrollTop)).toBe(300);
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
   * A toggle at the pin cap flips TWO pages, and the second one's ★ has to know.
   *
   * `togglePin` displaces the oldest pin at `PINS_MAX`, so "repaint the row that
   * was clicked" leaves the displaced page lit: its ★ still reads "Unpin this
   * page", and clicking it RE-pins (evicting yet another page) while the star
   * never changes — a control that reads as dead and does the opposite of its
   * label. The painter therefore takes its state from storage for every row,
   * which needs no notion of which pages changed.
   */
  test("a pin that displaces another at the cap darkens the displaced ★", async ({ page }) => {
    await openRail(page);
    const rels = await page
      .locator(".wiki-list-item")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-relpath")!));
    expect(rels.length).toBeGreaterThan(PINS_MAX);

    // Fill the pin list to the cap, oldest LAST — `togglePin` prepends, so the
    // stored array's tail is what a further pin displaces.
    await page.evaluate(
      ([key, seeded]: [string, string[]]) => localStorage.setItem(key, JSON.stringify(seeded)),
      [`${PINS_KEY_PREFIX}${WIKI}`, rels.slice(0, PINS_MAX)] as [string, string[]],
    );
    await reloadKeepingStore(page);

    const victim = rels[PINS_MAX - 1]!;
    await expect(
      page.locator(`.wiki-list-item[data-relpath="${victim}"] .wiki-pin`),
    ).toHaveAttribute("aria-pressed", "true");

    // One more pin: the victim falls off the end of the list.
    const fresh = page.locator(`.wiki-list-item[data-relpath="${rels[PINS_MAX]!}"]`);
    await fresh.hover();
    await fresh.locator(".wiki-pin").click();

    const victimPin = page.locator(`.wiki-list-item[data-relpath="${victim}"] .wiki-pin`);
    await expect(victimPin).toHaveAttribute("aria-pressed", "false");
    await expect(victimPin).toHaveAttribute("title", "Pin this page");
    // …and the star agrees with storage, which is the property that matters.
    const stored = await page.evaluate(
      (key: string) => JSON.parse(localStorage.getItem(key) || "[]") as string[],
      `${PINS_KEY_PREFIX}${WIKI}`,
    );
    expect(stored).not.toContain(victim);
    expect(stored).toHaveLength(PINS_MAX);
  });

  /**
   * A page stored under a different spelling must be ONE page to every half of
   * the rail — the renderer, the painter, AND the writer.
   *
   * Unifying the two READ halves was not enough: `togglePin` still compared raw,
   * so clicking a star labelled "Unpin this page" appended a SECOND entry for
   * one page instead of removing it, and at the next render that page rendered
   * twice under a `#wikiCount` that said otherwise. The earlier version of this
   * test clicked a DIFFERENT row's star to force the repaint, which is exactly
   * the one action that cannot see it.
   *
   * `#wikiCount` cannot detect this either — it counts distinct pages, so it
   * read 12/12 with 13 rows on screen. Only the row count can.
   */
  test("a differently-cased stored pin is ONE page to every half of the rail", async ({ page }) => {
    await openRail(page);
    await page.evaluate(
      ([key, rel]: [string, string]) => localStorage.setItem(key, JSON.stringify([rel])),
      [`${PINS_KEY_PREFIX}${WIKI}`, KILDESKATT.toUpperCase()] as [string, string],
    );
    await reloadKeepingStore(page);

    // The renderer resolved it, and the painter agrees.
    expect(await relPathsIn(page, "pinned")).toEqual([KILDESKATT]);
    const star = page.locator(`.wiki-list-item[data-relpath="${KILDESKATT}"] .wiki-pin`);
    await expect(star).toHaveAttribute("aria-pressed", "true");

    // The click the previous version of this test avoided: the mis-cased row's OWN
    // star, which is the only action that reproduces the duplicate.
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "false");
    const stored = await page.evaluate(
      (key: string) => JSON.parse(localStorage.getItem(key) || "[]") as string[],
      `${PINS_KEY_PREFIX}${WIKI}`,
    );
    expect(stored).toEqual([]);

    await rerender(page);
    expect(await sectionLabels(page)).toEqual([]);
    expect(await page.locator(`.wiki-list-item[data-relpath="${KILDESKATT}"]`).count()).toBe(1);
    expect(await page.locator(".wiki-list-item").count()).toBe(ALL_PAGES);
  });

  /** An `aria-label` overrides a button's text, so it is the string a screen
   *  reader actually announces — and the one that must move with the state. */
  test("the ★'s accessible name follows the pin state", async ({ page }) => {
    await openRail(page);
    const row = page.locator(`.wiki-list-item[data-relpath="${KILDESKATT}"]`);
    await expect(row.locator(".wiki-pin")).toHaveAttribute("aria-label", "Pin this page");
    await row.hover();
    await row.locator(".wiki-pin").click();
    await expect(row.locator(".wiki-pin")).toHaveAttribute("aria-label", "Unpin this page");
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
   * The one-time cleanup that ships with the removal of `Recently opened`.
   *
   * A reader who used the rail before this carries a `muninn.wiki.recents.v1:*`
   * key per wiki, which nothing will ever read again. The rail's boot purges
   * every one of them — and NOTHING else: the pins key beside it is the feature
   * that replaces the section, and `muninn.wiki.last.v1` is what makes a bare
   * `/wiki` open the wiki last read, so a prefix match that reached either would
   * be a silent data loss on an unrelated feature.
   *
   * The seeded recent names a DIFFERENT page from the pin on purpose, so the two
   * halves of the assertion cannot be satisfied by one row: the pinned page has
   * to stay lifted while the page the dead key named drops into the listing.
   */
  test("the boot purges dead recents keys and leaves pins and the last-wiki key", async ({
    page,
  }) => {
    await openRail(page);
    await page.evaluate(
      ([recentsPrefix, pinsPrefix, lastKey, wiki, otherWiki, recentRel, pinRel]: [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]) => {
        localStorage.setItem(recentsPrefix + wiki, JSON.stringify([recentRel]));
        localStorage.setItem(recentsPrefix + otherWiki, JSON.stringify([recentRel]));
        localStorage.setItem(pinsPrefix + wiki, JSON.stringify([pinRel]));
        localStorage.setItem(lastKey, wiki);
      },
      [
        RECENTS_KEY_PREFIX,
        PINS_KEY_PREFIX,
        LAST_WIKI_KEY,
        WIKI,
        OTHER_WIKI,
        ARSAVREGNING,
        KILDESKATT,
      ] as [string, string, string, string, string, string, string],
    );

    await reloadKeepingStore(page);

    // The section is gone from the rail: no fold, no clear affordance, no header.
    await expect(page.locator(".wiki-rail-fold")).toHaveCount(0);
    await expect(page.locator("[data-clear-recents]")).toHaveCount(0);
    expect(await sectionLabels(page)).toEqual(["Pinned", "Other pages"]);
    expect(await relPathsIn(page, "recent")).toEqual([]);
    // The page the dead key named is an ordinary listing row again.
    expect(await relPathsIn(page, "all")).toContain(ARSAVREGNING);

    // Every recents key is gone — both wikis', not just this one's…
    const state = await page.evaluate(
      ([recentsPrefix, pinsPrefix, lastKey, wiki]: [string, string, string, string]) => ({
        recents: Object.keys(localStorage).filter((k) => k.startsWith(recentsPrefix)),
        pins: localStorage.getItem(pinsPrefix + wiki),
        last: localStorage.getItem(lastKey),
      }),
      [RECENTS_KEY_PREFIX, PINS_KEY_PREFIX, LAST_WIKI_KEY, WIKI] as [string, string, string, string],
    );
    expect(state.recents).toEqual([]);
    // …and the two keys it must not touch are byte-identical.
    expect(state.pins).toBe(JSON.stringify([KILDESKATT]));
    expect(state.last).toBe(WIKI);
    // The pin still works, which is the point of keeping that key.
    expect(await relPathsIn(page, "pinned")).toEqual([KILDESKATT]);
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
    await expect(row.locator(".wiki-pin")).toHaveAttribute("aria-pressed", "true");
    // …and it pinned, rather than also opening the page.
    expect(await page.locator(".wiki-article").count()).toBe(0);
    await rerender(page);
    await expect(rowsIn(page, "pinned")).toHaveCount(1);
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
