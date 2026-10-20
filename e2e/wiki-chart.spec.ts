/**
 * `<Chart>` on the /wiki reader (`chartBlockHtml` in `src/web/web-format.ts`,
 * the view in `src/format/chart-view.ts`, CSS in `chartViewCss`, toggles in
 * `views/components/wiki-visuals.ts`), and in a chat bubble.
 *
 * What only a laid-out page can answer: each kind draws over a visually
 * hidden table in the theme's tokens, in both themes; the band and the track
 * reach 3:1 against the section; the Table, variant and gate toggles work by
 * mouse and keyboard; print and forced colours; a peek shows the table only;
 * an Explain selection across a chart locates in the source; nothing runs
 * past the page or its section at 390 px; and chat gets the table, no SVG.
 *
 * No model calls, no DB rows: one muninn over a temp wiki holding one
 * synthetic plan page; the Explain route is stubbed at the network boundary.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
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

const GAP_CHART = [
  '<Chart kind="gap" caption="Scores" value="Now" target="Goal" gap="Gap" mark="Last">',
  "",
  "| Track | Now | Goal | Gap | Last |",
  "|---|---|---|---|---|",
  "| Alpha track with a long name that has to wrap at phone width | 40 | 50 | 10 | 35 |",
  "| Beta | 12 | 20 | 8 | 15 |",
  "| Gamma | -3 | 10 | 13 | |",
  "",
  "</Chart>",
];

const PAGE = [
  "---",
  "title: Chart plan",
  "plan_status: in-flight",
  "---",
  "",
  "# Chart plan",
  "",
  // Filler: the page is past Explain's full-body size, so only a located
  // selection brings a chart's table into the excerpt.
  ...Array.from({ length: 20 }, (_, i) => `Background paragraph ${i + 1}: a synthetic line of prose that only pads the page so Explain has to locate a selection.\n`),
  "## PR ledger",
  "",
  "| PR | Title | State |",
  "|---|---|---|",
  "| 31 | rows | merged |",
  "| 32 | cells | dropped |",
  "",
  "## Gap chart",
  "",
  "The line before the gap chart, written long enough that a selection's first words stay inside it.",
  "",
  ...GAP_CHART,
  "",
  "The line after the gap chart; see «Gate chart» for the stop rule.",
  "",
  "## Gate chart",
  "",
  '<Chart kind="gate" caption="Gates" bar="Bar" pass="Pass" hold="Hold">',
  "",
  "| Slice | Bar | Bar after | Pass | Hold |",
  "|---|---|---|---|---|",
  "| PR 31 — rows | 5 (D3) | 7 | 6.5 | 5.5 |",
  "| PR 32 — cells | 5 (D9) | 4 | 4.5 | — |",
  "",
  "</Chart>",
  "",
  "## Steps chart",
  "",
  '<Chart kind="steps" caption="Steps" x="Step" ref="Base" normalize="ref">',
  "",
  "| Step | A | B |",
  "|---|---|---|",
  "| Base | 10 | 20 |",
  "| s1 | 12 | |",
  "| s2 | 15 | 25 |",
  "",
  "</Chart>",
  "",
  "## Long steps",
  "",
  '<Chart kind="steps" caption="Long steps" x="Step">',
  "",
  "| Step | A |",
  "|---|---|",
  ...Array.from({ length: 25 }, (_, i) => `| step number ${i + 1} with a long name | ${i + 2} |`),
  "",
  "</Chart>",
  "",
  "## Funnel chart",
  "",
  '<Chart kind="funnel" caption="Funnel">',
  "",
  "| Stage | Count | Of |",
  "|---|---|---|",
  "| All | 800 | |",
  "| Picked | 120 | 800 |",
  "| Kept | 30 | 120 |",
  "",
  "</Chart>",
  "",
  "## Broken chart",
  "",
  '<Chart kind="gap" caption="Broken" value="Missing" target="Goal" gap="Gap">',
  "",
  "| Track | Goal | Gap |",
  "|---|---|---|",
  "| Alpha | 50 | 10 |",
  "",
  "</Chart>",
  "",
  "## Signs chart",
  "",
  '<Chart kind="gap" caption="Signs" value="Now" target="Goal" gap="Gap">',
  "",
  "| Track | Now | Goal | Gap |",
  "|---|---|---|---|",
  "| Below [ref](https://example.com/signs) | -9 | -3 | 6 |",
  "| Over | 28 | 18 | -10 |",
  "| Cross | -4 | 6 | 10 |",
  "| Under | 4 | 12 | 8 |",
  "",
  "</Chart>",
  "",
  "## Decisions",
  "",
  "<DecisionLog>",
  "",
  "- **D3** — Rows ship first.",
  "",
  "</DecisionLog>",
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
const chart = (page: Page, kind: string, caption?: string) =>
  page.locator(`.wiki-article section.vc.vc-kind-${kind}${caption ? `[aria-label="${caption}"]` : ""}`).first();
const visiblePlot = (c: Locator) => c.locator(":scope > .vc-plot:not([hidden])");

/** The page at `width`; `focus` drops the rail and the Ask pane (the F key). */
async function open(page: Page, width: number, focus = false): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(page.locator(".wiki-article section.vc[class*='vc-kind-']")).toHaveCount(6);
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

