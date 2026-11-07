/**
 * The Your work card (plan `muninn-wiki-work-map`, P2) as wired into the /wiki
 * start view.
 *
 * The rendering rules are unit-tested (`wiki-work-card.test.ts`); what only a
 * real page can hold:
 *
 *  1. **The health strip (your-work board P1)**: its cells count the live
 *     listing, a cell opens its list and «+N more» expands it, a wiki taking no
 *     answers reads «owner not set», an adopt repaints the count, a themes map
 *     has no strip and keeps its markup when only the strip's inputs change.
 *     Focus on a cell or on «+N more», and an expanded list, survive that repaint.
 *     A long title wraps in the list; focus on an open cell shows in every theme,
 *     hover answers on an enabled cell, and forced colors keep open and focus apart.
 *  2. **The GitHub check (your-work board P2)**, with its GET stubbed: the fifth
 *     cell in one row with the others, its list, the struck, warning and neutral
 *     marks, «checking…», «refreshing» and its three more fetches, the «not
 *     checked» remedies, a repaint that keeps a fold and focus, a new map's
 *     refetch and no mark from the previous answer while it is pending or after
 *     it fails, and a themes map that never asks. Its list's three groups and
 *     their keyboard rule, focus and selection across a repaint, and the strip's
 *     layout, measured: equal cell widths and no word broken at six widths. Its
 *     lifecycle: a late answer dropped, and no fetch or timer added by a render.
 *
 * One muninn on its own port over the temp wikis `wiki-work-card-fixture.ts`
 * seeds. `SCHEDULER_ENABLED=false` keeps the work-map loop off and every wiki
 * not organizable. No model calls.
 */

import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { e2ePort } from "./ports.ts";
import { contrastOf, token } from "./contrast.ts";
import { WIKI_REFETCH_MIN_INTERVAL_MS } from "../src/dashboard/views/components/wiki-refresh.ts";
import type { WorkMapChecksBody } from "../src/wiki/work-map/gh-check.ts";
import {
  SWEEP,
  STRIP,
  STRIP_OFF,
  STRIP_GROW,
  STRIP_LONG,
  STRIP_KEEP_CELL,
  STRIP_KEEP_MORE,
  STRIP_KEEP_OPEN,
  THEME_HOLD,
  GH,
  GH_DROP_OK,
  GH_DROP_FAIL,
  GH_DROP_DONE,
  GH_ADOPT,
  BOARD,
  GH_DROP_RUN,
  LONG_TOKEN,
  HOUR,
  waitPage,
  mapJson,
  server,
  roots,
  openStart,
  checksPainted,
  openSettled,
  forceAdopt,
  boardCard,
  boardNeeds,
  holdChecks,
  GH_MERGED_AT,
  checksBody,
  GH_NEEDS,
  stubChecks,
  GH_UNLINKED,
  GH_UNCHECKED,
  pressPoint,
  DIGEST_OK,
  organizable,
  THEMES,
  sweepThemesMap,
  useWorkCardServer,
} from "./wiki-work-card-fixture.ts";

const PORT = e2ePort("wiki-work-card-strip");
const BASE = `http://127.0.0.1:${PORT}`;
useWorkCardServer(PORT);

test("the health strip's cells count the live listing, and the listing says the same", async ({ page }) => {
  const listing = (await (await page.request.get(`${BASE}/api/wiki/pages?wiki=${STRIP}`)).json()) as {
    waitsCounted: boolean;
    pages: { relPath: string; movesWaiting?: number; waitingSince?: string }[];
  };
  expect(listing.waitsCounted).toBe(true);
  const at = (rel: string) => listing.pages.find((p) => p.relPath === rel)!;
  expect(at("plans/two.mdx").movesWaiting).toBe(2);
  expect(at("plans/other.mdx").movesWaiting).toBeUndefined();
  await openStart(page, STRIP);
  const cell = (name: string) => page.locator(`#wikiWorkCard [data-wm-cell="${name}"]`);
  await expect(page.locator("#wikiWorkCard .wiki-wm-cell")).toHaveCount(4);
  await expect(cell("decisions").locator("b")).toHaveText("14");
  await expect(cell("decisions")).toHaveClass(/\bwarn\b/);
  await expect(cell("oldest").locator("b")).toHaveText(/^(28|29|30) d$/);
  await expect(cell("oldest")).toHaveClass(/\bwarn\b/);
  await expect(cell("steps").locator("b")).toHaveText("3");
  await expect(cell("shipped").locator("b")).toHaveText("1");
  await expect(cell("shipped")).toHaveClass(/\bmuted\b/);
  // The layout of the prototype's Proposed view: the strip opens the card, in one row at this width.
  const boxes = await page.locator("#wikiWorkCard .wiki-wm-cell").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  expect(new Set(boxes).size).toBe(1);
});

test("a cell opens its list, oldest first, and +N more expands it", async ({ page }) => {
  await openStart(page, STRIP);
  const card = page.locator("#wikiWorkCard");
  const rows = card.locator(".wiki-wm-drill-row");
  await expect(rows).toHaveCount(0);
  await card.locator('[data-wm-cell="decisions"]').click();
  await expect(card.locator('[data-wm-cell="decisions"]')).toHaveAttribute("aria-expanded", "true");
  await expect(rows).toHaveCount(8);
  await expect(rows.first()).toContainText("Wait 1");
  await expect(rows.first()).toContainText(/· 1 · since \d{4}-\d{2}-\d{2} · \d+ d/);
  await expect(card.locator("[data-wm-drill-more]")).toHaveText("+5 more");
  await card.locator("[data-wm-drill-more]").click();
  await expect(rows).toHaveCount(13);
  await expect(card.locator("[data-wm-drill-more]")).toHaveCount(0);
  // Focus lands on the first row the button hid, not on the document.
  expect(await page.evaluate(() => document.activeElement?.closest(".wiki-wm-drill-row")?.textContent ?? "")).toContain("Wait 9");
  await expect(rows.filter({ hasText: "Two asks" })).toContainText("· 2 ·");
  await expect(card.locator(".wiki-wm-drill")).not.toContainText("Other group");
  await expect(card.locator(".wiki-wm-drill")).not.toContainText("Dropped");
  // Another cell swaps the list and folds it again; its own cell closes it.
  await card.locator('[data-wm-cell="steps"]').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Steps");
  await card.locator('[data-wm-cell="steps"]').click();
  await expect(rows).toHaveCount(0);
  // A row opens its page.
  await card.locator('[data-wm-cell="shipped"]').click();
  await rows.first().locator("a").click();
  await expect(page).toHaveURL(/relPath=plans%2Floop\.mdx/);
});

test("a wiki that takes no answers reads «owner not set» in both wait cells", async ({ page }) => {
  const listing = (await (await page.request.get(`${BASE}/api/wiki/pages?wiki=${STRIP_OFF}`)).json()) as { waitsCounted: boolean };
  expect(listing.waitsCounted).toBe(false);
  await openStart(page, STRIP_OFF);
  const card = page.locator("#wikiWorkCard");
  for (const name of ["decisions", "oldest"]) {
    await expect(card.locator(`[data-wm-cell="${name}"] b`)).toHaveText("owner not set");
    await expect(card.locator(`[data-wm-cell="${name}"]`)).toBeDisabled();
  }
  await expect(card.locator('[data-wm-cell="steps"] b')).toHaveText("3");
});

test("an adopt repaints the strip's count, keeping the open list", async ({ page }) => {
  await page.clock.install();
  await openStart(page, STRIP_GROW);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator('[data-wm-cell="decisions"] b')).toHaveText("1");
  await card.locator('[data-wm-cell="decisions"]').click();
  await expect(card.locator(".wiki-wm-drill-row")).toHaveCount(1);
  await writeFile(path.join(roots[STRIP_GROW]!, "plans/second.mdx"), waitPage("Second wait", ["O1"], "2026-01-02"), "utf8");
  await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#wikiList")).toContainText("Second wait");
  await expect(card.locator('[data-wm-cell="decisions"] b')).toHaveText("2");
  await expect(card.locator(".wiki-wm-drill-row")).toHaveCount(2);
});

/** A wait lands and an adopt takes it: the strip's key moves, so the card repaints. */
async function adoptNewWait(page: Page, wiki: string): Promise<void> {
  await writeFile(path.join(roots[wiki]!, "plans/new-wait.mdx"), waitPage("New wait", ["O1"], "2026-01-02"), "utf8");
  await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#wikiList")).toContainText("New wait");
}

