/**
 * `<Chart>` in the /wiki reader (`chartBlockHtml` in `src/web/web-format.ts`,
 * the view in `src/format/chart-view.ts`, CSS in `chartCss`, toggles in
 * `views/components/wiki-visuals.ts`).
 *
 * What only a laid-out page can answer: that each of the four kinds draws a
 * chart with its table hidden behind the «Table» toggle, that the marks paint
 * the theme's own tokens in both themes, that the gate's «Bar after» toggle
 * swaps the verdicts, that a steps series hides from its legend key, that a
 * peek shows the table and no chart, that an Explain selection across a chart
 * still locates in the page source, and that nothing runs past the page at
 * 390 px.
 *
 * No model calls, no DB rows: one muninn over a temp wiki holding one
 * synthetic plan page; the Explain route is stubbed at the network boundary.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { EXPLAIN_FULL_BODY_MAX, locateExcerpt } from "../src/wiki/explain-context.ts";

const PORT = e2ePort("wiki-chart");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-chart";
const REL = "plans/charts.mdx";

const PAGE = [
  "---",
  "title: Chart plan",
  "plan_status: in-flight",
  "---",
  "",
  "# Chart plan",
  "",
  // Filler: the page is past Explain's full-body size and the charts past the
  // head it falls back to, so only a located selection brings a table in.
  ...Array.from({ length: 20 }, (_, i) => `Background paragraph ${i + 1}: a synthetic line of prose that only pads the page so Explain has to locate a selection instead of sending the whole body.\n`),
  "## PR ledger",
  "",
  "| PR | State |",
  "|---|---|",
  "| 21 | merged |",
  "| 22 | dropped |",
  "",
  "## Gap chart",
  "",
  "The line before the gap chart, written long enough that a selection's first eighty characters stay inside it.",
  "",
  '<Chart kind="gap" caption="Scores" value="Now" target="Goal" gap="Gap" mark="Last">',
  "",
  "| Track | Now | Goal | Gap | Last |",
  "|---|---|---|---|---|",
  "| Alpha | 40 | 50 | 10 | 35 |",
  "| Beta | 12 | 20 | 8 | 15 |",
  "",
  "</Chart>",
  "",
  "The line after the gap chart; see «Gate chart» for the stop rule.",
  "",
  "## Gate chart",
  "",
  '<Chart kind="gate" bar="Bar" pass="101–160" hold="Hold">',
  "",
  "| PR | Bar | Bar after | 101–160 | Hold |",
  "|---|---|---|---|---|",
  "| PR 21 | +5 (D17) | +7 | +6.1 | +5.2 |",
  "| 22 — Soft | +5 | +4 | +4.05 | +6 |",
  "",
  "</Chart>",
  "",
  "## Steps chart",
  "",
  '<Chart kind="steps" x="Step" ref="Base" normalize="ref">',
  "",
  "| Step | A | B |",
  "|---|---|---|",
  "| s1 | 10 | 20 |",
  "| s2 |  | 25 |",
  "| Base | 10 | 20 |",
  "",
  "</Chart>",
  "",
  "## Funnel chart",
  "",
  '<Chart kind="funnel">',
  "",
  "| Stage | Count | Of |",
  "|---|---|---|",
  "| All | 8 501 | |",
  "| Picked | 46 | 8 501 |",
  "| Kept | 3 | 46 |",
  "",
  "</Chart>",
  "",
  "## Broken chart",
  "",
  '<Chart kind="gap" value="Missing" target="Goal" gap="Gap">',
  "",
  "| Track | Goal | Gap |",
  "|---|---|---|",
  "| Alpha | 50 | 10 |",
  "",
  "</Chart>",
  "",
].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-chart-"));
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

const KINDS = ["gap", "gate", "steps", "funnel"] as const;
const chart = (page: Page, kind: string) => page.locator(`.wiki-article section.vc-chart.vc-${kind}.vc-has-plot`);

/** The page at `width`; `focus` drops the rail and the Ask pane (the F key). */
async function open(page: Page, width: number, focus = false): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(page.locator(".wiki-article section.vc-chart.vc-has-plot")).toHaveCount(4);
  if (focus) {
    await page.locator("body").press("f");
    await expect(page.locator("#wikiFocusExit")).toBeVisible();
  }
}