/** WCAG contrast of the first `sel` paint (`fill` or `stroke`) against the section's background. */
const contrast = (c: Locator, sel: string, prop: "fill" | "stroke") =>
  c.evaluate(
    (section, [s, p]) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      const rgb = (v: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = v;
        ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
      };
      const lum = ([r, g, b]: number[]) => {
        const f = (x: number) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
      };
      const paint = getComputedStyle(section.querySelector(s!)!)[p as "fill"];
      const bg = getComputedStyle(section).backgroundColor;
      if (bg === "rgba(0, 0, 0, 0)") throw new Error("section has no background");
      const [a, b] = [lum(rgb(paint)), lum(rgb(bg))].sort((x, y) => y - x);
      return (a! + 0.05) / (b! + 0.05);
    },
    [sel, prop],
  );

/** No element in `c` runs past its section. */
const overflowsSection = (c: Locator) => c.evaluate((e) => e.scrollWidth - e.clientWidth);

test.describe("Wiki reader: Chart", () => {
  for (const scheme of ["dark", "light"] as const) {
    test(`1280 px, ${scheme}: each kind draws over a visually hidden table, in the theme's tokens`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 1280);
      for (const kind of KINDS) {
        const c = chart(page, kind);
        await expect(visiblePlot(c), kind).toHaveCount(1);
        await expect(visiblePlot(c), kind).toBeVisible();
        await expect(c.locator("svg[role=img] > title").first(), kind).toHaveCount(1);
        await expect(c.locator('button[data-vc-mode="chart"]'), kind).toHaveAttribute("aria-pressed", "true");
        // Visually hidden, not removed: a screen reader and a selection still reach it.
        const table = c.locator(":scope > .vc-table");
        expect(await table.evaluate((e) => getComputedStyle(e).display), kind).not.toBe("none");
        expect((await table.boundingBox())!.width, kind).toBeLessThanOrEqual(1);
      }
      const gap = chart(page, "gap");
      const paint = (c: Locator, sel: string, prop: "fill" | "stroke" | "color") =>
        c.locator(sel).first().evaluate((e, p) => getComputedStyle(e)[p as "fill"], prop);
      expect(await paint(gap, ".vc-plot:not([hidden]) .vc-value", "fill")).toBe(await token(page, "--accent"));
      expect(await paint(gap, ".vc-plot:not([hidden]) .vc-band", "fill")).toBe(await token(page, "--tone-warn"));
      expect(await paint(gap, ".vc-plot:not([hidden]) .vc-mark", "stroke")).toBe(await token(page, "--status-magenta"));
      expect(await paint(gap, ".vc-plot:not([hidden]) .vc-track", "stroke")).toBe(await token(page, "--text-muted"));
      await expect(gap.locator(".vc-plot:not([hidden]) .vc-zero")).toHaveCount(3);
      const gate = chart(page, "gate");
      expect(await paint(gate, ".vc-plot:not([hidden]) .vc-ok", "color")).toBe(await token(page, "--tone-good"));
      expect(await paint(gate, ".vc-plot:not([hidden]) .vc-miss", "color")).toBe(await token(page, "--tone-err"));
      // Measured, both themes: the band and the track read against the section.
      expect(await contrast(gap, ".vc-plot:not([hidden]) .vc-band", "fill")).toBeGreaterThanOrEqual(3);
      expect(await contrast(gap, ".vc-plot:not([hidden]) .vc-track", "stroke")).toBeGreaterThanOrEqual(3);
      // An unpressed button's border is visible against the section.
      const unpressed = gap.locator('button[data-vc-mode="table"]');
      expect(await unpressed.evaluate((e) => getComputedStyle(e).borderTopColor)).toBe(await token(page, "--text-muted"));
    });
  }

  test("a chart whose table fails its kind renders the table under its finding", async ({ page }) => {
    await open(page, 1280);
    const broken = page.locator(".wiki-article section.vc.vc-fallback");
    await expect(broken).toHaveCount(1);
    await expect(broken.locator(".vc-notes")).toContainText("Missing");
    await expect(broken.locator("table")).toBeVisible();
    await expect(broken.locator("svg, .vc-plot, button")).toHaveCount(0);
  });

  test("the Table toggle swaps the chart for its table, hides the variants, and works from the keyboard", async ({ page }) => {
    await open(page, 1280);
    const c = chart(page, "gap");
    await c.locator('button[data-vc-mode="table"]').click();
    const table = c.locator(":scope > .vc-table table");
    await expect(table).toBeVisible();
    expect((await table.boundingBox())!.width).toBeGreaterThan(200);
    await expect(c.locator(":scope > .vc-plot")).toHaveCount(2);
    for (const plot of await c.locator(":scope > .vc-plot").all()) await expect(plot).toBeHidden();
    await expect(c.locator(".vc-variants")).toBeHidden();
    await expect(c.locator('button[data-vc-mode="table"]')).toHaveAttribute("aria-pressed", "true");
    await expect(c.locator('button[data-vc-mode="chart"]')).toHaveAttribute("aria-pressed", "false");
    // The cells read as any table's: wrapping and ink match the plain ledger table.
    const ledgerCell = page.locator(".wiki-article table").first().locator("td").first();
    const cell = table.locator("td").first();
    const look = (l: Locator) =>
      l.evaluate((e) => [getComputedStyle(e).whiteSpace, getComputedStyle(e).overflowWrap, getComputedStyle(e).color].join(" | "));
    const head = (l: Locator) => l.evaluate((e) => getComputedStyle(e).overflowWrap);
    expect(await head(table.locator("th").nth(1))).toBe(await head(page.locator(".wiki-article table").first().locator("th").first()));
    expect(await look(cell)).toBe(await look(ledgerCell));
    expect(await cell.evaluate((e) => getComputedStyle(e).whiteSpace)).toBe("normal");
    // Keyboard: focus Chart and press Space.
    await c.locator('button[data-vc-mode="chart"]').focus();
    await page.keyboard.press("Space");
    await expect(visiblePlot(c)).toBeVisible();
    await expect(c.locator('button[data-vc-mode="chart"]')).toHaveAttribute("aria-pressed", "true");
    expect((await c.locator(":scope > .vc-table").boundingBox())!.width).toBeLessThanOrEqual(1);
  });

  test("the gate shows each PR's ledger state and the Bar after toggle swaps the verdicts", async ({ page }) => {
    await open(page, 1280);
    const c = chart(page, "gate");
    await expect(visiblePlot(c).locator(".vc-verdict")).toHaveText(["numbers pass", "numbers miss: 4.5 < 5"]);
    await expect(visiblePlot(c).locator(".vc-pill")).toHaveText(["merged", "dropped"]);
    await expect(visiblePlot(c).locator(".vc-pill.dc-s-merged")).toHaveCount(1);
    await expect(visiblePlot(c).locator(".vc-pill.dc-s-dropped")).toHaveCount(1);
    await expect(visiblePlot(c).locator('a.dc-go[data-dc-ref="D3"]')).toHaveCount(1);
    // D9 is not in the page's log: plain text, not a link that goes nowhere.
    await expect(visiblePlot(c).locator('a.dc-go[data-dc-ref="D9"]')).toHaveCount(0);
    await expect(visiblePlot(c).locator(".vc-num").nth(1)).toContainText("5 (D9)");
    const target = await visiblePlot(c).locator('a.dc-go[data-dc-ref="D3"]').getAttribute("href");
    await expect(page.locator(`.wiki-article li.dl-item${target}`)).toHaveCount(1);
    const after = c.locator('button[data-vc-variant="after"]');
    await after.focus();
    await page.keyboard.press("Enter");
    await expect(after).toHaveAttribute("aria-pressed", "true");
    await expect(c.locator('button[data-vc-variant="decided"]')).toHaveAttribute("aria-pressed", "false");
    await expect(visiblePlot(c)).toHaveAttribute("data-vc-plot", "after");
    await expect(visiblePlot(c).locator(".vc-verdict")).toHaveText(["numbers miss: 6.5 < 7", "numbers miss: hold not measured"]);
  });

  test("the gap toggle switches points and % of target", async ({ page }) => {
    await open(page, 1280);
    const c = chart(page, "gap");
    await expect(visiblePlot(c)).toHaveAttribute("data-vc-plot", "pts");
    await c.locator('button[data-vc-variant="pct"]').click();
    await expect(visiblePlot(c)).toHaveAttribute("data-vc-plot", "pct");
    await expect(visiblePlot(c)).toContainText("% of");
  });

  test("a peek shows the chart's table and none of its chrome", async ({ page }) => {
    await open(page, 1280);
    await page.locator(".wiki-article a.wiki-ref", { hasText: "Gate chart" }).first().hover();
    const peek = page.locator(".wiki-ref-peek");
    await expect(peek).toBeVisible();
    await expect(peek.locator("table")).toBeVisible();
    expect((await peek.locator("table").boundingBox())!.width).toBeGreaterThan(50);
    await expect(peek.locator("table")).toContainText("PR 31");
    await expect(peek.locator(".vc-head, .vc-plot, .vc-legend, .vc-notes, svg")).toHaveCount(0);
    await expect(peek.locator("[class*='vc'], [data-vc-mode], [data-vc-variant], [data-vc-plot]")).toHaveCount(0);
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
    // The hidden table is the authored text, in source order between the two lines.
    const at = (s: string) => sel.indexOf(s);
    expect(at("The line before")).toBe(0);
    expect(at("Beta")).toBeGreaterThan(at("Alpha track"));
    expect(at("Gamma")).toBeGreaterThan(at("Beta"));
    expect(at("The line after")).toBeGreaterThan(at("Gamma"));
    for (const chrome of ["Scores", "Chart", "Table", "% of target", "Points"]) expect(sel, chrome).not.toContain(chrome);
    expect(PAGE.length).toBeGreaterThan(EXPLAIN_FULL_BODY_MAX);
    const excerpt = locateExcerpt(PAGE, sel);
    expect(excerpt, JSON.stringify(sel)).toContain("The line before the gap chart,");
    expect(excerpt).toContain(GAP_CHART[4]!);
  });

  for (const scheme of ["dark", "light"] as const) {
    test(`${scheme}: a link in a chart's hidden table shows its table while it has focus`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 1280);
      const c = chart(page, "gap", "Signs");
      const table = c.locator(":scope > .vc-table");
      expect((await table.boundingBox())!.width).toBeLessThanOrEqual(1);
      await c.locator('button[data-vc-mode="table"]').focus();
      await page.keyboard.press("Tab");
      const link = table.locator('a[href="https://example.com/signs"]');
      await expect(link).toBeFocused();
      // Focus is never on a 1 px clip: the table shows, and the link's middle is the link.
      expect((await table.boundingBox())!.width).toBeGreaterThan(100);
      const hit = await link.evaluate((a) => {
        const r = a.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("a") === a;
      });
      expect(hit).toBe(true);
      expect(await link.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe("none");
      // The chart stays in chart mode, and leaving the table hides it again.
      await expect(c.locator('button[data-vc-mode="chart"]')).toHaveAttribute("aria-pressed", "true");
      await expect(visiblePlot(c)).toBeVisible();
      await c.screenshot({ path: test.info().outputPath(`focus-${scheme}.png`) });
      await page.keyboard.press("Shift+Tab");
      expect((await table.boundingBox())!.width).toBeLessThanOrEqual(1);
    });

    test(`${scheme}: the gap band shows on every row, whichever side of the target and of zero the value is`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 1280);
      const c = chart(page, "gap", "Signs");
      const svgs = c.locator(".vc-plot:not([hidden]) svg");
      await expect(svgs).toHaveCount(4);
      for (const svg of await svgs.all()) {
        await svg.scrollIntoViewIfNeeded();
        const name = await svg.locator("title").textContent();
        // The band's middle is the band itself, not a bar painted over it.
        const top = await svg.locator(".vc-band").evaluate((band) => {
          const r = band.getBoundingClientRect();
          return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.getAttribute("class");
        });
        expect(top, name ?? "").toBe("vc-band");
      }
      await c.screenshot({ path: test.info().outputPath(`signs-${scheme}.png`) });
    });
  }

  test("print shows each table and hides the plot and controls", async ({ page }) => {
    await open(page, 1280);
    await page.emulateMedia({ media: "print" });
    for (const kind of KINDS) {
      const c = chart(page, kind);
      expect((await c.locator(":scope > .vc-table").boundingBox())!.width, kind).toBeGreaterThan(100);
      for (const plot of await c.locator(":scope > .vc-plot").all()) await expect(plot, kind).toBeHidden();
      await expect(c.locator(".vc-ctl"), kind).toBeHidden();
    }
  });

  test("forced colours paint the track, the marks, every series line and the swatches in system colours", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await open(page, 1280);
    const system = (name: string) =>
      page.evaluate((n) => {
        const probe = document.createElement("span");
        probe.style.color = n;
        document.body.appendChild(probe);
        const v = getComputedStyle(probe).color;
        probe.remove();
        return v;
      }, name);
    const [text, highlight] = [await system("CanvasText"), await system("Highlight")];
    expect(text).not.toBe(highlight);
    const all = (c: Locator, sel: string, prop: "fill" | "stroke" | "backgroundColor") =>
      c.locator(sel).evaluateAll((es, p) => es.map((e) => getComputedStyle(e)[p as "fill"]), prop);
    const gap = chart(page, "gap");
    expect(await all(gap, ".vc-plot:not([hidden]) .vc-track", "stroke")).toEqual(Array(3).fill(text));
    expect(await all(gap, ".vc-plot:not([hidden]) .vc-value", "fill")).toEqual(Array(3).fill(highlight));
    expect(await all(gap, ".vc-plot:not([hidden]) .vc-band", "fill")).toEqual(Array(3).fill(text));
    expect(await all(gap, ".vc-plot:not([hidden]) .vc-mark", "stroke")).toEqual(Array(2).fill(text));
    expect(await all(gap, ".vc-sw.vc-k-value", "backgroundColor")).toEqual([highlight]);
    expect(await all(gap, ".vc-sw.vc-k-band", "backgroundColor")).toEqual([text]);
    // Every steps series, plotted and in the legend, drops its hue.
    const steps = chart(page, "steps", "Steps");
    const lines = await all(steps, ".vc-plot:not([hidden]) .vc-line, .vc-legend .vc-line", "stroke");
    expect(lines.length).toBe(4);
    expect(lines).toEqual(Array(4).fill(text));
  });

  for (const scheme of ["dark", "light"] as const) {
    test(`390 px focus, ${scheme}: nothing runs past the page or a section, labels wrap, steps labels stay whole`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 390, true);
      const sections = page.locator(".wiki-article section.vc");
      for (const c of await sections.all()) {
        await c.scrollIntoViewIfNeeded();
        expect(await overflowsSection(c), await c.getAttribute("aria-label") ?? "").toBeLessThanOrEqual(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const gap = chart(page, "gap");
      const label = gap.locator(".vc-plot:not([hidden]) .vc-lab").first();
      expect(await label.evaluate((e) => [getComputedStyle(e).whiteSpace, getComputedStyle(e).color].join(" | "))).toBe(
        `normal | ${await token(page, "--text-primary")}`,
      );
      expect((await label.boundingBox())!.height).toBeGreaterThan(20); // it wrapped onto more lines
      // Table mode at 390 px: still inside its section.
      await gap.locator('button[data-vc-mode="table"]').click();
      expect(await overflowsSection(gap)).toBeLessThanOrEqual(0);
      expect(await gap.locator(":scope > .vc-table td").first().evaluate((e) => getComputedStyle(e).whiteSpace)).toBe("normal");
      // 25 long steps: a thinned, one-line label set under the plot.
      const long = chart(page, "steps", "Long steps");
      const labs = long.locator(".vc-xlab");
      expect(await labs.count()).toBeLessThanOrEqual(8);
      const area = (await long.locator(".vc-area").boundingBox())!;
      for (const l of await labs.all()) {
        const b = (await l.boundingBox())!;
        expect(b.height).toBeLessThan(20);
        expect(b.x).toBeGreaterThanOrEqual(area.x - 1);
        expect(b.x + b.width).toBeLessThanOrEqual(area.x + area.width + 1);
      }
    });
  }
});