test("focus on a cell survives an adopt that repaints the strip", async ({ page }) => {
  await page.clock.install();
  await openStart(page, STRIP_KEEP_CELL);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="decisions"]');
  await expect(cell.locator("b")).toHaveText("14");
  await cell.focus();
  await adoptNewWait(page, STRIP_KEEP_CELL);
  await expect(cell.locator("b")).toHaveText("15");
  await expect(cell).toBeFocused();
});

test("focus on +N more survives an adopt that repaints the strip", async ({ page }) => {
  await page.clock.install();
  await openStart(page, STRIP_KEEP_MORE);
  const card = page.locator("#wikiWorkCard");
  await card.locator('[data-wm-cell="decisions"]').click();
  const more = card.locator("[data-wm-drill-more]");
  await expect(more).toHaveText("+5 more");
  await more.focus();
  await adoptNewWait(page, STRIP_KEEP_MORE);
  await expect(more).toHaveText("+6 more");
  await expect(more).toBeFocused();
});

test("an expanded list stays expanded across an adopt that repaints the strip", async ({ page }) => {
  await page.clock.install();
  await openStart(page, STRIP_KEEP_OPEN);
  const card = page.locator("#wikiWorkCard");
  const rows = card.locator(".wiki-wm-drill-row");
  await card.locator('[data-wm-cell="decisions"]').click();
  await card.locator("[data-wm-drill-more]").click();
  await expect(rows).toHaveCount(13);
  await adoptNewWait(page, STRIP_KEEP_OPEN);
  await expect(rows).toHaveCount(14);
  await expect(card.locator("[data-wm-drill-more]")).toHaveCount(0);
});

test("the spec server never reaches gh: the real checks GET answers disabled and the cell is absent", async ({ page }) => {
  const res = await page.request.get(`${BASE}/api/wiki/work-map/checks?wiki=${GH}`);
  expect(((await res.json()) as WorkMapChecksBody).notChecked).toEqual({ reason: "disabled", repos: [] });
  await openStart(page, GH);
  await expect(page.locator("#wikiWorkCard .wiki-wm-cell")).toHaveCount(4);
  await expect(page.locator('#wikiWorkCard [data-wm-cell="github"]')).toHaveCount(0);
});

test("the fifth cell sits in one row with the others, opens its list, and the Needs you items carry their marks", async ({ page }) => {
  await stubChecks(page, () =>
    checksBody({
      contradictions: [{ page: "plans/alpha.mdx", pr: 369, repo: "acme/gears", rowState: "open", ghState: "MERGED", mergedAt: GH_MERGED_AT }],
      uncheckedRows: [{ page: "plans/beta.mdx", pr: 4, repo: "acme/gears" }],
      unlinkedRows: [{ page: "plans/gamma.mdx", label: "row with no link" }],
      needs: GH_NEEDS,
    }),
  );
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell.locator("b")).toHaveText("1");
  await expect(cell).toHaveClass(/\bbad\b/);
  await expect(cell).toContainText("PR row out of date");
  const tops = await card.locator(".wiki-wm-cell").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  expect(tops.length).toBe(5);
  expect(new Set(tops).size).toBe(1);

  await cell.click();
  const rows = card.locator('[data-wm-drill="github"] .wiki-wm-drill-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Alpha plan");
  await expect(rows.nth(0)).toContainText("says open · GitHub: #369 merged 29.10");
  await expect(rows.nth(0).locator('a[href="https://github.com/acme/gears/pull/369"]')).toBeVisible();
  await card.locator('[data-wm-gh-more="unchecked"]').click();
  await expect(rows.nth(1)).toContainText("#4 not checked");
  await card.locator('[data-wm-gh-more="unlinked"]').click();
  await expect(rows.nth(2)).toContainText("row with no link: no PR link in a column the check reads");

  const item = (title: string) => card.locator(".wiki-wm-need").filter({ hasText: title });
  const struck = (l: Locator) => l.evaluate((el) => getComputedStyle(el).textDecorationLine);
  await expect(item("Merge the fix").locator(".wiki-wm-ghnote.done")).toHaveText("GitHub: #369 merged 29.10, this step is done");
  expect(await struck(item("Merge the fix").locator(".wiki-wm-action"))).toBe("line-through");
  await expect(item("Closed one").locator(".wiki-wm-ghnote.warn")).toHaveText("GitHub: #12 closed without merge");
  expect(await struck(item("Closed one").locator(".wiki-wm-action"))).toBe("none");
  await expect(item("Only mentions").locator(".wiki-wm-ghnote.info")).toHaveText("GitHub: #3556 merged 28.10");
  expect(await struck(item("Only mentions").locator(".wiki-wm-action"))).toBe("none");
  await expect(item("Asks for two").locator(".wiki-wm-ghnote")).toHaveText(["GitHub: #1 merged 29.10", "GitHub: #2 open"]);
  expect(await struck(item("Asks for two").locator(".wiki-wm-action"))).toBe("none");
  await expect(item("No PR").locator(".wiki-wm-ghnote")).toHaveCount(0);
  // A struck item keeps its ✓, and ✓ still takes it off the card.
  await item("Merge the fix").locator("[data-wm-done]").click();
  await expect(item("Merge the fix")).toHaveCount(0);
});

test("the card paints before the check answers, reads «checking…», and the answer's repaint keeps a fold and focus", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/work-map/checks*", async (route) => {
    await held;
    await route.fulfill({ json: checksBody({ needs: GH_NEEDS }) });
  });
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(card.locator(".wiki-wm-need")).toHaveCount(5);
  await expect(cell.locator("b")).toHaveText("checking…");
  await expect(cell).toHaveClass(/\bmuted\b/);
  await expect(cell).toBeDisabled();
  await expect(card.locator(".wiki-wm-ghnote")).toHaveCount(0);
  // The reader opens a closed lane, which holds focus, while it waits.
  const summary = card.locator('[data-wm-lane="cooling"] > summary');
  await summary.click();
  await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
  await summary.focus();
  await page.evaluate(() => document.querySelector("#wikiWorkCard .wiki-wm-strip")!.setAttribute("data-before-repaint", ""));
  release();
  await expect(cell.locator("b")).toHaveText("0");
  await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
  await expect(card.locator(".wiki-wm-ghnote.done")).toHaveCount(1);
  await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
  await expect(summary).toBeFocused();
});

test("«refreshing» shows the count and the marks it has, and three more fetches end it with «N not checked»", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, (n) => checksBody({ refreshing: true, unchecked: 3, uncheckedRows: [{ page: "plans/beta.mdx", pr: 4, repo: "acme/gears" }], needs: GH_NEEDS, checked: n }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell).toContainText("refreshing");
  await expect(cell).not.toContainText("not checked");
  await expect(cell.locator("b")).toHaveText("0");
  await expect(card.locator(".wiki-wm-ghnote.done")).toHaveCount(1);
  expect(stub.count()).toBe(1);
  for (const n of [2, 3, 4]) await stub.retry(n);
  await expect(cell).toContainText("3 not checked");
  await expect(cell).not.toContainText("refreshing");
  await page.clock.runFor(60_000);
  await page.waitForTimeout(100);
  expect(stub.count()).toBe(4);
});

test("a `gh` that stays hung ends «not refreshed», muted with only merges marked, and tab clicks ask at most once a minute", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, () => checksBody({ refreshing: true, contradictions: [GH_CONTRADICTION], needs: GH_NEEDS }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell).toContainText("refreshing");
  await expect(card.locator(".wiki-wm-ghnote.warn")).toHaveCount(1);
  for (const n of [2, 3, 4]) await stub.retry(n);
  await expect(cell).toContainText("not refreshed");
  await expect(cell).not.toContainText("refreshing");
  await expect(cell.locator("b")).toHaveText("1");
  await expect(cell).toHaveClass(/\bmuted\b/);
  await expect(cell).not.toHaveClass(/\bbad\b/);
  await expect(card.locator(".wiki-wm-ghnote.warn")).toHaveCount(0);
  await expect(card.locator(".wiki-wm-ghnote.done")).toHaveCount(1);
  const tabs = async () => {
    await page.locator('.wiki-tab[data-tab="timeline"]').click();
    await page.locator('.wiki-tab[data-tab="hubs"]').click();
    await expect(page.locator('#wikiWorkCard [data-wm-cell="github"]')).toBeVisible();
  };
  await tabs();
  await tabs();
  await page.waitForTimeout(100);
  expect(stub.count()).toBe(4);
  await page.clock.runFor(60_000);
  await tabs();
  await expect.poll(() => stub.count()).toBe(5);
});

test("«refreshing» that settles stops the fetches at once", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, (n) => checksBody(n === 1 ? { refreshing: true } : {}));
  await openStart(page, GH);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
  await expect(cell).toContainText("refreshing");
  await page.clock.runFor(15_000);
  await expect(cell).not.toContainText("refreshing");
  await page.clock.runFor(60_000);
  await page.waitForTimeout(100);
  expect(stub.count()).toBe(2);
});

