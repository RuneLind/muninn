/**
 * The /wiki page rail: full titles and a draggable, remembered width.
 *
 * What the unit tests cannot reach:
 *  1. **A long title is no longer clipped to one line.** The rule is CSS on a
 *     bundled page; `wiki-rail-width.test.ts` knows nothing about it. The
 *     assertion is the RENDERED height of the title against its line-height —
 *     two lines is the whole feature.
 *  2. **A drag changes the grid column and a reload brings it back.** The
 *     variable is set inline by pointer events and read from localStorage at
 *     boot; every link in that chain is DOM. The width is asserted on the pane's
 *     bounding box, not on the variable — a variable the grid does not read
 *     would still "persist".
 *  3. **Double-click resets to the shipped default and forgets the stored value.**
 *
 * No model calls. ENV / SPAWN: as every spec here — `e2eEnv()` keeps this
 * muninn off Telegram/Slack and off the host's instance-profile flags.
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
  RAIL_MID_MIN_CHIP,
  RAIL_MID_MIN_CHIP_NARROW,
  RAIL_TITLE_MIN,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_DEFAULT_NARROW,
  RAIL_WIDTH_KEY,
  RAIL_WIDTH_KEY_STEP,
  RAIL_WIDTH_MAX,
} from "../src/dashboard/views/components/wiki-rail-width.ts";

const PORT = e2ePort("wiki-rail-width");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-rail";

/** Long enough to need a second line at every width the clamp allows, and
 *  shaped like the titles that motivated this: the distinguishing part is at the
 *  END. A one-line ellipsis loses exactly the "(B, follow-up)". */
const LONG_TITLE = "MELOSYS-7588/7969 — Nullable trygdesperiode-FK i grunnlag (B, follow-up)";
const LONG_REL = "long-title.md";
const SHORT_REL = "short.md";

/**
 * The row-layout edge cases the round-3 verify pass of #557 found, each a page
 * whose chip or fixed parts sit at the edge of one width budget. Settled (a
 * fixed `created:` and old mtimes) so Activity lifts none of the children out
 * and the chips read their full counts.
 *  - `sup10`: a superseded-only chip, `10 superseded` — the widest one-kind
 *    label, which the attached-only budget did not cover;
 *  - `big`: three-digit counts, `120 · 100`, beside a pill and a ⚑ — a compact
 *    chip wider than the mid box's floor allowed for;
 *  - `three`: `3 attached` beside a pill and a ⚑ at the DEFAULT rail — the one
 *    chip row on mimir that wrapped at 300px;
 *  - `bare`: a pill and a ⚑ with no chip — the row shape that wraps at the
 *    260px rail, where the title floor is what the second line buys.
 */
const SUP10 = "plans/sup10.mdx";
const BIG = "plans/big.mdx";
const THREE = "plans/three.mdx";
const BARE = "plans/bare.mdx";
const BIG_ATTACHED = 120;
const BIG_SUPERSEDED = 100;
const md = (title: string, extra: string[] = []) =>
  ["---", `title: ${title}`, SETTLED_CREATED_LINE, ...extra, "---", "", `# ${title}`, "", "Body.", ""].join("\n");
