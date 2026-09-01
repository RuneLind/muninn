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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import {
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_KEY,
  RAIL_WIDTH_KEY_STEP,
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
  await expect(page.locator(".wiki-list-item")).toHaveCount(2);
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
    await expect(page.locator(".wiki-list-item")).toHaveCount(2);
    expect(await railWidth(page)).toBe(after);
  });

  test("a width stored on a wide monitor is bounded by a narrow window", async ({ page }) => {
    await open(page);
    await page.evaluate((k) => localStorage.setItem(k, "560"), RAIL_WIDTH_KEY);
    await page.setViewportSize({ width: 700, height: 900 });
    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(2);
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
    await expect(page.locator(".wiki-list-item")).toHaveCount(2);
    expect(await railWidth(page)).toBe(315);
    // Stepping from the STORED 560 moved nothing for sixteen presses while
    // rewriting the stored value (measured in review); the base is what is shown.
    await page.locator(HANDLE).focus();
    await page.keyboard.press("ArrowLeft");
    expect(await railWidth(page)).toBe(315 - RAIL_WIDTH_KEY_STEP);
    expect(Number(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY))).toBe(
      315 - RAIL_WIDTH_KEY_STEP,
    );
    // A drag past the bound persists the bounded width, never the raw pointer.
    const hb = await page.locator(HANDLE).boundingBox();
    if (!hb) throw new Error("handle not laid out");
    await page.mouse.move(hb.x + hb.width / 2, hb.y + 40);
    await page.mouse.down();
    await page.mouse.move(650, hb.y + 40, { steps: 4 });
    await page.mouse.up();
    const shown = await railWidth(page);
    expect(shown).toBe(315);
    expect(Number(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY))).toBe(shown);
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
    await expect(page.locator(".wiki-list-item")).toHaveCount(2);
    expect(await railWidth(page)).toBe(480);

    await page.locator(HANDLE).dblclick();
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT);
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBeNull();
  });
});
