/**
 * The decision chain view and the PR strip in the /wiki reader
 * (`src/format/decision-views.ts`, CSS in `decisionViewsCss`).
 *
 * What only a laid-out page can answer: that every decision starts at one x
 * whether or not its row has questions, that opening a node keeps its chip's
 * size and opens a popover wide enough to read without moving the rows, that
 * nothing runs past the page at 390 px, that the narrow form follows the
 * view's own width (the rail and chat panes narrow the article, not the
 * viewport) and draws each chain as one bordered block with its arrows, and
 * that no two legend swatches look alike.
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

const PORT = e2ePort("wiki-decision-views");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-decision-views";
const REL = "plans/chain.mdx";

// Rows with two questions, one, and none; outputs in every state the strip
// draws, so look-alike states (closed/dropped, planned/optional,
// open/measurement) all appear.
const PAGE = [
  "---",
  "title: Chain plan",
  "plan_status: in-flight",
  "---",
  "",
  "# Chain plan",
  "",
  "<NextMoves>",
  "",
  '<Lane kind="you">',
  "",
  "1. Run it.",
  "",
  "</Lane>",
  "",
  "</NextMoves>",
  "",
  "## Decisions",
  "",
  "<DecisionLog>",
  "",
  "- **O1** — Which store holds the rows? Closed 2026-10-01 (D1).",
  "- **O2** — Which shape do rows take? Closed 2026-10-02 (D2).",
  "- **O3** — Which key groups them? Closed 2026-10-03 (D2).",
  "- **O4** — Who reads the groups? Closed 2026-10-04 (D4).",
  "- **D1** — Use the flat file, because one writer owns it and a database adds a service for no reader.",
  "- **D2** — One row per group, keyed by the group id, so a reader never joins.",
  "- **D3** — Ship the reader before the writer.",
  "- **D4** — The reader reads the groups; the writer never does.",
  "- **D5** — Measure the reader before tuning it.",
  "",
  "</DecisionLog>",
  "",
  "**PR ledger.**",
  "",
  "| PR | State | Decisions |",
  "|---|---|---|",
  "| 1 — store | merged | D1 |",
  "| 2 — rows | closed | D2 |",
  "| 3 — groups | dropped | D2 |",
  "| 4 — reader | open | D3 |",
  "| 5 — writer | planned | D3 |",
  "| 6 — docs | optional | D4 |",
  "| 7 — probe | measurement | D5 |",
  "| 8 — tune | blocked | D5 |",
  "",
].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-decision-views-"));
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

/** The page at `width`. `focus` drops the rail and the Ask pane (the reader's
 *  F key), the only way the article gets a phone's width: the reader keeps its
 *  panes side by side at any viewport. */
async function open(page: Page, width: number, focus = false): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(page.locator(".wiki-article .dc-chain .dc-row")).toHaveCount(5);
  await expect(page.locator(".wiki-article .dc-strip")).toBeVisible();
  if (focus) {
    await page.locator("body").press("f");
    await expect(page.locator("#wikiFocusExit")).toBeVisible();
  }
}

type Box = { x: number; y: number; width: number; height: number };
const box = async (page: Page, sel: string): Promise<Box[]> =>
  page.locator(sel).evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));

/** Each row's top, for "the rows below did not move". */
const rowTops = (page: Page) => box(page, ".wiki-article .dc-chain .dc-row").then((bs) => bs.map((b) => Math.round(b.y)));

/** The token as the browser resolves it on a probe in `body`. */
const token = (page: Page, prop: "color" | "borderTopColor", name: string) =>
  page.evaluate(([p, n]) => {
    const probe = document.createElement("span");
    probe.style.border = `1px solid var(${n})`;
    probe.style.color = `var(${n})`;
    document.body.appendChild(probe);
    const v = getComputedStyle(probe)[p as "color"];
    probe.remove();
    return v;
  }, [prop, name] as const);

