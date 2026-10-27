/**
 * Palettes (Reading mode) end to end: what a unit test over the init script's
 * string cannot see.
 *
 *  1. **No flash.** With a palette id stored (`reading`, `paper-light`), its
 *     base as `data-theme` and its id as `data-palette` are both on <html>
 *     before the header parses and at DOMContentLoaded. A palette applied by
 *     the end-of-header script would paint the base first.
 *  2. **The palette wins.** Its block shares the `html[data-theme]` blocks'
 *     specificity and wins on source order only — on the dashboard and on the
 *     chat page, which re-declares its own tokens after SHARED_STYLES. Every
 *     palette, under both OS colour schemes; a literal id → base table pins
 *     each palette's base against a registry edit.
 *  3. **The picker.** Menu order, keyboard, Escape from anywhere, outside
 *     click and Tools ▾ closing each other, System
 *     clearing both attributes, and `t` cycling the same list.
 *  4. **Mermaid follows the base.** A palette is a layer, never a third base:
 *     the diagram renders mermaid's theme for the palette's base.
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
const PAPER_LIGHT = PALETTES.find((p) => p.id === "paper-light")!;

/** `#rgb` / `#rrggbb` → the `rgb(r, g, b)` string getComputedStyle returns. */
function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

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

test.describe("A palette is applied before first paint", () => {
  for (const p of PALETTES) test(`${p.id}: data-theme and data-palette are set before the header parses and at DOMContentLoaded`, async ({ page }) => {
    await storeChoice(page, p.id);
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
        header: { theme: p.base, palette: p.id },
        dcl: { theme: p.base, palette: p.id },
      });
    }
  });

  // Every palette, under both OS schemes: the chat page re-emits only
  // CHAT_PALETTE_TOKENS after its own base blocks, so a palette missing from
  // that re-emit shows the base's chat surface under the palette's sidebar.
  for (const p of PALETTES) for (const scheme of ["light", "dark"] as const) {
    test(`${p.id} (OS ${scheme}): the palette's tokens win over the base, on the dashboard and on chat`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await storeChoice(page, p.id);
      await page.goto(BASE + "/");
      const dash = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        header: getComputedStyle(document.querySelector("header")!).backgroundColor,
      }));
      expect(dash).toEqual({ body: hexToRgb(p.tokens["--bg-page"]!), header: hexToRgb(p.tokens["--bg-panel"]!) });
      await page.goto(BASE + "/chat");
      const chat = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          page: cs.getPropertyValue("--bg-page").trim(),
          chat: cs.getPropertyValue("--bg-chat").trim(),
          elevated: cs.getPropertyValue("--bg-elevated").trim(),
          painted: getComputedStyle(document.querySelector(".sim-chat")!).backgroundColor,
        };
      });
      expect(chat).toEqual({
        page: p.tokens["--bg-page"],
        chat: p.tokens["--bg-chat"],
        elevated: p.tokens["--bg-elevated"],
        painted: hexToRgb(p.tokens["--bg-chat"]!),
      });
    });
  }

  // A literal table, so an edit to a registry entry's base fails here even
  // though every loop above derives its expectation from that same entry.
  test("each palette sits on the base it was designed for", () => {
    const EXPECTED_BASE: Record<string, "light" | "dark"> = { reading: "dark", "paper-light": "light" };
    expect(Object.fromEntries(PALETTES.map((p) => [p.id, p.base]))).toEqual(EXPECTED_BASE);
  });

  test("an unknown or 'system' stored value renders as system and stays stored", async ({ page }) => {
    for (const v of ["no-such-palette", "system"]) {
      await page.goto(BASE + "/");
      await page.evaluate((x) => localStorage.setItem("muninn-theme", x), v);
      await page.reload();
      expect(await attrs(page), v).toEqual({ theme: null, palette: null, stored: v });
      await expect(page.locator("#themeToggle")).toHaveText("◐");
      // An explicit pick of System is what clears it.
      await page.locator("#themeToggle").click();
      await page.getByRole("menuitemradio", { name: /System/ }).click();
      expect(await attrs(page), `${v} → System`).toEqual({ theme: null, palette: null, stored: null });
    }
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

  test("◐ → Light reading mode applies and persists it", async ({ page }) => {
    await storeChoice(page, null);
    await page.goto(BASE + "/");
    const btn = page.locator("#themeToggle");
    await btn.click();
    await page.getByRole("menuitemradio", { name: "Light reading mode", exact: true }).click();
    await expect(page.locator("#themeMenu")).toBeHidden();
    expect(await attrs(page)).toEqual({ theme: "light", palette: "paper-light", stored: "paper-light" });
    await expect(btn).toHaveText(PAPER_LIGHT.glyph);
    await page.reload();
    expect(await attrs(page)).toEqual({ theme: "light", palette: "paper-light", stored: "paper-light" });
    await btn.click();
    await expect(page.getByRole("menuitemradio", { name: "Light reading mode", exact: true })).toHaveAttribute("aria-checked", "true");
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

  // Fix round 1 batch 2 (PR #747, F4): dismissal.
  test("◐ and Tools ▾ close each other; each keeps its own toggle", async ({ page }) => {
    await storeChoice(page, null);
    await page.goto(BASE + "/");
    const btn = page.locator("#themeToggle");
    const menu = page.locator("#themeMenu");
    const tools = page.locator("details.nav-dropdown");
    const toolsOpen = () => tools.evaluate((d) => (d as HTMLDetailsElement).open);
    await tools.locator("summary").click();
    expect(await toolsOpen(), "Tools opens").toBe(true);
    await btn.click();
    await expect(menu).toBeVisible();
    expect(await toolsOpen(), "opening ◐ closes Tools").toBe(false);
    await tools.locator("summary").click();
    expect(await toolsOpen(), "Tools opens again").toBe(true);
    await expect(menu, "opening Tools closes ◐").toBeHidden();
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await tools.locator("summary").click();
    expect(await toolsOpen(), "Tools' own toggle closes it").toBe(false);
    await btn.click();
    await expect(menu).toBeVisible();
    await btn.click();
    await expect(menu, "◐'s own toggle closes it").toBeHidden();
  });

  test("Escape closes the menu wherever focus is and returns focus to ◐", async ({ page }) => {
    await storeChoice(page, null);
    await page.goto(BASE + "/");
    const btn = page.locator("#themeToggle");
    const menu = page.locator("#themeMenu");
    // A click in the menu's padding: nothing is picked, focus would drop to <body>.
    await btn.click();
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    await page.mouse.click(box.x + 3, box.y + 3);
    await expect(menu, "a padding click picks nothing and keeps the menu open").toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: /System/ }), "focus stays on the item").toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", { name: "Light", exact: true }), "arrows still move").toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu, "Escape after a padding click").toBeHidden();
    await expect(btn).toBeFocused();
    // Focus back on ◐ while the menu is open.
    await btn.click();
    await expect(menu).toBeVisible();
    await btn.focus();
    await page.keyboard.press("Escape");
    await expect(menu, "Escape with focus on ◐").toBeHidden();
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    expect((await attrs(page)).stored).toBeNull();
  });

  test("t with the menu open cycles and closes the menu, focus on ◐", async ({ page }) => {
    await storeChoice(page, null);
    await page.goto(BASE + "/");
    const btn = page.locator("#themeToggle");
    await btn.click();
    await expect(page.locator("#themeMenu")).toBeVisible();
    await page.keyboard.press("t");
    expect(await attrs(page)).toEqual({ theme: "light", palette: null, stored: "light" });
    await expect(page.locator("#themeMenu")).toBeHidden();
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await expect(btn).toBeFocused();
  });

  // Fix round 2 (PR #747): the open menu takes keys only from the picker or <body>.
  /** /summaries with the menu open and focus moved (not clicked) into #captureUrl, caret at 5. */
  async function menuOpenFieldFocused(page: Page) {
    await storeChoice(page, null);
    await page.goto(BASE + "/summaries");
    const btn = page.locator("#themeToggle");
    const menu = page.locator("#themeMenu");
    const input = page.locator("#captureUrl");
    await btn.click();
    await expect(menu).toBeVisible();
    await input.evaluate((el) => {
      const i = el as HTMLInputElement;
      i.value = "hello world";
      i.focus();
      i.setSelectionRange(5, 5);
      (window as unknown as { __inputEsc: number }).__inputEsc = 0;
      i.addEventListener("keydown", (e) => {
        if (e.key === "Escape") (window as unknown as { __inputEsc: number }).__inputEsc++;
      });
    });
    return { btn, menu, input };
  }

  test("with the menu open, End in a text field moves the caret, not focus", async ({ page }) => {
    const { menu, input } = await menuOpenFieldFocused(page);
    await page.keyboard.press("End");
    await expect(input, "End keeps focus in the field").toBeFocused();
    expect(await input.evaluate((el) => (el as HTMLInputElement).selectionStart), "End moves the caret").toBe(11);
    await expect(menu, "the menu stays open").toBeVisible();
  });

  test("with the menu open, Escape in a text field closes the menu and leaves focus in the field", async ({ page }) => {
    const { btn, menu, input } = await menuOpenFieldFocused(page);
    await page.keyboard.press("Escape");
    await expect(menu, "Escape closes the menu").toBeHidden();
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await expect(input, "Escape leaves focus in the field").toBeFocused();
    expect(await page.evaluate(() => (window as unknown as { __inputEsc: number }).__inputEsc), "the field sees its Escape").toBe(1);
  });

  test("with the menu open, arrows on a control outside the picker stay on it", async ({ page }) => {
    await storeChoice(page, null);
    await page.goto(BASE + "/agents");
    const pill = page.locator('button.bot-pill[data-bot=""]');
    await expect(pill).toBeVisible();
    await page.locator("#themeToggle").click();
    await expect(page.locator("#themeMenu")).toBeVisible();
    await pill.focus();
    for (const k of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      await page.keyboard.press(k);
      await expect(pill, k).toBeFocused();
    }
  });

  test("Tab from ◐ enters the menu; Shift+Tab from ◐ or Tab from an item leaves it and closes it", async ({ page }) => {
    await storeChoice(page, null);
    await page.goto(BASE + "/");
    const btn = page.locator("#themeToggle");
    const menu = page.locator("#themeMenu");
    const inPicker = () => page.evaluate(() => document.getElementById("themePicker")!.contains(document.activeElement));
    await btn.click();
    await btn.focus();
    await page.keyboard.press("Tab");
    await expect(menu, "Tab from ◐ keeps the menu open").toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: /System/ })).toBeFocused();
    await btn.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(menu, "Shift+Tab from ◐ closes the menu").toBeHidden();
    expect(await inPicker(), "focus left the picker").toBe(false);
    await btn.click();
    await expect(page.getByRole("menuitemradio", { name: /System/ })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(menu, "Tab from an item closes the menu").toBeHidden();
  });

  test("Escape in the picker or on <body> closes the menu, refocuses ◐ and reaches no page handler", async ({ page }) => {
    await storeChoice(page, null);
    await page.goto(BASE + "/");
    const btn = page.locator("#themeToggle");
    const menu = page.locator("#themeMenu");
    await page.evaluate(() => {
      (window as unknown as { __docEsc: number }).__docEsc = 0;
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") (window as unknown as { __docEsc: number }).__docEsc++;
      });
    });
    const docEsc = () => page.evaluate(() => (window as unknown as { __docEsc: number }).__docEsc);
    // Focus on an item.
    await btn.click();
    await expect(page.getByRole("menuitemradio", { name: /System/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(btn).toBeFocused();
    expect(await docEsc(), "an item's Escape stops at the menu").toBe(0);
    // Focus on <body> (guard: round 1 fixed this case and nothing tested it).
    await btn.click();
    await expect(menu).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", { name: /System/ }), "ArrowDown from <body> enters the menu").toBeFocused();
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.keyboard.press("Escape");
    await expect(menu, "Escape from <body>").toBeHidden();
    await expect(btn, "focus back on ◐").toBeFocused();
    expect(await docEsc(), "a <body> Escape stops at the menu").toBe(0);
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
  // mermaid's `default` theme fills nodes #ECECFF; `dark` fills #1f2020.
  const MERMAID_FILL = { light: "rgb(236, 236, 255)", dark: "rgb(31, 32, 32)" } as const;
  for (const p of PALETTES) {
    test(`mermaid renders its ${p.base} theme under ${p.id}`, async ({ page }) => {
      // The OS asks for the other scheme, so only the palette's base can draw this theme.
      await page.emulateMedia({ colorScheme: p.base === "light" ? "dark" : "light" });
      await storeChoice(page, p.id);
      await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=diagram-page`);
      const node = page.locator("#articleWrap svg .node rect, #articleWrap svg .node polygon").first();
      await expect(node).toBeVisible({ timeout: 20_000 });
      expect(await node.evaluate((el) => getComputedStyle(el).fill)).toBe(MERMAID_FILL[p.base]);
    });
  }
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

  // Fix round 2 (PR #747): two chat hovers named an undefined token and drew
  // the inherited colour on the accent. Main's colour (measured on 714ff8a1) is that inherited value.
  const CHAT_HOVERS = [
    { sel: "#hoverProbe .research-actions button", main: { light: "rgb(58, 61, 71)", dark: "rgb(224, 224, 224)" } },
    { sel: "#hoverProbe .dev-run-resend", main: { light: "rgb(58, 61, 71)", dark: "rgb(224, 224, 224)" } },
  ];
  const HOVER_PROBE =
    '<div id="hoverProbe" style="position:fixed;top:40px;left:40px;z-index:99999;display:flex;gap:16px">' +
    '<div class="research-actions"><button type="button">Research</button></div><button type="button" class="dev-run-resend">Resend</button></div>';
  for (const h of CHAT_HOVERS) {
    test(`/chat ${h.sel.replace("#hoverProbe ", "")}:hover: the bases keep main's ink, a palette reaches 4.5:1`, async ({ page }) => {
      await storeChoice(page, null);
      await page.goto(BASE + "/chat");
      await page.evaluate((p) => document.body.insertAdjacentHTML("beforeend", p), HOVER_PROBE);
      const loc = page.locator(h.sel);
      for (const t of BASES) {
        await forceTheme(page, t);
        await loc.hover();
        const got = await loc.evaluate((el) => ({ c: getComputedStyle(el).color, parent: getComputedStyle(el.parentElement!).color }));
        expect(got.c, `${t.name} :hover ink`).toBe(h.main[t.theme]);
        expect(got.c, `${t.name} :hover ink is inherited`).toBe(got.parent);
        await page.mouse.move(0, 0);
      }
      for (const t of PALETTE_THEMES) {
        await forceTheme(page, t);
        await loc.hover();
        expect(await paintedContrast(loc, { withOpacity: true }), `${t.name} :hover`).toBeGreaterThanOrEqual(4.5);
        await page.mouse.move(0, 0);
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

test.describe("The theme lab", () => {
  /** Set a lab slider the way a drag does: a new value, then an input event. */
  async function slide(page: Page, key: string, value: number): Promise<void> {
    await page.locator(`#themeLab input[data-key="${key}"]`).evaluate((el, v) => {
      (el as HTMLInputElement).value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  }
  const pageBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const inline = (page: Page) => page.evaluate(() => document.documentElement.getAttribute("style") ?? "");

  test("opens from ◐, tints the real page, survives a reload, follows a theme switch and closes clean", async ({ page }) => {
    await storeChoice(page, "reading");
    await page.goto(BASE + `/wiki?wiki=${WIKI}`);
    const shipped = await pageBg(page);
    expect(shipped).toBe(hexToRgb(READING.tokens["--bg-page"]!));
    // Closed, a page carries only the stub: the lab script is not loaded.
    await expect(page.locator('script[src="/theme-lab.js"]')).toHaveCount(0);

    await page.locator("#themeToggle").click();
    await page.getByRole("menuitem", { name: /Theme lab/ }).click();
    await expect(page.locator("#themeMenu")).toBeHidden();
    const lab = page.locator("#themeLab");
    await expect(lab).toBeVisible();
    await expect(lab.locator(".theme-lab-title")).toContainText("Reading mode");
    // Opening changes nothing: the sliders start at the theme as shipped.
    expect(await pageBg(page)).toBe(shipped);

    // Rune's 2026-10-27 ask: Reading mode at background lightness 5, saturation 12.
    await slide(page, "bgL", 5);
    await slide(page, "bgS", 12);
    const tinted = await pageBg(page);
    expect(tinted).not.toBe(shipped);
    const [r, g, b] = tinted.match(/\d+/g)!.map(Number);
    expect(Math.max(r!, g!, b!), "page lightness ~5 %").toBeLessThan(20);
    await expect(lab.locator("#themeLabMeters")).toContainText("Ladder order");
    await expect(lab.locator("#themeLabMeters b.bad")).toHaveCount(0);

    // Open and slid, it comes back on the next page.
    await page.goto(BASE + "/");
    await expect(page.locator("#themeLab")).toBeVisible();
    expect(await pageBg(page)).toBe(tinted);
    await expect(page.locator('#themeLab input[data-key="bgL"]')).toHaveValue("5");

    // Another theme from ◐: the lab starts over from that theme's own values.
    await page.locator("#themeToggle").click();
    await page.getByRole("menuitemradio", { name: /^.?Dark$/ }).click();
    await expect(page.locator("#themeLab .theme-lab-title")).toContainText("Dark");
    // Plain dark's page is #0a0a0f; the lab's HSL round trip may move a channel by 1–2.
    const dark = (await pageBg(page)).match(/\d+/g)!.map(Number);
    [10, 10, 15].forEach((v, i) => expect(Math.abs(dark[i]! - v), `channel ${i}`).toBeLessThanOrEqual(2));

    // × removes every override; the saved sliders wait for the next open.
    await page.locator('#themeLab [data-lab="close"]').click();
    await expect(page.locator("#themeLab")).toHaveCount(0);
    expect(await inline(page)).toBe("");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("muninn-theme-lab") ?? "{}"));
    expect(saved.open).toBe(false);
    expect(saved.states.reading.bgL).toBe(5);
  });

  // Fix round 1 (PR #755, F5): opening from the keyboard left focus on <body>,
  // and every re-render (minimize, reset) dropped focus out of the panel.
  test("opened from the keyboard, focus lands in the lab and survives its re-renders", async ({ page }) => {
    await storeChoice(page, "reading");
    await page.goto(BASE + "/");
    await page.locator("#themeToggle").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await expect(page.getByRole("menuitem", { name: /Theme lab/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator('#themeLab input[data-key="bgL"]')).toBeFocused();
    await page.locator('#themeLab [data-lab="reset"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('#themeLab [data-lab="reset"]')).toBeFocused();
    await page.locator('#themeLab [data-lab="min"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('#themeLab [data-lab="min"]')).toBeFocused();
    await page.keyboard.press("Enter");
    // Fix round 2 (PR #755): closing with × from the keyboard left focus on <body>.
    await page.locator('#themeLab [data-lab="close"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#themeLab")).toHaveCount(0);
    await expect(page.locator("#themeToggle")).toBeFocused();
  });

  // Fix round 2 (PR #755): pins the two open-focus branches. A page load that
  // re-opens the lab never takes focus; opened minimized, focus goes to ▴.
  test("a page load never moves focus into the lab; opened minimized, focus goes to ▴", async ({ page }) => {
    await storeChoice(page, "reading");
    await page.goto(BASE + "/");
    await page.locator("#themeToggle").click();
    await page.getByRole("menuitem", { name: /Theme lab/ }).click();
    await page.locator('#themeLab [data-lab="min"]').click();
    await page.reload();
    await expect(page.locator("#themeLab")).toBeVisible();
    expect(await page.evaluate(() => document.activeElement === document.body), "focus stays on the page").toBe(true);
    await page.locator("#themeToggle").click();
    await page.getByRole("menuitem", { name: /Theme lab/ }).click();
    await expect(page.locator('#themeLab [data-lab="min"]')).toBeFocused();
    await page.locator('#themeLab [data-lab="min"]').click();
    await page.locator('#themeLab [data-lab="close"]').click();
  });

  // Fix round 1 (PR #755, F3): under System an OS scheme flip kept the other
  // scheme's overrides, and one saved state served both schemes.
  test("under System, an OS scheme flip starts over from that scheme and keeps each scheme's sliders", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await storeChoice(page, null);
    await page.goto(BASE + "/");
    await page.locator("#themeToggle").click();
    await page.getByRole("menuitem", { name: /Theme lab/ }).click();
    await expect(page.locator("#themeLab .theme-lab-title")).toContainText("System (light)");
    await slide(page, "bgL", 90);
    const lightTinted = await pageBg(page);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("#themeLab .theme-lab-title")).toContainText("System (dark)");
    const dark = (await pageBg(page)).match(/\d+/g)!.map(Number);
    [10, 10, 15].forEach((v, i) => expect(Math.abs(dark[i]! - v), `dark page channel ${i}`).toBeLessThanOrEqual(2));

    await page.reload();
    expect((await pageBg(page)).match(/\d+/g)!.map(Number)[0]!, "a dark load keeps the dark state").toBeLessThan(20);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => pageBg(page)).toBe(lightTinted);
    await page.locator('#themeLab [data-lab="close"]').click();
  });

  // Rebuild review (PR #755): left open, a page load painted the shipped theme
  // until /theme-lab.js arrived, and a failed load dropped the click silently.
  test("left open, a page keeps the slid colours before the lab loads; a failed load says so", async ({ page }) => {
    await storeChoice(page, "reading");
    await page.goto(BASE + "/");
    await page.locator("#themeToggle").click();
    await page.getByRole("menuitem", { name: /Theme lab/ }).click();
    await slide(page, "bgL", 5);
    const tinted = await pageBg(page);
    await page.route("**/theme-lab.js", (r) => r.abort());
    await page.goto(BASE + "/");
    expect(await pageBg(page), "the stub applied the saved overrides").toBe(tinted);
    await expect(page.locator(".theme-lab-toast")).toContainText("did not load");
    await page.unroute("**/theme-lab.js");
    await page.locator("#themeToggle").click();
    await page.getByRole("menuitem", { name: /Theme lab/ }).click();
    await expect(page.locator("#themeLab")).toBeVisible();
    await page.locator('#themeLab [data-lab="close"]').click();
    expect(await inline(page)).toBe("");
  });

  test("Copy tokens puts a palettes.ts tokens block with the slid values on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await storeChoice(page, "reading");
    await page.goto(BASE + "/");
    await page.locator("#themeToggle").click();
    await page.getByRole("menuitem", { name: /Theme lab/ }).click();
    await slide(page, "bgL", 5);
    const bg = await page.evaluate(() => document.documentElement.style.getPropertyValue("--bg-page"));
    await page.locator('#themeLab [data-lab="copy"]').click();
    await expect(page.locator("#themeLabStatus")).toContainText("Copied");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toMatch(/^ {4}tokens: \{\n {6}\/\/ Theme lab .*page L5 /);
    expect(text).toContain(`"--bg-page": "${bg}",`);
    // Every key Reading mode sets is in the block, in the same order.
    const keys = [...text.matchAll(/^\s+"(--[a-z0-9-]+)":/gm)].map((m) => m[1]);
    expect(keys.slice(0, Object.keys(READING.tokens).length)).toEqual(Object.keys(READING.tokens));
    await page.locator('#themeLab [data-lab="close"]').click();
  });
});