for (const [reason, text] of [
  ["no-gh", "not checked: install gh"],
  ["auth", "not checked: log in with gh auth login"],
  ["sso", "not checked: authorize the token for the organization (gh auth refresh)"],
  ["no-access", "not checked: your gh login cannot see acme/gears (gh auth status)"],
] as const) {
  test(`notChecked ${reason} reads «${text}» and the other repos' counts still show`, async ({ page }) => {
    await stubChecks(page, () =>
      checksBody({
        checked: 2,
        unchecked: 1,
        notChecked: { reason, repos: ["acme/gears"] },
        contradictions: [{ page: "plans/alpha.mdx", pr: 369, repo: "acme/other", rowState: "open", ghState: "CLOSED", mergedAt: null }],
        uncheckedRows: [{ page: "plans/beta.mdx", pr: 4, repo: "acme/gears" }],
      }),
    );
    await openStart(page, GH);
    const card = page.locator("#wikiWorkCard");
    const cell = card.locator('[data-wm-cell="github"]');
    await expect(cell).toContainText(text);
    await expect(cell.locator("b")).toHaveText("1");
    // Its long remedy takes a row of its own, with no word broken.
    expect((await stripLayout(page)).broken).toEqual([]);
    const boxes = await card.locator(".wiki-wm-cell").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })));
    expect(new Set(boxes.slice(0, 4).map((b) => b.top)).size).toBe(1);
    expect(boxes[4]!.top).toBeGreaterThanOrEqual(boxes[0]!.bottom);
    // Four across, filling the row, with the remedy under them at full width.
    const strip = (await card.locator(".wiki-wm-strip").boundingBox())!;
    const edges = await card.locator(".wiki-wm-cell").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ right: r.right, width: r.width })));
    expect(Math.abs(edges[3]!.right - (strip.x + strip.width))).toBeLessThan(1);
    expect(Math.abs(edges[4]!.width - strip.width)).toBeLessThan(1);
    await cell.click();
    await expect(card.locator('[data-wm-drill="github"]')).toContainText("closed without merge");
  });
}

/**
 * The strip as laid out. `rows` holds the cell widths per rendered row; a `.wide`
 * cell spans its row and is left out of `narrow`. `broken` names each word whose
 * box spans two lines or leaves its cell: `scrollWidth` cannot show this, since
 * a word that may break never overflows.
 */
async function stripLayout(page: Page): Promise<{ rows: number[][]; narrow: number[]; broken: string[] }> {
  return page.locator("#wikiWorkCard .wiki-wm-strip").evaluate((strip) => {
    const rows = new Map<number, number[]>();
    const narrow: number[] = [];
    const broken: string[] = [];
    for (const cell of Array.from(strip.querySelectorAll<HTMLElement>(".wiki-wm-cell"))) {
      const box = cell.getBoundingClientRect();
      const top = Math.round(box.top);
      rows.set(top, [...(rows.get(top) ?? []), box.width]);
      if (!cell.classList.contains("wide")) narrow.push(box.width);
      const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        // A hyphen is a line-break opportunity, not a word's middle.
        for (const m of n.textContent!.matchAll(/[^\s-]+/g)) {
          const range = document.createRange();
          range.setStart(n, m.index);
          range.setEnd(n, m.index + m[0].length);
          const rects = Array.from(range.getClientRects());
          if (new Set(rects.map((r) => Math.round(r.top))).size > 1 || rects.some((r) => r.right > box.right + 0.5)) broken.push(`${m[0]} in a ${Math.round(box.width)} px cell`);
        }
      }
    }
    return { rows: [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w), narrow, broken };
  });
}

const STRIP_WIDTHS = [1280, 1265, 1200, 900, 800, 700, 480];

// A repo name has no break of its own: only the remedy's cell may break it.
for (const [width, length] of [[1280, 100], [700, 100], [700, 50], [480, 50]] as const) {
  test(`at ${width} wide a ${length}-character repo name stays in the remedy's cell`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const repo = `acme/${"a".repeat(length - 5)}`;
    await stubChecks(page, () => checksBody({ notChecked: { reason: "no-access", repos: [repo] } }));
    await openStart(page, GH);
    const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
    await expect(cell).toContainText(repo);
    const m = await cell.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, right: el.getBoundingClientRect().right, note: el.querySelector(".wiki-wm-cell-note")!.getBoundingClientRect().right }));
    expect(m.scroll).toBeLessThanOrEqual(m.client);
    expect(m.note).toBeLessThanOrEqual(m.right);
    // Every other word in the strip stays whole, however narrow its cell gets.
    expect((await stripLayout(page)).broken.filter((w) => !w.startsWith("acme/"))).toEqual([]);
    expect(await page.locator('#wikiWorkCard [data-wm-cell="decisions"]').evaluate((el) => getComputedStyle(el).overflowWrap)).toBe("normal");
  });
}

for (const width of STRIP_WIDTHS) {
  test(`at ${width} wide the cells are equal and no word breaks`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubChecks(page, () => checksBody({ checked: 2, unchecked: 3, contradictions: [GH_CONTRADICTION] }));
    await openStart(page, GH);
    const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
    await expect(cell).toContainText("3 not checked");
    const { rows, narrow, broken } = await stripLayout(page);
    expect(narrow.length).toBe(5);
    expect(broken).toEqual([]);
    expect(Math.max(...narrow) - Math.min(...narrow)).toBeLessThan(0.5);
    if (width >= 1265) expect(rows.map((r) => r.length)).toEqual([5]);
  });
}

test("«checking…» and «refreshing» fit their cells too", async ({ page }) => {
  await page.setViewportSize({ width: 1265, height: 900 });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/work-map/checks*", async (route) => {
    await held;
    await route.fulfill({ json: checksBody({ refreshing: true }) });
  });
  await openStart(page, GH);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
  await expect(cell.locator("b")).toHaveText("checking…");
  expect((await stripLayout(page)).broken).toEqual([]);
  release();
  await expect(cell).toContainText("refreshing");
  expect((await stripLayout(page)).broken).toEqual([]);
});

