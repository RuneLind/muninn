/**
 * The reader shapes (number columns, verdict cells, the label grid,
 * `src/format/reader-shapes.ts`) in a real browser, over a temp wiki: what a
 * reader SELECTS in a verdict cell or a grid item reads as the source does
 * (`✅ text`, `Label — text`), which is the text Explain and fact-check send
 * to `locateExcerpt`; and the ref links still read the bold label as the noun
 * before an id in a grid item, so no second noun is inserted. A unit test
 * cannot see either: whitespace around a hidden span is a layout outcome of
 * `Selection.toString()`, and the noun read-back walks the live DOM. Nor
 * can it see that a traffic light keeps its glyph on screen with no icon, or
 * that a number column's header and note wrap at phone width while the
 * number itself stays whole: both are computed style and layout.
 *
 * One muninn on its own port (the wiki's `.wiki-reader.json` declares the
 * `D` id noun, and the shared 3011 server's wikis are the developer's). No
 * model calls, no DB writes. ENV / SPAWN ENV: the spawn inherits
 * `DATABASE_URL` and `e2eEnv()` blanks the platform tokens and the host's
 * instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedMeasure } from "./contrast.ts";
import { PALETTES } from "../src/dashboard/views/components/palettes.ts";

const PORT = e2ePort("wiki-reader-shapes");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-reader-shapes";
const PAGE_REL = "plans/shapes.mdx";

const PAGE = [
  "---",
  "title: Shapes page",
  "type: plan",
  "---",
  "",
  "# Shapes page",
  "",
  "| Sjekk | Antall | Resultat |",
  "|---|---|---|",
  "| A | 1,200 | ✅ Targeted update prevents overwriting |",
  "| B | 30 | ❌ Fails on retry |",
  "",
  "Prosjektene:",
  "",
  "- **Muninn** — personal assistant platform",
  "- **Huginn** — knowledge index",
  "- **Mimir** — the code wiki",
  "",
  "Status:",
  "",
  "- **Beslutning:** D7 holder.",
  "- **Eier:** fag",
  "- **Frist:** fredag",
  "",
  "| Oppgave | Priority |",
  "|---|---|",
  "| Login | 🔴 Critical |",
  "| Logout | 🟢 Low |",
  "",
  "| Steg | Playwright-steget etter (min) | Rader |",
  "|---|---|---|",
  "| Bygg | 790 (just lists, no board) | 123 456 |",
  "| Test | 8 | 7 |",
  "",
  "| Sak | Hva skjedde i steget, med alle detaljene en leser trenger for å forstå utfallet | Sum |",
  "|---|---|---|",
  "| L9 | Bygget gikk gjennom alle stegene og la igjen en rapport med tallene for hver modul | **10 714** |",
  "| L10 | Kort | **~3.25 dager** |",
  "",
  "| Sak | Utfall |",
  "|---|---|",
  "| L1 | ✅ Fixed in [PR #3334](https://github.com/navikt/melosys-api/pull/3334), see [[plans/other]] and `fixFn()` |",
  "| L2 | ⚠️ Partly, [PR #3335](https://github.com/navikt/melosys-api/pull/3335) and [[plans/no-such-page]], `warnFn()` |",
  "| L3 | ❌ Broken, [PR #3336](https://github.com/navikt/melosys-api/pull/3336) and [[plans/other]], `badFn()` |",
  "| L4 | 🟢 Low, [PR #3337](https://github.com/navikt/melosys-api/pull/3337) and `lowFn()` |",
  "",
  "<DecisionLog>",
  "",
  "- **D7** — Vi gjør det slik.",
  "",
  "</DecisionLog>",
  "",
].join("\n");

let server: ChildProcess | undefined;
let base = "";

test.beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-shapes-"));
  const root = path.join(base, "wiki");
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, PAGE_REL), PAGE, "utf8");
  await writeFile(path.join(root, "plans/other.mdx"), "---\ntitle: Other page\ntype: plan\n---\n\n# Other page\n", "utf8");
  await writeFile(
    path.join(root, ".wiki-reader.json"),
    JSON.stringify({ language: "no", idLabels: { D: { one: "Beslutning", other: "beslutninger" } } }),
    "utf8",
  );
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
  if (base) await rm(base, { recursive: true, force: true });
});

async function openPage(page: Page): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(PAGE_REL)}`);
  await expect(page.locator(".wiki-article ul.label-grid")).toHaveCount(2);
  // The ref links have run once D7 in the grid is a link.
  await expect(page.locator(".wiki-article ul.label-grid a.wiki-ref")).toHaveCount(1);
}

/** The selection text of one element's contents, and its `innerText`, each
 *  with white space runs collapsed to one space (`locateExcerpt` collapses so). */
