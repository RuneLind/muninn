/**
 * Before → after chips and the section bar (plan muninn-wiki-render-richer
 * P3) in a real browser, over a temp wiki.
 *
 * Chips: the old value is drawn soft and the arrow in the light accent (the
 * tokens resolved on a body probe), both at 4.5:1 or more on the composited
 * chip in four palettes; the new value is bold, and a selection over the chip
 * reads as the source does (`10.5 → 6.4 min`), which is the text
 * Explain and fact-check send to `locateExcerpt`. Computed style and
 * `Selection.toString()` are layout outcomes a unit test cannot see.
 *
 * Section bar: the state table's risky rows in `wiki-section-bar.ts` — a
 * scroll moves `n/N`, the menu opens on the keyboard with focus on the current
 * entry and closes on Esc (focus back on the button) and on an outside click,
 * a jump into a closed fold opens it, navigation rebuilds the bar (or hides it
 * on a page with fewer than three sections), and a lens switch recomputes the
 * list. All of it is scroll position, focus and computed visibility.
 *
 * One muninn on its own port (the shared 3011 server's wikis are the
 * developer's). No model calls, no DB writes. ENV / SPAWN ENV: the spawn
 * inherits `DATABASE_URL` and `e2eEnv()` blanks the platform tokens and the
 * host's instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { PALETTES } from "../src/dashboard/views/components/palettes.ts";

const PORT = e2ePort("wiki-section-bar");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-section-bar";

const filler = (n: number, word: string) =>
  Array.from({ length: n }, (_, k) => `${word} paragraph ${k + 1}: the reader scrolls through this text to reach the next section of the page.`).join("\n\n");

const LONG = [
  "---",
  "title: Long plan",
  "type: plan",
  "---",
  "",
  "# Long plan",
  "",
  "## Brief",
  "",
  "- CI went 10.5 → 6.4 min after the split; the allowlist 113→57.",
  "- the second item",
  "",
  filler(14, "Brief"),
  "",
  '<Fold title="Decisions" summary="D1–D5">',
  "",
  "## Decisions",
  "",
  filler(14, "Decision"),
  "",
  "</Fold>",
  "",
  '<Fold title="Dev notes" for="dev">',
  "",
  filler(6, "Dev"),
  "",
  "</Fold>",
  "",
  '<Fold title="Hidden slice">',
  "",
  "## Hidden slice",
  "",
  filler(14, "Slice"),
  "",
  "</Fold>",
  "",
  "## Sources",
  "",
  "See [[plans/short]].",
  "",
  filler(14, "Source"),
  "",
].join("\n");

// Closed folds and a short last section at the foot: a jump there cannot
// scroll the section to the top of the pane.
const FOOT = [
  "---",
  "title: Foot page",
  "type: plan",
  "---",
  "",
  "# Foot page",
  "",
  "## Lead",
  "",
  filler(16, "Lead"),
  "",
  '<Fold title="First fold">',
  "",
  "one went 3 → 4 s",
  "",
  "</Fold>",
  "",
  '<Fold title="Second fold">',
  "",
  "two",
  "",
  "### Second detail",
  "",
  "the detail a hash names",
  "",
  "</Fold>",
  "",
  "## End",
  "",
  "the end",
  "",
].join("\n");

const SHORT = ["---", "title: Short page", "type: plan", "---", "", "# Short page", "", "## One", "", "a", "", "## Two", "", "b", ""].join("\n");

let server: ChildProcess | undefined;
let base = "";

test.beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-secbar-"));
  const root = path.join(base, "wiki");
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, "plans/long.mdx"), LONG, "utf8");
  await writeFile(path.join(root, "plans/short.mdx"), SHORT, "utf8");
  await writeFile(path.join(root, "plans/foot.mdx"), FOOT, "utf8");
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

async function openLong(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent("plans/long.mdx")}&lens=all`);
  await expect(page.locator(".wiki-article .ba-chip").first()).toBeVisible();
  await expect(page.locator("#wikiSectionBar")).toBeVisible();
}

const n = (page: Page) => page.locator("#wikiSectionBar .wiki-sec-n");
const title = (page: Page) => page.locator("#wikiSectionBar .wiki-sec-t");

/** Scroll the pane so `selector`'s top sits `gap` px under the bar. */
async function scrollTo(page: Page, selector: string, gap = 4): Promise<void> {
  await page.evaluate(([sel, g]) => {
    const wrap = document.getElementById("articleWrap")!;
    const el = document.querySelector(sel)!;
    wrap.scrollTop += el.getBoundingClientRect().top - wrap.getBoundingClientRect().top - g;
  }, [selector, gap] as const);
}