/** The token as the browser resolves it on a probe in `body`. */
const token = (page: Page, name: string) =>
  page.evaluate((n) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${n})`;
    document.body.appendChild(probe);
    const v = getComputedStyle(probe).color;
    probe.remove();
    return v;
  }, name);

const visiblePlot = (c: ReturnType<typeof chart>) => c.locator(":scope > .vc-plot:not([hidden])");

test.describe("Wiki reader: Chart", () => {
  for (const scheme of ["dark", "light"] as const) {
    test(`1280 px, ${scheme}: each kind draws a chart over a hidden table, in the theme's tokens`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 1280);
      for (const kind of KINDS) {
        const c = chart(page, kind);
        await expect(visiblePlot(c), kind).toHaveCount(1);
        await expect(visiblePlot(c), kind).toBeVisible();
        await expect(c.locator(":scope > .vc-table"), kind).toBeHidden();
        await expect(c.locator('button[data-vc-mode="chart"]'), kind).toHaveAttribute("aria-pressed", "true");
      }
      const fillOf = (sel: string) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).fill);
      const strokeOf = (sel: string) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).stroke);
      expect(await fillOf(".vc-gap .vc-plot:not([hidden]) .vc-value")).toBe(await token(page, "--status-info"));
      expect(await fillOf(".vc-gap .vc-plot:not([hidden]) .vc-track")).toBe(await token(page, "--bg-inset"));
      expect(await strokeOf(".vc-gap .vc-plot:not([hidden]) .vc-mark")).toBe(await token(page, "--status-magenta"));
      expect(await fillOf(".vc-gate .vc-plot:not([hidden]) .vc-hold")).toBe(await token(page, "--status-cyan"));
      const ink = (sel: string) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).color);
      expect(await ink(".vc-gate .vc-plot:not([hidden]) .vc-ok")).toBe(await token(page, "--tone-good"));
      expect(await ink(".vc-gate .vc-plot:not([hidden]) .vc-miss")).toBe(await token(page, "--tone-err"));
    });
  }

  test("a chart whose table fails its kind renders the table with the finding", async ({ page }) => {
    await open(page, 1280);
    const broken = page.locator(".wiki-article section.vc-chart.vc-fallback");
    await expect(broken).toHaveCount(1);
    await expect(broken.locator(".vc-finding")).toContainText("Missing");
    await expect(broken.locator(".vc-table table")).toBeVisible();
    await expect(broken.locator(".vc-plot")).toHaveCount(0);
  });

  test("the Table toggle swaps the chart for its table and back", async ({ page }) => {
    await open(page, 1280);
    const c = chart(page, "funnel");
    await c.locator('button[data-vc-mode="table"]').click();
    await expect(c.locator(":scope > .vc-table table")).toBeVisible();
    await expect(c.locator(":scope > .vc-plot")).toBeHidden();
    await expect(c.locator('button[data-vc-mode="table"]')).toHaveAttribute("aria-pressed", "true");
    await expect(c.locator('button[data-vc-mode="chart"]')).toHaveAttribute("aria-pressed", "false");
    await expect(c.locator(":scope > .vc-table tbody tr")).toHaveCount(3);
    await c.locator('button[data-vc-mode="chart"]').click();
    await expect(visiblePlot(c)).toBeVisible();
    await expect(c.locator(":scope > .vc-table")).toBeHidden();
  });

  test("the gate shows the PR's ledger state and the Bar after toggle swaps the verdicts", async ({ page }) => {
    await open(page, 1280);
    const c = chart(page, "gate");
    const plot = visiblePlot(c);
    await expect(plot.locator(".vc-verdict")).toHaveText(["numbers pass", "numbers miss: +4.05 < +5"]);
    await expect(plot.locator(".vc-state")).toHaveText(["merged", "dropped"]);
    await c.locator('button[data-vc-variant="after"]').click();
    await expect(c.locator('button[data-vc-variant="after"]')).toHaveAttribute("aria-pressed", "true");
    await expect(c.locator('button[data-vc-variant="decided"]')).toHaveAttribute("aria-pressed", "false");
    await expect(visiblePlot(c)).toHaveAttribute("data-vc-variant", "after");
    await expect(visiblePlot(c).locator(".vc-verdict")).toHaveText(["numbers miss: +6.1 < +7", "numbers pass"]);
  });

  test("the gap toggle switches points and % of target", async ({ page }) => {
    await open(page, 1280);
    const c = chart(page, "gap");
    await expect(visiblePlot(c)).toHaveAttribute("data-vc-variant", "pts");
    await c.locator('button[data-vc-variant="pct"]').click();
    await expect(visiblePlot(c)).toHaveAttribute("data-vc-variant", "pct");
    await expect(visiblePlot(c).locator(".vc-num").first()).toContainText("%");
  });

  test("a steps legend key hides its series", async ({ page }) => {
    await open(page, 1280);
    const c = chart(page, "steps");
    const key = c.locator('button.vc-key[data-vc-series="0"]');
    const series = c.locator('g.vc-series[data-vc-series="0"]');
    const display = () => series.evaluate((e) => getComputedStyle(e).display);
    expect(await display()).not.toBe("none");
    await key.click();
    await expect(key).toHaveAttribute("aria-pressed", "false");
    await expect.poll(display).toBe("none");
    await key.click();
    await expect(key).toHaveAttribute("aria-pressed", "true");
    await expect.poll(display).not.toBe("none");
  });

  test("a peek shows the chart's table and no chart", async ({ page }) => {
    await open(page, 1280);
    await page.locator(".wiki-article a.wiki-ref", { hasText: "Gate chart" }).first().hover();
    const peek = page.locator(".wiki-ref-peek");
    await expect(peek).toBeVisible();
    await expect(peek.locator("table")).toBeVisible();
    await expect(peek.locator("table")).toContainText("+4.05");
    await expect(peek.locator(".vc-plot, .vc-ctl, .vc-legend, svg")).toHaveCount(0);
  });

  test("an Explain selection across a chart locates in the page source", async ({ page }) => {
    await open(page, 1280);
    const sent: string[] = [];
    await page.route("**/api/wiki/explain?**", (route) => {
      sent.push(new URL(route.request().url()).searchParams.get("sel") ?? "");
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: done\ndata: ${JSON.stringify({ answer: "Ok." })}\n\n` });
    });
    await page.evaluate(() => {
      const find = (needle: string): [Node, number] => {
        const walk = document.createTreeWalker(document.querySelector(".wiki-article")!, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const k = (n as Text).data.indexOf(needle);
          if (k !== -1) return [n, k];
        }
        throw new Error(`no ${needle}`);
      };
      const [s, so] = find("The line before the gap chart");
      const [e, eo] = find("The line after the gap chart");
      const r = document.createRange();
      r.setStart(s, so);
      r.setEnd(e, eo + "The line after".length);
      const w = window.getSelection()!;
      w.removeAllRanges();
      w.addRange(r);
      document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await expect(page.locator("#wikiExplainBtn")).toBeVisible();
    await page.locator("#wikiExplainBtn").dispatchEvent("mousedown");
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    const sel = sent[0]!;
    // The chart's hidden table is the authored text: it rides the selection.
    expect(sel).toContain("Alpha");
    expect(sel).toContain("Beta");
    // No chart label, toggle or verdict text rides along.
    for (const chrome of ["Chart", "Table", "% of target", "Points"]) expect(sel, chrome).not.toContain(chrome);
    expect(PAGE.length).toBeGreaterThan(EXPLAIN_FULL_BODY_MAX);
    const excerpt = locateExcerpt(PAGE, sel);
    expect(excerpt, JSON.stringify(sel)).toContain("The line before the gap chart,");
    expect(excerpt).toContain("| Alpha | 40 | 50 | 10 | 35 |");
  });

  for (const scheme of ["dark", "light"] as const) {
    test(`390 px focus, ${scheme}: every chart stays inside the article and nothing overflows`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 390, true);
      const article = (await page.locator(".wiki-article").boundingBox())!;
      for (const kind of KINDS) {
        const c = chart(page, kind);
        await c.scrollIntoViewIfNeeded();
        const cb = (await c.boundingBox())!;
        expect(cb.x, kind).toBeGreaterThanOrEqual(article.x - 0.5);
        expect(cb.x + cb.width, kind).toBeLessThanOrEqual(article.x + article.width + 0.5);
        expect(await c.evaluate((e) => e.scrollWidth - e.clientWidth), kind).toBeLessThanOrEqual(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      expect(await chart(page, "gap").locator(".vc-plot:not([hidden]) .vc-value").first().evaluate((e) => getComputedStyle(e).fill)).toBe(
        await token(page, "--status-info"),
      );
    });
  }
});
