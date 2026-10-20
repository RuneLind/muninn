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
 * that no two legend swatches look alike and each draws exactly as its
 * squares do, that an open popover covers no other row (later rows move down
 * instead), and that one row with many questions moves no other row's
 * decision.
 *
 * No model calls, no DB rows: one muninn over a temp wiki holding two
 * synthetic plan pages.
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
  "| 9 — later | tbd | D5 |",
  "",
].join("\n");

// 30 chains, the oldest closing eight questions: one long row among short ones.
const MANY_REL = "plans/many.mdx";
const MANY = [
  "---",
  "title: Many chains",
  "plan_status: in-flight",
  "---",
  "",
  "# Many chains",
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
  ...Array.from({ length: 8 }, (_, i) => `- **O${i + 1}** — Which option ${i + 1} holds? Closed 2026-10-01 (D1).`),
  ...Array.from({ length: 30 }, (_, i) => `- **D${i + 1}** — Decision ${i + 1} reads the rows in PR ${i + 1}, so the reader never joins.`),
  "",
  "</DecisionLog>",
  "",
].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-decision-views-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REL), PAGE, "utf8");
  await writeFile(path.join(root, MANY_REL), MANY, "utf8");
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
async function open(page: Page, width: number, focus = false, rel = REL): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(page.locator(".wiki-article .dc-chain .dc-row")).toHaveCount(rel === REL ? 5 : 30);
  if (rel === REL) await expect(page.locator(".wiki-article .dc-strip")).toBeVisible();
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

/** With a popover open, every summary in the view (the open one too) is the
 *  topmost element at its centre: visible and clickable. */