test("no contradictions: the list opens with a sentence and a line for the rest, and stays short", async ({ page }) => {
  await stubChecks(page, () => checksBody({ checked: 5, compared: 5, unlinked: 197, unlinkedRows: GH_UNLINKED }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell.locator("b")).toHaveText("0");
  const before = await card.evaluate((el) => el.getBoundingClientRect().height);
  await cell.click();
  const drill = card.locator('[data-wm-drill="github"]');
  await expect(drill.locator(".wiki-wm-drill-counts")).toContainText("5 checked");
  await expect(drill.locator(".wiki-wm-drill-counts")).toContainText("197 with no PR link read");
  await expect(drill.locator(".wiki-wm-drill-row")).toHaveCount(0);
  await expect(drill.locator('[data-wm-gh-group="contradictions"]')).toHaveCount(0);
  await expect(drill.locator('[data-wm-gh-group="unlinked"]')).toContainText("No PR link read · 197");
  await expect(drill.locator('[data-wm-gh-more="unlinked"]')).toHaveText("+197 more");
  const after = await card.evaluate((el) => el.getBoundingClientRect().height);
  expect(after - before).toBeLessThan(120);
});

test("the groups read apart, a line opens its group at the first revealed row, and +N more goes on from there", async ({ page }) => {
  await stubChecks(page, () => checksBody({ checked: 3, unchecked: 9, unlinked: 197, contradictions: [GH_CONTRADICTION, { ...GH_CONTRADICTION, pr: 370 }], uncheckedRows: GH_UNCHECKED, unlinkedRows: GH_UNLINKED }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await card.locator('[data-wm-cell="github"]').click();
  const group = (name: string) => card.locator(`[data-wm-gh-group="${name}"]`);
  await expect(group("contradictions").locator(".wiki-wm-drill-group-head")).toHaveText("GitHub contradicts · 2");
  await expect(group("contradictions").locator(".wiki-wm-drill-row")).toHaveCount(2);
  await expect(card.locator(".wiki-wm-drill-counts")).toContainText("3 checked · ");
  await expect(group("unchecked").locator(".wiki-wm-drill-group-head")).toContainText("Not checked · 9");
  await expect(group("unchecked").locator(".wiki-wm-drill-row")).toHaveCount(0);
  await expect(group("unlinked").locator(".wiki-wm-drill-row")).toHaveCount(0);
  const heads = await card.locator(".wiki-wm-drill-group-head").evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
  expect(heads[0]).not.toBe(heads[1]);

  const focusRow = () => page.evaluate(() => document.activeElement?.closest(".wiki-wm-drill-row")?.textContent ?? "");
  const more = card.locator('[data-wm-gh-more="unlinked"]');
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(group("unlinked").locator(".wiki-wm-drill-row")).toHaveCount(8);
  expect(await focusRow()).toContain("row 1:");
  // The other group stays shut.
  await expect(group("unchecked").locator(".wiki-wm-drill-row")).toHaveCount(0);
  await expect(more).toHaveText("+189 more");
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(group("unlinked").locator(".wiki-wm-drill-row")).toHaveCount(197);
  expect(await focusRow()).toContain("row 9:");
  await expect(more).toHaveCount(0);
  // Shutting the list folds the groups again.
  await card.locator('[data-wm-cell="github"]').click();
  await card.locator('[data-wm-cell="github"]').click();
  await expect(group("unlinked").locator(".wiki-wm-drill-row")).toHaveCount(0);
});

test("focus stays on a GitHub link, a group's line and its +N more across a checks repaint", async ({ page }) => {
  await page.clock.install();
  // Each answer differs, so each repaints: the marker below goes with the old DOM.
  const stub = await stubChecks(page, (n) => checksBody({ refreshing: true, checked: n, contradictions: [GH_CONTRADICTION, { ...GH_CONTRADICTION, pr: 370 }], uncheckedRows: GH_UNCHECKED, unlinkedRows: GH_UNLINKED }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await card.locator('[data-wm-cell="github"]').click();
  const repaint = async (n: number) => {
    await page.evaluate(() => document.querySelector("#wikiWorkCard .wiki-wm-strip")!.setAttribute("data-before-repaint", ""));
    await stub.retry(n);
    await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
  };
  const link = card.locator('a[href="https://github.com/acme/gears/pull/370"]');
  await link.focus();
  await repaint(2);
  await expect(link).toBeFocused();
  const line = card.locator('[data-wm-gh-more="unchecked"]');
  await line.focus();
  await repaint(3);
  await expect(line).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card.locator('[data-wm-gh-group="unchecked"] .wiki-wm-drill-row')).toHaveCount(8);
  await expect(line).toHaveText("+1 more");
  await line.focus();
  await repaint(4);
  await expect(line).toBeFocused();
});

test("focus on the second link to one PR comes back to the second", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, (n) => checksBody({ refreshing: true, checked: n, contradictions: [GH_CONTRADICTION, { ...GH_CONTRADICTION, page: "plans/beta.mdx" }] }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await card.locator('[data-wm-cell="github"]').click();
  const links = card.locator('a[href="https://github.com/acme/gears/pull/369"]');
  await expect(links).toHaveCount(2);
  await links.nth(1).focus();
  await stub.retry(2);
  await expect(card.locator('[data-wm-cell="github"]')).toHaveAttribute("title", /^2 checked/);
  await expect(links.nth(1)).toBeFocused();
});

test("a checks answer that changes nothing leaves the DOM and a selection alone", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, () => checksBody({ refreshing: true, contradictions: [GH_CONTRADICTION] }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell).toContainText("refreshing");
  await page.evaluate(() => {
    document.querySelector("#wikiWorkCard .wiki-wm-strip")!.setAttribute("data-before-repaint", "");
    const r = document.createRange();
    r.selectNodeContents(document.querySelector("#wikiWorkCard .wiki-wm-need-title")!);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  });
  const selected = await page.evaluate(() => getSelection()!.toString());
  expect(selected.length).toBeGreaterThan(0);
  await stub.retry(2);
  await page.waitForTimeout(100);
  await expect(card.locator("[data-before-repaint]")).toHaveCount(1);
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(selected);
  // The last fetch ends the suffix: that one is a change, and paints once the selection ends.
  await stub.retry(3);
  await stub.retry(4);
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await expect(cell).not.toContainText("refreshing");
  await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
});

/** How many checks answers the page has read. The page's own chain on `json()` runs in that promise's microtask
 *  checkpoint, so once this counts one, the page has handled it by the next `evaluate`. */
async function countChecksAnswers(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __checksRead: number };
    w.__checksRead = 0;
    const json = Response.prototype.json;
    Response.prototype.json = function (this: Response) {
      const p = json.call(this);
      if (this.url.includes("/work-map/checks")) void p.then(() => { w.__checksRead += 1; });
      return p;
    };
  });
  return () => page.evaluate(() => (window as unknown as { __checksRead: number }).__checksRead);
}

/** Select a page-title's text in the card, the way a reader's drag ends up. */
const selectNeedTitle = (page: Page) =>
  page.evaluate(() => {
    const r = document.createRange();
    r.selectNodeContents(document.querySelector("#wikiWorkCard .wiki-wm-need-title")!);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    return sel.toString();
  });

/** A check that answers «refreshing» first and a contradiction next, with the reader's selection in between. */
async function checksChangeUnderSelection(page: Page) {
  await page.clock.install();
  const read = await countChecksAnswers(page);
  const stub = await stubChecks(page, (n) =>
    n === 1 ? checksBody({ refreshing: true }) : checksBody({ contradictions: [GH_CONTRADICTION] }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const github = card.locator('[data-wm-cell="github"]');
  await expect(github).toContainText("refreshing");
  await card.locator(".wiki-wm-strip").evaluate((el) => el.setAttribute("data-before-repaint", ""));
  const selected = await selectNeedTitle(page);
  expect(selected.length).toBeGreaterThan(0);
  await stub.retry(2);
  await expect.poll(read).toBe(2);
  return { card, github, selected };
}

test("a checks answer that changes the card waits while the reader has text selected in it", async ({ page }) => {
  const { card, github, selected } = await checksChangeUnderSelection(page);
  await expect(card.locator("[data-before-repaint]")).toHaveCount(1);
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(selected);
  await expect(github).toContainText("refreshing");
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await expect(github).not.toContainText("refreshing");
  await expect(github.locator("b")).toHaveText("1");
  await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
});

test("a press that ends the selection holds the waiting answer until the pointer is up", async ({ page }) => {
  const { card, github } = await checksChangeUnderSelection(page);
  const box = (await card.locator(".wiki-wm-summary").boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 6);
  await page.mouse.down();
  // A press collapses the selection. A paint now would replace whatever is under the pointer and lose its click.
  await expect.poll(() => page.evaluate(() => getSelection()!.isCollapsed)).toBe(true);
  await page.waitForTimeout(50);
  await expect(card.locator("[data-before-repaint]")).toHaveCount(1);
  await page.mouse.up();
  await page.clock.runFor(1);
  await expect(github.locator("b")).toHaveText("1");
  await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
});

test("a drag that starts a new selection keeps the answer waiting", async ({ page }) => {
  const { card, github } = await checksChangeUnderSelection(page);
  const box = (await card.locator(".wiki-wm-summary").boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 8, { steps: 6 });
  await page.mouse.up();
  await page.clock.runFor(1);
  expect((await page.evaluate(() => getSelection()!.toString())).length).toBeGreaterThan(0);
  await expect(card.locator("[data-before-repaint]")).toHaveCount(1);
  await expect(github).toContainText("refreshing");
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await expect(github.locator("b")).toHaveText("1");
});

test("a selection outside the card does not hold the answer back", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, (n) =>
    n === 1 ? checksBody({ refreshing: true }) : checksBody({ contradictions: [GH_CONTRADICTION] }));
  await openStart(page, GH);
  const github = page.locator('#wikiWorkCard [data-wm-cell="github"]');
  await expect(github).toContainText("refreshing");
  await page.evaluate(() => {
    const outside = Array.from(document.querySelectorAll(".wiki-start *")).find(
      (n) => !n.closest("#wikiWorkCard") && !n.querySelector("#wikiWorkCard") && (n.textContent ?? "").trim().length > 0,
    ) ?? document.querySelector("#wikiList a")!;
    getSelection()!.selectAllChildren(outside);
  });
  expect((await page.evaluate(() => getSelection()!.toString())).length).toBeGreaterThan(0);
  await stub.retry(2);
  await expect(github.locator("b")).toHaveText("1");
});

/** A held checks answer on a board whose strip is painted and marked, with no timer in the way. */
async function boardWithHeldAnswer(page: Page) {
  const read = await countChecksAnswers(page);
  const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
  await openStart(page, BOARD);
  const card = boardCard(page);
  await card.locator(".wiki-wm-strip").evaluate((el) => el.setAttribute("data-before-repaint", ""));
  const land = async () => {
    release();
    await expect.poll(read).toBe(1);
  };
  return { card, land };
}

