/**
 * Palettes (Reading mode) end to end: what a unit test over the init script's
 * string cannot see.
 *
 *  1. **No flash.** With `muninn-theme=reading` stored, `data-theme="dark"` and
 *     `data-palette="reading"` are both on <html> before the header parses and
 *     at DOMContentLoaded. A palette applied by the end-of-header script would
 *     paint the base first.
 *  2. **The palette wins.** Its block shares the `html[data-theme]` blocks'
 *     specificity and wins on source order only — on the dashboard and on the
 *     chat page, which re-declares its own tokens after SHARED_STYLES.
 *  3. **The picker.** Menu order, keyboard, Escape/outside click, System
 *     clearing both attributes, and `t` cycling the same list.
 *  4. **Mermaid follows the base.** A palette is a layer, never a third base:
 *     the diagram renders mermaid's dark theme under Reading mode.
 *
 * Boots its own muninn with a temp `WIKI_EXTRA` wiki (the mermaid fixture).
 * The mermaid bundle loads from the CDN, as it does for every reader.
 * No model calls, no writes.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { PALETTES } from "../src/dashboard/views/components/palettes.ts";
import { paintedContrast, token } from "./contrast.ts";

const PORT = e2ePort("theme-palettes");
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI = "e2e-palettes";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const READING = PALETTES.find((p) => p.id === "reading")!;

const PAGE = [
  "---",
  "title: Diagram Page",
  "---",
  "",
  "# Diagram Page",
  "",
  "```mermaid",
  "graph TD",
  "  A[start] --> B[end]",
  "```",
  "",
].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-palettes-"));
  await writeFile(path.join(root, "diagram-page.md"), PAGE, "utf8");
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

/** Store a choice before any page script runs, the way a returning reader has it. */
async function storeChoice(page: Page, value: string | null): Promise<void> {
  await page.addInitScript((v) => {
    try {
      if (sessionStorage.getItem("__seeded")) return; // only the first load
      sessionStorage.setItem("__seeded", "1");
      if (v === null) localStorage.removeItem("muninn-theme");
      else localStorage.setItem("muninn-theme", v);
    } catch {
      /* storage unavailable */
    }
  }, value);
}

const attrs = (page: Page) =>
  page.evaluate(() => ({
    theme: document.documentElement.getAttribute("data-theme"),
    palette: document.documentElement.getAttribute("data-palette"),
    stored: localStorage.getItem("muninn-theme"),
  }));

test.describe("Reading mode is applied before first paint", () => {
  test("data-theme and data-palette are set before the header parses and at DOMContentLoaded", async ({ page }) => {
    await storeChoice(page, "reading");
    await page.addInitScript(() => {
      const w = window as unknown as { __seen: Record<string, unknown> };
      w.__seen = {};
      const snap = () => ({
        theme: document.documentElement.getAttribute("data-theme"),
        palette: document.documentElement.getAttribute("data-palette"),
      });
      new MutationObserver((_, obs) => {
        if (document.querySelector("header") && !w.__seen.header) {
          w.__seen.header = snap();
          obs.disconnect();
        }
      }).observe(document, { childList: true, subtree: true });
      document.addEventListener("DOMContentLoaded", () => (w.__seen.dcl = snap()));
    });
    for (const url of ["/", `/wiki?wiki=${WIKI}`, "/chat"]) {
      await page.goto(BASE + url);
      const seen = await page.evaluate(() => (window as unknown as { __seen: unknown }).__seen);
      expect(seen, url).toEqual({
        header: { theme: "dark", palette: "reading" },
        dcl: { theme: "dark", palette: "reading" },
      });
    }
  });

  test("the palette's tokens win over the base, on the dashboard and on chat", async ({ page }) => {
    await storeChoice(page, "reading");
    await page.goto(BASE + "/");
    const dash = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      header: getComputedStyle(document.querySelector("header")!).backgroundColor,
    }));
    expect(dash).toEqual({ body: "rgb(30, 28, 26)", header: "rgb(38, 36, 34)" }); // #1e1c1a, #262422
    await page.goto(BASE + "/chat");
    const chat = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        page: cs.getPropertyValue("--bg-page").trim(),
        chat: cs.getPropertyValue("--bg-chat").trim(),
        elevated: cs.getPropertyValue("--bg-elevated").trim(),
      };
    });
    expect(chat).toEqual({
      page: READING.tokens["--bg-page"],
      chat: READING.tokens["--bg-chat"],
      elevated: READING.tokens["--bg-elevated"],
    });
  });

  test("an unknown stored value renders as system", async ({ page }) => {
    await storeChoice(page, "no-such-palette");
    await page.goto(BASE + "/");
    expect(await attrs(page)).toMatchObject({ theme: null, palette: null });
    await expect(page.locator("#themeToggle")).toHaveText("◐");
  });
});

