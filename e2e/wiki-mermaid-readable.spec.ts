/**
 * Mermaid in the reader's palette, at a readable size, with a full-window view
 * (`wiki-mermaid.ts` + `mermaid-theme.ts`). What a unit test over the pure half
 * cannot see:
 *
 *  1. **Palette.** A node is filled with the colour the reader's own tokens
 *     resolve to (accent 4.5% over panel, from a `color-mix()` probe in the
 *     page, never a literal hex), not mermaid's `#ECECFF` / `#1f2020`; a node
 *     with `class X warn` takes the warn tone; a page's own `classDef good`
 *     beats the predefined one, and a page's partial `classDef bad` (stroke
 *     only) stands alone instead of merging with ours.
 *  2. **Readable size.** A too-wide `LR` chain that reads larger top-down is
 *     drawn `TD`; one too tall top-down keeps `LR` at 11 px text and scrolls
 *     sideways as a named tab stop; a fence in a closed `<Fold>` is measured
 *     only once the fold opens.
 *     The floor is the smallest REAL text drawn (gantt 10 px ticks, sequence
 *     16 px messages, a page's 9 px init), measured here from computed
 *     font-size × screen transform: under 11 px only with a scrollbar, a gantt
 *     fills the column at 11 px with none, and a flip that would stand over
 *     900 px once widened stays LR.
 *  3. **⤢ full-window.** Opens by click and keyboard, closes by Esc, backdrop
 *     and button with focus back on ⤢, stays open on a click inside, redraws
 *     its copy in the new colours on a palette flip (its own svg id, so its
 *     node fill is the themed one), and closes on back navigation. Its copy
 *     reads at ≥ 11 px (a too-wide LR, a gantt), a drag from a label out to
 *     the backdrop does not close it, and a label naming the svg id keeps its
 *     text in the copy.
 *  4. **Copies.** A ref-link peek's copy of a diagram is themed (it lost its
 *     ids, so it is redrawn) and re-themed on a flip, with no ⤢; a fact-check
 *     card's copy carries no ⤢ and no scroll stop.
 *
 * Boots its own muninn with a temp `WIKI_EXTRA` wiki. The mermaid bundle loads
 * from the CDN, as it does for every reader. No model calls, no writes.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-mermaid-readable");
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI = "e2e-mermaid-readable";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const chain = (n: number, label: string) =>
  Array.from({ length: n - 1 }, (_, i) => `  N${i}[${label} ${i}] --> N${i + 1}[${label} ${i + 1}]`).join("\n");

/** Six long-label nodes: LR is too wide for the column, TD reads larger and stays short. */
const FLIPS = ["```mermaid", "flowchart LR", chain(6, "a fairly long node label number"), "```"].join("\n");
/** Sixteen nodes: TD would be far over 900 px tall, so LR stays and scrolls. */
const SCROLLS = ["```mermaid", "graph LR", chain(16, "step"), "```"].join("\n");
const MARKS = [
  "```mermaid",
  "flowchart TD",
  "  classDef good fill:#ff0000",
  "  classDef bad stroke:#00ff00",
  "  A[plain] --> W[warned] --> G[good] --> P[partial]",
  "  class W warn",
  "  class G good",
  "  class P bad",
  "```",
].join("\n");

const DIAGRAM_PAGE = [
  "---",
  "title: Diagram Page",
  "---",
  "",
  "# Diagram Page",
  "",
  "## Flips",
  "",
  FLIPS,
  "",
  "## Scrolls",
  "",
  SCROLLS,
  "",
  "## Marks",
  "",
  MARKS,
  "",
].join("\n");

const FOLD_PAGE = [
  "---",
  "title: Fold Page",
  "---",
  "",
  "# Fold Page",
  "",
  '<Fold title="Inside">',
  "",
  SCROLLS,
  "",
  "</Fold>",
  "",
].join("\n");