test.describe("Wiki reader: Chart steps labels", () => {
  for (const width of [1280, 390]) {
    test(`${width} px: 25 long step names show what tells them apart, centred under their points`, async ({ page }) => {
      await open(page, width, width < 500);
      const long = chart(page, "steps", "Long steps");
      await long.scrollIntoViewIfNeeded();
      const area = (await long.locator(".vc-area").boundingBox())!;
      const labs = await long.locator(".vc-xlab").all();
      expect(labs.length).toBeGreaterThan(2);
      const shown: string[] = [];
      for (const [k, l] of labs.entries()) {
        const [text, clipped, left] = await l.evaluate((e) => [e.textContent ?? "", e.scrollWidth > e.clientWidth, parseFloat((e as HTMLElement).style.left)] as const);
        expect(clipped, text).toBe(false); // the whole label is visible, no ellipsis
        const b = (await l.boundingBox())!;
        expect(b.height).toBeLessThan(20); // one line
        const x = area.x + (left / 100) * area.width;
        if (k === 0) expect(Math.abs(b.x - x)).toBeLessThan(2);
        else if (k === labs.length - 1) expect(Math.abs(b.x + b.width - x)).toBeLessThan(2);
        else expect(Math.abs(b.x + b.width / 2 - x)).toBeLessThan(2);
        shown.push(text);
      }
      expect(new Set(shown).size).toBe(shown.length);
      await expect(long.locator(".vc-xcap")).toHaveText("step number … with a long name");
      const cap = (await long.locator(".vc-xcap").boundingBox())!;
      expect(cap.y).toBeGreaterThanOrEqual(area.y + area.height); // under the axis labels
      expect(Math.abs(cap.x + cap.width / 2 - (area.x + area.width / 2))).toBeLessThan(2); // centred under the plot
      expect(await overflowsSection(long)).toBeLessThanOrEqual(0);
    });
  }
});

