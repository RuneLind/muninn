import { describe, expect, test } from "bun:test";
import {
  FLIP_MAX_HEIGHT_PX,
  MERMAID_TEXT_MIN_PX,
  buildMermaidPalette,
  chooseLayout,
  dialogWidth,
  flipToTopDown,
  injectClassDefs,
  mix,
  needsFlipCandidate,
  parseCssColor,
  parseViewBox,
  renderedTextPx,
  rewriteSvgId,
  toHex,
  widenedWidth,
} from "./mermaid-theme.ts";

const LIGHT_TOKENS = {
  panel: "rgb(255, 255, 255)",
  text: "rgb(20, 21, 26)",
  soft: "rgb(90, 94, 104)",
  accent: "rgb(99, 87, 240)",
  border: "rgb(226, 228, 234)",
  inset: "rgb(236, 238, 243)",
  good: "rgb(22, 163, 74)",
  warn: "rgb(217, 119, 6)",
  bad: "rgb(220, 38, 38)",
};

describe("parseCssColor", () => {
  test("rgb(), rgba(), space syntax and percent channels", () => {
    expect(parseCssColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseCssColor("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseCssColor("rgb(10 20 30 / 25%)")).toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
    expect(parseCssColor("rgba(0, 0, 0, 0)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
  test("color(srgb …) as color-mix() computes, with and without alpha", () => {
    expect(parseCssColor("color(srgb 1 0.5 0)")).toEqual({ r: 255, g: 127.5, b: 0, a: 1 });
    expect(parseCssColor("color(srgb 0 0 1 / 0.4)")).toEqual({ r: 0, g: 0, b: 255, a: 0.4 });
  });
  test("hex, and null for what mermaid could not take", () => {
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("#14151a")).toEqual({ r: 20, g: 21, b: 26, a: 1 });
    expect(parseCssColor("")).toBeNull();
    expect(parseCssColor("oklch(0.5 0.1 200)")).toBeNull();
    expect(parseCssColor("var(--accent)")).toBeNull();
  });
});

test("mix is color-mix(in srgb) and toHex clamps", () => {
  const black = { r: 0, g: 0, b: 0, a: 1 };
  const white = { r: 255, g: 255, b: 255, a: 1 };
  expect(mix(black, white, 0.5)).toBe("#808080");
  expect(mix(black, white, 1)).toBe("#000000");
  expect(mix(black, white, 0)).toBe("#ffffff");
  expect(toHex({ r: 300, g: -4, b: 15.4, a: 1 })).toBe("#ff000f");
});

describe("buildMermaidPalette", () => {
  const base = { tokens: LIGHT_TOKENS, ground: "rgb(241, 242, 246)", fontFamily: "Inter, sans-serif", dark: false };

  test("every value handed to mermaid is a hex built from the tokens", () => {
    const p = buildMermaidPalette(base)!;
    const v = p.themeVariables;
    expect(v.darkMode).toBe(false);
    expect(v.fontFamily).toBe("Inter, sans-serif");
    expect(v.fontSize).toBe("14px");
    expect(v.background).toBe("#f1f2f6");
    expect(v.edgeLabelBackground).toBe("#f1f2f6");
    // accent 4.5% over panel; accent 60% over panel.
    expect(v.primaryColor).toBe(mix(parseCssColor(LIGHT_TOKENS.accent)!, parseCssColor(LIGHT_TOKENS.panel)!, 0.045));
    expect(v.primaryBorderColor).toBe(mix(parseCssColor(LIGHT_TOKENS.accent)!, parseCssColor(LIGHT_TOKENS.panel)!, 0.6));
    expect(v.primaryTextColor).toBe("#14151a");
    expect(v.noteBkgColor).toBe(mix(parseCssColor(LIGHT_TOKENS.warn)!, parseCssColor(LIGHT_TOKENS.panel)!, 0.14));
    for (const [k, val] of Object.entries(v)) {
      if (k === "darkMode" || k === "fontFamily" || k === "fontSize") continue;
      expect(val, k).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("the four classDefs: tone over panel, stroke = tone, muted dashed", () => {
    const p = buildMermaidPalette(base)!;
    expect(p.classDefs).toEqual([
      `classDef good fill:${mix(parseCssColor(LIGHT_TOKENS.good)!, parseCssColor(LIGHT_TOKENS.panel)!, 0.16)},stroke:#16a34a,color:#14151a,stroke-width:1.5px`,
      `classDef warn fill:${mix(parseCssColor(LIGHT_TOKENS.warn)!, parseCssColor(LIGHT_TOKENS.panel)!, 0.16)},stroke:#d97706,color:#14151a,stroke-width:1.5px`,
      `classDef bad fill:${mix(parseCssColor(LIGHT_TOKENS.bad)!, parseCssColor(LIGHT_TOKENS.panel)!, 0.14)},stroke:#dc2626,color:#14151a,stroke-width:1.5px`,
      "classDef muted fill:#eceef3,stroke:#e2e4ea,color:#5a5e68,stroke-dasharray:4 3",
    ]);
  });

  test("a transparent or missing box background falls back to the panel", () => {
    expect(buildMermaidPalette({ ...base, ground: "rgba(0, 0, 0, 0)" })!.themeVariables.background).toBe("#ffffff");
    expect(buildMermaidPalette({ ...base, ground: "" })!.themeVariables.background).toBe("#ffffff");
  });

  test("a missing or unparseable token gives null (the caller falls back)", () => {
    const { warn: _w, ...noWarn } = LIGHT_TOKENS;
    expect(buildMermaidPalette({ ...base, tokens: noWarn })).toBeNull();
    expect(buildMermaidPalette({ ...base, tokens: { ...LIGHT_TOKENS, accent: "" } })).toBeNull();
  });

  test("the key changes with any colour and stays for identical input", () => {
    const a = buildMermaidPalette(base)!;
    expect(buildMermaidPalette(base)!.key).toBe(a.key);
    expect(buildMermaidPalette({ ...base, tokens: { ...LIGHT_TOKENS, accent: "rgb(146, 84, 39)" } })!.key).not.toBe(a.key);
    expect(buildMermaidPalette({ ...base, dark: true })!.key).not.toBe(a.key);
  });
});

describe("injectClassDefs", () => {
  const defs = ["classDef good fill:#000", "classDef bad fill:#111"];
  test("right after a flowchart / graph header", () => {
    expect(injectClassDefs("flowchart LR\n  A --> B", defs)).toBe(
      "flowchart LR\n  classDef good fill:#000\n  classDef bad fill:#111\n  A --> B",
    );
    expect(injectClassDefs("graph TD;A-->B", defs).split("\n")[1]).toBe("  classDef good fill:#000");
  });
  test("skips leading %% comments / directives, blank lines and front matter", () => {
    const src = "%%{init: {}}%%\n%% note\n\ngraph TD\n  A --> B";
    expect(injectClassDefs(src, defs).split("\n").slice(3, 6)).toEqual(["graph TD", "  classDef good fill:#000", "  classDef bad fill:#111"]);
    const fm = "---\ntitle: x\n---\nflowchart TB\n  A";
    expect(injectClassDefs(fm, defs).split("\n")[4]).toBe("  classDef good fill:#000");
  });
  test("leaves any other diagram type alone", () => {
    for (const src of ["sequenceDiagram\n  A->>B: hi", "%% c\nstateDiagram-v2\n  [*] --> A", "pie\n  \"a\": 1", ""]) {
      expect(injectClassDefs(src, defs)).toBe(src);
    }
  });
  test("a page's own classDef of the same name stays after ours (it wins in mermaid)", () => {
    const out = injectClassDefs("graph TD\n  classDef good fill:#f00\n  A:::good", defs);
    expect(out.indexOf("classDef good fill:#000")).toBeLessThan(out.indexOf("classDef good fill:#f00"));
  });
});

describe("flipToTopDown", () => {
  test("LR and RL become TD; the rest of the header line is kept", () => {
    expect(flipToTopDown("flowchart LR\n  A --> B")).toBe("flowchart TD\n  A --> B");
    expect(flipToTopDown("%% c\ngraph RL;\n  A")).toBe("%% c\ngraph TD;\n  A");
  });
  test("anything else is null", () => {
    expect(flipToTopDown("flowchart TD\n  A")).toBeNull();
    expect(flipToTopDown("graph LRX\n  A")).toBeNull();
    expect(flipToTopDown("sequenceDiagram\n  A->>B: x")).toBeNull();
    expect(flipToTopDown("  A --> B\nflowchart LR")).toBeNull();
  });
});

test("parseViewBox reads width and height of the root svg", () => {
  expect(parseViewBox('<svg id="wm-1" width="100%" viewBox="-8 -8 1234.5 300" style="max-width: 1234.5px;">')).toEqual({ width: 1234.5, height: 300 });
  expect(parseViewBox('<svg viewBox="0,0,10,20">')).toEqual({ width: 10, height: 20 });
  expect(parseViewBox("<svg>")).toBeNull();
  expect(parseViewBox('<svg viewBox="0 0 0 20">')).toBeNull();
});

test("renderedTextPx shrinks with the column, never grows past the font", () => {
  expect(renderedTextPx(14, 700, 1400)).toBe(7);
  expect(renderedTextPx(14, 1400, 700)).toBe(14);
});

test("widenedWidth draws the text at exactly the floor", () => {
  expect(widenedWidth(1400, 14)).toBe(1100);
  expect(renderedTextPx(14, widenedWidth(1400, 14), 1400)).toBeCloseTo(MERMAID_TEXT_MIN_PX, 9);
});

describe("chooseLayout", () => {
  const original = { width: 1960, height: 200 }; // 700 px body → 5 px text
  test("fits: no flip, no widen", () => {
    expect(chooseLayout({ bodyWidth: 1960, fontPx: 14, original, flipped: { width: 400, height: 800 } })).toEqual({ flipped: false, widenTo: null });
  });
  test("too small, the top-down copy reads larger and stays short: flip, no widen", () => {
    expect(chooseLayout({ bodyWidth: 700, fontPx: 14, original, flipped: { width: 600, height: 800 } })).toEqual({ flipped: true, widenTo: null });
  });
  test("flipped but still under 11 px: flip and widen the top-down copy", () => {
    const flipped = { width: 1400, height: 500 }; // 7 px > 5 px, 250 px tall
    expect(chooseLayout({ bodyWidth: 700, fontPx: 14, original, flipped })).toEqual({ flipped: true, widenTo: 1100 });
  });
  test("the top-down copy too tall: keep LR and widen it", () => {
    const flipped = { width: 600, height: FLIP_MAX_HEIGHT_PX + 1 };
    expect(chooseLayout({ bodyWidth: 700, fontPx: 14, original, flipped })).toEqual({ flipped: false, widenTo: 1540 });
  });
  test("the top-down copy no larger: keep LR and widen it", () => {
    expect(chooseLayout({ bodyWidth: 700, fontPx: 14, original, flipped: { width: 1960, height: 200 } })).toEqual({ flipped: false, widenTo: 1540 });
  });
  test("no top-down copy (not LR/RL): widen", () => {
    expect(chooseLayout({ bodyWidth: 700, fontPx: 14, original, flipped: null })).toEqual({ flipped: false, widenTo: 1540 });
  });
  test("decided from the original each time: wider again un-flips", () => {
    const flipped = { width: 600, height: 800 };
    expect(chooseLayout({ bodyWidth: 700, fontPx: 14, original, flipped }).flipped).toBe(true);
    expect(chooseLayout({ bodyWidth: 1600, fontPx: 14, original, flipped })).toEqual({ flipped: false, widenTo: null });
  });
  test("needsFlipCandidate is the same 11 px line", () => {
    expect(needsFlipCandidate(700, 14, original)).toBe(true);
    expect(needsFlipCandidate(1960, 14, original)).toBe(false);
  });
});

test("rewriteSvgId renames the root id, its style scope and marker refs, and only that id", () => {
  const svg =
    '<svg id="wm-1"><style>#wm-1 .node rect{fill:#fff}</style><marker id="wm-1_flowchart-v2-pointEnd"/>' +
    '<path marker-end="url(#wm-1_flowchart-v2-pointEnd)"/><g id="wm-12"/></svg>';
  const out = rewriteSvgId(svg, "wm-1", "wm-dlg-0");
  expect(out).toBe(
    '<svg id="wm-dlg-0"><style>#wm-dlg-0 .node rect{fill:#fff}</style><marker id="wm-dlg-0_flowchart-v2-pointEnd"/>' +
      '<path marker-end="url(#wm-dlg-0_flowchart-v2-pointEnd)"/><g id="wm-12"/></svg>',
  );
});

test("dialogWidth is natural × 1.3, capped at 92% of the window", () => {
  expect(dialogWidth(500, 1440)).toBe(650);
  expect(dialogWidth(2000, 1000)).toBe(920);
});