/** A gantt: its smallest text is a 10 px tick and its viewBox follows its box. */
const GANTT = [
  "```mermaid",
  "gantt",
  "  title Release plan",
  "  dateFormat YYYY-MM-DD",
  "  section Build",
  "  Design the parser :a1, 2026-01-01, 30d",
  "  Write the renderer :after a1, 25d",
  "  section Ship",
  "  Review and land :2026-02-20, 14d",
  "```",
].join("\n");
/** A sequence diagram (16 px messages) a little wider than the column. */
const SEQUENCE = [
  "```mermaid",
  "sequenceDiagram",
  ...Array.from({ length: 4 }, (_, i) => `  participant P${i} as Participant number ${i}`),
  ...Array.from({ length: 3 }, (_, i) => `  P${i}->>P${i + 1}: message ${i}`),
  "```",
].join("\n");
/** A small flowchart whose page init sets 9 px text. */
const NINE_PX = ["```mermaid", '%%{init:{"themeVariables":{"fontSize":"9px"}}}%%', "flowchart LR", "  A[small] --> B[text]", "```"].join("\n");
/** Eight parallel twelve-node chains: TD fits under 900 px scaled to the
 *  column, but widened to 11 px text it would stand far over 900 px. */
const TALL_FLIP = [
  "```mermaid",
  "flowchart LR",
  ...Array.from({ length: 8 }, (_, r) =>
    Array.from({ length: 11 }, (_, i) => `  R${r}N${i}[row ${r} step ${i} label] --> R${r}N${i + 1}[row ${r} step ${i + 1} label]`).join("\n"),
  ),
  "```",
].join("\n");

/** A node hidden by its own class, with 6 px text: hidden text is no floor. */
const HIDDEN = ["```mermaid", "flowchart TD", "  A[visible] --> B[gone]", "  classDef gone display:none,font-size:6px", "  class B gone", "```"].join("\n");

const TYPES_PAGE = [
  "---",
  "title: Types Page",
  "---",
  "",
  "# Types Page",
  "",
  GANTT,
  "",
  SEQUENCE,
  "",
  NINE_PX,
  "",
  TALL_FLIP,
  "",
  HIDDEN,
  "",
].join("\n");

const OTHER_PAGE = ["---", "title: Other Page", "---", "", "# Other Page", "", "See [[diagram-page|the diagrams]].", ""].join("\n");

/** One diagram, so its svg id is the first one drawn on a fresh load: `wm-0`. */
const ID_PAGE = ["---", "title: Id Page", "---", "", "# Id Page", "", "```mermaid", "flowchart TD", '  A["see wm-0 and wm-0x and dwm-0"] --> B[end]', "```", ""].join("\n");

/** A ref link to a heading whose section opens with a diagram (its peek copies it). */
const PEEK_PAGE = [
  "---",
  "title: Peek Page",
  "---",
  "",
  "# Peek Page",
  "",
  "See [the chart](#chart-section).",
  "",
  "## Chart section",
  "",
  "```mermaid",
  "flowchart TD",
  "  A[peek one] --> B[peek two]",
  "```",
  "",
].join("\n");

/** A fact-check card whose evidence holds a wide diagram (scrolls on the page). */
const FACT_PAGE = [
  "---",
  "title: Fact Page",
  "---",
  "",
  "# Fact Page",
  "",
  '<Fact n="1" v="bad">The chain is short.</Fact>',
  "",
  "<!-- factcheck:start -->",
  '<FactCheck date="2026-11-08" ok="0" warn="0" bad="1">',
  "",
  "### ❌ Claim 1/1 — The chain is short",
  "",
  "It is long:",
  "",
  SCROLLS,
  "",
  "Confidence: 90/100",
  "",
  "</FactCheck>",
  "<!-- factcheck:end -->",
  "",
].join("\n");

const BROKEN_PAGE = ["---", "title: Broken Page", "---", "", "# Broken Page", "", "```mermaid", "flowchart LR", "  A -->|unclosed B", "  ((((", "```", ""].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-mermaid-readable-"));
  await writeFile(path.join(root, "diagram-page.md"), DIAGRAM_PAGE, "utf8");
  await writeFile(path.join(root, "fold-page.mdx"), FOLD_PAGE, "utf8");
  await writeFile(path.join(root, "other-page.md"), OTHER_PAGE, "utf8");
  await writeFile(path.join(root, "broken-page.md"), BROKEN_PAGE, "utf8");
  await writeFile(path.join(root, "types-page.md"), TYPES_PAGE, "utf8");
  await writeFile(path.join(root, "id-page.md"), ID_PAGE, "utf8");
  await writeFile(path.join(root, "peek-page.md"), PEEK_PAGE, "utf8");
  await writeFile(path.join(root, "fact-page.mdx"), FACT_PAGE, "utf8");
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