test.describe("Chat bubbles: a Chart reaches chat as its table", () => {
  test("sanitizeHtml(formatWebHtml(<Chart>)) keeps the table and allows no svg", async ({ page }) => {
    await page.goto(`${BASE}/chat`);
    await page.waitForFunction(
      () =>
        typeof (globalThis as { formatWebHtml?: unknown }).formatWebHtml === "function" &&
        typeof (globalThis as { sanitizeHtml?: unknown }).sanitizeHtml === "function",
    );
    const result = await page.evaluate((src: string) => {
      const g = globalThis as unknown as {
        formatWebHtml: (s: string, o?: { views?: boolean }) => string;
        sanitizeHtml: (h: string, isWeb: boolean) => string;
      };
      const clean = g.sanitizeHtml(g.formatWebHtml(src, { views: true }), true);
      const probe = document.createElement("div");
      probe.innerHTML = clean;
      return {
        rows: Array.from(probe.querySelectorAll("tbody tr")).map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent)),
        vc: clean.includes("vc-"),
        svg: g.sanitizeHtml('<p>a</p><svg role="img"><title>t</title><rect/></svg>', true).includes("<svg"),
      };
    }, GAP_CHART.join("\n"));
    expect(result.rows).toEqual([
      ["Alpha track with a long name that has to wrap at phone width", "40", "50", "10", "35"],
      ["Beta", "12", "20", "8", "15"],
      ["Gamma", "-3", "10", "13", ""],
    ]);
    expect(result.vc).toBe(false);
    expect(result.svg).toBe(false);
  });
});