test.describe("The theme picker", () => {
  const order = ["System", "Light", "Dark", ...PALETTES.map((p) => p.label)];

  test("◐ opens a menu of every choice; picking Reading mode applies and persists it", async ({ page }) => {
    await storeChoice(page, null);
    await page.goto(BASE + "/");
    const btn = page.locator("#themeToggle");
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await btn.click();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#themeMenu [role=menuitemradio]")).toHaveText(order.map((l) => new RegExp(l)));
    await page.getByRole("menuitemradio", { name: /Reading mode/ }).click();
    await expect(page.locator("#themeMenu")).toBeHidden();
    expect(await attrs(page)).toEqual({ theme: "dark", palette: "reading", stored: "reading" });
    await expect(btn).toHaveText(READING.glyph);
    await expect(btn).toHaveAttribute("title", /Reading mode/);
    await page.reload();
    expect(await attrs(page)).toEqual({ theme: "dark", palette: "reading", stored: "reading" });
    await btn.click();
    await expect(page.getByRole("menuitemradio", { name: /Reading mode/ })).toHaveAttribute("aria-checked", "true");
    // System clears both attributes and the key.
    await page.getByRole("menuitemradio", { name: /System/ }).click();
    expect(await attrs(page)).toEqual({ theme: null, palette: null, stored: null });
    await expect(btn).toHaveText("◐");
  });

  test("keyboard: arrows move, Enter picks, Escape closes and refocuses, outside click closes", async ({ page }) => {
    await storeChoice(page, null);
    await page.goto(BASE + "/");
    const btn = page.locator("#themeToggle");
    await btn.focus();
    await page.keyboard.press("ArrowDown"); // opens on the current choice (System)
    await expect(page.locator("#themeMenu")).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: /System/ })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", { name: /Dark/ })).toBeFocused();
    await page.keyboard.press("Enter");
    expect(await attrs(page)).toEqual({ theme: "dark", palette: null, stored: "dark" });
    await expect(page.locator("#themeMenu")).toBeHidden();
    await expect(btn).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#themeMenu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#themeMenu")).toBeHidden();
    await expect(btn).toBeFocused();
    await btn.click();
    await expect(page.locator("#themeMenu")).toBeVisible();
    await page.mouse.click(5, 300);
    await expect(page.locator("#themeMenu")).toBeHidden();
    expect((await attrs(page)).stored).toBe("dark");
  });

  test("t cycles System → Light → Dark → every palette → System", async ({ page }) => {
    await storeChoice(page, null);
    await page.goto(BASE + "/");
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    const seen: unknown[] = [];
    for (let i = 0; i < 3 + PALETTES.length; i++) {
      await page.keyboard.press("t");
      const a = await attrs(page);
      seen.push([a.theme, a.palette]);
    }
    expect(seen).toEqual([
      ["light", null],
      ["dark", null],
      ...PALETTES.map((p) => [p.base, p.id]),
      [null, null],
    ]);
  });
});