async function selected(page: Page, selector: string, n = 0): Promise<{ selection: string; inner: string }> {
  return page.locator(selector).nth(n).evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
    const norm = (t: string) => t.replace(/\s+/g, " ").trim();
    return { selection: norm(s.toString()), inner: norm((el as HTMLElement).innerText) };
  });
}

test.describe("Wiki reader shapes: selection text and ref nouns", () => {
  test("a verdict cell selects as glyph, space, text", async ({ page }) => {
    await openPage(page);
    expect(await selected(page, ".wiki-article td.v-good")).toEqual({
      selection: "✅ Targeted update prevents overwriting",
      inner: "✅ Targeted update prevents overwriting",
    });
    expect((await selected(page, ".wiki-article td.v-bad")).selection).toBe("❌ Fails on retry");
    // The glyph is in the text, not on screen: the round icon stands for it.
    expect(await page.locator(".wiki-article td.v-good .v-glyph").first().evaluate((e) => e.getBoundingClientRect().width)).toBe(0);
  });

  test("a grid item selects as label, separator, text", async ({ page }) => {
    await openPage(page);
    expect(await selected(page, ".wiki-article ul.label-grid > li", 0)).toEqual({
      selection: "Muninn — personal assistant platform",
      inner: "Muninn — personal assistant platform",
    });
    expect((await selected(page, ".wiki-article ul.label-grid > li", 3)).selection).toBe("Beslutning: D7 holder.");
    expect(await page.locator(".wiki-article ul.label-grid .lg-c").first().evaluate((e) => e.getBoundingClientRect().width)).toBe(0);
  });

  test("the bold label is the noun before an id in a grid item: no second noun", async ({ page }) => {
    await openPage(page);
    await expect(page.locator(".wiki-article ul.label-grid .id-noun")).toHaveCount(0);
    expect(await page.locator(".wiki-article ul.label-grid > li").nth(3).evaluate((e) => e.textContent)).toBe("Beslutning: D7 holder.");
  });

  test("a traffic light keeps its own glyph on screen and draws no pass/fail icon", async ({ page }) => {
    await openPage(page);
    const cell = page.locator(".wiki-article td", { hasText: "Critical" });
    await expect(cell).toHaveText("🔴 Critical");
    const look = await cell.evaluate((td) => {
      // The glyph's own text node, wherever the renderer put it.
      const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent!.includes("🔴")) node = walker.nextNode();
      const r = document.createRange();
      const at = node!.textContent!.indexOf("🔴");
      r.setStart(node!, at);
      r.setEnd(node!, at + 2);
      return {
        before: getComputedStyle(td, "::before").content,
        glyphWidth: r.getBoundingClientRect().width,
        tint: getComputedStyle(td).backgroundColor,
      };
    });
    expect(look.before).toBe("none");
    expect(look.glyphWidth).toBeGreaterThan(8);
    expect(look.tint).not.toBe("rgba(0, 0, 0, 0)");
    // A pass/fail glyph still draws the round icon in place of its glyph.
    expect(await page.locator(".wiki-article td.v-bad:not(.v-light)").first().evaluate((td) => getComputedStyle(td, "::before").content)).not.toBe("none");
  });

  test("at phone width a number column's header and note wrap, the number stays whole", async ({ page }) => {
    await openPage(page);
    await page.setViewportSize({ width: 390, height: 844 });
    // Focus mode: the article alone, as a phone reads it (wiki-genre-blocks.spec.ts).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("f");
    await expect.poll(async () => (await page.locator(".wiki-article").boundingBox())!.width).toBeGreaterThan(250);
    const table = page.locator(".wiki-article table").filter({ hasText: "Playwright-steget" });
    const m = await table.evaluate((t) => {
      const article = t.closest(".wiki-article") as HTMLElement;
      const th = t.querySelector("th.num") as HTMLElement;
      const nws = Array.from(t.querySelectorAll("td.num .num-nw"));
      const lh = parseFloat(getComputedStyle(th).lineHeight) || parseFloat(getComputedStyle(th).fontSize) * 1.4;
      return {
        table: t.getBoundingClientRect().width,
        article: article.getBoundingClientRect().width,
        thLines: Math.round((th.clientHeight - parseFloat(getComputedStyle(th).paddingTop) - parseFloat(getComputedStyle(th).paddingBottom)) / lh),
        // Each number on one line box: one client rect.
        numbers: nws.map((n) => `${n.textContent}:${n.getClientRects().length}`),
      };
    });
    expect(m.table).toBeLessThanOrEqual(m.article + 1);
    expect(m.thLines).toBeGreaterThan(1);
    expect(m.numbers).toEqual(["123 456:1"]);
    // A bold total beside a prose column, its column squeezed: the bold box on one line.
    const bold = await page.locator(".wiki-article table").filter({ hasText: "Hva skjedde" }).evaluate((t) =>
      Array.from(t.querySelectorAll("td.num strong")).map((b) => `${b.textContent}:${b.getClientRects().length}`),
    );
    expect(bold).toEqual(["10 714:1", "~3.25 dager:1"]);
  });

  // Fix round 1 batch 3: a link "PR #3334" in a v-good cell measured 4.19:1
  // in light. Every element in a tinted cell that paints text of its own
  // (links, code, bold) is measured against what is painted behind it: the
  // cell's resolved tint composited over the table, or its own fill (code).
  const THEMES = [
    { name: "light", theme: "light", palette: null },
    { name: "dark", theme: "dark", palette: null },
    ...PALETTES.map((p) => ({ name: p.id, theme: p.base, palette: p.id })),
  ];
  test("every coloured inline child of a tinted verdict cell reads at AA in light, dark and every palette", async ({ page }) => {
    await openPage(page);
    const measure = await paintedMeasure(page);
    const failures: string[] = [];
    let measured = 0;
    for (const t of THEMES) {
      const rows = await page.evaluate(
        ([theme, palette, measure]) => {
          if (!document.getElementById("noTransitions")) {
            document.head.insertAdjacentHTML("beforeend", '<style id="noTransitions">*, *::before, *::after { transition: none !important; }</style>');
          }
          document.documentElement.setAttribute("data-theme", theme as string);
          if (palette) document.documentElement.setAttribute("data-palette", palette as string);
          else document.documentElement.removeAttribute("data-palette");
          const out: { cell: string; el: string; text: string; ratio: number }[] = [];
          const plain: string[] = [];
          for (const td of Array.from(document.querySelectorAll(".wiki-article td.v-good, .wiki-article td.v-warn, .wiki-article td.v-bad"))) {
            // A link keeps a colour of its own: darkened, not dropped to the text's.
            for (const a of Array.from(td.querySelectorAll("a"))) if (getComputedStyle(a).color === getComputedStyle(td).color) plain.push(`${td.className} ${a.textContent}`);
            for (const el of [td, ...Array.from(td.querySelectorAll("*"))]) {
              if (el.matches(".v-glyph, .lg-c")) continue;
              const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent!.trim()).map((n) => n.textContent!.trim()).join(" ");
              if (!own) continue;
              out.push({ cell: td.className, el: el.tagName.toLowerCase(), text: own, ratio: (measure as (e: Element, o: boolean, f: boolean) => number)(el, false, false) });
            }
          }
          return { out, plain };
        },
        [t.theme, t.palette, measure] as const,
      );
      for (const p of rows.plain) failures.push(`${t.name} ${p}: drawn in the text colour`);
      for (const r of rows.out) {
        measured++;
        if (r.ratio < 4.5) failures.push(`${t.name} ${r.cell} <${r.el}> "${r.text}" ${r.ratio.toFixed(2)}`);
      }
    }
    // Four tinted tables' worth of cells, links and code under every theme.
    expect(measured).toBeGreaterThanOrEqual(THEMES.length * 12);
    expect(failures).toEqual([]);
  });
});
