import { describe, expect, test } from "bun:test";
import { CHAT_PALETTE_TOKENS, PALETTES, PALETTE_REQUIRED_TOKENS, paletteBaseMap, paletteTokenStyles } from "./palettes.ts";
import { THEME_KEY, themeChoices, themeInitScript, themeToggleHtml } from "./theme.ts";
import { baseTokenNames, SHARED_STYLES, themeTokenStyles } from "../shared-styles.ts";
import { chatStyles } from "../../../chat/views/components/chat-styles.ts";

/** Run the real init script against a stub localStorage and <html>. */
function runInit(stored: Record<string, string>): { dataset: Record<string, string>; storage: Record<string, string> } {
  const storage = { ...stored };
  const dataset: Record<string, string> = { theme: "stale", palette: "stale" };
  const localStorage = {
    getItem: (k: string) => (k in storage ? storage[k]! : null),
    setItem: (k: string, v: string) => { storage[k] = v; },
    removeItem: (k: string) => { delete storage[k]; },
  };
  const document = { documentElement: { dataset } };
  new Function("localStorage", "document", themeInitScript())(localStorage, document);
  return { dataset, storage };
}

describe("palette registry", () => {
  const chatNames = [...chatStyles().matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!);
  const known = new Set([...baseTokenNames(), ...chatNames]);

  test("ids are unique and never collide with a base or system", () => {
    const ids = PALETTES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(["system", "light", "dark"]).not.toContain(id);
  });

  for (const p of PALETTES) {
    test(`${p.id}: a valid base, the full required token set, only known tokens`, () => {
      expect(["light", "dark"]).toContain(p.base);
      expect(p.label.length).toBeGreaterThan(0);
      expect(PALETTE_REQUIRED_TOKENS.filter((t) => !(t in p.tokens))).toEqual([]);
      expect(Object.keys(p.tokens).filter((t) => !known.has(t))).toEqual([]);
      for (const v of Object.values(p.tokens)) expect(v.trim().length).toBeGreaterThan(0);
    });
  }

  test("every required token is one the bases or the chat page declare", () => {
    expect(PALETTE_REQUIRED_TOKENS.filter((t) => !known.has(t))).toEqual([]);
    expect(CHAT_PALETTE_TOKENS.every((t) => PALETTE_REQUIRED_TOKENS.includes(t))).toBe(true);
  });

  test("the palette CSS comes after the base blocks, at the same specificity", () => {
    const base = SHARED_STYLES.indexOf('html[data-theme="light"] {');
    for (const p of PALETTES) {
      const at = SHARED_STYLES.indexOf(`html[data-palette="${p.id}"] {`);
      expect(at).toBeGreaterThan(base);
    }
    const chat = chatStyles();
    for (const p of PALETTES) {
      expect(chat.indexOf(`html[data-palette="${p.id}"] {`)).toBeGreaterThan(chat.indexOf('html[data-theme="light"] {'));
    }
  });

  test("the summary export's token styles stay on the two bases", () => {
    expect(themeTokenStyles()).not.toContain("data-palette");
  });

  test("paletteTokenStyles(only) narrows the emitted tokens", () => {
    const css = paletteTokenStyles(CHAT_PALETTE_TOKENS);
    expect(css).toContain("--bg-chat:");
    expect(css).not.toContain("--bg-page:");
  });
});

describe("theme init script", () => {
  test("its id → base map equals the registry", () => {
    const m = themeInitScript().match(/var BASES = (\{[^;]*\});/);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]!)).toEqual({ light: "light", dark: "dark", ...paletteBaseMap() });
  });

  test("system (absent) sets neither attribute", () => {
    expect(runInit({}).dataset).toEqual({});
  });

  test("light and dark set the base only", () => {
    expect(runInit({ [THEME_KEY]: "light" }).dataset).toEqual({ theme: "light" });
    expect(runInit({ [THEME_KEY]: "dark" }).dataset).toEqual({ theme: "dark" });
  });

  for (const p of PALETTES) {
    test(`${p.id} sets its base AND data-palette`, () => {
      expect(runInit({ [THEME_KEY]: p.id }).dataset).toEqual({ theme: p.base, palette: p.id });
    });
  }

  test("an unknown stored value behaves like system", () => {
    expect(runInit({ [THEME_KEY]: "sepia-9000" }).dataset).toEqual({});
    expect(runInit({ [THEME_KEY]: "toString" }).dataset).toEqual({});
  });

  test("the legacy chat key still migrates", () => {
    const r = runInit({ "muninn-chat-theme": "light" });
    expect(r.dataset).toEqual({ theme: "light" });
    expect(r.storage).toEqual({ [THEME_KEY]: "light" });
  });
});

describe("theme picker", () => {
  test("lists System, Light, Dark, then every palette, in cycle order", () => {
    expect(themeChoices().map((c) => c.id)).toEqual(["system", "light", "dark", ...PALETTES.map((p) => p.id)]);
    const html = themeToggleHtml();
    const order = [...html.matchAll(/data-theme-choice="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(themeChoices().map((c) => c.id));
    expect(html).toContain('aria-haspopup="menu"');
  });
});
