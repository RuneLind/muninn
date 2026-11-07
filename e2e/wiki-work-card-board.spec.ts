/**
 * The Your work card (plan `muninn-wiki-work-map`, P2) as wired into the /wiki
 * start view.
 *
 * The rendering rules are unit-tested (`wiki-work-card.test.ts`); what only a
 * real page can hold:
 *
 *  1. **Legible in every theme** — each explicit pick (Light, Dark, Reading,
 *     Light reading) and System under both OS schemes: every element that
 *     paints text, in every state (map, refusal, running, all done, error),
 *     clears 4.5:1 against what is painted behind it.
 *  2. **The board (your-work board P3)**: the columns' tracks at each window, the
 *     folds that stop folding when all five fit, live under F with no repaint, no
 *     horizontal overflow, an effort moving between columns when the check or a ✓
 *     or an adopt says so, focus following it, the sparkline under forced colors,
 *     and from that width heads that take no focus or key, with each column named.
 *     Beside a tall Waiting on you the other columns land right under each other,
 *     and a compact row is two lines, all measured.
 *
 * One muninn on its own port over the temp wikis `wiki-work-card-fixture.ts`
 * seeds. `SCHEDULER_ENABLED=false` keeps the work-map loop off and every wiki
 * not organizable. No model calls.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { e2ePort } from "./ports.ts";
import { paintedMeasure, token } from "./contrast.ts";
import { WIKI_REFETCH_MIN_INTERVAL_MS } from "../src/dashboard/views/components/wiki-refresh.ts";
import {
  SWEEP,
  STRIP_OFF,
  BOARD,
  BOARD_ADOPT,
  BOARD_QUIET,
  BOARD_TALL,
  BOARD_NO_WAIT,
  HOUR,
  waitPage,
  roots,
  openStart,
  openSettled,
  forceAdopt,
  boardCard,
  boardNeeds,
  holdChecks,
  GH_MERGED_AT,
  checksBody,
  stubChecks,
  GH_UNLINKED,
  GH_UNCHECKED,
  organizable,
  THEMES,
  sweepThemesMap,
  useWorkCardServer,
} from "./wiki-work-card-fixture.ts";

const PORT = e2ePort("wiki-work-card-board");
const BASE = `http://127.0.0.1:${PORT}`;
useWorkCardServer(PORT);

// ── The board (your-work board P3) ────────────────────────────────────
const COLUMN_IDS = ["you", "moving", "cooling", "quiet", "shipped"];

async function trackCount(page: Page): Promise<number> {
  return boardCard(page).locator(".wiki-wm-cols").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
}

/** The column ids whose content the reader can see, by the browser's own answer. */
async function columnsShown(page: Page): Promise<string[]> {
  return boardCard(page).locator("details.wiki-wm-col").evaluateAll((cols) =>
    cols.flatMap((c) => {
      const content = c.querySelector(".wiki-wm-efforts, .wiki-wm-col-none");
      return content?.checkVisibility({ contentVisibilityAuto: true }) ? [c.getAttribute("data-wm-lane")!] : [];
    }),
  );
}

/** Nothing in the card reaches past it, and the page does not scroll sideways. */
async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const r = await boardCard(page).evaluate((card) => {
    const right = card.getBoundingClientRect().right;
    const past = Array.from(card.querySelectorAll("*")).filter((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().right > right + 0.5);
    return {
      scroll: card.scrollWidth - card.clientWidth,
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      past: past.map((el) => el.getAttribute("class")).slice(0, 5),
    };
  });
  expect(r, label).toEqual({ scroll: 0, doc: 0, past: [] });
}

async function boardInnerWidth(page: Page): Promise<number> {
  return boardCard(page).locator(".wiki-wm-board").evaluate((el) => el.getBoundingClientRect().width);
}

for (const [width, tracks, shown] of [
  [1280, 2, ["you", "moving"]],
  [1512, 3, ["you", "moving"]],
  [1728, 4, ["you", "moving"]],
  [1920, 5, COLUMN_IDS],
  [700, 1, ["you", "moving"]],
] as const) {
  test(`at a ${width} window the board has ${tracks} track${tracks === 1 ? "" : "s"} and shows ${shown.length} columns' content, with nothing overflowing`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettled(page, BOARD);
    const card = boardCard(page);
    await expect(card.locator(".wiki-wm-tile").first()).toBeAttached();
    console.log(`board inner width at ${width}: ${await boardInnerWidth(page)}`);
    expect(await trackCount(page)).toBe(tracks);
    expect(await columnsShown(page)).toEqual([...shown]);
    await expectNoOverflow(page, `at ${width}`);
  });
}

test("the column heads count every effort in the column, nested included, in the table's order", async ({ page }) => {
  await openSettled(page, BOARD);
  const heads = await boardCard(page).locator("details.wiki-wm-col > summary").allInnerTexts();
  expect(heads.map((h) => h.replace(/\s+/g, " ").trim().toLowerCase())).toEqual(["waiting on you 3", "moving 3", "cooling 1", "quiet 1", "shipped 1"]);
  const moves = boardCard(page).locator('[data-wm-lane="moving"] .wiki-wm-tile[data-effort-id="moves"]');
  await expect(moves.locator('.wiki-wm-kid[data-effort-id="sub"]')).toHaveCount(1);
  // A sub-effort in another column stands on its own, naming its parent.
  await expect(boardCard(page).locator('[data-wm-lane="cooling"] .wiki-wm-tile[data-effort-id="away"] .wiki-wm-partof')).toHaveText("part of moves work");
  await expect(boardCard(page).locator('[data-wm-lane="you"] .wiki-wm-tile[data-effort-id="waiting"] .wiki-wm-pill.warn')).toHaveText("1 decision · 4 d");
});

test("pressing F at 1280 gives five tracks with every column's content shown, with no repaint, and Esc brings the folds back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSettled(page, BOARD);
  const card = boardCard(page);
  await expect(card.locator(".wiki-wm-tile").first()).toBeAttached();
  expect(await trackCount(page)).toBe(2);
  await card.locator(".wiki-wm-board").evaluate((el) => el.setAttribute("data-before-f", ""));
  await page.keyboard.press("f");
  await expect(page.locator(".wiki-layout.focus-mode")).toHaveCount(1);
  console.log(`board inner width at 1280 under F: ${await boardInnerWidth(page)}`);
  await expect.poll(() => trackCount(page)).toBe(5);
  expect(await columnsShown(page)).toEqual(COLUMN_IDS);
  await expect(card.locator("[data-before-f]")).toHaveCount(1);
  await expectNoOverflow(page, "under F");
  // A folded column's own state is untouched, and its head reads as a heading.
  await expect(card.locator('[data-wm-lane="quiet"]')).not.toHaveAttribute("open", "");
  const head = card.locator('[data-wm-lane="quiet"] > summary');
  expect(await head.evaluate((el) => getComputedStyle(el).display)).toBe("flex");
  await head.click({ force: true });
  await expect(card.locator('[data-wm-lane="quiet"]')).not.toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect.poll(() => trackCount(page)).toBe(2);
  expect(await columnsShown(page)).toEqual(["you", "moving"]);
  await expect(card.locator("[data-before-f]")).toHaveCount(1);
});