const selectCardTitle = (page: Page) =>
  page.evaluate(() => {
    getSelection()!.selectAllChildren(document.querySelector("#wikiWorkCard .wiki-wn-title")!);
    return getSelection()!.toString();
  });

for (const [name, lane, opened] of [
  ["opens a closed lane", '[data-wm-lane="cooling"]', true],
  ["closes an open lane", '[data-wm-lane="moving"]', false],
] as const) {
  test(`a click that ends the selection ${name}, and the waiting answer keeps that`, async ({ page }) => {
    const { card, land } = await boardWithHeldAnswer(page);
    expect((await selectCardTitle(page)).length).toBeGreaterThan(0);
    await land();
    await expect(card.locator("[data-before-repaint]")).toHaveCount(1);
    await card.locator(`${lane} > summary`).click();
    await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
    if (opened) await expect(card.locator(lane)).toHaveAttribute("open", "");
    else await expect(card.locator(lane)).not.toHaveAttribute("open", "");
  });
}

test("a click on a control with the selection still up lands, and paints what waited", async ({ page }) => {
  const { card, land } = await boardWithHeldAnswer(page);
  const name = await card.locator("[data-wm-cell]:not([disabled])").first().getAttribute("data-wm-cell");
  const cell = card.locator(`[data-wm-cell="${name}"]`);
  expect((await selectCardTitle(page)).length).toBeGreaterThan(0);
  await land();
  await expect(card.locator("[data-before-repaint]")).toHaveCount(1);
  await cell.click();
  await expect(cell).toHaveAttribute("aria-expanded", "true");
  await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
});

test("a drag that collapses back over its start keeps the answer waiting until the pointer is up", async ({ page }) => {
  const { card, land } = await boardWithHeldAnswer(page);
  const start = await pressPoint(card);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, start.y + 2, { steps: 6 });
  expect((await page.evaluate(() => getSelection()!.toString())).length).toBeGreaterThan(0);
  await land();
  await page.mouse.move(start.x, start.y, { steps: 6 });
  await expect.poll(() => page.evaluate(() => getSelection()!.isCollapsed)).toBe(true);
  await expect(card.locator("[data-before-repaint]")).toHaveCount(1);
  await page.mouse.move(start.x + start.width / 2, start.y + 2, { steps: 6 });
  expect((await page.evaluate(() => getSelection()!.toString())).length).toBeGreaterThan(0);
  await page.mouse.up();
  await expect(card.locator("[data-before-repaint]")).toHaveCount(1);
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
});

test("a cancelled press lets the waiting answer paint", async ({ page }) => {
  const { card, land } = await boardWithHeldAnswer(page);
  await selectCardTitle(page);
  await land();
  const at = await pressPoint(card);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await expect(card.locator("[data-before-repaint]")).toHaveCount(1);
  await page.evaluate(() => document.dispatchEvent(new PointerEvent("pointercancel")));
  await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
  await page.mouse.up();
});

test("a right-button press does not hold the waiting answer back once its menu opens", async ({ page }) => {
  const { card, land } = await boardWithHeldAnswer(page);
  await selectCardTitle(page);
  await land();
  const at = await pressPoint(card);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: "right" });
  await page.evaluate(() => document.dispatchEvent(new MouseEvent("contextmenu")));
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
  await page.mouse.up({ button: "right" });
});

for (const [name, heal] of [
  ["a hover with no button down", async (page: Page, at: { x: number; y: number }) => { await page.mouse.move(at.x, at.y); await page.mouse.move(at.x + 4, at.y); }],
  ["a context menu", async (page: Page) => { await page.evaluate(() => document.dispatchEvent(new MouseEvent("contextmenu"))); }],
] as const) {
  test(`a release the page never saw is ended by ${name}`, async ({ page }) => {
    const { card, land } = await boardWithHeldAnswer(page);
    await selectCardTitle(page);
    await land();
    const at = await pressPoint(card);
    // What a release over an iframe leaves: a press, and no pointerup at this document.
    await page.evaluate(() => document.dispatchEvent(new PointerEvent("pointerdown", { button: 0 })));
    await page.evaluate(() => getSelection()!.removeAllRanges());
    await expect(card.locator("[data-before-repaint]")).toHaveCount(1);
    await heal(page, at);
    await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
  });
}

test("a lane opened without a click stays open through the repaint", async ({ page }) => {
  const { card, land } = await boardWithHeldAnswer(page);
  await page.evaluate(() => new Promise((resolve) => {
    const lane = document.querySelector<HTMLDetailsElement>('#wikiWorkCard [data-wm-lane="cooling"]')!;
    lane.addEventListener("toggle", resolve, { once: true });
    lane.open = true;
  }));
  await land();
  await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
  await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
});

test("a start view that comes back paints its card, though the last answer changed nothing", async ({ page }) => {
  await stubChecks(page, () => checksBody({ contradictions: [GH_CONTRADICTION] }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("1");
  await page.locator("#wikiList a").first().click();
  await expect(page).toHaveURL(/effort=|relPath=/);
  await page.goBack();
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("1");
});

test("rows with no PR link read and nothing read: «—», muted, the count, and a list", async ({ page }) => {
  await stubChecks(page, () => checksBody({ checked: 0, unchecked: 0, unlinked: 197, unlinkedRows: GH_UNLINKED }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell.locator("b")).toHaveText("—");
  await expect(cell).toHaveClass(/\bmuted\b/);
  await expect(cell).toContainText("197 with no PR link read");
  await cell.click();
  await expect(card.locator(".wiki-wm-drill-counts")).toContainText("197 with no PR link read");
});

test("a checks GET that fails says «not checked», and a start view a minute later asks again", async ({ page }) => {
  await page.clock.install();
  let n = 0;
  await page.route("**/api/wiki/work-map/checks*", (route) => (++n === 1 ? route.fulfill({ status: 500, json: { error: "x" } }) : route.fulfill({ json: checksBody() })));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell).toContainText("not checked");
  await expect(cell.locator("b")).toHaveText("—");
  await card.locator('.wiki-wm-pages a[data-relpath], .wiki-wm-summary a[data-relpath]').first().click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  await page.clock.fastForward(60_000);
  await page.goBack();
  await expect(cell.locator("b")).toHaveText("0");
  expect(n).toBe(2);
});

/** Open a page off the card, and come back. */
async function visitAndReturn(page: Page): Promise<void> {
  await page.locator("#wikiWorkCard").locator('.wiki-wm-pages a[data-relpath], .wiki-wm-summary a[data-relpath]').first().click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator(".wiki-start")).toBeVisible();
}

const GH_CONTRADICTION = { page: "plans/alpha.mdx", pr: 369, repo: "acme/gears", rowState: "open", ghState: "MERGED" as const, mergedAt: GH_MERGED_AT };

test("a not refreshed answer: one line above the whole list, contradictions included, and the tooltip opens with it", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, () => checksBody({ refreshing: true, contradictions: [GH_CONTRADICTION], unlinked: 197, unlinkedRows: GH_UNLINKED }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell).toContainText("refreshing");
  await expect(cell).not.toHaveAttribute("title", /^From the last answer/);
  for (const n of [2, 3, 4]) await stub.retry(n);
  await expect(cell).toContainText("not refreshed");
  await expect(cell).toHaveAttribute("title", /^From the last answer, not current · 5 checked/);
  await cell.click();
  const drill = card.locator('[data-wm-drill="github"]');
  await expect(drill.locator(":scope > *").nth(1)).toHaveText("From the last answer, not current");
  await expect(drill.locator(":scope > *").nth(2)).toHaveClass("wiki-wm-drill-counts");
  await expect(drill.locator(":scope > *").nth(3)).toHaveAttribute("data-wm-gh-group", "contradictions");
});

test("a retry that fails during «refreshing» keeps the count muted with «not checked», and the next start view asks again", async ({ page }) => {
  await page.clock.install();
  let n = 0;
  await page.route("**/api/wiki/work-map/checks*", (route) =>
    ++n === 2 ? route.fulfill({ status: 500, json: { error: "x" } }) : route.fulfill({ json: n === 1 ? checksBody({ refreshing: true, contradictions: [GH_CONTRADICTION], needs: GH_NEEDS }) : checksBody({ contradictions: [GH_CONTRADICTION], needs: GH_NEEDS }) }),
  );
  await openStart(page, GH);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
  await expect(cell).toContainText("refreshing");
  await page.clock.runFor(15_000);
  await expect(cell).toContainText("not checked");
  await expect(cell).not.toContainText("refreshing");
  await expect(cell.locator("b")).toHaveText("1");
  await expect(cell).toHaveClass(/\bmuted\b/);
  await expect(cell).not.toHaveClass(/\bbad\b/);
  // The same map's marks stay.
  await expect(page.locator("#wikiWorkCard .wiki-wm-ghnote.done")).toHaveCount(1);
  // A failure starts no loop.
  await page.clock.runFor(60_000);
  await page.waitForTimeout(100);
  expect(n).toBe(2);
  await visitAndReturn(page);
  await expect.poll(() => n).toBe(3);
  await expect(cell).not.toContainText("not checked");
  await expect(cell).toHaveClass(/\bbad\b/);
});