test.use({ viewport: { width: 1440, height: 900 } });

async function setTheme(page: Page, theme: string, palette: string | null): Promise<void> {
  await page.evaluate(
    ([t, p]) => {
      document.documentElement.setAttribute("data-theme", t!);
      if (p) document.documentElement.setAttribute("data-palette", p);
      else document.documentElement.removeAttribute("data-palette");
    },
    [theme, palette] as const,
  );
}

/** A colour as `[r, g, b]` from a computed `rgb()` / `color(srgb …)` string. */
function channels(c: string): number[] {
  const rgb = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(c);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const s = /color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)/.exec(c);
  if (s) return [Number(s[1]) * 255, Number(s[2]) * 255, Number(s[3]) * 255];
  throw new Error("unparsed colour " + c);
}

function expectSameColour(actual: string, expected: string, what: string): void {
  const a = channels(actual);
  const e = channels(expected);
  for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - e[i]!), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1.5);
}

/** What `color-mix(in srgb, <tone> <pct>, var(--bg-panel))` computes at the article. */
async function probeMix(page: Page, tone: string, pct: number): Promise<string> {
  return page.evaluate(
    ([t, p]) => {
      const art = document.querySelector(".wiki-article")!;
      const el = document.createElement("span");
      el.style.color = `color-mix(in srgb, var(${t}) ${p}%, var(--bg-panel))`;
      art.appendChild(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    },
    [tone, pct] as const,
  );
}

const diagrams = (page: Page) => page.locator("#articleWrap .diagram[data-mermaid-src]");
const plainNodeFill = (page: Page, nth: number) =>
  diagrams(page).nth(nth).locator("svg .node:not(.warn):not(.good) rect").first().evaluate((el) => getComputedStyle(el).fill);

async function openDiagramPage(page: Page): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=diagram-page.md`);
  await expect(diagrams(page)).toHaveCount(3, { timeout: 20_000 });
}

test.describe("palette", () => {
  for (const t of [
    { theme: "light", palette: null, mermaidDefault: "rgb(236, 236, 255)" },
    { theme: "dark", palette: null, mermaidDefault: "rgb(31, 32, 32)" },
  ]) {
    test(`a node takes the reader's colour, not mermaid's, in ${t.theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: t.theme as "light" | "dark" });
      await openDiagramPage(page);
      await setTheme(page, t.theme, t.palette);
      const expected = await probeMix(page, "--accent", 4.5);
      await expect.poll(() => plainNodeFill(page, 2), { timeout: 10_000 }).not.toBe(t.mermaidDefault);
      expectSameColour(await plainNodeFill(page, 2), expected, "primaryColor");
    });
  }

  test("two quick flips serialize: the final colours are the final theme's", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openDiagramPage(page);
    await page.evaluate(() => {
      const h = document.documentElement;
      h.setAttribute("data-theme", "dark");
      h.setAttribute("data-palette", "reading");
      h.setAttribute("data-theme", "light");
      h.setAttribute("data-palette", "paper-light");
    });
    const expected = await probeMix(page, "--accent", 4.5);
    await expect.poll(async () => {
      const a = channels(await plainNodeFill(page, 2));
      const e = channels(expected);
      return Math.max(...a.map((v, i) => Math.abs(v - e[i]!)));
    }, { timeout: 10_000 }).toBeLessThanOrEqual(1.5);
    await page.waitForTimeout(500); // no late pass repaints it
    expectSameColour(await plainNodeFill(page, 2), expected, "final primaryColor");
  });

  test("class X warn takes the warn tone; the page's own classDef good or bad replaces ours", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openDiagramPage(page);
    const marks = diagrams(page).nth(2);
    const warnFill = await marks.locator("svg .node.warn rect, svg .node.warn polygon").first().evaluate((el) => getComputedStyle(el).fill);
    expectSameColour(warnFill, await probeMix(page, "--status-warning", 16), "warn fill");
    const warnStroke = await marks.locator("svg .node.warn rect").first().evaluate((el) => getComputedStyle(el).stroke);
    const warnToken = await page.evaluate(() => {
      const el = document.createElement("span");
      el.style.color = "var(--status-warning)";
      document.querySelector(".wiki-article")!.appendChild(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    });
    expectSameColour(warnStroke, warnToken, "warn stroke");
    const goodFill = await marks.locator("svg .node.good rect").first().evaluate((el) => getComputedStyle(el).fill);
    expect(goodFill, "the page's classDef good comes later in the source and wins").toBe("rgb(255, 0, 0)");
    // A page classDef that sets only a stroke is not merged with the injected
    // `bad` fill: the node keeps the plain fill and the page's stroke.
    const partial = marks.locator("svg .node.bad rect").first();
    expect(await partial.evaluate((el) => getComputedStyle(el).stroke)).toBe("rgb(0, 255, 0)");
    const plain = await marks.locator("svg .node:not(.warn):not(.good):not(.bad) rect").first().evaluate((el) => getComputedStyle(el).fill);
    expect(await partial.evaluate((el) => getComputedStyle(el).fill), "no injected bad fill under the page's partial classDef").toBe(plain);
    // The injected classes never reach the retained source.
    expect(await marks.getAttribute("data-mermaid-src")).not.toContain("classDef warn");
  });
});