test("a resize across the five-track width folds and unfolds with no repaint", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await openSettled(page, BOARD);
  const card = boardCard(page);
  await expect(card.locator(".wiki-wm-tile").first()).toBeAttached();
  expect(await columnsShown(page)).toEqual(COLUMN_IDS);
  await card.locator(".wiki-wm-board").evaluate((el) => el.setAttribute("data-before-resize", ""));
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(() => columnsShown(page)).toEqual(["you", "moving"]);
  await expect(card.locator("[data-before-resize]")).toHaveCount(1);
});

// Fix round 1 batch 3: where the columns land beside a tall Waiting on you.
const COL_GAP = 10;

/** Each column's box against the board's top-left, and where its own content ends. */
async function boardGeometry(page: Page) {
  return boardCard(page).locator(".wiki-wm-board").evaluate((board) => {
    const b = board.getBoundingClientRect();
    const cols = Array.from(board.querySelectorAll("details.wiki-wm-col")).map((c) => {
      const r = c.getBoundingClientRect();
      const kids = Array.from(c.children).filter((k) => k.tagName === "SUMMARY" || k.checkVisibility());
      return { id: c.getAttribute("data-wm-lane")!, left: r.left - b.left, top: r.top - b.top, bottom: r.bottom - b.top, slack: r.bottom - Math.max(...kids.map((k) => k.getBoundingClientRect().bottom)) };
    });
    return { height: b.height, cols: Object.fromEntries(cols.map((c) => [c.id, c])) };
  });
}

/** Waiting on you alone in the first track (tracks > 1), from 3 tracks Moving alone in
 *  the second, the rest row by row in the others, each row a gap below the tallest box
 *  above it, and nothing under the last. */
async function expectBoardLayout(page: Page, tracks: number, label: string): Promise<void> {
  const g = await boardGeometry(page);
  const at = (id: string) => g.cols[id]!;
  console.log(`${label}: ${COLUMN_IDS.map((id) => `${id} ${Math.round(at(id).top)}`).join(", ")}; board ${Math.round(g.height)}`);
  expect(at("you").left, `${label}: you left`).toBeCloseTo(0, 0);
  expect(at("you").top, `${label}: you top`).toBeCloseTo(0, 0);
  const spans = tracks >= 3 ? 2 : tracks > 1 ? 1 : 0;
  if (spans === 2) {
    expect(at("moving").top, `${label}: moving top`).toBeCloseTo(0, 0);
    expect(at("moving").left, `${label}: moving beside Waiting on you`).toBeGreaterThan(0);
  }
  const flowing = COLUMN_IDS.slice(spans);
  const inRows = tracks === 1 ? COLUMN_IDS.map((id) => [id]) : chunk(flowing, tracks - spans);
  let top = 0;
  for (const row of inRows) {
    for (const id of row) expect(Math.abs(at(id).top - top), `${label}: ${id} top ${at(id).top}, wanted ${top}`).toBeLessThanOrEqual(1);
    if (spans) for (const id of row) expect(at(id).left, `${label}: ${id} beside the spanning columns`).toBeGreaterThan(at(COLUMN_IDS[spans - 1]!).left);
    top = Math.max(...row.map((id) => at(id).bottom)) + COL_GAP;
  }
  const lowest = Math.max(...COLUMN_IDS.map((id) => at(id).bottom));
  expect(Math.abs(g.height - lowest), `${label}: board ${g.height}, lowest column ${lowest}`).toBeLessThanOrEqual(1);
  // A column ends where its content does (a tile's own bottom margin is inside it).
  for (const id of COLUMN_IDS) expect(at(id).slack, `${label}: ${id} is stretched`).toBeLessThanOrEqual(9);
}

function chunk<T>(xs: readonly T[], n: number): T[][] {
  return Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
}

for (const [label, width, f, tracks] of [
  ["1280", 1280, false, 2],
  ["1512", 1512, false, 3],
  ["1728", 1728, false, 4],
  ["1920", 1920, false, 5],
  ["1280 under F", 1280, true, 5],
  ["800 under F", 800, true, 3],
  ["700", 700, false, 1],
] as const) {
  test(`beside a tall Waiting on you at ${label}, the other columns land right under each other`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettled(page, BOARD_TALL);
    await expect(boardCard(page).locator(".wiki-wm-tile").first()).toBeAttached();
    if (f) {
      await page.keyboard.press("f");
      await expect.poll(() => trackCount(page)).toBe(tracks);
    }
    expect(await trackCount(page)).toBe(tracks);
    await expectBoardLayout(page, tracks, `tall ${label}`);
    await expectNoOverflow(page, label);
  });
}

for (const [width, tracks] of [[1280, 2], [1512, 3], [1728, 4], [700, 1]] as const) {
  test(`at ${width}, a Waiting on you the reader folds leaves no gap`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettled(page, BOARD_TALL);
    const you = boardCard(page).locator('[data-wm-lane="you"]');
    await you.locator("> summary").click();
    await expect(you).not.toHaveAttribute("open", "");
    await expectBoardLayout(page, tracks, `folded ${width}`);
  });
  test(`at ${width}, an empty Waiting on you leaves no gap`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettled(page, BOARD_NO_WAIT);
    await expect(boardCard(page).locator('[data-wm-lane="you"] .wiki-wm-col-none')).toBeVisible();
    await expectBoardLayout(page, tracks, `empty ${width}`);
  });
}

/** The tall map's Moving emptied: every effort that lands there is gone from the GET. */
async function dropMovingEfforts(page: Page): Promise<void> {
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { map: { efforts: { id: string }[] } } & Record<string, unknown>;
    const out = new Set(["kids", "kid-two", "kid-long", "kid-idle", "moving-a", "moving-b"]);
    await route.fulfill({ json: { ...body, map: { ...body.map, efforts: body.map.efforts.filter((e) => !out.has(e.id)) } } });
  });
}