test("an hourly refetch that fails does not look fresh", async ({ page }) => {
  await page.clock.install();
  let n = 0;
  await page.route("**/api/wiki/work-map/checks*", (route) => (++n === 2 ? route.fulfill({ status: 500, json: { error: "x" } }) : route.fulfill({ json: checksBody({ contradictions: [GH_CONTRADICTION] }) })));
  await openStart(page, GH);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
  await expect(cell).toHaveClass(/\bbad\b/);
  await page.locator("#wikiWorkCard").locator('.wiki-wm-pages a[data-relpath], .wiki-wm-summary a[data-relpath]').first().click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  await page.clock.fastForward(HOUR + 1_000);
  await page.goBack();
  await expect.poll(() => n).toBe(2);
  await expect(cell).toContainText("not checked");
  await expect(cell.locator("b")).toHaveText("1");
  await expect(cell).toHaveClass(/\bmuted\b/);
  await page.clock.fastForward(60_000);
  await visitAndReturn(page);
  await expect.poll(() => n).toBe(3);
  await expect(cell).toHaveClass(/\bbad\b/);
});

for (const [name, first] of [
  ["a remedy", { notChecked: { reason: "auth", repos: ["acme/gears"] } }],
  ["no access", { notChecked: { reason: "no-access", repos: ["acme/gears"] } }],
  ["rows left unchecked", { checked: 0, unchecked: 85 }],
] as [string, Partial<WorkMapChecksBody>][]) {
  test(`an answer with ${name} is asked again on the next start view, and starts no loop`, async ({ page }) => {
    await page.clock.install();
    const stub = await stubChecks(page, (n) => (n === 1 ? checksBody(first) : checksBody()));
    await openStart(page, GH);
    const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
    await expect(cell).toContainText("not checked");
    await page.clock.runFor(60_000);
    await page.waitForTimeout(100);
    expect(stub.count()).toBe(1);
    await visitAndReturn(page);
    await expect.poll(() => stub.count()).toBe(2);
    await expect(cell).not.toContainText("not checked");
    await expect(cell.locator("b")).toHaveText("0");
    // Settled: the next visit asks nothing.
    await visitAndReturn(page);
    await page.waitForTimeout(100);
    expect(stub.count()).toBe(2);
  });
}

test("a no-access answer reads its remedy on the card", async ({ page }) => {
  await stubChecks(page, () => checksBody({ checked: 2, unchecked: 1, notChecked: { reason: "no-access", repos: ["acme/gears"] } }));
  await openStart(page, GH);
  await expect(page.locator('#wikiWorkCard [data-wm-cell="github"]')).toContainText("not checked: your gh login cannot see acme/gears (gh auth status)");
});

test("disabled is not asked again on the next start view", async ({ page }) => {
  const stub = await stubChecks(page, () => checksBody({ notChecked: { reason: "disabled", repos: [] } }));
  await openStart(page, GH);
  await expect.poll(() => stub.count()).toBe(1);
  await visitAndReturn(page);
  await page.waitForTimeout(100);
  expect(stub.count()).toBe(1);
});

test("an answer older than an hour is fetched again when the start view renders, and not before", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, () => checksBody());
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("0");
  const link = card.locator('.wiki-wm-pages a[data-relpath], .wiki-wm-summary a[data-relpath]').first();
  await link.click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator(".wiki-start")).toBeVisible();
  await page.waitForTimeout(100);
  expect(stub.count()).toBe(1);
  await link.click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  await page.clock.fastForward(HOUR + 1_000);
  await page.goBack();
  await expect.poll(() => stub.count()).toBe(2);
});

// ── The check's lifecycle ─────────────────────────────────────────────
const GH_REFRESHING = (): WorkMapChecksBody => checksBody({ refreshing: true, checked: 1, unchecked: 3, uncheckedRows: [{ page: "plans/beta.mdx", pr: 4, repo: "acme/gears" }] });
const CHECKS_PATH = "/api/wiki/work-map/checks";
const mapFile = (wiki: string) => path.join(roots[wiki]!, ".work-map.json");

for (const [what, wiki, late] of [
  ["An answer", GH_DROP_OK, (route: Route) => route.fulfill({ json: checksBody({ refreshing: true, contradictions: [GH_CONTRADICTION] }) })],
  ["A failure", GH_DROP_FAIL, (route: Route) => route.fulfill({ status: 500, json: { error: "x" } })],
] as const) {
  test(`${what} arriving after the card left the slot paints nothing and is dropped, and the card coming back behaves as new`, async ({ page }) => {
    await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
    let n = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/wiki/work-map/checks*", async (route) => {
      if (++n === 1) {
        await held;
        await late(route);
      } else await route.fulfill({ json: checksBody() });
    });
    await page.clock.install();
    await openStart(page, wiki);
    const card = page.locator("#wikiWorkCard");
    const wn = page.locator("#wikiWhatsNew");
    const cell = card.locator('[data-wm-cell="github"]');
    await expect(cell.locator("b")).toHaveText("checking…");
    await rm(mapFile(wiki));
    await forceAdopt(page, wiki);
    await expect(card).toBeHidden();
    await expect(wn).toContainText("Something changed");
    const landed = page.waitForResponse((r) => new URL(r.url()).pathname === CHECKS_PATH);
    release();
    await landed;
    await page.waitForTimeout(200);
    await expect(card).toBeHidden();
    await expect(wn).toBeVisible();
    // Same run time, so only the dropped answer could spare it a fetch.
    await writeFile(mapFile(wiki), mapJson(wiki, GH_DROP_RUN), "utf8");
    await forceAdopt(page, wiki);
    await expect.poll(() => n).toBe(2);
    await expect(cell.locator("b")).toHaveText("0");
    await expect(cell).not.toHaveClass(/\bmuted\b/);
    await expect(cell).not.toContainText("refreshing");
    await expect(wn).toBeHidden();
    // The late answer left no timer behind.
    await page.clock.runFor(60_000);
    await page.waitForTimeout(100);
    expect(n).toBe(2);
  });
}

test("an answer the card already has is forgotten when the card leaves the slot", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  const stub = await stubChecks(page, (n) => checksBody(n === 1 ? { contradictions: [GH_CONTRADICTION] } : {}));
  await page.clock.install();
  await openStart(page, GH_DROP_DONE);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("1");
  await rm(mapFile(GH_DROP_DONE));
  await forceAdopt(page, GH_DROP_DONE);
  await expect(card).toBeHidden();
  await writeFile(mapFile(GH_DROP_DONE), mapJson(GH_DROP_DONE, GH_DROP_RUN), "utf8");
  await forceAdopt(page, GH_DROP_DONE);
  await expect.poll(() => stub.count()).toBe(2);
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("0");
});

test("an answer arriving on an article view paints nothing there, and the start view shows it with no new fetch", async ({ page }) => {
  let n = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/work-map/checks*", async (route) => {
    n++;
    await held;
    await route.fulfill({ json: checksBody({ contradictions: [GH_CONTRADICTION] }) });
  });
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("checking…");
  await card.locator('.wiki-wm-pages a[data-relpath], .wiki-wm-summary a[data-relpath]').first().click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  const landed = page.waitForResponse((r) => new URL(r.url()).pathname === CHECKS_PATH);
  release();
  await landed;
  await page.waitForTimeout(100);
  await expect(card).toHaveCount(0);
  await page.goBack();
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("1");
  expect(n).toBe(1);
});

test("start views rendered while the first fetch is in flight add no fetch", async ({ page }) => {
  let n = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/work-map/checks*", async (route) => {
    n++;
    await held;
    await route.fulfill({ json: checksBody() });
  });
  await openStart(page, GH);
  const b = page.locator('#wikiWorkCard [data-wm-cell="github"] b');
  await expect(b).toHaveText("checking…");
  await visitAndReturn(page);
  await visitAndReturn(page);
  await expect(b).toHaveText("checking…");
  release();
  await expect(b).toHaveText("0");
  await page.waitForTimeout(100);
  expect(n).toBe(1);
});

