import { describe, expect, test } from "bun:test";
import { PALETTES, PALETTE_REQUIRED_TOKENS } from "./palettes.ts";
import { renderNav, themeTokenStyles } from "../shared-styles.ts";
import { THEME_LAB_KEY, THEME_LAB_PATH, themeLabScript, themeLabStubScript } from "./theme-lab.ts";
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

  test("Reading mode at page lightness 11, saturation 12 moves the whole ladder and keeps its order", () => {
    const ref = themeRef("reading");
    const st = { ...labInitialState(ref), bgL: 11, bgS: 12 };
    const out = labDerive(ref, st);
    const page = labHsl(out["--bg-page"]!)!;
    expect(page[2]).toBeCloseTo(11, 0);
    expect(page[1]).toBeGreaterThan(10);
    // Every field and surface moves by the page's own delta.
    const delta = 11 - labHsl(ref["--bg-page"]!)![2];
    for (const name of ["--bg-panel", "--bg-card", "--bg-inset", "--border-primary"]) {
      expect(labHsl(out[name]!)![2], name).toBeCloseTo(labHsl(ref[name]!)![2] + delta, 0);
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

  // Fix round 1 (PR #755, F4): light's edge is `transparent`, which did not parse, so the slider did nothing.
  test("on light, the Edge slider draws a black edge from transparent", () => {
    const ref = themeRef("light");
    expect(ref["--code-inline-border"]).toBe("transparent");
    expect(labInitialState(ref).chipEdge).toBe(0);
    expect(labDerive(ref, { ...labInitialState(ref), chipEdge: 20 })["--code-inline-border"]).toBe("rgba(0, 0, 0, 0.2)");
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
  // Fix round 2 (PR #755): string comparison flagged #fff vs #ffffff and
  // transparent vs rgba(0, 0, 0, 0) as moved before any slider did.
  for (const id of ["dark", "light", ...PALETTES.map((p) => p.id)]) {
    test(`${id}: at the initial sliders, nothing counts as changed`, () => {
      const ref = themeRef(id);
      expect(labChangedKeys(ref, labDerive(ref, labInitialState(ref)))).toEqual([]);
    });
  }

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

  test("loaded, the lab sets nothing until it is opened", () => {
    const set: string[] = [];
    const window: Record<string, unknown> = {};
    const document = { documentElement: { dataset: {}, style: { setProperty: (n: string) => set.push(n), removeProperty: () => {} } }, body: {} };
    const localStorage = { getItem: () => JSON.stringify({ open: true }), setItem: () => {} };
    class MutationObserver { observe() {} }
    new Function("window", "document", "localStorage", "MutationObserver", themeLabScript())(window, document, localStorage, MutationObserver);
    expect(set).toEqual([]);
    expect(typeof window.__themeLabOpenNow).toBe("function");
  });
});

/** Run the per-page stub against stub storage; returns the scripts it added. */
interface StubEl { src: string; style?: object; textContent?: string; onload?: () => void; onerror?: () => void; removed?: boolean; remove(): void; setAttribute?(): void }

/** Run the per-page stub against stub storage and <html>; returns the scripts and toasts it added. */
function runStub(stored: string | null, dataset: Record<string, string> = {}) {
  const added: StubEl[] = [], toasts: StubEl[] = [], props: Record<string, string> = {};
  const window: Record<string, unknown> = { matchMedia: () => ({ matches: true }), setTimeout: () => 0 };
  const el = (): StubEl => ({ src: "", style: {}, remove() { this.removed = true; }, setAttribute() {} });
  const document = {
    documentElement: { dataset, style: { setProperty: (n: string, v: string) => { props[n] = v; } } },
    createElement: el,
    head: { appendChild: (e: StubEl) => added.push(e) },
    body: { appendChild: (e: StubEl) => toasts.push(e) },
  };
  const localStorage = { getItem: () => stored };
  new Function("window", "document", "localStorage", "setTimeout", themeLabStubScript())(window, document, localStorage, () => 0);
  return { added, toasts, props, window };
}

describe("theme lab stub (every page)", () => {
  // Fix after CI (PR #755): the whole lab was inline on every page, clipboard
  // code included, which jira-page.test.ts forbids on pages that copy nothing.
  test("carries no lab code: no clipboard, a fraction of the lab's size", () => {
    expect(themeLabStubScript()).not.toContain("clipboard");
    expect(themeLabStubScript().length).toBeLessThan(themeLabScript().length / 10);
  });

  test("a closed or never-used lab loads nothing", () => {
    expect(runStub(null).added).toEqual([]);
    expect(runStub(JSON.stringify({ open: false })).added).toEqual([]);
    expect(runStub("not json").added).toEqual([]);
  });

  test("a lab left open loads the lab script once; opening it again while loading queues", () => {
    const { added, window } = runStub(JSON.stringify({ open: true }));
    expect(added.map((s) => s.src)).toEqual([THEME_LAB_PATH]);
    (window.__themeLabOpen as (f: boolean) => void)(true);
    expect(added).toHaveLength(1);
  });

  // Rebuild review (PR #755): the stub's load and failure paths were unpinned.
  test("on load, the queued opens run in order with their own focus", () => {
    const { added, window } = runStub(JSON.stringify({ open: true }));
    (window.__themeLabOpen as (f: boolean) => void)(true);
    const calls: boolean[] = [];
    window.__themeLabOpenNow = (f: boolean) => calls.push(f);
    added[0]!.onload!();
    expect(calls).toEqual([false, true]);
  });

  test("a failed load says so, and the next open tries again", () => {
    const { added, toasts, window } = runStub(null);
    (window.__themeLabOpen as (f: boolean) => void)(true);
    added[0]!.onerror!();
    expect(added[0]!.removed).toBe(true);
    expect(toasts.map((t) => t.textContent)).toEqual([expect.stringContaining("did not load")]);
    (window.__themeLabOpen as (f: boolean) => void)(true);
    expect(added).toHaveLength(2);
  });

  test("a response that is not the lab (a login page) also says so", () => {
    const { added, toasts, window } = runStub(null);
    (window.__themeLabOpen as (f: boolean) => void)(true);
    added[0]!.onload!();
    expect(toasts).toHaveLength(1);
  });

  // Rebuild review (PR #755): a page load showed the shipped theme until /theme-lab.js arrived.
  test("left open, the stub applies the saved overrides before the lab loads, for the same theme only", () => {
    const applied = { key: "reading", tokens: { "--bg-page": "#0d0c0b" } };
    expect(runStub(JSON.stringify({ open: true, applied }), { palette: "reading", theme: "dark" }).props).toEqual({ "--bg-page": "#0d0c0b" });
    expect(runStub(JSON.stringify({ open: true, applied }), { theme: "dark" }).props).toEqual({});
    expect(runStub(JSON.stringify({ open: false, applied }), { palette: "reading", theme: "dark" }).props).toEqual({});
    const sys = { key: "system:dark", tokens: { "--bg-page": "#000000" } };
    expect(runStub(JSON.stringify({ open: true, applied: sys })).props).toEqual({ "--bg-page": "#000000" });
  });

  // Fix round 2 (PR #755): the stub ran at the end of <header>, so a paint
  // between the header and the stub still showed the shipped theme.
  test("runs before the header, right after the theme init script", () => {
    const nav = renderNav("dashboard", { profile: "default" });
    const stub = nav.indexOf("__themeLabStub");
    expect(stub).toBeGreaterThan(-1);
    expect(stub).toBeLessThan(nav.indexOf("<header"));
  });

  test("the ◐ menu's open loads the lab script", () => {
    const { added, window } = runStub(null);
    (window.__themeLabOpen as (f: boolean) => void)(true);
    expect(added.map((s) => s.src)).toEqual([THEME_LAB_PATH]);
  });
});