test.describe("before → after chips", () => {
  test("old value soft, arrow light accent, new value bold; selection reads the source", async ({ page }) => {
    await openLong(page);
    const look = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const resolve = (token: string) => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color;
      };
      const chip = document.querySelector(".wiki-article .ba-chip")!;
      const r = document.createRange();
      r.selectNodeContents(chip.closest("li")!);
      const sel = getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
      const out = {
        old: getComputedStyle(chip.querySelector(".ba-old")!).color,
        soft: resolve("--text-soft"),
        arr: getComputedStyle(chip.querySelector(".ba-arr")!).color,
        accent: resolve("--accent-light"),
        weight: Number(getComputedStyle(chip.querySelector(".ba-new")!).fontWeight),
        bg: getComputedStyle(chip).backgroundColor,
        chips: Array.from(document.querySelectorAll(".wiki-article .ba-chip")).map((c) => c.textContent),
        selection: sel.toString().replace(/\s+/g, " ").trim(),
        source: (chip.closest("li")!.textContent ?? "").replace(/\s+/g, " ").trim(),
      };
      probe.remove();
      return out;
    });
    expect(look.chips).toEqual(["10.5 → 6.4 min", "113→57"]);
    expect(look.old).toBe(look.soft);
    expect(look.arr).toBe(look.accent);
    expect(look.weight).toBeGreaterThanOrEqual(600);
    expect(look.bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(look.selection).toBe("CI went 10.5 → 6.4 min after the split; the allowlist 113→57.");
    expect(look.selection).toBe(look.source);
  });
});

/** Contrast of `.ba-old` and `.ba-arr` on the chip's background composited
 *  over every ancestor's, all colours read from the page (a canvas parses
 *  whatever form `getComputedStyle` returns, `color(srgb …)` included). */
async function chipContrast(page: Page, chipSel: string): Promise<{ old: number; arr: number }> {
  return page.evaluate((sel) => {
    const chip = document.querySelector(sel)!;
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const layers: string[] = [];
    for (let el: Element | null = chip; el; el = el.parentElement) layers.unshift(getComputedStyle(el).backgroundColor);
    const paint = (colors: string[]) => {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 1, 1);
      for (const c of colors) {
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
      }
      return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (fg: string) => {
      const a = lum(paint(layers));
      const b = lum(paint([...layers, fg]));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    return {
      old: ratio(getComputedStyle(chip.querySelector(".ba-old")!).color),
      arr: ratio(getComputedStyle(chip.querySelector(".ba-arr")!).color),
    };
  }, chipSel);
}

test.describe("chip contrast", () => {
  const SCHEMES = [
    { name: "light", theme: "light", palette: null },
    { name: "dark", theme: "dark", palette: null },
    { name: "reading", theme: "dark", palette: "reading" },
    { name: "paper-light", theme: "light", palette: "paper-light" },
  ];
  test("old value and arrow clear 4.5:1 on the chip, in prose and inside a fold, in light, dark, reading and paper-light", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent("plans/long.mdx")}&lens=all`);
    const measured: string[] = [];
    const low: string[] = [];
    for (const where of ["prose", "fold"] as const) {
      if (where === "fold") {
        await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent("plans/foot.mdx")}&lens=all`);
        await page.locator(".wiki-article details.fold summary", { hasText: "First fold" }).click();
      }
      const sel = where === "fold" ? ".wiki-article details.fold .ba-chip" : ".wiki-article .ba-chip";
      await expect(page.locator(sel).first()).toBeVisible();
      for (const s of SCHEMES) {
        await page.evaluate(([theme, palette]) => {
          document.documentElement.setAttribute("data-theme", theme as string);
          if (palette) document.documentElement.setAttribute("data-palette", palette as string);
          else document.documentElement.removeAttribute("data-palette");
        }, [s.theme, s.palette] as const);
        const c = await chipContrast(page, sel);
        measured.push(`${s.name} ${where} old=${c.old.toFixed(2)} arr=${c.arr.toFixed(2)}`);
        if (c.old < 4.5) low.push(`${s.name} ${where} old ${c.old.toFixed(2)}`);
        if (c.arr < 4.5) low.push(`${s.name} ${where} arr ${c.arr.toFixed(2)}`);
      }
    }
    console.log(measured.join("\n"));
    expect(low).toEqual([]);
  });
});

