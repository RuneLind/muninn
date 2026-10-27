import { describe, expect, test } from "bun:test";
import { PALETTES, PALETTE_REQUIRED_TOKENS } from "./palettes.ts";
import { themeTokenStyles } from "../shared-styles.ts";
import { THEME_LAB_KEY, themeLabScript } from "./theme-lab.ts";
import { labChangedKeys, labDerive, labExport, labHsl, labInitialState, labLadderIssues, labParse, labStateKey } from "./theme-lab-core.ts";

/** A base's token block, parsed (the palettes.test.ts helper). */
function baseTokens(base: "light" | "dark"): Record<string, string> {
  const css = themeTokenStyles();
  const start = css.indexOf(`html[data-theme="${base}"] {`);
  const block = css.slice(start, css.indexOf("}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

/** The tokens the lab reads for a theme: its base under its palette. */
function themeRef(id: string): Record<string, string> {
  const p = PALETTES.find((x) => x.id === id);
  if (!p) return baseTokens(id as "light" | "dark");
  return { ...baseTokens(p.base), ...p.tokens };
}

/** Max per-channel difference between two colours, 0–255. */
function channelDiff(a: string, b: string): number {
  const x = labParse(a)!, y = labParse(b)!;
  return Math.max(...[0, 1, 2].map((i) => Math.abs(x[i]! - y[i]!)));
}

describe("theme lab derivation", () => {
  for (const id of ["dark", "light", ...PALETTES.map((p) => p.id)]) {
    test(`${id}: the initial sliders reproduce the theme`, () => {
      const ref = themeRef(id);
      const out = labDerive(ref, labInitialState(ref));
      for (const [name, value] of Object.entries(out)) {
        if (labParse(value) && labParse(ref[name]!)) {
          // The HSL round trip and the 0.1 slider rounding move a channel by at most 2.
          expect(channelDiff(value, ref[name]!), `${name} ${value} vs ${ref[name]}`).toBeLessThanOrEqual(2);
        }
      }
      expect(labLadderIssues(ref, { ...ref, ...out })).toEqual([]);
    });
  }

  test("Reading mode at page lightness 5, saturation 12 moves the whole ladder and keeps its order", () => {
    const ref = themeRef("reading");
    const st = { ...labInitialState(ref), bgL: 5, bgS: 12 };
    const out = labDerive(ref, st);
    const page = labHsl(out["--bg-page"]!)!;
    expect(page[2]).toBeCloseTo(5, 0);
    expect(page[1]).toBeGreaterThan(10);
    // Every field and surface moves down by the page's own delta (11 → 5).
    for (const name of ["--bg-panel", "--bg-card", "--bg-inset", "--border-primary"]) {
      expect(labHsl(out[name]!)![2], name).toBeCloseTo(labHsl(ref[name]!)![2] - 6, 0);
    }
    expect(labLadderIssues(ref, { ...ref, ...out })).toEqual([]);
    // Text and accent are untouched by the background sliders.
    expect(channelDiff(out["--text-secondary"]!, ref["--text-secondary"]!)).toBeLessThanOrEqual(2);
    expect(out["--accent"]).toBeUndefined();
  });

  test("the chip sits at its own offset from the page, with its edge at the slider's alpha", () => {
    const ref = themeRef("reading");
    const out = labDerive(ref, { ...labInitialState(ref), bgL: 8, chipLift: 10, chipEdge: 25 });
    expect(labHsl(out["--bg-code-inline"]!)![2]).toBeCloseTo(18, 0);
    expect(out["--code-inline-border"]).toBe("rgba(255, 255, 255, 0.25)");
  });

  test("the graph canvas follows the page only where it is the page", () => {
    const paper = themeRef("paper-light");
    expect(labDerive(paper, { ...labInitialState(paper), bgL: 90 })["--graph-canvas"]).toBeUndefined();
    const reading = themeRef("reading");
    const out = labDerive(reading, { ...labInitialState(reading), bgL: 5 });
    expect(out["--graph-canvas"]).toBe(out["--bg-page"]!);
  });

  // Fix round 1 (PR #755, F1): a grey token has hue 0, so added saturation tinted it red.
  test("saturation added to grey tokens takes the page's hue, not red", () => {
    const ref = themeRef("dark");
    const init = labInitialState(ref);
    const out = labDerive(ref, { ...init, textS: 20, bgS: init.bgS + 20 });
    const pageHue = labHsl(ref["--bg-page"]!)![0];
    for (const name of ["--text-secondary", "--text-tertiary", "--tint-neutral", "--bg-panel"]) {
      const c = labHsl(out[name]!)!;
      expect(c[1], `${name} ${out[name]} is tinted`).toBeGreaterThan(5);
      expect(Math.abs(c[0] - pageHue), `${name} ${out[name]} hue ${c[0].toFixed(0)} vs page ${pageHue.toFixed(0)}`).toBeLessThan(10);
    }
  });

  test("a ladder pair the overrides turn around is reported", () => {
    const ref = themeRef("reading");
    expect(labLadderIssues(ref, { ...ref, "--bg-inset": "#ffffff" })).toContain("bg-inset ≥ bg-panel");
  });
});

describe("theme lab export", () => {
  // Fix round 1 (PR #755, F2): the block carried every watched token, e.g. the
  // base's --status-* on Reading, freezing base values a palette need not set.
  for (const p of PALETTES) {
    test(`${p.id}: the block holds the palette's keys, the required ones and what the lab changed, nothing else`, () => {
      const ref = themeRef(p.id);
      const st = { ...labInitialState(ref), bgL: labInitialState(ref).bgL + (p.base === "dark" ? -4 : -3) };
      const derived = labDerive(ref, st);
      const changed = labChangedKeys(ref, derived);
      const out = labExport({ ...ref, ...derived }, Object.keys(p.tokens), PALETTE_REQUIRED_TOKENS, changed, "x");
      const keys = [...out.matchAll(/^\s+"(--[a-z0-9-]+)":/gm)].map((m) => m[1]!);
      const allowed = new Set([...Object.keys(p.tokens), ...PALETTE_REQUIRED_TOKENS, ...changed]);
      expect(keys.filter((k) => !allowed.has(k))).toEqual([]);
      expect(keys.some((k) => k.startsWith("--status-")) && !Object.keys(p.tokens).some((k) => k.startsWith("--status-"))).toBe(false);
      expect(changed).toContain("--bg-page");
    });
  }

  test("keeps the palette's key order, adds missing required tokens, lists empty ones", () => {
    const reading = PALETTES.find((p) => p.id === "reading")!;
    const tokens = { ...themeRef("reading"), "--bg-page": "#0d0c0b", "--on-accent-inherit": "" };
    const out = labExport(tokens, Object.keys(reading.tokens), PALETTE_REQUIRED_TOKENS, [], "Theme lab test");
    expect(out.startsWith("    tokens: {\n      // Theme lab test\n")).toBe(true);
    expect(out).toContain('"--bg-page": "#0d0c0b",');
    const keys = [...out.matchAll(/^\s+"(--[a-z0-9-]+)":/gm)].map((m) => m[1]);
    expect(keys.slice(0, 3)).toEqual(Object.keys(reading.tokens).slice(0, 3));
    expect(out).toContain("set by hand: --on-accent-inherit");
    for (const t of PALETTE_REQUIRED_TOKENS.filter((x) => x !== "--on-accent-inherit")) expect(keys, t).toContain(t);
  });

  test("an exported block is a valid palette tokens object", () => {
    const ref = themeRef("paper-light");
    const body = labExport({ ...ref, ...labDerive(ref, labInitialState(ref)) }, [], PALETTE_REQUIRED_TOKENS, [], "x");
    const parsed = new Function(`return {${body.trim().replace(/,$/, "")}}`)() as { tokens: Record<string, string> };
    expect(PALETTE_REQUIRED_TOKENS.filter((t) => !(t in parsed.tokens))).toEqual([]);
  });
});

describe("theme lab state key", () => {
  // Fix round 1 (PR #755, F3): System kept one absolute slider state for both OS schemes.
  test("System keeps one state per OS scheme; an explicit choice keeps one", () => {
    expect(labStateKey("system", true)).toBe("system:dark");
    expect(labStateKey("system", false)).toBe("system:light");
    expect(labStateKey("reading", true)).toBe("reading");
    expect(labStateKey("dark", false)).toBe("dark");
  });
});

describe("theme lab script", () => {
  test("compiles with every core function injected", () => {
    const src = themeLabScript();
    expect(() => new Function(src)).not.toThrow();
    for (const fn of ["labDerive", "labInitialState", "labExport", "labLadderIssues"]) expect(src).toContain(`var ${fn} = `);
  });

  test("a closed lab touches nothing on load", () => {
    const set: string[] = [];
    const storage: Record<string, string> = { [THEME_LAB_KEY]: JSON.stringify({ open: false }) };
    const window: Record<string, unknown> = {};
    const document = {
      documentElement: { dataset: {}, style: { setProperty: (n: string) => set.push(n), removeProperty: () => {} } },
      body: {},
    };
    const localStorage = { getItem: (k: string) => storage[k] ?? null, setItem: (k: string, v: string) => { storage[k] = v; } };
    class MutationObserver { observe() {} }
    new Function("window", "document", "localStorage", "MutationObserver", themeLabScript())(window, document, localStorage, MutationObserver);
    expect(set).toEqual([]);
    expect(typeof window.__themeLabOpen).toBe("function");
  });
});