// Fix round 2: at 3 and 4 tracks a tall Moving spans the rows too.
for (const [width, tracks] of [[1280, 2], [1512, 3], [1728, 4], [1920, 5]] as const) {
  // Shut by script: at 1920 no head can shut it, so a shut fold there comes from a narrower window.
  test(`at ${width}, a Moving with its fold shut leaves no gap`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettled(page, BOARD_TALL);
    const moving = boardCard(page).locator('[data-wm-lane="moving"]');
    await moving.evaluate((el: HTMLDetailsElement) => (el.open = false));
    await expect(moving).not.toHaveAttribute("open", "");
    await expectBoardLayout(page, tracks, `moving folded ${width}`);
  });
  test(`at ${width}, an empty Moving leaves no gap`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await dropMovingEfforts(page);
    await openSettled(page, BOARD_TALL);
    await expect(boardCard(page).locator('[data-wm-lane="moving"] .wiki-wm-col-none')).toBeAttached();
    await expectBoardLayout(page, tracks, `moving empty ${width}`);
  });
}

for (const [boardWidth, tracks] of [[619, 2], [620, 3], [829, 3], [830, 4], [1039, 4], [1040, 5]] as const) {
  test(`on a ${boardWidth} px board, ${tracks} tracks with the columns landing right under each other`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    await openSettled(page, BOARD_TALL);
    const board = boardCard(page).locator(".wiki-wm-board");
    await board.evaluate((el, w) => (el.style.width = `${w}px`), boardWidth);
    expect(await boardInnerWidth(page)).toBe(boardWidth);
    expect(await trackCount(page)).toBe(tracks);
    await expectBoardLayout(page, tracks, `board ${boardWidth}`);
  });
}

for (const [width, tracks] of [[1512, 3], [1728, 4]] as const) {
  test(`at ${width}, Cooling the reader opens keeps Quiet and Shipped right under the row above`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettled(page, BOARD_TALL);
    const cooling = boardCard(page).locator('[data-wm-lane="cooling"]');
    await cooling.locator("> summary").click();
    await expect(cooling).toHaveAttribute("open", "");
    expect(await columnsShown(page)).toEqual(["you", "moving", "cooling"]);
    await expectBoardLayout(page, tracks, `cooling open ${width}`);
  });
}