test.describe("readable size", () => {
  /** Text px as drawn: 14 × rendered svg width ÷ viewBox width. */
  const textPx = (page: Page, nth: number) =>
    diagrams(page).nth(nth).locator(".diagram-body svg").evaluate((svg) => {
      const s = svg as SVGSVGElement;
      return (14 * s.getBoundingClientRect().width) / s.viewBox.baseVal.width;
    });

  test("a too-wide LR chain that reads larger top-down is drawn TD", async ({ page }) => {
    await openDiagramPage(page);
    const flips = diagrams(page).nth(0);
    await expect(flips).toHaveAttribute("data-mermaid-flipped", "");
    expect(await textPx(page, 0)).toBeGreaterThanOrEqual(11 - 0.01);
    const vb = await flips.locator(".diagram-body svg").evaluate((s) => {
      const b = (s as SVGSVGElement).viewBox.baseVal;
      return { width: b.width, height: b.height };
    });
    expect(vb.height, "top-down: taller than wide").toBeGreaterThan(vb.width);
    expect(await flips.getAttribute("data-mermaid-src")).toContain("flowchart LR");
  });

  test("one too tall top-down keeps LR at 11 px and scrolls as a named tab stop", async ({ page }) => {
    await openDiagramPage(page);
    const scrolls = diagrams(page).nth(1);
    await expect(scrolls).not.toHaveAttribute("data-mermaid-flipped", "");
    const body = scrolls.locator(".diagram-body");
    await expect(body).toHaveAttribute("role", "region");
    await expect(body).toHaveAttribute("tabindex", "0");
    await expect(body).toHaveAttribute("aria-label", /Diagram/);
    expect(await body.evaluate((b) => b.scrollWidth > b.clientWidth)).toBe(true);
    expect(await textPx(page, 1)).toBeCloseTo(11, 0);
  });

  test("a wide window un-widens and drops the stop; narrow again re-widens", async ({ page }) => {
    await openDiagramPage(page);
    const body = diagrams(page).nth(1).locator(".diagram-body");
    await expect(body).toHaveAttribute("role", "region");
    // Make the column wide enough for the LR chain at 14 px.
    await page.addStyleTag({ content: "#articleWrap .wiki-article { max-width: none !important; }" });
    await page.setViewportSize({ width: 3800, height: 900 });
    await expect.poll(() => body.evaluate((b) => b.scrollWidth > b.clientWidth), { timeout: 5000 }).toBe(false);
    await expect(body).not.toHaveAttribute("role", "region");
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(body).toHaveAttribute("role", "region", { timeout: 5000 });
  });

  test("a fence in a closed Fold is measured once the fold opens", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=fold-page.mdx`);
    const wrap = page.locator("#articleWrap details .diagram[data-mermaid-src]");
    await expect(wrap).toHaveCount(1, { timeout: 20_000 });
    // No layout: drawn as written, never widened at width 0.
    expect(await wrap.locator(".diagram-body svg").getAttribute("width")).toBe("100%");
    await page.locator("#articleWrap details > summary").first().click();
    await expect(wrap.locator(".diagram-body")).toHaveAttribute("role", "region", { timeout: 5000 });
    expect(await wrap.locator(".diagram-body svg").evaluate((s) => (14 * s.getBoundingClientRect().width) / (s as SVGSVGElement).viewBox.baseVal.width)).toBeCloseTo(11, 0);
  });
});

test.describe("readable size from the smallest real text", () => {
  /** Per diagram: the smallest text as drawn on screen (computed font-size ×
   *  the element's screen transform), whether the body scrolls, the drawn
   *  height and whether it was flipped. Independent of the code's own maths. */
  const measure = (page: Page) =>
    diagrams(page).evaluateAll((wraps) =>
      wraps.map((w) => {
        const body = w.querySelector<HTMLElement>(".diagram-body")!;
        const svg = body.querySelector<SVGSVGElement>("svg")!;
        let min = Infinity;
        for (const el of Array.from(svg.querySelectorAll<Element>("*"))) {
          if (["style", "title", "desc"].includes(el.tagName.toLowerCase())) continue;
          if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const g = (el instanceof SVGGraphicsElement ? el : el.closest("foreignObject")) as SVGGraphicsElement;
          const m = g.getScreenCTM()!;
          min = Math.min(min, parseFloat(getComputedStyle(el).fontSize) * Math.hypot(m.a, m.b));
        }
        return {
          head: (w.getAttribute("data-mermaid-src") ?? "").split("\n").find((l) => l.trim() && !l.trim().startsWith("%%")) ?? "",
          px: min,
          over: body.scrollWidth - body.clientWidth,
          widened: svg.getAttribute("width") !== "100%",
          scrolls: body.scrollWidth > body.clientWidth + 1,
          height: svg.getBoundingClientRect().height,
          flipped: w.hasAttribute("data-mermaid-flipped"),
        };
      }),
    );

  for (const vp of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    test(`at ${vp.width}×${vp.height}: no text under 11 px without a scrollbar, no flip over 900 px`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=types-page.md`);
      await expect(diagrams(page)).toHaveCount(5, { timeout: 20_000 });
      await page.waitForTimeout(600); // a resize or redraw pass settles
      const rows = await measure(page);
      for (const r of rows) {
        expect.soft(r.px >= 10.95 || r.scrolls, `${r.head}: ${r.px.toFixed(2)} px with no scrollbar`).toBe(true);
        if (r.flipped) expect.soft(r.height, `${r.head}: flipped ${r.height} px tall`).toBeLessThanOrEqual(900);
      }
      const [gantt, seq, nine, tall, hidden] = rows;
      // gantt: drawn at the width that fills the column at 11 px, not 1 px more.
      expect.soft(gantt!.over, "gantt needs no scrollbar").toBeLessThanOrEqual(0);
      expect.soft(gantt!.px).toBeGreaterThanOrEqual(10.95);
      // sequence: 16 px messages read ≥ 11 px in the column: never widened for 14 px maths.
      expect.soft(seq!.px).toBeGreaterThanOrEqual(10.95);
      // 9 px init: drawn larger than natural so its text reads 11 px.
      expect.soft(nine!.px).toBeGreaterThanOrEqual(10.95);
      // the tall flip stays LR and scrolls.
      expect.soft(tall!.flipped, "TD widened would be over 900 px tall").toBe(false);
      expect.soft(tall!.scrolls).toBe(true);
      // a hidden 6 px label is not the floor: the visible 14 px nodes fit unwidened.
      expect.soft(hidden!.widened, "hidden text widened nothing").toBe(false);
      expect.soft(hidden!.px).toBeCloseTo(14, 1);
    });
  }

  test("sequence at a scale where 14 px maths would widen it shows no scrollbar", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=types-page.md`);
    await expect(diagrams(page)).toHaveCount(5, { timeout: 20_000 });
    const seq = diagrams(page).nth(1).locator(".diagram-body");
    // Font metrics differ by OS, so size the body to put the drawing at 0.74 of
    // its natural width: 14 px × 0.74 = 10.4 (old maths widened), 16 px × 0.74 = 11.8.
    const vbw = await seq.evaluate((b) => (b.querySelector("svg") as SVGSVGElement).viewBox.baseVal.width);
    await seq.evaluate((b, w) => { (b as HTMLElement).style.width = `${w}px`; }, Math.round(vbw * 0.74));
    await page.waitForTimeout(600); // the debounced re-measure
    const scale = await seq.evaluate((b) => b.clientWidth / (b.querySelector("svg") as SVGSVGElement).viewBox.baseVal.width);
    expect(14 * scale).toBeLessThan(11);
    expect(16 * scale).toBeGreaterThanOrEqual(11);
    expect(await seq.evaluate((b) => (b.querySelector("svg") as SVGSVGElement).getAttribute("width")), "not widened").toBe("100%");
    expect(await seq.evaluate((b) => b.scrollWidth > b.clientWidth + 1)).toBe(false);
  });
});

test.describe("⤢ full-window", () => {
  const dialog = (page: Page) => page.locator("dialog.diagram-dialog");

  test("opens by keyboard and click, closes by Esc, backdrop and button, focus back on ⤢", async ({ page }) => {
    await openDiagramPage(page);
    const btn = diagrams(page).nth(2).getByRole("button", { name: "Open diagram full-window" });
    // Keyboard: Enter, then Esc.
    await btn.focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Close full-window diagram" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await expect(btn).toBeFocused();
    // Space opens; the close button closes.
    await page.keyboard.press(" ");
    await expect(dialog(page)).toBeVisible();
    await page.getByRole("button", { name: "Close full-window diagram" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(btn).toBeFocused();
    // Click opens; a click inside the diagram keeps it; the backdrop closes it.
    await btn.click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).locator("svg .node").first().click();
    await expect(dialog(page)).toBeVisible();
    await page.mouse.click(3, 3);
    await expect(dialog(page)).toBeHidden();
    await expect(btn).toBeFocused();
  });

  test("the copy is themed under its own id, and a palette flip redraws it while open", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openDiagramPage(page);
    await setTheme(page, "light", null);
    await expect.poll(() => plainNodeFill(page, 2)).not.toBe("rgb(236, 236, 255)");
    await diagrams(page).nth(2).getByRole("button", { name: "Open diagram full-window" }).click();
    const dlgFill = () => dialog(page).locator("svg .node:not(.warn):not(.good) rect").first().evaluate((el) => getComputedStyle(el).fill);
    expectSameColour(await dlgFill(), await probeMix(page, "--accent", 4.5), "dialog primaryColor (light)");
    const ids = await page.evaluate(() => Array.from(document.querySelectorAll("svg[id]")).map((s) => s.id));
    expect(new Set(ids).size, "no duplicated svg ids").toBe(ids.length);
    const before = await dlgFill();
    await setTheme(page, "light", "paper-light");
    await expect.poll(dlgFill, { timeout: 10_000 }).not.toBe(before);
    expectSameColour(await dlgFill(), await probeMix(page, "--accent", 4.5), "dialog primaryColor (paper-light)");
    expectSameColour(await plainNodeFill(page, 2), await probeMix(page, "--accent", 4.5), "page primaryColor (paper-light)");
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Close full-window diagram" })).toBeFocused();
  });

  test("⤢ survives a re-render with its focus", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openDiagramPage(page);
    const btn = diagrams(page).nth(2).getByRole("button", { name: "Open diagram full-window" });
    await btn.focus();
    const before = await plainNodeFill(page, 2);
    await setTheme(page, "dark", null);
    await expect.poll(() => plainNodeFill(page, 2), { timeout: 10_000 }).not.toBe(before);
    await expect(btn).toBeFocused();
  });

  test("back navigation closes the dialog with no error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=other-page.md`);
    await page.locator("#articleWrap a", { hasText: "the diagrams" }).click();
    await expect(diagrams(page)).toHaveCount(3, { timeout: 20_000 });
    await diagrams(page).nth(0).getByRole("button", { name: "Open diagram full-window" }).click();
    await expect(dialog(page)).toBeVisible();
    await page.goBack();
    await expect(dialog(page)).toBeHidden();
    await expect(page.locator("#articleWrap h1", { hasText: "Other Page" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("a fence that fails to render stays a <pre> with no ⤢", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=broken-page.md`);
    // The library loads, then the render rejects: wait for mermaid to be there.
    await expect.poll(() => page.evaluate(() => !!(globalThis as { mermaid?: unknown }).mermaid), { timeout: 20_000 }).toBe(true);
    await page.waitForTimeout(500);
    await expect(page.locator("#articleWrap pre code.language-mermaid")).toHaveCount(1);
    expect(await page.locator("#articleWrap .diagram-expand").count()).toBe(0);
  });
});

/** The smallest text inside `svg` as drawn on screen: computed font-size × the
 *  element's screen transform (independent of the code's own maths).
 *  Self-contained, so `evaluate` can ship its source to the page. */
function screenMinText(svg: Element): number {
  let min = Infinity;
  for (const el of Array.from(svg.querySelectorAll<Element>("*"))) {
    if (["style", "title", "desc"].includes(el.tagName.toLowerCase())) continue;
    if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const g = (el instanceof SVGGraphicsElement ? el : el.closest("foreignObject")) as SVGGraphicsElement;
    const m = g.getScreenCTM()!;
    min = Math.min(min, parseFloat(getComputedStyle(el).fontSize) * Math.hypot(m.a, m.b));
  }
  return min;
}

test.describe("⤢ full-window size and copy", () => {
  const dialog = (page: Page) => page.locator("dialog.diagram-dialog");
  const dialogText = (page: Page) => dialog(page).locator("svg").first().evaluate(screenMinText);

  test("a too-wide LR chain reads at ≥ 11 px and at least as large as the page; the dialog scrolls", async ({ page }) => {
    await openDiagramPage(page);
    const wrap = diagrams(page).nth(1);
    const pagePx = await wrap.locator(".diagram-body svg").evaluate(screenMinText);
    await wrap.getByRole("button", { name: "Open diagram full-window" }).click();
    await expect(dialog(page)).toBeVisible();
    const px = await dialogText(page);
    expect(px).toBeGreaterThanOrEqual(10.95);
    expect(px).toBeGreaterThanOrEqual(pagePx - 0.05);
    expect(await dialog(page).evaluate((d) => d.scrollWidth > d.clientWidth || d.scrollHeight > d.clientHeight), "the dialog scrolls inside").toBe(true);
  });

  test("a gantt fills the window at ≥ 11 px, from its own width, not its column's", async ({ page }) => {
    await page.setViewportSize({ width: 1150, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=types-page.md`);
    await expect(diagrams(page)).toHaveCount(5, { timeout: 20_000 });
    await page.waitForTimeout(600);
    await diagrams(page).nth(0).getByRole("button", { name: "Open diagram full-window" }).click();
    await expect(dialog(page)).toBeVisible();
    // The redraw for the dialog runs through the pass mutex.
    await expect.poll(() => dialog(page).locator("svg").first().evaluate((s) => s.getBoundingClientRect().width), { timeout: 10_000 }).toBeGreaterThan(1150 * 0.8);
    expect(await dialogText(page)).toBeGreaterThanOrEqual(10.95);
    expect(await dialog(page).evaluate((d) => d.scrollWidth > d.clientWidth + 1), "no sideways scroll").toBe(false);
  });

  test("a drag from a label out to the backdrop keeps it open; a backdrop click closes it", async ({ page }) => {
    await openDiagramPage(page);
    const btn = diagrams(page).nth(2).getByRole("button", { name: "Open diagram full-window" });
    await btn.click();
    await expect(dialog(page)).toBeVisible();
    const label = await dialog(page).locator("svg .node").first().boundingBox();
    await page.mouse.move(label!.x + label!.width / 2, label!.y + label!.height / 2);
    await page.mouse.down();
    await page.mouse.move(5, 5, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    await expect(dialog(page)).toBeVisible();
    await page.mouse.click(3, 3);
    await expect(dialog(page)).toBeHidden();
    await expect(btn).toBeFocused();
  });

  test("a label naming the svg id keeps its text in the copy; ids stay unique and resolve", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=id-page.md`);
    await expect(diagrams(page)).toHaveCount(1, { timeout: 20_000 });
    const pageSvg = diagrams(page).locator(".diagram-body svg");
    expect(await pageSvg.getAttribute("id"), "precondition: the label names this svg's id").toBe("wm-0");
    await diagrams(page).getByRole("button", { name: "Open diagram full-window" }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator("svg .node").first()).toContainText("see wm-0 and wm-0x and dwm-0");
    const audit = await page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
      const dlgSvg = document.querySelector("dialog.diagram-dialog svg")!;
      const refs: string[] = [];
      for (const el of Array.from(dlgSvg.querySelectorAll("*"))) {
        for (const a of Array.from(el.attributes)) {
          for (const m of a.value.matchAll(/url\(['"]?#([^)'"]+)/g)) refs.push(m[1]!);
          if ((a.name === "href" || a.name === "xlink:href") && a.value.startsWith("#")) refs.push(a.value.slice(1));
        }
      }
      return { dup: ids.length - new Set(ids).size, refs, dangling: refs.filter((r) => !dlgSvg.querySelector(`[id="${r}"]`)) };
    });
    expect(audit.dup, "no duplicated ids").toBe(0);
    expect(audit.refs.length, "the copy has marker refs to audit").toBeGreaterThan(0);
    expect(audit.dangling).toEqual([]);
  });
});

test.describe("copies of a diagram", () => {
  test("a ref-link peek's copy is themed, re-themes on a flip, and has no ⤢", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=peek-page.md`);
    await expect(diagrams(page)).toHaveCount(1, { timeout: 20_000 });
    await setTheme(page, "light", null);
    await page.locator(".wiki-article a.wiki-ref", { hasText: "the chart" }).hover();
    const copy = page.locator(".wiki-ref-peek .diagram[data-mermaid-src]");
    await expect(copy).toHaveCount(1);
    await expect(copy.locator(".diagram-expand")).toHaveCount(0);
    const fill = () => copy.locator("svg .node rect").first().evaluate((el) => getComputedStyle(el).fill);
    await expect.poll(async () => {
      const a = channels(await fill());
      const e = channels(await probeMix(page, "--accent", 4.5));
      return Math.max(...a.map((v, i) => Math.abs(v - e[i]!)));
    }, { timeout: 10_000 }).toBeLessThanOrEqual(1.5);
    const before = await fill();
    await setTheme(page, "light", "paper-light");
    await expect.poll(fill, { timeout: 10_000 }).not.toBe(before);
    expectSameColour(await fill(), await probeMix(page, "--accent", 4.5), "peek copy primaryColor (paper-light)");
  });

  test("a fact-check card's copy has no ⤢ and no scroll stop", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=fact-page.mdx`);
    await expect(page.locator(".wiki-article .diagram[data-mermaid-src] .diagram-expand")).toHaveCount(1, { timeout: 20_000 });
    // The appendix is a closed <details>: opened, its diagram is measured and widened.
    await page.locator(".wiki-article details:has(.diagram) > summary").first().click();
    await expect(page.locator(".wiki-article .diagram[data-mermaid-src] .diagram-body[role=region]")).toHaveCount(1, { timeout: 5000 });
    await page.locator('.wiki-article .fc-chip[data-fact="1"]').click();
    const card = page.locator(".fc-card .diagram[data-mermaid-src]");
    await expect(card).toHaveCount(1);
    await expect(card.locator(".diagram-expand")).toHaveCount(0);
    const body = card.locator(".diagram-body");
    await expect(body).not.toHaveAttribute("role", "region");
    await expect(body).not.toHaveAttribute("tabindex", "0");
  });
});

