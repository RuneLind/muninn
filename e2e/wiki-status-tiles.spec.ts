/**
 * `<StatusRows view="tiles">` in the /wiki reader (`statusRowsHtml` in
 * `src/web/web-format.ts`, CSS in `statusTilesCss`).
 *
 * What only a laid-out page can answer: that the rows draw as tiles (the big
 * value over its note), that a tile's tone paints the theme's own token in
 * both themes, that the separator after the big value is hidden from sight
 * but kept in the row's text, that a block without `view="tiles"` keeps its
 * rows, and that nothing runs past the page at 390 px.
 *
 * No model calls, no DB rows: one muninn over a temp wiki holding one
 * synthetic plan page.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-status-tiles");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-status-tiles";
const REL = "plans/tiles.mdx";

const PAGE = [
  "---",
  "title: Tiles plan",
  "plan_status: in-flight",
  "---",
  "",
  "# Tiles plan",
  "",
  '<StatusRows view="tiles" tones="Gap=warn;Next=good;Probe=info;Old=muted">',
  "",
  "- **Score:** 1 234 · up from 1 100 last week",
  "- **Gap:** 3 points · to the leader, closing",
  "- **Next:** ship the reader · then the writer, which waits on a review that has not been booked yet",
  "- **Probe:** 95 ms · p95 over the last day",
  "- **Old:** retired",
  "",
  "</StatusRows>",
  "",
  "## Rows",
  "",
  "<StatusRows>",
  "",
  "- **Plain:** 7 · a row, not a tile",
  "",
  "</StatusRows>",
  "",
].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-status-tiles-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REL), PAGE, "utf8");
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
      if ((await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`)).ok) break;
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

const TILES = ".wiki-article .status-rows.sr-tiles";

/** The page at `width`; `focus` drops the rail and the Ask pane (the F key). */
async function open(page: Page, width: number, focus = false): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(page.locator(`${TILES} .sr-row`)).toHaveCount(5);
  if (focus) {
    await page.locator("body").press("f");
    await expect(page.locator("#wikiFocusExit")).toBeVisible();
  }
}

/** The token as the browser resolves it on a probe in `body`. */
const token = (page: Page, prop: "color" | "backgroundColor", name: string) =>
  page.evaluate(([p, n]) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${n})`;
    probe.style.backgroundColor = `var(${n})`;
    document.body.appendChild(probe);
    const v = getComputedStyle(probe)[p as "color"];
    probe.remove();
    return v;
  }, [prop, name] as const);

const rowStyle = (page: Page, label: string) =>
  page.locator(`${TILES} .sr-row`, { has: page.locator(".sr-label", { hasText: label }) }).evaluate((row) => {
    const big = row.querySelector(".sr-big")!;
    return {
      bg: getComputedStyle(row).backgroundColor,
      ink: getComputedStyle(big).color,
      bigPx: parseFloat(getComputedStyle(big).fontSize),
      labelPx: parseFloat(getComputedStyle(row.querySelector(".sr-label")!).fontSize),
    };
  });

test.describe("Wiki reader: StatusRows tiles", () => {
  for (const scheme of ["dark", "light"] as const) {
    test(`1280 px, ${scheme}: one tile per row, the big value over its note, tones from the theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 1280);
      const tiles = page.locator(`${TILES} .sr-row`);
      // More than one column, each tile a box of its own.
      const xs = new Set((await tiles.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)))));
      expect(xs.size).toBeGreaterThan(1);
      for (let i = 0; i < 5; i++) {
        const t = tiles.nth(i);
        expect(await t.evaluate((e) => getComputedStyle(e).display)).toBe("flex");
        const tb = (await t.boundingBox())!;
        const bb = (await t.locator(".sr-big").boundingBox())!;
        const lb = (await t.locator(".sr-label").boundingBox())!;
        // Label above the big value, both inside the tile.
        expect(lb.y + lb.height).toBeLessThanOrEqual(bb.y + 0.5);
        expect(bb.x + bb.width).toBeLessThanOrEqual(tb.x + tb.width + 0.5);
        expect(bb.y + bb.height).toBeLessThanOrEqual(tb.y + tb.height + 0.5);
      }
      const surface = await token(page, "backgroundColor", "--bg-surface");
      const primary = await token(page, "color", "--text-primary");
      const plain = await rowStyle(page, "Score");
      expect(plain).toMatchObject({ bg: surface, ink: primary });
      expect(plain.bigPx).toBeGreaterThan(plain.labelPx * 1.5);
      for (const [label, tint, ink] of [
        ["Gap", "--tint-warning", "--tone-warn"],
        ["Next", "--tint-success", "--tone-good"],
        ["Probe", "--tint-info", "--tone-info"],
        ["Old", "--tint-neutral", "--text-soft"],
      ] as const) {
        const s = await rowStyle(page, label);
        expect({ label, bg: s.bg, ink: s.ink }).toEqual({
          label,
          bg: await token(page, "backgroundColor", tint),
          ink: await token(page, "color", ink),
        });
      }
    });
  }

  test("the separator after the big value is out of sight and still in the row's text", async ({ page }) => {
    await open(page, 1280);
    const row = page.locator(`${TILES} .sr-row`).first();
    const sep = row.locator(".sr-big + .sr-sep");
    const sb = (await sep.boundingBox())!;
    expect(sb.width).toBeLessThanOrEqual(1);
    expect(sb.height).toBeLessThanOrEqual(1);
    expect(await row.textContent()).toBe("Score1 234 · up from 1 100 last week");
  });

  test("a block without view=tiles keeps its rows", async ({ page }) => {
    await open(page, 1280);
    const rows = page.locator(".wiki-article .status-rows:not(.sr-tiles)");
    await expect(rows).toHaveCount(1);
    await expect(rows.locator(".sr-big")).toHaveCount(0);
    expect(await rows.locator(".sr-row").evaluate((e) => getComputedStyle(e).display)).toBe("contents");
  });

  for (const scheme of ["dark", "light"] as const) {
    test(`390 px focus, ${scheme}: tiles stay inside the article and nothing overflows`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 390, true);
      const section = (await page.locator(TILES).boundingBox())!;
      const tiles = page.locator(`${TILES} .sr-row`);
      for (let i = 0; i < 5; i++) {
        const tb = (await tiles.nth(i).boundingBox())!;
        expect(tb.x).toBeGreaterThanOrEqual(section.x - 0.5);
        expect(tb.x + tb.width).toBeLessThanOrEqual(section.x + section.width + 0.5);
        for (const part of [".sr-label", ".sr-big", ".sr-value"]) {
          const pb = (await tiles.nth(i).locator(part).boundingBox())!;
          expect(pb.x + pb.width, `${i} ${part}`).toBeLessThanOrEqual(tb.x + tb.width + 0.5);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const warn = await rowStyle(page, "Gap");
      expect(warn.ink).toBe(await token(page, "color", "--tone-warn"));
    });
  }
});