test.describe("section bar", () => {
  test("load at the top: 1/N, the first title, progress 0; a scroll moves n/N", async ({ page }) => {
    await openLong(page);
    await expect(n(page)).toHaveText("1/5");
    await expect(title(page)).toHaveText("Brief");
    expect(parseFloat(await page.locator("#wikiSectionBar .wiki-sec-bar i").evaluate((i) => (i as HTMLElement).style.width))).toBe(0);
    // Just above the reading line (140 px): the closed folds after it sit below.
    await scrollTo(page, ".wiki-article > details.fold:nth-of-type(1) > summary", 130);
    await expect(n(page)).toHaveText("2/5");
    await expect(title(page)).toHaveText("Decisions");
    // Closed folds are short: the last section is reached at the bottom.
    await page.evaluate(() => {
      const w = document.getElementById("articleWrap")!;
      w.scrollTop = w.scrollHeight;
    });
    await expect(n(page)).toHaveText("5/5");
    await expect(title(page)).toHaveText("Sources");
    expect(parseFloat(await page.locator("#wikiSectionBar .wiki-sec-bar i").evaluate((i) => (i as HTMLElement).style.width))).toBeGreaterThan(99);
    // A fold opened by the reader moves the sections after it: re-derived.
    await page.evaluate(() => {
      const w = document.getElementById("articleWrap")!;
      w.scrollTop = 0;
    });
    await expect(n(page)).toHaveText("1/5");
  });

  test("menu: keyboard opens on the current entry, Esc closes to the button, outside click closes", async ({ page }) => {
    await openLong(page);
    const btn = page.locator("#wikiSectionBar .wiki-sec-btn");
    const menu = page.locator("#wikiSectionMenu");
    await btn.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await expect(menu.locator(".wiki-sec-item")).toHaveText(["1Brief", "2Decisions", "3Dev notes", "4Hidden slice", "5Sources"]);
    await expect(menu.locator('.wiki-sec-item[aria-current="location"]')).toHaveText("1Brief");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("1Brief");
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("2Decisions");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.classList.contains("wiki-sec-btn"))).toBe(true);
    // Esc closed the menu only: focus mode was not entered or left.
    await expect(page.locator(".wiki-layout.focus-mode")).toHaveCount(0);
    await page.keyboard.press(" ");
    await expect(menu).toBeVisible();
    // A click in the pane, below where the menu hangs.
    const box = (await page.locator("#articleWrap").boundingBox())!;
    await page.mouse.click(box.x + box.width - 40, box.y + box.height - 30);
    await expect(menu).toBeHidden();
  });

  test("a jump into a closed fold opens it, scrolls it under the bar and focuses its summary", async ({ page }) => {
    await openLong(page);
    const fold = page.locator(".wiki-article > details.fold", { has: page.locator("summary", { hasText: "Hidden slice" }) });
    expect(await fold.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    await page.locator("#wikiSectionBar .wiki-sec-btn").click();
    await page.locator("#wikiSectionMenu .wiki-sec-item", { hasText: "Hidden slice" }).click();
    await expect(page.locator("#wikiSectionMenu")).toBeHidden();
    expect(await fold.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
    await expect(n(page)).toHaveText("4/5");
    await expect(title(page)).toHaveText("Hidden slice");
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("SUMMARY");
    const gap = await fold.evaluate((d) => d.getBoundingClientRect().top - document.getElementById("articleWrap")!.getBoundingClientRect().top);
    expect(Math.abs(gap)).toBeLessThan(40);
  });

  test("a jump at the page's foot keeps the picked section current until the pane scrolls", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent("plans/foot.mdx")}&lens=all`);
    await expect(n(page)).toHaveText("1/4");
    await page.locator("#wikiSectionBar .wiki-sec-btn").click();
    await page.locator("#wikiSectionMenu .wiki-sec-item", { hasText: "First fold" }).click();
    await expect(title(page)).toHaveText("First fold");
    await expect(n(page)).toHaveText("2/4");
    // Without the pin the foot rule names the last section on screen.
    await expect(title(page)).not.toHaveText("End");
    // A scroll of the pane hands the bar back to the rule (up past the stretch
    // where the line slides, into Lead).
    await page.evaluate(() => {
      document.getElementById("articleWrap")!.scrollTop -= 700;
    });
    await expect(title(page)).toHaveText("Lead");
  });

  test("a lens switch recomputes the sections from what is visible", async ({ page }) => {
    await openLong(page);
    await expect(n(page)).toHaveText("1/5");
    await page.locator('.wiki-lens-switch button[data-lens="overview"]').click();
    await expect(n(page)).toHaveText("1/4");
    await page.locator("#wikiSectionBar .wiki-sec-btn").click();
    await expect(page.locator("#wikiSectionMenu .wiki-sec-item")).toHaveText(["1Brief", "2Decisions", "3Hidden slice", "4Sources"]);
    await page.keyboard.press("Escape");
    await page.locator('.wiki-lens-switch button[data-lens="all"]').click();
    await expect(n(page)).toHaveText("1/5");
  });

  test("navigation rebuilds the bar: a page under 3 sections has none, Back brings it again", async ({ page }) => {
    await openLong(page);
    await page.locator("#wikiSectionBar .wiki-sec-btn").click();
    await expect(page.locator("#wikiSectionMenu")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const w = document.getElementById("articleWrap")!;
      w.scrollTop = w.scrollHeight;
    });
    await page.locator(".wiki-article a", { hasText: /Short page|short/ }).first().click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Short page");
    await expect(page.locator("#wikiSectionBar")).toBeHidden();
    // The breadcrumb is as before.
    await expect(page.locator("#wikiBreadcrumb .wiki-bc-cur")).toBeVisible();
    await page.goBack();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Long plan");
    await expect(page.locator("#wikiSectionBar")).toBeVisible();
    await expect(n(page)).toHaveText("1/5");
    await expect(page.locator("#wikiSectionMenu")).toBeHidden();
  });

  test("navigations leave no keydown listener behind on the bar's host", async ({ page }) => {
    await openLong(page);
    const cdp = await page.context().newCDPSession(page);
    const keydowns = async (): Promise<number> => {
      const { result } = await cdp.send("Runtime.evaluate", { expression: "document.getElementById('wikiSectionBar')" });
      const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId! });
      return listeners.filter((l) => l.type === "keydown").length;
    };
    const before = await keydowns();
    for (let k = 0; k < 3; k++) {
      await page.locator(".wiki-article a", { hasText: /Short page|short/ }).first().click();
      await expect(page.locator(".wiki-article-head h1")).toHaveText("Short page");
      await page.goBack();
      await expect(page.locator(".wiki-article-head h1")).toHaveText("Long plan");
    }
    expect(await keydowns()).toBe(before);
  });

  test("a navigation with the menu open closes it: Esc in the next bar still leaves focus mode", async ({ page }) => {
    await openLong(page);
    await page.locator(".wiki-article a", { hasText: /Short page|short/ }).first().click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Short page");
    await page.goBack();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Long plan");
    await page.locator("#wikiSectionBar .wiki-sec-btn").click();
    await expect(page.locator("#wikiSectionMenu")).toBeVisible();
    // History moves without a pointer event, so the outside-click close never runs.
    await page.goForward();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Short page");
    await page.goBack();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Long plan");
    await expect(page.locator("#wikiSectionMenu")).toBeHidden();
    await page.locator("body").press("f");
    await expect(page.locator(".wiki-layout.focus-mode")).toHaveCount(1);
    await page.locator("#wikiSectionBar .wiki-sec-btn").focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(".wiki-layout.focus-mode")).toHaveCount(0);
  });

  test("a page loaded with a hash shows the anchored section", async ({ page }) => {
    await openLong(page);
    const id = await page.locator(".wiki-article > h3", { hasText: "Sources" }).getAttribute("id");
    expect(id).toBeTruthy();
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent("plans/long.mdx")}&lens=all#${id}`);
    await expect(title(page)).toHaveText("Sources");
  });

  test("a hash near the page's foot shows the anchored section, not the last one on screen", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const url = `${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent("plans/foot.mdx")}&lens=all`;
    await page.goto(url);
    await expect(n(page)).toHaveText("1/4");
    const id = await page.locator(".wiki-article details.fold h4", { hasText: "Second detail" }).getAttribute("id");
    expect(id).toBeTruthy();
    await page.goto(`${url}#${id}`);
    await expect(title(page)).toHaveText("Second fold");
    await expect(n(page)).toHaveText("3/4");
    // The case itself: the pane is at its foot, so the target never reached the top.
    expect(await page.evaluate(() => {
      const w = document.getElementById("articleWrap")!;
      return w.scrollTop >= w.scrollHeight - w.clientHeight - 2;
    })).toBe(true);
  });

  test("an Ask answer or the start view replacing the article leaves no bar", async ({ page }) => {
    await openLong(page);
    await page.locator("#wikiBreadcrumb .wiki-bc-wiki").click();
    await expect(page.locator("#wikiSectionBar")).toBeHidden();
    await expect(page.locator("#wikiSectionBar .wiki-sec-btn")).toHaveCount(0);
  });

  const THEMES = [
    { name: "light", theme: "light", palette: null },
    { name: "dark", theme: "dark", palette: null },
    ...PALETTES.map((p) => ({ name: p.id, theme: p.base, palette: p.id })),
  ];
  test("every colour the bar and the chip draw resolves in light, dark and every palette", async ({ page }) => {
    await openLong(page);
    await page.locator("#wikiSectionBar .wiki-sec-btn").click();
    const failures: string[] = [];
    for (const t of THEMES) {
      const got = await page.evaluate(
        ([theme, palette]) => {
          document.documentElement.setAttribute("data-theme", theme as string);
          if (palette) document.documentElement.setAttribute("data-palette", palette as string);
          else document.documentElement.removeAttribute("data-palette");
          const cs = (sel: string, prop: string) => getComputedStyle(document.querySelector(sel)!).getPropertyValue(prop);
          return {
            n: cs("#wikiSectionBar .wiki-sec-n", "color"),
            t: cs("#wikiSectionBar .wiki-sec-t", "color"),
            track: cs("#wikiSectionBar .wiki-sec-bar", "background-color"),
            fill: cs("#wikiSectionBar .wiki-sec-bar i", "background-color"),
            menu: cs("#wikiSectionMenu", "background-color"),
            menuBorder: cs("#wikiSectionMenu", "border-top-color"),
            chip: cs(".wiki-article .ba-chip", "background-color"),
            text: getComputedStyle(document.body).color,
          };
        },
        [t.theme, t.palette] as const,
      );
      for (const [k, v] of Object.entries(got)) {
        if (!v || v === "rgba(0, 0, 0, 0)" || (k !== "text" && k !== "t" && v === "rgb(0, 0, 0)" && got.text !== "rgb(0, 0, 0)")) failures.push(`${t.name} ${k}=${v}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
