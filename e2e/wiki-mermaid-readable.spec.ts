/**
 * Mermaid in the reader's palette, at a readable size, with a full-window view
 * (`wiki-mermaid.ts` + `mermaid-theme.ts`). What a unit test over the pure half
 * cannot see:
 *
 *  1. **Palette.** A node is filled with the colour the reader's own tokens
 *     resolve to (accent 4.5% over panel, from a `color-mix()` probe in the
 *     page, never a literal hex), not mermaid's `#ECECFF` / `#1f2020`; a node
 *     with `class X warn` takes the warn tone; a page's own `classDef good`
 *     beats the predefined one.
 *  2. **Readable size.** A too-wide `LR` chain that reads larger top-down is
 *     drawn `TD`; one too tall top-down keeps `LR` at 11 px text and scrolls
 *     sideways as a named tab stop; a fence in a closed `<Fold>` is measured
 *     only once the fold opens.
 *  3. **⤢ full-window.** Opens by click and keyboard, closes by Esc, backdrop
 *     and button with focus back on ⤢, stays open on a click inside, redraws
 *     its copy in the new colours on a palette flip (its own svg id, so its
 *     node fill is the themed one), and closes on back navigation.
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
  "  A[plain] --> W[warned] --> G[good]",
  "  class W warn",
  "  class G good",
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

const OTHER_PAGE = ["---", "title: Other Page", "---", "", "# Other Page", "", "See [[diagram-page|the diagrams]].", ""].join("\n");

const BROKEN_PAGE = ["---", "title: Broken Page", "---", "", "# Broken Page", "", "```mermaid", "flowchart LR", "  A -->|unclosed B", "  ((((", "```", ""].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-mermaid-readable-"));
  await writeFile(path.join(root, "diagram-page.md"), DIAGRAM_PAGE, "utf8");
  await writeFile(path.join(root, "fold-page.mdx"), FOLD_PAGE, "utf8");
  await writeFile(path.join(root, "other-page.md"), OTHER_PAGE, "utf8");
  await writeFile(path.join(root, "broken-page.md"), BROKEN_PAGE, "utf8");
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

  test("class X warn takes the warn tone; the page's own classDef good wins over ours", async ({ page }) => {
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