test.describe("Wiki reader: decision chain view and PR strip", () => {
  test("wide: decisions share one x, outputs share one x, whatever the row holds", async ({ page }) => {
    await open(page, 1280);
    const view = (await box(page, ".wiki-article .dc-chain"))[0]!;
    // With the rail and the Ask pane open the view is ~530 px: still the wide
    // form, which needs the view over the 30rem breakpoint.
    expect(view.width).toBeGreaterThan(480);
    const decX = new Set((await box(page, ".wiki-article .dc-chain .dc-node.dc-d > summary")).map((b) => Math.round(b.x)));
    expect([...decX]).toHaveLength(1);
    const outX = new Set((await box(page, ".wiki-article .dc-chain .dc-outs")).map((b) => Math.round(b.x)));
    expect([...outX]).toHaveLength(1);
  });

  test("wide: an open node keeps its chip size, its popover reads at ≥ 240 px and the rows stay put", async ({ page }) => {
    await open(page, 1280);
    const summary = page.locator(".wiki-article .dc-chain .dc-node.dc-d > summary").first();
    const before = (await summary.boundingBox())!;
    const tops = await rowTops(page);
    await summary.click();
    const after = (await summary.boundingBox())!;
    expect(Math.abs(after.width - before.width)).toBeLessThan(1);
    expect(Math.abs(after.height - before.height)).toBeLessThan(1);
    expect(await rowTops(page)).toEqual(tops);
    const pop = (await page.locator(".wiki-article .dc-node[open] .dc-pop").boundingBox())!;
    expect(pop.width).toBeGreaterThanOrEqual(240);
    const view = (await box(page, ".wiki-article .dc-chain"))[0]!;
    expect(pop.x).toBeGreaterThanOrEqual(view.x);
    expect(pop.x + pop.width).toBeLessThanOrEqual(view.x + view.width + 0.5);
    // Below the chip it opened from.
    expect(pop.y).toBeGreaterThanOrEqual(after.y + after.height - 0.5);
  });

  for (const scheme of ["dark", "light"] as const) {
    test(`390 px, ${scheme}: each chain is one bordered block with its arrows, and nothing overflows`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 390, true);
      const border = await token(page, "borderTopColor", "--border-secondary");
      const rows = page.locator(".wiki-article .dc-chain .dc-row");
      const n = await rows.count();
      let prevBottom = -Infinity;
      for (let i = 0; i < n; i++) {
        const row = rows.nth(i);
        const rb = (await row.boundingBox())!;
        const style = await row.evaluate((e) => {
          const s = getComputedStyle(e);
          return { w: parseFloat(s.borderTopWidth), c: s.borderTopColor, style: s.borderTopStyle };
        });
        expect(style).toEqual({ w: 1, c: border, style: "solid" });
        // Separated from the row above by more than the in-row gap.
        expect(rb.y - prevBottom).toBeGreaterThanOrEqual(6);
        prevBottom = rb.y + rb.height;
        // Every chip and arrow of the chain sits inside its block.
        const parts = await row.locator("summary, .dc-out, .dc-arrow, .dc-snudd").evaluateAll((els) =>
          els.map((e) => ({ ...e.getBoundingClientRect().toJSON(), what: `${e.className || e.tagName}:${e.textContent}` })),
        );
        for (const b of parts) {
          expect(b.x, b.what).toBeGreaterThanOrEqual(rb.x);
          expect(b.y, b.what).toBeGreaterThanOrEqual(rb.y);
          expect(b.x + b.width, b.what).toBeLessThanOrEqual(rb.x + rb.width + 0.5);
          expect(b.y + b.height, b.what).toBeLessThanOrEqual(rb.y + rb.height + 0.5);
        }
      }
      // The arrows are drawn, not hidden.
      const arrows = await box(page, ".wiki-article .dc-chain .dc-arrow");
      expect(arrows.length).toBeGreaterThan(0);
      for (const a of arrows) expect(a.width).toBeGreaterThan(0);
      // Open every node: no popover and no chip runs past the page.
      await page.locator(".wiki-article .dc-node").evaluateAll((els) => els.forEach((e) => ((e as HTMLDetailsElement).open = true)));
      const view = (await box(page, ".wiki-article .dc-chain"))[0]!;
      for (const p of await box(page, ".wiki-article .dc-pop")) {
        expect(p.x).toBeGreaterThanOrEqual(view.x);
        expect(p.x + p.width).toBeLessThanOrEqual(view.x + view.width + 0.5);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    });
  }

  test("the narrow form follows the view's width, not the viewport's", async ({ page }) => {
    await open(page, 1280);
    const row = page.locator(".wiki-article .dc-chain .dc-row").first();
    expect(await row.evaluate((e) => getComputedStyle(e).display)).toBe("grid");
    // A pane narrowing the article: same 1280 px viewport, a 400 px view.
    await page.addStyleTag({ content: ".wiki-article .dc-chain { width: 400px; }" });
    expect(await row.evaluate((e) => getComputedStyle(e).display)).toBe("flex");
    expect(await row.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe("solid");
  });

  for (const scheme of ["dark", "light"] as const) {
    test(`strip legend, ${scheme}: one entry per look, no two swatches alike`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 1280);
      const keys = await page.locator(".wiki-article .dc-strip .dc-key").allTextContents();
      expect(keys).toEqual(["merged", "closed / dropped", "open / measurement", "planned / optional", "blocked"]);
      const looks = await page.locator(".wiki-article .dc-strip .dc-sw").evaluateAll((els) =>
        els.map((e) => {
          const s = getComputedStyle(e);
          return `${s.backgroundColor}|${s.borderTopColor}|${s.borderTopStyle}`;
        }),
      );
      expect(new Set(looks).size).toBe(looks.length);
    });
  }
});