test("start views rendered during a retry chain add no fetch and no second timer", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, GH_REFRESHING);
  await openStart(page, GH);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
  // Painted after its timer is set. An unread answer re-arms on a start view, so
  // only the pending timer keeps these renders from fetching.
  await expect(cell).toContainText("refreshing");
  for (const n of [1, 2, 3]) {
    await visitAndReturn(page);
    await visitAndReturn(page);
    await expect(cell).toContainText("refreshing");
    await page.waitForTimeout(100);
    expect(stub.count()).toBe(n);
    await stub.retry(n + 1);
    await page.waitForTimeout(100);
    expect(stub.count()).toBe(n + 1);
  }
  await expect(cell).toContainText("3 not checked");
  await page.clock.runFor(60_000);
  await page.waitForTimeout(100);
  expect(stub.count()).toBe(4);
});

test("a start view rendered while a retry is in flight adds no fetch and still reads «refreshing»", async ({ page }) => {
  await page.clock.install();
  let n = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/work-map/checks*", async (route) => {
    if (++n === 2) await held;
    await route.fulfill({ json: n === 1 ? GH_REFRESHING() : checksBody() });
  });
  await openStart(page, GH);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
  await expect(cell).toContainText("refreshing");
  await page.clock.runFor(15_000);
  await expect.poll(() => n).toBe(2);
  // The timer has fired, so only the fetch in flight says «refreshing» now.
  await visitAndReturn(page);
  await expect(cell).toContainText("refreshing");
  await expect(cell).not.toContainText("not checked");
  await page.waitForTimeout(100);
  expect(n).toBe(2);
  release();
  await expect(cell).not.toContainText("refreshing");
  await page.clock.runFor(60_000);
  await page.waitForTimeout(100);
  expect(n).toBe(2);
});

for (const [what, answer] of [
  ["rows left unchecked", (route: Route) => route.fulfill({ json: checksBody({ checked: 1, unchecked: 3, uncheckedRows: [{ page: "plans/beta.mdx", pr: 4, repo: "acme/gears" }] }) })],
  ["a failed GET", (route: Route) => route.fulfill({ status: 500, json: { error: "x" } })],
] as const) {
  test(`an adopt over ${what} re-arms nothing: neither it nor the next repaint fetches`, async ({ page }) => {
    let n = 0;
    await page.route("**/api/wiki/work-map/checks*", (route) => {
      n++;
      return answer(route);
    });
    await page.clock.install();
    await openStart(page, GH_ADOPT);
    const card = page.locator("#wikiWorkCard");
    await expect(card.locator('[data-wm-cell="github"]')).toContainText("not checked");
    await forceAdopt(page, GH_ADOPT);
    expect(n).toBe(1);
    // ✓ repaints the card, and a repaint is what reads a re-armed answer.
    const needs = card.locator("[data-wm-done]");
    const before = await needs.count();
    await needs.first().click();
    await expect(needs).toHaveCount(before - 1);
    await page.waitForTimeout(100);
    expect(n).toBe(1);
  });
}

test("a new map after ↻ fetches the checks at once, for its marks", async ({ page }) => {
  const stub = await stubChecks(page, () => checksBody());
  const newRun = Date.now();
  let gets = 0;
  let posted = false;
  await page.route("**/api/wiki/work-map?*", async (route) => {
    gets++;
    const res = await route.fetch();
    const body = (await res.json()) as { map: { runAtMs: number } } & Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - HOUR, map: posted ? { ...body.map, runAtMs: newRun } : body.map } });
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => {
    posted = true;
    return route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } });
  });
  await page.clock.install();
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("0");
  expect(stub.count()).toBe(1);
  await card.locator("#wikiWorkMapRefresh").click();
  await expect
    .poll(async () => {
      await page.clock.runFor(1_000);
      return stub.count();
    })
    .toBe(2);
  expect(gets).toBeGreaterThan(1);
});

// The new map shares a title with the old one, so an old answer would land on it.
async function refreshToNewMap(page: Page, second: (route: Route) => Promise<void>): Promise<{ card: Locator; checks: () => number }> {
  let n = 0;
  await page.route("**/api/wiki/work-map/checks*", async (route) => (++n === 1 ? route.fulfill({ json: checksBody({ needs: GH_NEEDS, contradictions: [{ page: "plans/alpha.mdx", pr: 369, repo: "acme/gears", rowState: "open", ghState: "MERGED", mergedAt: GH_MERGED_AT }] }) }) : second(route)));
  const newRun = Date.now();
  let posted = false;
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { map: { runAtMs: number } } & Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - HOUR, map: posted ? { ...body.map, runAtMs: newRun } : body.map } });
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => {
    posted = true;
    return route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } });
  });
  await page.clock.install();
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator(".wiki-wm-ghnote.done")).toHaveCount(1);
  await card.locator("#wikiWorkMapRefresh").click();
  await expect
    .poll(async () => {
      await page.clock.runFor(1_000);
      return n;
    })
    .toBe(2);
  return { card, checks: () => n };
}

test("a new map shows no mark from the previous answer while its own GET is pending", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const { card } = await refreshToNewMap(page, async (route) => {
    await held;
    await route.fulfill({ json: checksBody({ needs: [{ kind: "followup", title: "Only mentions", pr: 3556, state: "MERGED", mergedAt: "2026-10-28T12:00:00Z", asksForIt: false }] }) });
  });
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(card.locator(".wiki-wm-ghnote")).toHaveCount(0);
  await expect(card.locator(".wiki-wm-need.gh-done")).toHaveCount(0);
  expect(await card.locator(".wiki-wm-need").filter({ hasText: "Merge the fix" }).locator(".wiki-wm-action").evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
  // The old answer still counts the rows, muted.
  await expect(cell.locator("b")).toHaveText("1");
  await expect(cell).toHaveClass(/\bmuted\b/);
  await expect(cell).not.toHaveClass(/\bbad\b/);
  await expect(cell).toContainText("checking…");
  // Its own answer marks.
  release();
  await expect(card.locator(".wiki-wm-ghnote.info")).toHaveText("GitHub: #3556 merged 28.10");
  await expect(card.locator(".wiki-wm-ghnote")).toHaveCount(1);
  await expect(cell).not.toHaveClass(/\bmuted\b/);
});

test("a new map whose GET answers 500 keeps no mark from the previous answer", async ({ page }) => {
  const { card, checks } = await refreshToNewMap(page, (route) => route.fulfill({ status: 500, json: { error: "x" } }));
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(card.locator(".wiki-wm-ghnote")).toHaveCount(0);
  await expect(card.locator(".wiki-wm-need.gh-done")).toHaveCount(0);
  await expect(cell).toContainText("not checked");
  await expect(cell.locator("b")).toHaveText("1");
  await expect(cell).toHaveClass(/\bmuted\b/);
  // No retry loop on the same map.
  await page.clock.runFor(30_000);
  await page.waitForTimeout(100);
  expect(checks()).toBe(2);
  await expect(card.locator(".wiki-wm-ghnote")).toHaveCount(0);
});

test("a themes map never asks for the check", async ({ page }) => {
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: false, map: sweepThemesMap(Date.now()) } });
  });
  const stub = await stubChecks(page, () => checksBody());
  await openStart(page, SWEEP);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator(".wiki-wn-title")).toHaveText("What you’re following");
  await page.waitForTimeout(300);
  expect(stub.count()).toBe(0);
  await expect(card.locator(".wiki-wm-ghnote")).toHaveCount(0);
});

test("a themes map has no strip", async ({ page }) => {
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: false, map: sweepThemesMap(Date.now()) } });
  });
  await openStart(page, SWEEP);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator(".wiki-wn-title")).toHaveText("What you’re following");
  await expect(card.locator(".wiki-wm-strip")).toHaveCount(0);
});