async function nothingCovered(page: Page): Promise<void> {
  const covered = await page.evaluate(() => {
    const bad: string[] = [];
    for (const s of Array.from(document.querySelectorAll<HTMLElement>(".wiki-article .dc-chain summary"))) {
      s.scrollIntoView({ block: "center" });
      const b = s.getBoundingClientRect();
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      if (!hit || !s.contains(hit)) bad.push(`${s.textContent} under ${hit?.className}`);
    }
    return bad;
  });
  expect(covered).toEqual([]);
}

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

  test("wide: an open node keeps its chip size and place, its popover reads at ≥ 240 px under its row", async ({ page }) => {
    await open(page, 1280);
    const summary = page.locator(".wiki-article .dc-chain .dc-node.dc-d > summary").first();
    const before = (await summary.boundingBox())!;
    const tops = await rowTops(page);
    await summary.click();
    const after = (await summary.boundingBox())!;
    expect(Math.abs(after.width - before.width)).toBeLessThan(1);
    expect(Math.abs(after.height - before.height)).toBeLessThan(1);
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
    // The open row stays put; the rows after it move down, never under the popover.
    const now = await rowTops(page);
    expect(now[0]).toBe(tops[0]);
    const popBox = (await page.locator(".wiki-article .dc-node[open] .dc-pop").boundingBox())!;
    expect(now[1]!).toBeGreaterThanOrEqual(popBox.y + popBox.height);
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
      // Open each node in turn: no popover and no chip runs past the page,
      // and the popover stays inside its own bordered block.
      const nodes = page.locator(".wiki-article .dc-node");
      for (let i = 0; i < (await nodes.count()); i++) {
        await nodes.nth(i).evaluate((e) => ((e as HTMLDetailsElement).open = true));
        const view = (await box(page, ".wiki-article .dc-chain"))[0]!;
        const p = (await nodes.nth(i).locator(".dc-pop").boundingBox())!;
        const rb = await nodes.nth(i).evaluate((e) => e.closest(".dc-row")!.getBoundingClientRect().toJSON() as { y: number; height: number });
        expect(p.x).toBeGreaterThanOrEqual(view.x);
        expect(p.x + p.width).toBeLessThanOrEqual(view.x + view.width + 0.5);
        expect(p.y + p.height).toBeLessThanOrEqual(rb.y + rb.height + 0.5);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      }
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
    test(`strip legend, ${scheme}: one entry per look, each swatch drawn as its squares, no two alike`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 1280);
      const keys = await page.locator(".wiki-article .dc-strip .dc-key").allTextContents();
      expect(keys).toEqual(["merged", "closed / dropped", "open / measurement", "planned / optional", "blocked", "unknown"]);
      // Each swatch against the first square of its state: same fill, border style and colour.
      const pairs = await page.locator(".wiki-article .dc-strip .dc-sw").evaluateAll((els) =>
        els.map((e) => {
          const state = Array.from(e.classList).find((c) => c.startsWith("dc-s-"))!;
          const sq = document.querySelector(`.wiki-article .dc-strip .dc-pr.${state}`)!;
          const look = (el: Element) => {
            const s = getComputedStyle(el);
            return `${s.backgroundColor}|${s.borderTopStyle}|${s.borderTopColor}`;
          };
          return { state, swatch: look(e), square: look(sq) };
        }),
      );
      expect(pairs).toHaveLength(6);
      for (const p of pairs) expect(p.swatch, p.state).toBe(p.square);
      const looks = await page.locator(".wiki-article .dc-strip .dc-sw").evaluateAll((els) =>
        els.map((e) => {
          const s = getComputedStyle(e);
          return `${s.backgroundColor}|${s.borderTopColor}|${s.borderTopStyle}`;
        }),
      );
      expect(new Set(looks).size).toBe(looks.length);
    });
  }

  for (const [width, focus] of [[1280, false], [390, true]] as const) {
    test(`${width} px: an open popover covers no chip, by pointer or by Tab`, async ({ page }) => {
      await open(page, width, focus, MANY_REL);
      // A row in the middle: rows above and below it.
      const first = page.locator(".wiki-article .dc-chain .dc-node.dc-d > summary").nth(1);
      await first.click();
      await expect(page.locator(".wiki-article .dc-node[open] .dc-pop")).toBeVisible();
      // The popover lies in its own row's band: under its chip, above the row's end.
      const band = await page.locator(".wiki-article .dc-node[open]").evaluate((e) => {
        const pop = e.querySelector(".dc-pop")!.getBoundingClientRect();
        const chip = e.querySelector("summary")!.getBoundingClientRect();
        const row = e.closest(".dc-row")!.getBoundingClientRect();
        return { underChip: pop.top >= chip.bottom - 0.5, insideRow: pop.bottom <= row.bottom + 0.5 };
      });
      expect(band).toEqual({ underChip: true, insideRow: true });
      await nothingCovered(page);
      // Tab past the popover's link: the next focus is the next row's chip, in plain sight.
      await first.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      const seen = await page.evaluate(() => {
        const f = document.activeElement!;
        const b = f.getBoundingClientRect();
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return { tag: f.tagName, inNextRow: f.closest(".dc-row") === document.querySelectorAll(".wiki-article .dc-chain .dc-row")[2], visible: !!hit && f.contains(hit) };
      });
      expect(seen).toEqual({ tag: "SUMMARY", inNextRow: true, visible: true });
    });
  }

  test("one row with eight questions moves no other row's decision", async ({ page }) => {
    await open(page, 1280, false, MANY_REL);
    const rows = (await box(page, ".wiki-article .dc-chain .dc-rows"))[0]!;
    const decX = new Set((await box(page, ".wiki-article .dc-chain .dc-node.dc-d > summary")).map((b) => Math.round(b.x)));
    expect([...decX]).toHaveLength(1);
    // The questions column holds at most ~ a third of the rows box.
    expect([...decX][0]! - rows.x).toBeLessThanOrEqual(rows.width * 0.45);
    // The eight questions wrap inside column 1: none crosses the row's arrow.
    const longRow = page.locator(".wiki-article .dc-chain .dc-row", { has: page.locator(".dc-qs") });
    await expect(longRow).toHaveCount(1);
    const arrow = (await longRow.locator(".dc-a-q").boundingBox())!;
    const qs = await box(page, ".wiki-article .dc-chain .dc-qs summary");
    expect(qs).toHaveLength(8);
    for (const q of qs) expect(q.x + q.width).toBeLessThanOrEqual(arrow.x + 0.5);
    expect(new Set(qs.map((q) => Math.round(q.y))).size).toBeGreaterThan(1);
  });
});