test.describe("A palette follows its base everywhere that asks light or dark", () => {
  test("mermaid renders its dark theme under Reading mode", async ({ page }) => {
    await storeChoice(page, "reading");
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=diagram-page`);
    const node = page.locator("#articleWrap svg .node rect, #articleWrap svg .node polygon").first();
    await expect(node).toBeVisible({ timeout: 20_000 });
    const fill = await node.evaluate((el) => getComputedStyle(el).fill);
    // mermaid's `default` theme fills nodes #ECECFF; `dark` fills #1f2020.
    expect(fill).not.toBe("rgb(236, 236, 255)");
    expect(fill).toBe("rgb(31, 32, 32)");
  });
});

// ── Fix round 1 (PR #747): a palette is a layer, the bases stay main's ─────

/** The three themes a reader can be on that this file measures: both bases, then every palette. */
const BASES = [
  { name: "light", theme: "light", palette: null },
  { name: "dark", theme: "dark", palette: null },
] as const;
const PALETTE_THEMES = PALETTES.map((p) => ({ name: p.id, theme: p.base, palette: p.id }));

async function forceTheme(page: Page, t: { theme: string; palette: string | null }): Promise<void> {
  await page.evaluate(([theme, palette]) => {
    // Buttons animate `background` over 0.2s: without this a read right after
    // the switch measures a fill halfway between the two themes.
    if (!document.getElementById("noTransitions")) {
      document.head.insertAdjacentHTML("beforeend", '<style id="noTransitions">*, *::before, *::after { transition: none !important; }</style>');
    }
    document.documentElement.setAttribute("data-theme", theme!);
    if (palette) document.documentElement.setAttribute("data-palette", palette);
    else document.documentElement.removeAttribute("data-palette");
  }, [t.theme, t.palette] as const);
}

/** WCAG ratio of two computed `rgb()` strings. */
function ratio(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = c.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * The seven dashboard rules that drew hardcoded pale text on a hardcoded dark
 * fill on main (714ff8a1): dark islands in BOTH bases. A probe of each is added
 * to the real dashboard page, so the page's own CSS styles it.
 */
const ISLANDS = [
  { sel: ".detail-mini-item .mini-badge.deadline", bg: "rgb(58, 42, 26)", fg: "rgb(240, 192, 96)" }, // #3a2a1a / #f0c060
  { sel: ".detail-mini-item .mini-badge.quiet", bg: "rgb(26, 42, 62)", fg: "rgb(96, 176, 240)" }, // #1a2a3e / #60b0f0
  { sel: ".user-platform-badge.telegram", bg: "rgb(26, 42, 62)", fg: "rgb(84, 169, 235)" }, // #1a2a3e / #54a9eb
  { sel: ".user-platform-badge.slack_assistant", bg: "rgb(42, 26, 62)", fg: "rgb(224, 160, 255)" }, // #2a1a3e / #e0a0ff
  { sel: ".watcher-badge.github", bg: "rgb(26, 42, 26)", fg: null }, // #1a2a1a / --status-success
  { sel: ".watcher-badge.x", bg: "rgb(26, 26, 42)", fg: "rgb(136, 153, 204)" }, // #1a1a2a / #8899cc
];
const ISLAND_PROBE =
  '<div id="islandProbe"><div class="detail-mini-item"><span class="mini-badge deadline">due</span><span class="mini-badge quiet">quiet</span></div>' +
  '<span class="user-platform-badge telegram">telegram</span><span class="user-platform-badge slack_assistant">slack</span>' +
  '<span class="watcher-badge github">github</span><span class="watcher-badge x">x</span><div class="detail-skeleton"></div></div>';

async function islandColours(page: Page) {
  return page.evaluate(([probe, sels]) => {
    if (!document.getElementById("islandProbe")) document.body.insertAdjacentHTML("beforeend", probe as string);
    const root = document.getElementById("islandProbe")!;
    const out: Record<string, { bg: string; fg: string }> = {};
    for (const s of sels as string[]) {
      const el = root.querySelector(s)!;
      const cs = getComputedStyle(el);
      out[s] = { bg: cs.backgroundColor, fg: cs.color };
    }
    return {
      out,
      shimmer: getComputedStyle(root.querySelector(".detail-skeleton")!).backgroundImage,
      success: (() => {
        const p = document.createElement("span");
        p.style.color = "var(--status-success)";
        root.appendChild(p);
        const c = getComputedStyle(p).color;
        p.remove();
        return c;
      })(),
    };
  }, [ISLAND_PROBE, ISLANDS.map((i) => i.sel)] as const);
}

test.describe("Plain light and plain dark keep main's colours", () => {
  for (const t of BASES) {
    test(`the seven dark-island badges and the skeleton shimmer, ${t.name}`, async ({ page }) => {
      await storeChoice(page, null);
      await page.goto(BASE + "/");
      await forceTheme(page, t);
      const got = await islandColours(page);
      for (const i of ISLANDS) {
        expect(got.out[i.sel]!.bg, `${i.sel} fill`).toBe(i.bg);
        expect(got.out[i.sel]!.fg, `${i.sel} text`).toBe(i.fg ?? got.success);
      }
      // #22222e at the gradient's midpoint, in both bases.
      expect(got.shimmer).toContain("rgb(34, 34, 46) 50%");
    });
  }
});

test.describe("A palette keeps the dark-island badges readable", () => {
  for (const t of PALETTE_THEMES) {
    test(`every badge's text is >= 4.5:1 on its fill, ${t.name}`, async ({ page }) => {
      await storeChoice(page, null);
      await page.goto(BASE + "/");
      await forceTheme(page, t);
      const got = await islandColours(page);
      for (const i of ISLANDS) {
        const c = got.out[i.sel]!;
        expect(ratio(c.fg, c.bg), `${i.sel}: ${c.fg} on ${c.bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

/**
 * Text drawn on an `--accent` fill, on three pages. Base expectations are
 * main's colours (white, or `--text-primary` where main used it: #fff in dark,
 * #14151a in light); a palette must reach 4.5:1, its hover fill included.
 */
const ACCENT_CONTROLS: { url: string; sel: string; main: { light: string; dark: string }; hover?: boolean; enable?: boolean; probe?: string }[] = [
  { url: "/chat", sel: "#newThreadBtn", main: { light: "rgb(20, 21, 26)", dark: "rgb(255, 255, 255)" }, hover: true },
  { url: "/chat", sel: "#chatSend", main: { light: "rgb(20, 21, 26)", dark: "rgb(255, 255, 255)" }, enable: true, hover: true },
  { url: `/wiki?wiki=${WIKI}&page=diagram-page`, sel: "#wikiAskBtn", main: { light: "rgb(255, 255, 255)", dark: "rgb(255, 255, 255)" } },
  {
    url: `/wiki?wiki=${WIKI}&page=diagram-page`,
    sel: "#lensProbe button.on",
    main: { light: "rgb(255, 255, 255)", dark: "rgb(255, 255, 255)" },
    probe: '<div class="wiki-lens-switch" id="lensProbe"><button class="on">Overview</button><button>All</button></div>',
  },
  { url: "/summaries", sel: "#submitBtn", main: { light: "rgb(255, 255, 255)", dark: "rgb(255, 255, 255)" } },
  { url: "/summaries", sel: "#captureUrlBtn", main: { light: "rgb(255, 255, 255)", dark: "rgb(255, 255, 255)" } },
];

async function openControl(page: Page, c: (typeof ACCENT_CONTROLS)[number]) {
  await page.goto(BASE + c.url);
  await page.evaluate(([probe, sel, enable]) => {
    if (probe) document.body.insertAdjacentHTML("afterbegin", probe as string);
    const el = document.querySelector(sel as string) as HTMLButtonElement;
    if (enable) el.disabled = false;
  }, [c.probe ?? null, c.sel, c.enable ?? false] as const);
  const loc = page.locator(c.sel).first();
  await expect(loc).toHaveCount(1);
  return loc;
}

test.describe("Text on the accent: the bases keep main's ink, a palette reaches 4.5:1", () => {
  for (const c of ACCENT_CONTROLS) {
    test(`${c.url.split("?")[0]} ${c.sel}`, async ({ page }) => {
      await storeChoice(page, null);
      const loc = await openControl(page, c);
      for (const t of BASES) {
        await forceTheme(page, t);
        expect(await loc.evaluate((el) => getComputedStyle(el).color), `${t.name} ink`).toBe(c.main[t.theme]);
      }
      for (const t of PALETTE_THEMES) {
        await forceTheme(page, t);
        // The chat script disables Send again once it loads; measure it enabled.
        if (c.enable) await loc.evaluate((el) => ((el as HTMLButtonElement).disabled = false));
        expect(await loc.evaluate((el) => (el as HTMLButtonElement).disabled), "measured enabled").toBe(false);
        expect(await paintedContrast(loc, { withOpacity: true }), `${t.name}`).toBeGreaterThanOrEqual(4.5);
        if (c.hover) {
          await loc.hover();
          expect(await paintedContrast(loc, { withOpacity: true }), `${t.name} :hover`).toBeGreaterThanOrEqual(4.5);
          await page.mouse.move(0, 0);
        }
      }
    });
  }

  for (const t of PALETTE_THEMES) {
    test(`the accent ink tokens on --accent and --accent-hover, ${t.name}`, async ({ page }) => {
      await storeChoice(page, null);
      await page.goto(BASE + "/");
      await forceTheme(page, t);
      for (const ink of ["--on-accent", "--on-accent-primary"]) {
        for (const fill of ["--accent", "--accent-hover"]) {
          const r = ratio(await token(page, ink), await token(page, fill));
          expect(r, `${ink} on ${fill}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});

test.describe("A palette's text tokens read on every surface", () => {
  for (const t of PALETTE_THEMES) {
    test(`--text-secondary … --text-muted >= 4.5:1 on page, panel, card and surface, ${t.name}`, async ({ page }) => {
      await storeChoice(page, null);
      await page.goto(BASE + "/");
      await forceTheme(page, t);
      for (const text of ["--text-primary", "--text-secondary", "--text-tertiary", "--text-soft", "--text-muted"]) {
        for (const bg of ["--bg-page", "--bg-panel", "--bg-card", "--bg-surface"]) {
          const r = ratio(await token(page, text), await token(page, bg));
          expect(r, `${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});