const html = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;
const PILL_AND_FLAG = ["plan_status: shipped", "followups: open"];
const EDGE_PAGES: Array<[string, string]> = [
  [SUP10, md("Sup ten parent plan")],
  ...Array.from({ length: 10 }, (_, i): [string, string] => [
    `plans/sup10-old-${i + 1}.md`,
    md(`Sup ten retired ${i + 1}`, ["superseded_by: [[sup10]]"]),
  ]),
  [BIG, md("Big parent plan with a long enough title", PILL_AND_FLAG)],
  ...Array.from({ length: BIG_ATTACHED }, (_, i): [string, string] => [
    `plans/big-prototype-${i + 1}.html`,
    html(`Big mock ${i + 1}`),
  ]),
  ...Array.from({ length: BIG_SUPERSEDED }, (_, i): [string, string] => [
    `plans/big-old-${i + 1}.md`,
    md(`Big retired ${i + 1}`, ["superseded_by: [[big]]"]),
  ]),
  [THREE, md("Three attached plan title", PILL_AND_FLAG)],
  ...Array.from({ length: 3 }, (_, i): [string, string] => [
    `plans/three-prototype-${i + 1}.html`,
    html(`Three mock ${i + 1}`),
  ]),
  [BARE, md("Bare plan with a pill and a flag", PILL_AND_FLAG)],
];
/** Rows on screen with every group closed: the two title pages + four parents. */
const CLOSED_ROWS = 2 + 4;

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-rail-"));
  await writeFile(
    path.join(root, LONG_REL),
    ["---", `title: ${LONG_TITLE}`, "---", "", `# ${LONG_TITLE}`, "", "Body.", ""].join("\n"),
    "utf8",
  );
  await writeFile(path.join(root, SHORT_REL), ["---", "title: Short", "---", "", "# Short", "", "Body.", ""].join("\n"), "utf8");
  for (const [rel, body] of EDGE_PAGES) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  await settleWikiMtimes(root);

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root}`,
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
});

const RAIL = ".wiki-layout > .wiki-pane:first-child";
const HANDLE = "#wikiRailResizer";

async function open(page: import("@playwright/test").Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
}

async function railWidth(page: import("@playwright/test").Page): Promise<number> {
  const box = await page.locator(RAIL).boundingBox();
  if (!box) throw new Error("rail not laid out");
  return Math.round(box.width);
}

test.describe("Wiki rail: full titles + remembered width", () => {
  test("a long title wraps to a second line instead of clipping", async ({ page }) => {
    await open(page);
    const title = page.locator(`.wiki-list-item[data-relpath="${LONG_REL}"] .wiki-list-title`);
    await expect(title).toHaveText(LONG_TITLE);
    const { height, lineHeight, whiteSpace } = await title.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { height: el.getBoundingClientRect().height, lineHeight: parseFloat(cs.lineHeight), whiteSpace: cs.whiteSpace };
    });
    expect(whiteSpace).not.toBe("nowrap");
    // Two lines: taller than one line-height by a clear margin. The one-line
    // ellipsis this replaces measures exactly ONE line-height here.
    expect(height).toBeGreaterThan(lineHeight * 1.8);
  });

  test("dragging the handle widens the rail, and a reload keeps it", async ({ page }) => {
    await open(page);
    const before = await railWidth(page);
    expect(before).toBe(RAIL_WIDTH_DEFAULT);

    const hb = await page.locator(HANDLE).boundingBox();
    if (!hb) throw new Error("handle not laid out");
    const x0 = hb.x + hb.width / 2;
    const y0 = hb.y + hb.height / 2;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 60, y0, { steps: 6 });
    await page.mouse.move(x0 + 120, y0, { steps: 6 });
    await page.mouse.up();

    const after = await railWidth(page);
    expect(after).toBeGreaterThanOrEqual(before + 110);
    expect(after).toBeLessThanOrEqual(before + 130);

    // The stored value is what a reload reads — assert it, then assert the reload.
    const stored = await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY);
    expect(Number(stored)).toBe(after);

    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
    expect(await railWidth(page)).toBe(after);
  });

  test("a width stored on a wide monitor is bounded by a narrow window", async ({ page }) => {
    await open(page);
    await page.evaluate((k) => localStorage.setItem(k, "560"), RAIL_WIDTH_KEY);
    await page.setViewportSize({ width: 700, height: 900 });
    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
    // 45% of 700 = 315: the stored value is bounded at APPLY time, never
    // rewritten — widening the window again gets the stored width back.
    expect(await railWidth(page)).toBe(315);
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect.poll(() => railWidth(page)).toBe(560);
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBe("560");
  });

  test("losing pointer capture mid-drag ends the drag instead of leaving the page in drag state", async ({
    page,
  }) => {
    await open(page);
    const hb = await page.locator(HANDLE).boundingBox();
    if (!hb) throw new Error("handle not laid out");
    const x0 = hb.x + hb.width / 2;
    const y0 = hb.y + hb.height / 2;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 80, y0, { steps: 4 });
    await expect(page.locator("body")).toHaveClass(/wiki-rail-dragging/);
    // A right-click's context-menu gesture (measured in review) drops the capture
    // and the handle never sees the pointerup; Playwright's mouse cannot reproduce
    // that gesture, so the browser-fired event is dispatched directly. Before the
    // fix the body kept `user-select: none` + col-resize until a reload, and any
    // later hover over the handle resized the rail with no button held.
    await page.locator(HANDLE).evaluate((el) => {
      el.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1, bubbles: true }));
    });
    await expect(page.locator("body")).not.toHaveClass(/wiki-rail-dragging/);
    const settled = await railWidth(page);
    expect(settled).toBeGreaterThan(RAIL_WIDTH_DEFAULT);
    // Still physically captured by Playwright's mouse, so these moves reach the
    // handle — with no drag in progress they must not resize.
    await page.mouse.move(x0 + 140, y0, { steps: 3 });
    expect(await railWidth(page)).toBe(settled);
    await page.mouse.up();
    // The width the drag reached before losing capture is what gets remembered.
    expect(Number(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY))).toBe(settled);
  });

  test("in a bounded window, arrows step the DISPLAYED width and a drag stores what was shown", async ({
    page,
  }) => {
    await open(page);
    await page.evaluate((k) => localStorage.setItem(k, "560"), RAIL_WIDTH_KEY);
    await page.setViewportSize({ width: 700, height: 900 });
    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
    expect(await railWidth(page)).toBe(315);
    // Stepping from the STORED 560 moved nothing press after press while
    // rewriting the stored value (measured in review); the base is what is shown.
    // A GROW the bound makes inert must not lower the stored desktop width.
    await page.locator(HANDLE).focus();
    await page.keyboard.press("ArrowRight");
    expect(await railWidth(page)).toBe(315);
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBe("560");
    // The same inert grow by a SHORT drag (to 320, under the stored 560).
    const hb0 = await page.locator(HANDLE).boundingBox();
    if (!hb0) throw new Error("handle not laid out");
    await page.mouse.move(hb0.x + hb0.width / 2, hb0.y + 40);
    await page.mouse.down();
    await page.mouse.move(hb0.x + hb0.width / 2 + 5, hb0.y + 40, { steps: 2 });
    await page.mouse.up();
    expect(await railWidth(page)).toBe(315);
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBe("560");
    await page.keyboard.press("ArrowLeft");
    expect(await railWidth(page)).toBe(315 - RAIL_WIDTH_KEY_STEP);
    expect(Number(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY))).toBe(
      315 - RAIL_WIDTH_KEY_STEP,
    );
    // A drag all the way right is a GROW: it stores what was asked for (the
    // pointer's clamped width, 560) while the bound keeps showing 315 — the same
    // rule as the arrow keys, so the desktop width is what the reader dragged to.
    const hb = await page.locator(HANDLE).boundingBox();
    if (!hb) throw new Error("handle not laid out");
    await page.mouse.move(hb.x + hb.width / 2, hb.y + 40);
    await page.mouse.down();
    await page.mouse.move(650, hb.y + 40, { steps: 4 });
    await page.mouse.up();
    expect(await railWidth(page)).toBe(315);
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBe(String(RAIL_WIDTH_MAX));
    // And a drag back to a width UNDER the bound is a shrink: stored = shown.
    const hb2 = await page.locator(HANDLE).boundingBox();
    if (!hb2) throw new Error("handle not laid out");
    await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + 40);
    await page.mouse.down();
    await page.mouse.move(hb2.x - 40, hb2.y + 40, { steps: 4 });
    await page.mouse.up();
    const shown = await railWidth(page);
    expect(shown).toBeLessThan(315);
    expect(Number(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY))).toBe(shown);
  });

  test("a drag that overshoots the bound and comes back stores the RELEASE width, not the maximum", async ({
    page,
  }) => {
    await open(page);
    await page.setViewportSize({ width: 700, height: 900 });
    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
    const rb = await page.locator(RAIL).boundingBox();
    if (!rb) throw new Error("rail not laid out");
    const hb = await page.locator(HANDLE).boundingBox();
    if (!hb) throw new Error("handle not laid out");
    const y = hb.y + 40;
    await page.mouse.move(hb.x + hb.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(rb.x + 500, y, { steps: 4 }); // out past the bound (shown pins at 315)
    await page.mouse.move(rb.x + 330, y, { steps: 4 }); // back, still over the bound
    await page.mouse.up();
    expect(await railWidth(page)).toBe(315);
    // The rule is judged against the state at the START of the gesture; fed its
    // own running result it stored the maximum the pointer ever reached (500).
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBe("330");
  });

  test("the hit zone starts at the pane's border: the list's last pixel never starts a drag", async ({
    page,
  }) => {
    await open(page);
    const rb = await page.locator(RAIL).boundingBox();
    if (!rb) throw new Error("rail not laid out");
    const railRight = Math.round(rb.x + rb.width); // first pixel OUTSIDE the pane
    const y = rb.y + rb.height / 2;
    // railRight-2 is the last pixel of the list's content box (the pane's 1px
    // border is railRight-1). On Windows/Linux that pixel is the outer edge of a
    // classic scrollbar; the accent pseudo-element used to be hit-testable there.
    await page.mouse.move(railRight - 2, y);
    await page.mouse.down();
    await page.mouse.move(railRight + 60, y, { steps: 3 });
    await expect(page.locator("body")).not.toHaveClass(/wiki-rail-dragging/);
    await page.mouse.up();
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT);
    // One pixel further out is the handle.
    await page.mouse.move(railRight - 1, y);
    await page.mouse.down();
    await page.mouse.move(railRight + 60, y, { steps: 3 });
    await page.mouse.up();
    expect(await railWidth(page)).toBeGreaterThan(RAIL_WIDTH_DEFAULT);
  });

  test("below the breakpoint the reset lands on the narrow default and arrows step from it", async ({
    page,
  }) => {
    await open(page);
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT_NARROW);
    await page.locator(HANDLE).focus();
    await page.keyboard.press("ArrowRight");
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT_NARROW + RAIL_WIDTH_KEY_STEP);
    await page.keyboard.press("Home");
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT_NARROW);
  });

  test("a click on the handle focuses it, so the keyboard path is reachable by pointer", async ({ page }) => {
    await open(page);
    const hb = await page.locator(HANDLE).boundingBox();
    if (!hb) throw new Error("handle not laid out");
    await page.mouse.click(hb.x + hb.width / 2, hb.y + 40);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("wikiRailResizer");
  });

  test("a move with no button held mid-drag, and a dead pointer's down, are ignored", async ({ page }) => {
    // Both pin guards the drag path carries for other pointers: a second,
    // uncaptured pointer hovering the handle while a pen drags (buttons = 0), and a
    // pointerdown for a pointer the browser no longer knows (setPointerCapture
    // throws). Neither is reachable with Playwright's one mouse, so both are
    // dispatched. Written as pins after review found both guards unpinned.
    await open(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const hb = await page.locator(HANDLE).boundingBox();
    if (!hb) throw new Error("handle not laid out");
    const x0 = hb.x + hb.width / 2;
    const y0 = hb.y + 40;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 60, y0, { steps: 3 });
    const during = await railWidth(page);
    await page.locator(HANDLE).evaluate((el, x) => {
      el.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: x, buttons: 0, bubbles: true }));
    }, x0 + 200);
    expect(await railWidth(page)).toBe(during);
    await page.mouse.up();

    await page.locator(HANDLE).evaluate((el) => {
      el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 999, button: 0, buttons: 1, bubbles: true }));
    });
    await expect(page.locator("body")).not.toHaveClass(/wiki-rail-dragging/);
    expect(errors).toEqual([]);
  });

  test("the handle is keyboard-operable: arrows resize, Home resets", async ({ page }) => {
    await open(page);
    await page.locator(HANDLE).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT + 3 * RAIL_WIDTH_KEY_STEP);
    expect(Number(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY))).toBe(
      RAIL_WIDTH_DEFAULT + 3 * RAIL_WIDTH_KEY_STEP,
    );
    await page.keyboard.press("Home");
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT);
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBeNull();
  });

  test("double-click resets to the default and clears the stored width", async ({ page }) => {
    await open(page);
    await page.evaluate((k) => localStorage.setItem(k, "480"), RAIL_WIDTH_KEY);
    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
    expect(await railWidth(page)).toBe(480);

    await page.locator(HANDLE).dblclick();
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT);
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBeNull();
  });
});

/**
 * The row's width budgets, driven at the widths where the round-3 verify pass
 * of #557 measured them failing. Every case asserts a PROPERTY (nothing clipped,
 * nothing overflowing its box, the title at its floor) and never a form or a
 * pixel count, so a font-metric drift on another machine degrades the chip to
 * its compact form rather than failing the case. The rail width is set the way
 * a reader sets it: the stored value.
 */
test.describe("Wiki rail: row layout at the width budgets", () => {
  type Page = import("@playwright/test").Page;
  async function openAt(page: Page, width: number): Promise<void> {
    await page.addInitScript(
      ([key, w]) => localStorage.setItem(key as string, String(w)),
      [RAIL_WIDTH_KEY, width] as const,
    );
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
    expect(await railWidth(page)).toBe(width);
  }
  const rowOf = (page: Page, rel: string) => page.locator(`.wiki-list-item[data-relpath="${rel}"]`);
  /** The geometry every case reads: which chip form is painted and whether it is
   *  whole, whether the title+chip pair overflows its box, the title's width,
   *  and whether the ★+date slot sits on the title's line or under it. */
  function geometry(page: Page, rel: string) {
    return rowOf(page, rel).evaluate((el) => {
      const q = (s: string) => el.querySelector(s) as HTMLElement | null;
      const full = q(".wiki-fold-chip-label");
      const counts = q(".wiki-fold-chip-counts");
      const shown = full && getComputedStyle(full).display !== "none" ? full : counts;
      const chip = q(".wiki-fold-chip");
      const mid = q(".wiki-list-mid")!;
      const title = q(".wiki-list-title")!;
      const end = q(".wiki-list-end")!;
      return {
        label: shown?.textContent ?? "",
        // scrollWidth and clientWidth are rounded apart on a fractional span, so a
        // whole 98.4px label can read 99 > 98; a real clip here is 5px or more.
        labelClipped: shown ? shown.scrollWidth - shown.clientWidth > 1 : false,
        chipPastMid: chip ? chip.getBoundingClientRect().right - mid.getBoundingClientRect().right : 0,
        midOverflow: mid.scrollWidth - mid.clientWidth,
        title: title.getBoundingClientRect().width,
        wrapped: end.getBoundingClientRect().top > title.getBoundingClientRect().top + 8,
        endGap: el.getBoundingClientRect().right - 10 - end.getBoundingClientRect().right,
        kids: Array.from(el.children).map((c) => [c.className.slice(0, 24), Math.round(c.getBoundingClientRect().width), Math.round(c.getBoundingClientRect().top)]),
        item: el.clientWidth,
      };
    });
  }

  test("a superseded-only chip is never painted clipped, at the narrow rail and the default", async ({ page }) => {
    for (const width of [260, 270, 300]) {
      await openAt(page, width);
      const g = await geometry(page, SUP10);
      expect(g.label.replace(/\s+/g, " "), `counts intact at ${width}`).toContain("10");
      expect(g.labelClipped, `label whole at ${width}: "${g.label}"`).toBe(false);
      expect(g.chipPastMid, `chip inside its box at ${width}`).toBeLessThanOrEqual(0.5);
      expect(g.title, `title floor at ${width}`).toBeGreaterThanOrEqual(RAIL_TITLE_MIN);
    }
  });

  test("a three-digit chip beside a pill and a ⚑ stays inside the title+chip box at every width under 270", async ({ page }) => {
    for (const width of [260, 265, 269, 270, 300]) {
      await openAt(page, width);
      const g = await geometry(page, BIG);
      expect(g.label.replace(/\s+/g, " "), `counts intact at ${width}`).toContain(String(BIG_ATTACHED));
      expect(g.labelClipped, `label whole at ${width}`).toBe(false);
      expect(g.midOverflow, `pair fits its box at ${width}`).toBeLessThanOrEqual(0);
      expect(g.chipPastMid, `chip inside its box at ${width}`).toBeLessThanOrEqual(0.5);
      expect(g.title, `title floor at ${width}`).toBeGreaterThanOrEqual(RAIL_TITLE_MIN);
      expect(g.endGap, `end slot flush right at ${width}`).toBeLessThanOrEqual(1);
    }
  });

  /**
   * The narrow floor, pinned as a COUNTERFACTUAL rather than at a width: the
   * row's fixed parts are platform font metrics (CI's Linux paints the pill at
   * 61px, the ⚑ at 9 and the date at 73 against 56/6/74 on macOS, and a rail
   * picked by hand here summed to exactly the content box there and wrapped).
   * So the case measures the fixed parts on the row itself, computes the rail at
   * which the narrow floor fits with 4px to spare, asserts one line there, and
   * asserts the same rail is under what the DEFAULT floor would need — which is
   * what makes it evidence about the floor and not about the machine. On mimir
   * the row this stands for (`3 attached` + pill + ⚑ + a compact age) was the
   * one chip row wrapping at the 300px default; measured 0 after, 1 before.
   */
  test("a one-count chip beside a pill and a ⚑ keeps ONE line where only the narrow floor fits", async ({ page }) => {
    await openAt(page, 300);
    const fixed = await rowOf(page, THREE).evaluate((el) => {
      const w = (s: string) => (el.querySelector(s) as HTMLElement).getBoundingClientRect().width;
      const cs = getComputedStyle(el);
      const gap = parseFloat(cs.gap) || 8;
      const content = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      // dot · [mid] · pill · ⚑ · ★+date, and the four gaps between five items.
      return { parts: w(".wiki-type-dot") + w(".wiki-status") + w(".wiki-followup-flag") + w(".wiki-list-end") + 4 * gap, content };
    });
    // Rail px per content px is 1:1; the offset is whatever the pane, list and
    // row paddings take, read from this machine rather than assumed.
    const offset = 300 - fixed.content;
    const railFor = (floor: number) => Math.ceil(fixed.parts + floor + offset);
    const width = railFor(RAIL_MID_MIN_CHIP_NARROW) + 4;
    // The counterfactual: at this rail the default floor would NOT fit.
    expect(width, `narrow ${railFor(RAIL_MID_MIN_CHIP_NARROW)} vs default ${railFor(RAIL_MID_MIN_CHIP)}`).toBeLessThan(railFor(RAIL_MID_MIN_CHIP));
    await openAt(page, width);
    const g = await geometry(page, THREE);
    expect(g.wrapped, `one line at ${width}: ${JSON.stringify(g)}`).toBe(false);
    expect(g.labelClipped).toBe(false);
    expect(g.title).toBeGreaterThanOrEqual(RAIL_TITLE_MIN);
  });

  test("a chipless pill + ⚑ row at the narrow rail keeps the title floor, and its second line is flush right", async ({ page }) => {
    await openAt(page, 260);
    const g = await geometry(page, BARE);
    // Whether it wraps is the row's business (measured: it does, at 260 — the
    // fixed parts leave under the floor); what it must not do is starve the
    // title or leave the ★+date hanging mid-row.
    expect(g.title).toBeGreaterThanOrEqual(RAIL_TITLE_MIN);
    expect(g.endGap).toBeLessThanOrEqual(1);
    await openAt(page, 300);
    const h = await geometry(page, BARE);
    expect(h.wrapped, `one line at 300: ${JSON.stringify(h)}`).toBe(false);
    expect(h.title).toBeGreaterThanOrEqual(RAIL_TITLE_MIN);
  });
});