for (const width of [600, 420]) {
  test(`at a ${width} window the track fits the board, however narrow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettled(page, BOARD_TALL);
    const cols = boardCard(page).locator(".wiki-wm-cols");
    await expect(boardCard(page).locator(".wiki-wm-tile").first()).toBeAttached();
    const r = await cols.evaluate((el) => {
      const right = el.getBoundingClientRect().right;
      return {
        board: el.getBoundingClientRect().width,
        tracks: getComputedStyle(el).gridTemplateColumns.split(" ").map(parseFloat),
        past: Array.from(el.querySelectorAll("*")).filter((k) => k.getClientRects().length > 0 && k.getBoundingClientRect().right > right + 0.5).map((k) => k.getAttribute("class")),
      };
    });
    console.log(`window ${width}: board ${r.board}, tracks ${r.tracks.join(" ")}`);
    expect(r.tracks).toHaveLength(1);
    expect(r.tracks[0]!).toBeLessThanOrEqual(r.board + 0.5);
    // At 420 the page leaves the card no width at all, so there is nothing to hold it to.
    if (r.board > 0) expect(r.past).toEqual([]);
  });
}

for (const column of [200, 245, 500]) {
  test(`a compact row in a ${column} px column is two lines: name and sparkline, then pills`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSettled(page, BOARD_TALL);
    const card = boardCard(page);
    await expect(card.locator('.wiki-wm-kid[data-effort-id="kid-two"]')).toBeAttached();
    const rows = await card.locator(".wiki-wm-cols").evaluate((grid, column) => {
      (grid as HTMLElement).style.gridTemplateColumns = `${column}px`;
      return Array.from(grid.querySelectorAll<HTMLElement>(".wiki-wm-kid")).map((row, i, all) => {
        const box = (sel: string) => row.querySelector(sel)!.getBoundingClientRect();
        const name = row.querySelector<HTMLElement>(".wiki-wm-effort-name")!;
        const before = all[i - 1];
        return {
          id: row.dataset.effortId!,
          h: row.getBoundingClientRect().height,
          right: row.getBoundingClientRect().right,
          name: box(".wiki-wm-effort-name"),
          text: name.textContent,
          title: name.title,
          clipped: name.scrollWidth > name.clientWidth,
          spark: box("svg.wiki-wm-spark"),
          pills: box(".wiki-wm-pills"),
          pillCount: row.querySelectorAll(".wiki-wm-pill").length,
          rule: getComputedStyle(row).borderTopStyle + " " + getComputedStyle(row).borderTopWidth,
          ruleColor: getComputedStyle(row).borderTopColor,
          gapAbove: before ? box(".wiki-wm-effort-name").top - before.querySelector(".wiki-wm-pills")!.getBoundingClientRect().bottom : null,
        };
      });
    }, column);
    console.log(`compact row at ${column}: ${rows.map((r) => `${r.id} ${r.h.toFixed(1)} (${r.pillCount} pills)`).join(", ")}`);
    expect(rows.map((r) => r.id).sort()).toEqual(["kid-idle", "kid-long", "kid-two"]);
    expect(rows.find((r) => r.id === "kid-two")!.pillCount).toBe(2);
    for (const r of rows) {
      expect(r.h, `${r.id} height`).toBeLessThanOrEqual(46);
      expect(r.name.height, `${r.id} name is one line`).toBeLessThanOrEqual(20);
      expect(r.pills.height, `${r.id} pills are one line`).toBeLessThanOrEqual(20);
      expect(r.spark.width, `${r.id} sparkline width`).toBeCloseTo(56, 0);
      expect(r.spark.height, `${r.id} sparkline height`).toBeCloseTo(12, 0);
      expect(r.spark.left, `${r.id} sparkline clear of the name`).toBeGreaterThanOrEqual(r.name.right);
      expect(Math.abs(r.spark.right - r.right), `${r.id} sparkline ends the line`).toBeLessThanOrEqual(1);
      expect(r.spark.bottom, `${r.id} sparkline above the pills`).toBeLessThanOrEqual(r.pills.top);
      expect(r.title, `${r.id} keeps its whole name`).toBe(r.text);
    }
    if (column <= 245) expect(rows.find((r) => r.id === "kid-long")!.clipped).toBe(true);
    // Rows read apart: a rule between them, and air from the pills above to the next name.
    const ruled = await token(page, "--border-secondary");
    expect(rows[0]!.rule, "no rule above the first row").toBe("none 0px");
    for (const r of rows.slice(1)) {
      expect(r.rule, `${r.id} rule`).toBe("solid 1px");
      expect(r.ruleColor, `${r.id} rule colour`).toBe(ruled);
      expect(r.gapAbove!, `${r.id} gap`).toBeGreaterThanOrEqual(8);
    }
  });
}

// Fix round 1 batch 2: the wide board's rules and its heads.
test("the wide board's rules all sit behind @supports selector(::details-content), and without them the folds work at 1920", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await openStart(page, BOARD);
  const card = boardCard(page);
  await expect(card.locator(".wiki-wm-tile").first()).toBeAttached();
  expect(await columnsShown(page)).toEqual(COLUMN_IDS);
  // Chromium supports the selector, so no run here is a browser without it. This
  // is the stylesheet's structure, then what such a browser does: it drops the block.
  const shape = await page.evaluate(() => {
    const out = { supported: CSS.supports("selector(::details-content)"), guarded: [] as string[], bare: [] as string[] };
    const walk = (rules: CSSRuleList, guarded: boolean, wide: boolean) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSSupportsRule) walk(r.cssRules, guarded || r.conditionText === "selector(::details-content)", wide);
        else if (r instanceof CSSContainerRule) walk(r.cssRules, guarded, wide || (r.containerName === "wmboard" && r.containerQuery === "(min-width: 1040px)"));
        else if (r instanceof CSSMediaRule) walk(r.cssRules, guarded, wide);
        else if (wide && r instanceof CSSStyleRule) (guarded ? out.guarded : out.bare).push(r.selectorText);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try { rules = sheet.cssRules; } catch { /* a cross-origin sheet */ }
      if (rules) walk(rules, false, false);
    }
    return out;
  });
  expect(shape.supported).toBe(true);
  expect(shape.bare).toEqual([]);
  expect(shape.guarded.sort()).toEqual([".wiki-wm-col > summary", ".wiki-wm-col::details-content"]);
  await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try { rules = sheet.cssRules; } catch { /* a cross-origin sheet */ }
      if (!rules) continue;
      for (let i = rules.length - 1; i >= 0; i--) {
        const r = rules[i];
        if (r instanceof CSSSupportsRule && r.conditionText === "selector(::details-content)") sheet.deleteRule(i);
      }
    }
  });
  expect(await columnsShown(page)).toEqual(["you", "moving"]);
  await card.locator('[data-wm-lane="cooling"] > summary').click();
  await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
  expect(await columnsShown(page)).toEqual(["you", "moving", "cooling"]);
});

/** What Chromium's accessibility tree says of the board's columns. */
async function columnsInAxTree(page: Page): Promise<{ groups: string[]; triangles: string[] }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Accessibility.enable");
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  await cdp.detach();
  const named = (role: string) =>
    nodes
      .filter((n) => !n.ignored && n.role?.value === role)
      .map((n) => String(n.name?.value ?? ""))
      .filter((name) => /^(waiting on you|moving|cooling|quiet|shipped) \d+$/i.test(name));
  return { groups: named("group"), triangles: named("DisclosureTriangle") };
}

const COLUMN_NAMES = ["Waiting on you 3", "Moving 3", "Cooling 1", "Quiet 1", "Shipped 1"];

test("from 1040 px Tab goes link to link and no key flips a fold; at 1280 a head focuses and Enter opens it", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await openSettled(page, BOARD);
  const card = boardCard(page);
  const links = card.locator(".wiki-wm-board a");
  const total = await links.count();
  expect(total).toBeGreaterThan(5);
  await links.first().focus();
  const stops: string[] = [];
  for (let i = 1; i < total; i++) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate(() => document.activeElement!.tagName));
  }
  expect(stops).toEqual(Array(total - 1).fill("A"));
  // A head takes no focus even when asked, so Enter and Space have nothing to flip.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  for (const [id, key] of [["you", "Enter"], ["cooling", "Space"]] as const) {
    const head = card.locator(`[data-wm-lane="${id}"] > summary`);
    await head.focus();
    await expect(head).not.toBeFocused();
    expect(await head.getAttribute("tabindex")).toBeNull();
    await page.keyboard.press(key);
  }
  await expect(card.locator('[data-wm-lane="you"]')).toHaveAttribute("open", "");
  await expect(card.locator('[data-wm-lane="cooling"]')).not.toHaveAttribute("open", "");
  // The tree names each column and holds no collapsed triangle.
  expect(await columnsInAxTree(page)).toEqual({ groups: COLUMN_NAMES, triangles: [] });
  // At 1280 the columns fold again, and a head opens its column.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(() => columnsShown(page)).toEqual(["you", "moving"]);
  const narrow = await columnsInAxTree(page);
  expect(narrow.groups).toEqual(COLUMN_NAMES);
  expect(narrow.triangles.map((t) => t.toLowerCase())).toEqual(COLUMN_NAMES.map((n) => n.toLowerCase()));
  const head = card.locator('[data-wm-lane="cooling"] > summary');
  await head.focus();
  await expect(head).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
  expect(await columnsShown(page)).toEqual(["you", "moving", "cooling"]);
});

test("a column's name follows its count through a repaint", async ({ page }) => {
  const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
  await openStart(page, BOARD);
  const card = boardCard(page);
  await expect(card.locator('[data-wm-lane="you"]')).toHaveAttribute("aria-label", "Waiting on you 3");
  release();
  await expect(card.locator('[data-wm-lane="you"] .wiki-wm-count')).toHaveText("1");
  await expect(card.locator('[data-wm-lane="you"]')).toHaveAttribute("aria-label", "Waiting on you 1");
});

test("a head focused while the board crosses to wide lets go of focus and keeps no tabindex", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSettled(page, BOARD);
  const head = boardCard(page).locator('[data-wm-lane="cooling"] > summary');
  await head.focus();
  await page.keyboard.press("f");
  await expect(page.locator(".wiki-layout.focus-mode")).toHaveCount(1);
  await expect.poll(() => trackCount(page)).toBe(5);
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  expect(await head.getAttribute("tabindex")).toBeNull();
});

test("a summary key saved at narrow and resolved at wide lands on the card's heading, writes no tabindex and throws nothing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSettled(page, BOARD);
  const card = boardCard(page);
  await card.locator('[data-wm-done="0"]').click();
  // One task: the head is still document.activeElement when the wide paint reads
  // its key, since the browser moves focus off an inert element only at the next frame.
  await page.evaluate(() => {
    (document.querySelector('#wikiWorkCard [data-wm-lane="cooling"] > summary') as HTMLElement).focus();
    document.querySelector(".wiki-layout")!.classList.add("focus-mode");
    (document.getElementById("wikiWorkMapRestore") as HTMLElement).click();
  });
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  const head = card.locator('[data-wm-lane="cooling"] > summary');
  await expect(head).not.toBeFocused();
  expect(await head.getAttribute("tabindex")).toBeNull();
  await expect(card.locator(".wiki-wn-title")).toBeFocused();
  await expect(card.locator(".wiki-wn-title")).not.toHaveAttribute("data-wm-parked", "");
  expect(errors).toEqual([]);
  // Back at narrow it is an ordinary head.
  await page.evaluate(() => document.querySelector(".wiki-layout")!.classList.remove("focus-mode"));
  await expect.poll(() => trackCount(page)).toBe(2);
  await head.focus();
  await expect(head).toBeFocused();
});

test("a fold the reader opens shows its content, and stays open across a repaint", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openStart(page, BOARD);
  const card = boardCard(page);
  await card.locator('[data-wm-lane="quiet"] > summary').click();
  expect(await columnsShown(page)).toEqual(["you", "moving", "quiet"]);
  await card.locator('[data-wm-done="0"]').click();
  await expect(card.locator("[data-wm-need]")).toHaveCount(1);
  await expect(card.locator('[data-wm-lane="quiet"]')).toHaveAttribute("open", "");
  expect(await columnsShown(page)).toEqual(["you", "moving", "quiet"]);
});

test("an effort leaves Waiting on you when the stubbed checks arrive, and goes to the column of its state", async ({ page }) => {
  const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
  await openStart(page, BOARD);
  const card = boardCard(page);
  const inCol = (col: string, id: string) => card.locator(`[data-wm-lane="${col}"] [data-effort-id="${id}"]`);
  await expect(inCol("you", "to-moving")).toHaveCount(1);
  await expect(inCol("you", "to-cooling")).toHaveCount(1);
  await expect(card.locator('[data-wm-lane="you"] .wiki-wm-count')).toHaveText("3");
  release();
  await expect(inCol("moving", "to-moving")).toHaveCount(1);
  await expect(inCol("cooling", "to-cooling")).toHaveCount(1);
  await expect(inCol("you", "to-moving")).toHaveCount(0);
  // The Needs you cards keep their layout and P2's marks.
  await expect(card.locator(".wiki-wm-need.gh-done")).toHaveCount(2);
  // Its wait keeps the other one there.
  await expect(card.locator('[data-wm-lane="you"] .wiki-wm-count')).toHaveText("1");
});

test("focus on an effort link follows the effort to its new open column", async ({ page }) => {
  const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
  await openStart(page, BOARD);
  const card = boardCard(page);
  const link = card.locator('a[data-effort-link="to-moving"]');
  await link.focus();
  await card.locator(".wiki-wm-board").evaluate((el) => el.setAttribute("data-before", ""));
  release();
  await expect(card.locator('[data-wm-lane="moving"] a[data-effort-link="to-moving"]')).toBeFocused();
  await expect(card.locator("[data-before]")).toHaveCount(0);
});

test("focus on an effort link that moves into a folded column lands on that column's head, and stays when the fold opens", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
  await openStart(page, BOARD);
  const card = boardCard(page);
  await card.locator('a[data-effort-link="to-cooling"]').focus();
  release();
  const head = card.locator('[data-wm-lane="cooling"] > summary');
  await expect(card.locator('[data-wm-lane="cooling"] [data-effort-id="to-cooling"]')).toHaveCount(1);
  await expect(head).toBeFocused();
  expect(await head.evaluate((el) => el.hasAttribute("data-wm-parked"))).toBe(false);
  await page.keyboard.press("Enter");
  await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
  // The next repaint leaves the reader on the head.
  await card.locator('[data-wm-done="0"]').click();
  await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
});

for (const native of [true, false]) {
  test(`a link that moves into a folded column stays reachable by keyboard once the fold opens, ${native ? "with no tabindex ever written to it" : "in a browser without checkVisibility"}`, async ({ page }) => {
    if (!native) await page.addInitScript(() => Reflect.deleteProperty(Element.prototype, "checkVisibility"));
    await page.setViewportSize({ width: 1280, height: 900 });
    const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
    await openStart(page, BOARD);
    const card = boardCard(page);
    const link = card.locator('a[data-effort-link="to-cooling"]');
    await expect(link).toBeAttached();
    expect(await page.evaluate(() => typeof Element.prototype.checkVisibility === "function")).toBe(native);
    // Every tabindex write in the card, including one taken back at once.
    await card.evaluate((el) => {
      const writes: string[] = [];
      (window as unknown as { __tabindexWrites: string[] }).__tabindexWrites = writes;
      new MutationObserver((ms) => ms.forEach((m) => writes.push((m.target as Element).getAttribute("data-effort-link") ?? (m.target as Element).tagName))).observe(el, { subtree: true, attributes: true, attributeFilter: ["tabindex"] });
    });
    await link.focus();
    release();
    const head = card.locator('[data-wm-lane="cooling"] > summary');
    await expect(card.locator('[data-wm-lane="cooling"] [data-effort-id="to-cooling"]')).toHaveCount(1);
    await expect(head).toBeFocused();
    expect(await link.getAttribute("tabindex")).toBeNull();
    if (native) expect(await page.evaluate(() => (window as unknown as { __tabindexWrites: string[] }).__tabindexWrites)).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
    // Tab walks the opened fold: the column holds only what the fixture put there.
    const reached = async () => link.evaluate((el) => document.activeElement === el);
    let at = false;
    for (let i = 0; i < 4 && !at; i++) {
      await page.keyboard.press("Tab");
      at = await reached();
    }
    expect(at).toBe(true);
  });
}

test("a link that moves into a column the wide card shows keeps its focus", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
  await openStart(page, BOARD);
  const card = boardCard(page);
  await card.locator('a[data-effort-link="to-cooling"]').focus();
  release();
  await expect(card.locator('[data-wm-lane="cooling"] [data-effort-id="to-cooling"]')).toHaveCount(1);
  await expect(card.locator('[data-wm-lane="cooling"] a[data-effort-link="to-cooling"]')).toBeFocused();
});

test("an adopt that changes nothing on the card keeps its nodes and the reader's selection", async ({ page }) => {
  await page.clock.install();
  await openSettled(page, BOARD_QUIET);
  const card = boardCard(page);
  const link = card.locator('a[data-effort-link="moves"]');
  await link.evaluate((el) => {
    (window as unknown as { __held: Element }).__held = el;
    getSelection()!.selectAllChildren(el);
  });
  const before = await card.innerHTML();
  await forceAdopt(page, BOARD_QUIET);
  // Byte-equal markup, or this test would be about a repaint that had a reason.
  expect(await card.innerHTML()).toBe(before);
  expect(await page.evaluate(() => (window as unknown as { __held: Element }).__held.isConnected)).toBe(true);
  expect(await page.evaluate(() => getSelection()!.toString())).toBe("moves work");
});

test("focus on a column's head survives the repaint that changes the column", async ({ page }) => {
  const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
  await openStart(page, BOARD);
  const head = boardCard(page).locator('[data-wm-lane="you"] > summary');
  await head.focus();
  release();
  await expect(boardCard(page).locator('[data-wm-lane="you"] .wiki-wm-count')).toHaveText("1");
  await expect(head).toBeFocused();
});

test("a checks answer that changes no column leaves the board alone", async ({ page }) => {
  await stubChecks(page, () => checksBody({ needs: [] }));
  await openStart(page, BOARD);
  const card = boardCard(page);
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("0");
  await card.locator(".wiki-wm-board").evaluate((el) => el.setAttribute("data-kept", ""));
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  await expect(card.locator("[data-kept]")).toHaveCount(1);
});

test("✓ moves an effort out of Waiting on you, and restoring brings it back", async ({ page }) => {
  await openStart(page, BOARD);
  const card = boardCard(page);
  await card.locator('[data-wm-done="0"]').click();
  await expect(card.locator('[data-wm-lane="moving"] [data-effort-id="to-moving"]')).toHaveCount(1);
  await card.locator("#wikiWorkMapRestore").click();
  await expect(card.locator('[data-wm-lane="you"] [data-effort-id="to-moving"]')).toHaveCount(1);
});

test("an adopt that brings a page a wait moves its effort, and focus on its link follows", async ({ page }) => {
  await page.clock.install();
  await openStart(page, BOARD_ADOPT);
  const card = boardCard(page);
  await expect(card.locator('[data-wm-lane="moving"] [data-effort-id="moves"]')).toHaveCount(1);
  await card.locator('a[data-effort-link="moves"]').focus();
  await writeFile(path.join(roots[BOARD_ADOPT]!, "plans/gamma.mdx"), waitPage("Gamma plan", ["O1"], "2026-01-02"), "utf8");
  await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(card.locator('[data-wm-lane="you"] [data-effort-id="moves"]')).toHaveCount(1);
  await expect(card.locator('a[data-effort-link="moves"]')).toBeFocused();
});

for (const forced of [false, true]) {
  test(`every effort has a sparkline that fills its tile${forced ? ", under forced colors" : ""}`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    if (forced) await page.emulateMedia({ forcedColors: "active" });
    await openSettled(page, BOARD);
    const card = boardCard(page);
    await expect(card.locator(".wiki-wm-tile").first()).toBeAttached();
    const r = await card.locator(".wiki-wm-effort").evaluateAll((efforts) =>
      efforts.map((e) => {
        const svg = e.querySelector("svg.wiki-wm-spark")!;
        const box = svg.getBoundingClientRect();
        const rects = Array.from(svg.querySelectorAll("rect"));
        const painted = rects.filter((b) => b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().height > 0).length;
        const fills = new Set(rects.map((b) => getComputedStyle(b).fill));
        const inner = e.getBoundingClientRect().width;
        return { id: e.getAttribute("data-effort-id"), role: svg.getAttribute("role"), label: svg.getAttribute("aria-label"), bars: rects.length, painted, fills: [...fills], share: box.width / inner, h: box.height };
      }),
    );
    expect(r.length).toBe(9);
    for (const s of r) {
      expect(s, `${s.id}`).toMatchObject({ role: "img", label: "Activity, last 28 days", bars: 28, painted: 28 });
      // A compact row's sparkline shares a line with the name, at a fixed width.
      if (s.id !== "sub") expect(s.share, `${s.id}`).toBeGreaterThan(0.75);
    }
    const moves = r.find((s) => s.id === "moves")!;
    const none = r.find((s) => s.id === "still")!;
    expect(none.fills).toHaveLength(1);
    expect(moves.fills).toHaveLength(2);
    if (forced) {
      const system = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.color = "CanvasText";
        document.body.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      });
      expect(moves.fills).toContain(system);
      // The bar must not sit on the tile in its own colour.
      const tile = await card.locator('.wiki-wm-tile[data-effort-id="moves"]').evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(moves.fills.every((f) => f !== tile)).toBe(true);
    }
  });
}

/** Every element in the card that paints its own text, measured where it sits
 *  (no `.first()`: one class can sit on two boxes). Returns the ratios and the
 *  classes of every visible element, for the coverage check. */
async function sweepCard(page: Page, label: string): Promise<{ low: string[]; min: number; classes: string[] }> {
  const card = page.locator("#wikiWorkCard");
  const measure = await paintedMeasure(page);
  const { what, ratios, classes } = await card.evaluate((root, measure) => {
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
  const low = ratios.flatMap((r, i) => (r < 4.5 ? [`${label}: ${what[i]} ${r.toFixed(2)}`] : []));
  const min = Math.min(...ratios);
  return { low, min, classes };
}

/** The `.wiki-wm-*` / `.wm-state-*` classes the stylesheet styles, and the
 *  shared `.wiki-wn-*` ones it restyles inside the card: each must be painted
 *  in some swept state, or the sweep never measured it. */
async function styledCardClasses(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        const sel = (rule as CSSStyleRule).selectorText;
        if (!sel) continue;
        for (const m of sel.matchAll(/\.((?:wiki-wm|wm-state)-[\w-]+)/g)) out.add(m[1]!);
        for (const part of sel.split(",")) if (part.includes(".wiki-workcard")) for (const m of part.matchAll(/\.(wiki-wn-[\w-]+)/g)) out.add(m[1]!);
      }
    }
    return [...out].sort();
  });
}

for (const theme of THEMES) {
  test(`legible in the ${theme.label} theme, in every state the card paints`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme.scheme });
    await page.addInitScript((v) => {
      if (v === null) localStorage.removeItem("muninn-theme");
      else localStorage.setItem("muninn-theme", v);
    }, theme.stored);
    await page.route("**/api/wiki/work-map?*", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - 31 * HOUR, lastAttempt: { at: Date.now() - 10 * 60_000, outcome: "failed", error: "model timed out" } } });
    });
    let posts = 0;
    await page.route("**/api/wiki/work-map/refresh*", (route) =>
      ++posts === 1
        ? route.fulfill({ status: 429, json: { error: "ran recently", lastSuccessAt: Date.now() - 5 * 60_000, retryAfterMs: 5 * 60_000 } })
        : route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } }),
    );
    // Every mark and note the GitHub check paints: bad tone, remedy, three note tones.
    let answerNotCurrent = false;
    let answerAllClear = false;
    await stubChecks(page, () =>
      answerAllClear ? checksBody({ checked: 5, unlinked: 197, unlinkedRows: GH_UNLINKED, refreshing: answerNotCurrent }) : checksBody({
        notChecked: { reason: "auth", repos: ["acme/gears"] },
        contradictions: [{ page: "plans/alpha.mdx", pr: 1, repo: "acme/other", rowState: "open", ghState: "MERGED", mergedAt: GH_MERGED_AT }],
        uncheckedRows: GH_UNCHECKED,
        unlinkedRows: GH_UNLINKED,
        needs: [
          { kind: "decision", title: "Settle ⟦plans/alpha.mdx⟧", pr: 1, state: "MERGED", mergedAt: GH_MERGED_AT, asksForIt: true },
          { kind: "decision", title: "Settle ⟦plans/alpha.mdx⟧", pr: 2, state: "CLOSED", mergedAt: null, asksForIt: true },
          { kind: "resume", title: "Resume beta", pr: 3, state: "MERGED", mergedAt: GH_MERGED_AT, asksForIt: true },
        ],
      }),
    );
    await page.clock.install();
    await openStart(page, SWEEP);
    const card = page.locator("#wikiWorkCard");
    await expect(card.locator(".wiki-wm-stale")).toBeVisible();
    await expect(card.locator(".wiki-wm-ghnote")).toHaveCount(3);
    expect(await card.locator("a.wiki-wm-effort-name").first().evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--accent-light"));
    expect(await card.locator(".wiki-wm-summary a").first().evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--accent-light"));
    const low: string[] = [];
    const seen = new Set<string>();
    const mins: number[] = [];
    const labels: string[] = [];
    const sweep = async (label: string) => {
      const r = await sweepCard(page, label);
      low.push(...r.low);
      mins.push(r.min);
      labels.push(label);
      r.classes.forEach((c) => seen.add(c));
    };
    // The map: every lane open, the long why opened, the last attempt's warning.
    await card.evaluate((root) => root.querySelectorAll("details").forEach((d) => (d.open = true)));
    await card.locator(".wiki-wm-why-more:visible").click();
    await expect(card.locator(".wiki-wm-why.open")).toHaveCount(1);
    await expect(card.locator("#wikiWorkMapStatus.warn")).toBeVisible();
    await card.locator('[data-wm-cell="decisions"]').click();
    await expect(card.locator("[data-wm-drill-more]")).toBeVisible();
    await sweep("map");
    // The GitHub list: a group's line shut, then both groups open with their +N more.
    await card.locator('[data-wm-cell="github"]').click();
    await expect(card.locator('[data-wm-drill="github"] .wiki-wm-drill-row')).toHaveCount(1);
    await sweep("GitHub list shut");
    await card.locator('[data-wm-gh-more="unchecked"]').click();
    await card.locator('[data-wm-gh-more="unlinked"]').click();
    await expect(card.locator('[data-wm-drill="github"] .wiki-wm-drill-row')).toHaveCount(17);
    await expect(card.locator('[data-wm-gh-group="contradictions"] .wiki-wm-drill-group-head')).toBeVisible();
    await sweep("GitHub list open");
    // ↻ hovered, then focused from the keyboard.
    await card.locator("#wikiWorkMapRefresh").hover();
    await expect.poll(async () => card.locator("#wikiWorkMapRefresh").evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--accent-light"));
    await sweep("↻ hover");
    await page.mouse.move(0, 0);
    await page.keyboard.press("Shift");
    await card.locator("#wikiWorkMapRefresh").focus();
    expect(await card.locator("#wikiWorkMapRefresh").evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    await sweep("↻ focus-visible");
    // ↻ refused (warn), then running (plain), ↻ disabled.
    await card.locator("#wikiWorkMapRefresh").click();
    await expect(card.locator("#wikiWorkMapStatus")).toHaveText("Ran 5 min ago — try again in 5 min.");
    await sweep("refusal");
    const posted = page.waitForResponse("**/api/wiki/work-map/refresh*");
    await card.locator("#wikiWorkMapRefresh").click();
    await posted;
    await expect(card.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
    await page.waitForTimeout(200);
    await sweep("running");
    // Every item done: the restore control and the empty line.
    while ((await card.locator("[data-wm-done]").count()) > 0) await card.locator("[data-wm-done]").first().click();
    await expect(card.locator(".wiki-wm-empty")).toBeVisible();
    await expect(card.locator("#wikiWorkMapRestore")).toBeVisible();
    await sweep("empty");
    // The same GET answering a themes map (theme map P2): What you're
    // following paints its own classes, every lane open.
    await page.unroute("**/api/wiki/work-map?*");
    await page.route("**/api/wiki/work-map?*", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      // Run now: the seeded map is 30 h old, which until Tuesday morning falls in last week, so no slot is current.
      await route.fulfill({ json: { ...body, organizable: false, map: sweepThemesMap(Date.now()) } });
    });
    await page.reload();
    await expect(card.locator(".wiki-wn-title")).toHaveText("What you’re following");
    await card.evaluate((root) => root.querySelectorAll("details").forEach((d) => (d.open = true)));
    await expect(card.locator(".wiki-wm-conn")).toHaveCount(1);
    // The running week is framed dashed, and the hidden weeks read «+N earlier».
    const cur = card.locator(".wiki-wm-theme").first().locator(".wiki-wm-slot.current");
    expect(await cur.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("dashed");
    await expect(card.locator(".wiki-wm-theme").first().locator(".wiki-wm-weeks-earlier")).toHaveText("+4 earlier");
    await sweep("themes");
    // The GET answered 5xx: the card's error and Retry.
    await page.unroute("**/api/wiki/work-map?*");
    await page.route("**/api/wiki/work-map?*", (route) => route.fulfill({ status: 503, json: { error: "down" } }));
    await page.reload();
    await expect(card.locator("#wikiWorkMapRetry")).toBeVisible();
    await sweep("error");
    await card.locator("#wikiWorkMapRetry").hover();
    await expect.poll(async () => card.locator("#wikiWorkMapRetry").evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--accent-light"));
    await sweep("Retry hover");
    // A wiki taking no answers: the two cells' «owner not set».
    await page.unroute("**/api/wiki/work-map?*");
    await openStart(page, STRIP_OFF);
    await expect(card.locator('[data-wm-cell="decisions"] b')).toHaveText("owner not set");
    await sweep("owner not set");
    // The GitHub list with no contradiction: its counts line.
    answerAllClear = true;
    await openStart(page, SWEEP);
    await card.locator('[data-wm-cell="github"]').click();
    await expect(card.locator(".wiki-wm-drill-counts")).toBeVisible();
    await sweep("GitHub all clear");
    // The same list on an answer that is no longer current: its line.
    answerNotCurrent = true;
    await openStart(page, SWEEP);
    const github = card.locator('[data-wm-cell="github"]');
    await expect
      .poll(async () => {
        await page.clock.runFor(15_000);
        return github.innerText();
      })
      .toContain("not refreshed");
    await github.click();
    await expect(card.locator(".wiki-wm-drill-stale")).toBeVisible();
    await sweep("GitHub not current");
    // A work effort's state chip paints on the effort page alone: that page's spec sweeps and pins all three.
    expect((await styledCardClasses(page)).filter((c) => !seen.has(c) && !["wm-state-active", "wm-state-blocked", "wm-state-shipped"].includes(c))).toEqual([]);
    console.log(`contrast min ${theme.label}: ${Math.min(...mins).toFixed(2)} (${labels.map((l, i) => `${l} ${mins[i]!.toFixed(2)}`).join(", ")})`);
    expect(low).toEqual([]);
  });
}

// Non-text marks need 3:1 (WCAG 1.4.11), a zero bar included: it is the row's baseline.
// A computed fill says nothing about a bar thinner than its pixels, so this reads paint.
function contrastOfRgb(a: number[], b: number[]): number {
  const lum = (c: number[]) => {
    const [r, g, bl] = c.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** A locator's device pixels as painted, decoded on a blank page. */
async function paintedPixels(l: Locator): Promise<{ w: number; h: number; px: number[] }> {
  const png = (await l.screenshot()).toString("base64");
  const blank = await l.page().context().newPage();
  try {
    return await blank.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      return { w: c.width, h: c.height, px: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
    }, png);
  } finally {
    await blank.close();
  }
}

/** The pixel row holding the most runs clearing 3:1 against the commonest colour, the
 *  background. A day's bar is a run, so 28 runs is 28 bars each read as its own day. */
async function sparkRuns(l: Locator): Promise<{ runs: number; peak: number; lowest: number; inked: number }> {
  const { w, h, px } = await paintedPixels(l);
  const at = (x: number, y: number) => px.slice((y * w + x) * 4, (y * w + x) * 4 + 3);
  const tally = new Map<string, number>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tally.set(at(x, y).join(), (tally.get(at(x, y).join()) ?? 0) + 1);
  const bg = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0].split(",").map(Number);
  let best = { runs: 0, peak: 0, lowest: 0, inked: 0 };
  for (let y = 0; y < h; y++) {
    const ratios = Array.from({ length: w }, (_, x) => contrastOfRgb(at(x, y), bg));
    const inRun = ratios.flatMap((r, x) => (r >= 3 ? [x] : []));
    const runs = inRun.filter((x, i) => i === 0 || inRun[i - 1] !== x - 1).length;
    const peak = Math.max(...ratios);
    if (runs > best.runs || (runs === best.runs && peak > best.peak)) best = { runs, peak, lowest: inRun.length ? Math.min(...inRun.map((x) => ratios[x]!)) : 0, inked: ratios.filter((r) => r >= 1.2).length / w };
  }
  return best;
}

for (const scale of [1, 2]) {
  test.describe(`at device scale ${scale}`, () => {
    test.use({ deviceScaleFactor: scale });
    for (const theme of THEMES.slice(0, 4)) {
      test(`each of a sparkline's 28 bars paints as its own day at 3:1, on a tile and a compact row, in the ${theme.label} theme`, async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.emulateMedia({ colorScheme: theme.scheme });
        await page.addInitScript((v) => localStorage.setItem("muninn-theme", v!), theme.stored);
        await openSettled(page, BOARD_TALL);
        const card = boardCard(page);
        const row = (id: string) => card.locator(`.wiki-wm-kid[data-effort-id="${id}"] > svg.wiki-wm-spark`);
        const tile = (id: string) => card.locator(`.wiki-wm-tile[data-effort-id="${id}"] > svg.wiki-wm-spark`);
        const read = async (targets: [string, Locator][]) => {
          for (const [what, l] of targets) {
            const r = await sparkRuns(l);
            console.log(`spark ${theme.label} x${scale} ${what}: ${r.runs} bars, peak ${r.peak.toFixed(2)}, lowest ${r.lowest.toFixed(2)}`);
            expect(r.runs, `${what} at x${scale}: peak ${r.peak.toFixed(2)}`).toBe(28);
          }
        };
        await read([["row, all zero", row("kid-idle")], ["row, one bar", row("kid-two")], ["tile, all zero", tile("moving-b")], ["tile, one bar", tile("moving-a")]]);
        // The narrowest tile a track gives.
        await card.locator(".wiki-wm-cols").evaluate((el) => ((el as HTMLElement).style.gridTemplateColumns = "200px"));
        await read([["200 px tile, all zero", tile("moving-b")], ["200 px tile, one bar", tile("moving-a")]]);
      });
    }
  });
}

// A crisp 1 px bar scaled below a pixel can miss every pixel centre, so below 1x the row
// keeps its soft bars: fainter than 3:1, but each still paints. Emulated deviceScaleFactor
// misreads fractional scales, so this pins the ink and not its ratio.
test.describe("at device scale 0.9", () => {
  test.use({ deviceScaleFactor: 0.9 });
  test("a compact row's baseline keeps its ink", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSettled(page, BOARD_TALL);
    const r = await sparkRuns(boardCard(page).locator('.wiki-wm-kid[data-effort-id="kid-idle"] > svg.wiki-wm-spark'));
    console.log(`spark x0.9 row: inked ${r.inked.toFixed(2)}, peak ${r.peak.toFixed(2)}`);
    expect(r.inked).toBeGreaterThan(0.8);
  });
});
