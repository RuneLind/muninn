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