for (const width of [1280, 700]) {
  test(`a long unbroken title wraps inside the open list at ${width} wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openSettled(page, STRIP_LONG);
    const card = page.locator("#wikiWorkCard");
    await card.locator('[data-wm-cell="decisions"]').click();
    const drill = card.locator(".wiki-wm-drill");
    await expect(drill.locator(".wiki-wm-drill-row")).toHaveCount(2);
    await expect(drill).toContainText(LONG_TOKEN);
    await expect(drill).toContainText("s".repeat(180));
    const m = await drill.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, rowH: el.querySelector("li")!.getBoundingClientRect().height, twoEm: parseFloat(getComputedStyle(el).fontSize) * 2 }));
    expect(m.scroll).toBeLessThanOrEqual(m.client);
    expect(m.rowH).toBeGreaterThan(m.twoEm);
    expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  });
}

test("a themes map keeps its markup when only the strip's inputs change, and repaints on a declaration", async ({ page }) => {
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: false, map: sweepThemesMap(Date.now()) } });
  });
  await page.clock.install();
  await openStart(page, THEME_HOLD);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator(".wiki-wn-title")).toHaveText("What you’re following");
  const selected = await page.evaluate(() => {
    const el = document.querySelector("#wikiWorkCard .wiki-wm-summary")!;
    el.setAttribute("data-before-adopt", "");
    getSelection()!.selectAllChildren(el);
    return String(getSelection());
  });
  expect(selected.length).toBeGreaterThan(0);
  const adopt = async (title: string) => {
    await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("#wikiList")).toContainText(title);
    await page.waitForTimeout(300);
  };
  await writeFile(path.join(roots[THEME_HOLD]!, "plans/hold-steps.mdx"), `---\ntitle: Hold steps\n---\n\n<NextMoves>\n\n<Lane kind="you">\n\n- One\n\n</Lane>\n\n</NextMoves>\n`, "utf8");
  await adopt("Hold steps");
  await expect(card.locator("[data-before-adopt]")).toHaveCount(1);
  expect(await page.evaluate(() => String(getSelection()))).toBe(selected);
  // A declaration still re-joins a themes map: this is the repaint the guard must not take away.
  await writeFile(path.join(roots[THEME_HOLD]!, "plans/hold-declared.mdx"), `---\ntitle: Hold declared\neffort: t0\n---\n\nBody.\n`, "utf8");
  await adopt("Hold declared");
  // It waits for the reader's selection like any paint nobody asked for.
  await expect(card.locator("[data-before-adopt]")).toHaveCount(1);
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await expect(card.locator("[data-before-adopt]")).toHaveCount(0);
});

for (const theme of THEMES) {
  test(`keyboard focus on an open cell looks different from open without focus in the ${theme.label} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme.scheme });
    await page.addInitScript((v) => {
      if (v === null) localStorage.removeItem("muninn-theme");
      else localStorage.setItem("muninn-theme", v);
    }, theme.stored);
    await openSettled(page, STRIP);
    const card = page.locator("#wikiWorkCard");
    const open = card.locator('[data-wm-cell="decisions"]');
    const next = card.locator('[data-wm-cell="oldest"]');
    const shut = card.locator('[data-wm-cell="steps"]');
    const accent = await token(page, "--accent");
    await open.focus();
    await page.keyboard.press("Enter");
    await expect(open).toHaveAttribute("aria-expanded", "true");
    await expect(open).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(next).toBeFocused();
    const closedFocused = await cellPaint(next);
    const openAtRest = await cellPaint(open);
    const closedAtRest = await cellPaint(shut);
    await page.keyboard.press("Shift+Tab");
    await expect(open).toBeFocused();
    expect(await open.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    const openFocused = await cellPaint(open);
    expect(openFocused).not.toEqual(openAtRest);
    // Focus is the outline, on an open cell and a closed one alike.
    expect(openAtRest.outline).toBe("none 0px");
    expect(openFocused.outline).toBe("solid 2px");
    expect(openFocused.outlineColor).toBe(accent);
    expect(closedFocused.outline).toBe("solid 2px");
    // Open still reads at rest, without any outline.
    expect(openAtRest.shadow).toContain(accent);
    expect(openAtRest.shadow).toContain("inset");
    expect(openAtRest.border).toBe(accent);
    expect(closedAtRest.shadow).toBe("none");
    expect(closedAtRest.border).not.toBe(accent);
    // The ring is seen against the card behind it (WCAG 1.4.11: 3:1).
    await card.evaluate((el) => {
      const probe = document.createElement("span");
      probe.id = "ringProbe";
      probe.style.color = "var(--accent)";
      el.appendChild(probe);
    });
    expect(await contrastOf(page.locator("#ringProbe"))).toBeGreaterThanOrEqual(3);
  });
}

/** How often `cellPaint` reads, 50 ms apart, before it calls the card repainting for good. */
const CELL_PAINT_READS = 40;

/** All a cell's border, ring and shadow paint: what a state change has to move.
 *  `Locator.evaluate` finds the element, then reads it: a repaint between the two
 *  reads a detached element, whose computed style is empty, so this paint's fields
 *  would be "" and the outline " " (CI, #787). */
async function cellPaint(cell: Locator) {
  await checksPainted(cell.page());
  for (let read = 0; read < CELL_PAINT_READS; read++) {
    const paint = await cell.evaluate(
      (el) => {
        if (!el.isConnected) return null;
        const c = getComputedStyle(el);
        return { outline: `${c.outlineStyle} ${c.outlineWidth}`, outlineColor: c.outlineColor, shadow: c.boxShadow, border: c.borderTopColor, borderWidth: c.borderTopWidth };
      },
      undefined,
      { timeout: 5_000 },
    );
    if (paint) return paint;
    await cell.page().waitForTimeout(50);
  }
  throw new Error(`cellPaint: ${cell} was detached on all ${CELL_PAINT_READS} reads, so the card keeps repainting`);
}

for (const theme of THEMES) {
  test.describe(`cell hover in the ${theme.label} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ colorScheme: theme.scheme });
      await page.addInitScript((v) => {
        if (v === null) localStorage.removeItem("muninn-theme");
        else localStorage.setItem("muninn-theme", v);
      }, theme.stored);
    });

    test("hovering an open cell paints differently from the open cell at rest", async ({ page }) => {
      await openSettled(page, STRIP);
      const open = page.locator('#wikiWorkCard [data-wm-cell="decisions"]');
      await open.click();
      await expect(open).toHaveAttribute("aria-expanded", "true");
      await page.mouse.move(0, 0);
      const rest = await cellPaint(open);
      await open.hover();
      await expect.poll(() => cellPaint(open)).not.toEqual(rest);
    });

    test("hovering a closed cell paints the accent border, and a disabled cell does not react", async ({ page }) => {
      await openSettled(page, STRIP);
      const shut = page.locator('#wikiWorkCard [data-wm-cell="steps"]');
      const rest = await cellPaint(shut);
      expect(rest.border).not.toBe(await token(page, "--accent"));
      await shut.hover();
      await expect.poll(async () => (await cellPaint(shut)).border).toBe(await token(page, "--accent"));
      await page.mouse.move(0, 0);
      await openSettled(page, STRIP_OFF);
      const off = page.locator('#wikiWorkCard [data-wm-cell="decisions"]');
      await expect(off).toBeDisabled();
      const offRest = await cellPaint(off);
      await off.hover();
      expect(await off.evaluate((el) => el.matches(":hover"))).toBe(true);
      expect(await cellPaint(off)).toEqual(offRest);
    });
  });
}

test("a mouse click opens a cell and draws no focus ring", async ({ page }) => {
  await openSettled(page, STRIP);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="decisions"]');
  await cell.click();
  await expect(cell).toHaveAttribute("aria-expanded", "true");
  await expect(cell).toBeFocused();
  expect((await cellPaint(cell)).outline).toBe("none 0px");
});

for (const scheme of ["light", "dark"] as const) {
  test(`forced colors over a ${scheme} scheme: open differs from closed, and focus from open at rest`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, forcedColors: "active" });
    await openSettled(page, STRIP);
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    const card = page.locator("#wikiWorkCard");
    const open = card.locator('[data-wm-cell="decisions"]');
    const next = card.locator('[data-wm-cell="oldest"]');
    const shut = card.locator('[data-wm-cell="steps"]');
    const box = async () => {
      const b = (await open.locator("b").boundingBox())!;
      return { x: b.x, y: b.y, cell: (await open.boundingBox())!.height };
    };
    const boxShut = await box();
    await open.focus();
    await page.keyboard.press("Enter");
    await expect(open).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Tab");
    await expect(next).toBeFocused();
    const closedFocused = await cellPaint(next);
    const openAtRest = await cellPaint(open);
    const closedAtRest = await cellPaint(shut);
    // Open is a colour and a width, so it does not hang on one system colour pair.
    expect(openAtRest.border).not.toBe(closedAtRest.border);
    expect(openAtRest.borderWidth).toBe("2px");
    expect(closedAtRest.borderWidth).toBe("1px");
    // The wider border takes its width from the padding: nothing moves when a cell opens.
    expect(await box()).toEqual(boxShut);
    await page.keyboard.press("Shift+Tab");
    await expect(open).toBeFocused();
    const openFocused = await cellPaint(open);
    // Focus is still the outline alone, on top of the open mark.
    expect(openAtRest.outline).toBe("none 0px");
    expect(openFocused.outline).toBe("solid 2px");
    expect(closedFocused.outline).toBe("solid 2px");
    expect(openFocused.borderWidth).toBe("2px");
    expect(closedFocused.borderWidth).toBe("1px");
  });
}
