import { describe, expect, test } from "bun:test";
import {
  FLIP_MAX_HEIGHT_PX,
  MERMAID_TEXT_MIN_PX,
  buildMermaidPalette,
  chooseLayout,
  dialogBox,
  dialogFit,
  dialogHostWidth,
  flipToTopDown,
  hostWidthFor,
  injectClassDefs,
  mix,
  needsFlipCandidate,
  parseCssColor,
  parseViewBox,
  renderedTextPx,
  pickDialogDrawing,
  rescopeSvgIds,
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
      if (k === "darkMode" || k === "fontFamily" || k === "fontSize" || k === "pieOpacity" || k.endsWith("StrokeWidth")) continue;
      if (typeof val === "object") {
        for (const [kk, vv] of Object.entries(val)) if (kk !== "plotColorPalette") expect(vv, `${k}.${kk}`).toMatch(/^#[0-9a-f]{6}$/);
        continue;
      }
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

// ── Categorical colours for the non-flowchart diagrams ──────────────────
// Helpers kept here, not imported, so the assertions do not lean on the code
// under test.
const DARK_TOKENS = {
  panel: "rgb(18, 18, 26)", text: "rgb(255, 255, 255)", soft: "rgb(170, 170, 170)", accent: "rgb(108, 99, 255)",
  border: "rgb(30, 30, 46)", inset: "rgb(13, 13, 20)", good: "rgb(74, 222, 128)", warn: "rgb(251, 191, 36)", bad: "rgb(248, 113, 113)",
};
const READING_TOKENS = { ...DARK_TOKENS, panel: "#191513", inset: "#14100e", border: "#28201d", text: "#fdfcfb", soft: "#aca5a2", accent: "#c8875a" };
const PAPER_TOKENS = {
  ...LIGHT_TOKENS, panel: "#fcfaf6", inset: "#ebe6dc", border: "#e7dfd0", text: "#1a1814", soft: "#5f5a4e", accent: "#925427",
  good: "#149544", warn: "#c66d05", bad: "#c72222",
};
const SETS = [
  { name: "light", tokens: LIGHT_TOKENS, dark: false },
  { name: "paper-light", tokens: PAPER_TOKENS, dark: false },
  { name: "dark", tokens: DARK_TOKENS, dark: true },
  { name: "reading", tokens: READING_TOKENS, dark: true },
];

function rgbOf(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/.exec(hex);
  if (!m) throw new Error(`not #rrggbb: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16)) as [number, number, number];
}
function lum(hex: string): number {
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgbOf(hex).map(lin) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
function lab(hex: string): [number, number, number] {
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgbOf(hex).map(lin) as [number, number, number];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const X = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const Y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const Z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
function deltaE(a: string, b: string): number {
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
/** Smallest ΔE76 between any two colours of the list. */
function minPairDeltaE(list: string[]): number {
  let min = Infinity;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) min = Math.min(min, deltaE(list[i]!, list[j]!));
  return min;
}

describe("categorical colours: every diagram type gets real hues, readable labels", () => {
  for (const set of SETS) {
    const tv = () => {
      const p = buildMermaidPalette({ tokens: set.tokens, ground: "", fontFamily: "x", dark: set.dark })!;
      return p.themeVariables as Record<string, unknown>;
    };
    const str = (v: Record<string, unknown>, k: string) => {
      const x = v[k];
      if (typeof x !== "string") throw new Error(`${set.name}: ${k} is not set`);
      return x;
    };

    test(`${set.name}: the 12 pie slices are distinct, stand off the panel, and carry the label at 4.5:1`, () => {
      const v = tv();
      const panel = str(v, "background");
      const pies = Array.from({ length: 12 }, (_, i) => str(v, `pie${i + 1}`));
      expect(minPairDeltaE(pies)).toBeGreaterThanOrEqual(10);
      for (const c of pies) expect(deltaE(c, panel), c).toBeGreaterThanOrEqual(12);
      for (const c of pies) expect(contrast(c, str(v, "pieSectionTextColor")), c).toBeGreaterThanOrEqual(4.5);
      expect(v.pieOpacity).toBe("1");
    });

    test(`${set.name}: cScale0..11 (timeline, mindmap, kanban) are distinct with a per-fill label at 4.5:1`, () => {
      const v = tv();
      const fills = Array.from({ length: 12 }, (_, i) => str(v, `cScale${i}`));
      expect(minPairDeltaE(fills)).toBeGreaterThanOrEqual(10);
      for (let i = 0; i < 12; i++) {
        expect(contrast(fills[i]!, str(v, `cScaleLabel${i}`)), `cScale${i}`).toBeGreaterThanOrEqual(4.5);
        expect(str(v, `cScalePeer${i}`)).toMatch(/^#[0-9a-f]{6}$/);
        expect(str(v, `cScaleInv${i}`)).toMatch(/^#[0-9a-f]{6}$/);
      }
    });

    test(`${set.name}: xychart series and git branches are strong hues that read on the ground`, () => {
      const v = tv();
      const ground = str(v, "background");
      const xy = v.xyChart as Record<string, string>;
      const series = xy.plotColorPalette!.split(",");
      expect(series.length).toBeGreaterThanOrEqual(8);
      expect(minPairDeltaE(series)).toBeGreaterThanOrEqual(10);
      for (const c of series) expect(contrast(c, ground), c).toBeGreaterThanOrEqual(3);
      expect(xy.backgroundColor).toBe(ground);
      expect(contrast(xy.xAxisLabelColor!, ground)).toBeGreaterThanOrEqual(4.5);
      for (let i = 0; i < 8; i++) {
        const g = str(v, `git${i}`);
        expect(contrast(g, ground), `git${i}`).toBeGreaterThanOrEqual(3);
        expect(contrast(g, str(v, `gitBranchLabel${i}`)), `gitBranchLabel${i}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    test(`${set.name}: gantt bars are filled, bands stay near the panel, text reads`, () => {
      const v = tv();
      const panel = str(v, "background");
      expect(deltaE(str(v, "taskBkgColor"), panel)).toBeGreaterThanOrEqual(12);
      expect(contrast(str(v, "taskBkgColor"), str(v, "taskTextColor"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(str(v, "critBkgColor"), str(v, "taskTextDarkColor"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(str(v, "activeTaskBkgColor"), str(v, "taskTextDarkColor"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(str(v, "doneTaskBkgColor"), str(v, "taskTextDarkColor"))).toBeGreaterThanOrEqual(4.5);
      for (const k of ["sectionBkgColor", "altSectionBkgColor", "sectionBkgColor2", "excludeBkgColor"]) {
        // A band behind the bars: close to the panel, never a white or black stripe.
        expect(deltaE(str(v, k), panel), k).toBeLessThanOrEqual(12);
      }
    });

    test(`${set.name}: er attribute rows stay near the panel and keep the text readable`, () => {
      const v = tv();
      const panel = str(v, "background");
      for (const k of ["rowOdd", "rowEven"]) {
        expect(deltaE(str(v, k), panel), k).toBeLessThanOrEqual(12);
        expect(contrast(str(v, k), str(v, "textColor")), k).toBeGreaterThanOrEqual(4.5);
      }
    });

    test(`${set.name}: a low-contrast text token still gets 4.5:1 labels (fills step away from it)`, () => {
      const tokens = { ...set.tokens, text: set.dark ? "rgb(175, 175, 175)" : "rgb(105, 105, 105)" };
      const v = buildMermaidPalette({ tokens, ground: "", fontFamily: "x", dark: set.dark })!.themeVariables as Record<string, string>;
      for (let i = 1; i <= 12; i++) expect(contrast(v[`pie${i}`]!, v.pieSectionTextColor!), `pie${i}`).toBeGreaterThanOrEqual(4.5);
    });

    test(`${set.name}: quadrant fills differ and carry their text`, () => {
      const v = tv();
      const q = [1, 2, 3, 4].map((i) => str(v, `quadrant${i}Fill`));
      expect(minPairDeltaE(q)).toBeGreaterThanOrEqual(5);
      for (let i = 1; i <= 4; i++) expect(contrast(str(v, `quadrant${i}Fill`), str(v, `quadrant${i}TextFill`))).toBeGreaterThanOrEqual(4.5);
    });

    test(`${set.name}: a quadrant point stands out at 3:1 on every quadrant fill`, () => {
      const v = tv();
      const point = str(v, "quadrantPointFill");
      for (let i = 1; i <= 4; i++) {
        expect(contrast(point, str(v, `quadrant${i}Fill`)), `point on quadrant${i}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
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
  test("a class the page defines itself is not injected, so a partial page classDef is not merged with ours", () => {
    // mermaid merges two classDefs of one name property by property: a page's
    // `stroke` alone would keep our fill. The page's class must stand alone.
    const out = injectClassDefs("graph TD\n  classDef good stroke:#f00\n  A:::good", defs);
    expect(out).not.toContain("classDef good fill:#000");
    expect(out).toContain("classDef bad fill:#111");
    expect(out).toContain("classDef good stroke:#f00");
  });
  test("a comma list in the page's classDef counts for every name in it", () => {
    const out = injectClassDefs("flowchart LR\n  A --> B\n  classDef good,bad color:#fff", defs);
    expect(out).toBe("flowchart LR\n  A --> B\n  classDef good,bad color:#fff");
  });
  test("a page classDef after a `;` separator counts, on one line or after a newline", () => {
    // mermaid's flowchart grammar ends a statement at `;` as at a newline (a
    // classDef's own styles run to the line's end, so it comes last on it).
    const one = injectClassDefs("flowchart LR; A-->B; class A good; classDef good fill:#f00", defs);
    expect(one).not.toContain("classDef good fill:#000");
    expect(one).toContain("classDef bad fill:#111");
    expect(injectClassDefs("graph TD\n  A-->B ;classDef good,bad stroke:#f00", defs)).toBe("graph TD\n  A-->B ;classDef good,bad stroke:#f00");
    // A `>` inside a label (`<br>`) opens no asymmetric-node label.
    expect(injectClassDefs("flowchart LR; A[one<br>two] --> B; classDef good fill:#f00", defs)).not.toContain("classDef good fill:#000");
  });
  test("the text `classDef good` inside a label or an edge label is not a page classDef", () => {
    for (const src of [
      'flowchart LR\n  A["a ] b; classDef good now"] --> B',
      "flowchart LR\n  A[x; classDef good now] --> B",
      "flowchart LR\n  A(x; classDef good now) --> B",
      "flowchart LR\n  A>x; classDef good now] --> B",
      "flowchart LR\n  A -->|x; classDef good now| B",
      "flowchart LR\n  %% x; classDef good now\n  A --> B",
    ]) {
      expect(injectClassDefs(src, defs), src).toContain("classDef good fill:#000");
    }
  });
  // Each expected value below is mermaid 11.16's own reading, checked by
  // rendering the source in headless chromium (a page `classDef good
  // fill:#ff0000` either turns its node red or does not).
  const pageDefines = (src: string) => !injectClassDefs(src, defs).includes("classDef good fill:#000");
  test("a newline inside a quoted label starts no statement", () => {
    expect(pageDefines('flowchart LR\n  A["x\nclassDef good fill:#ff0000"] --> B\n  class A good')).toBe(false);
  });
  test("a newline ends an unclosed bracket or edge-label pipe count, and a comment", () => {
    // `<br>` in a pipe label raises the depth, so the second `|` cannot close it.
    expect(pageDefines("flowchart LR\n  A -->|a<br>b| B\n  B --> C; classDef good fill:#ff0000\n  class C good")).toBe(true);
    expect(pageDefines("flowchart LR\n  %% a note\n  A --> B; classDef good fill:#ff0000\n  class A good")).toBe(true);
  });
  test("`%%` inside a bracket label opens no comment", () => {
    expect(pageDefines("flowchart LR\n  A[50%% done] --> B; classDef good fill:#ff0000\n  class B good")).toBe(true);
  });
  test("known gaps of the hand-written scanner (today's output, not mermaid's)", () => {
    // (a) `<br>`, `>` or `(` in unquoted edge text leaves the depth raised, so a
    // later `;` classDef on that line is missed: mermaid reads it, we inject ours too.
    for (const src of [
      "flowchart LR\n  A -->|one<br>two| B; classDef good fill:#ff0000",
      "flowchart LR\n  A-- one<br>two -->B; classDef good fill:#ff0000",
      "flowchart LR\n  A-- go>stop -->B; classDef good fill:#ff0000",
      "flowchart LR\n  A-- a (b -->B; classDef good fill:#ff0000",
    ]) {
      expect(pageDefines(src), src).toBe(false);
    }
    // (b) a `;` inside `-- text -->` edge text: mermaid reads it as edge text, we as a classDef.
    expect(pageDefines("flowchart LR\n  A-- text; classDef good -->B")).toBe(true);
  });
  test("a longer class name sharing a prefix is not the same class", () => {
    const out = injectClassDefs("graph TD\n  classDef goodish fill:#f00", defs);
    expect(out).toContain("classDef good fill:#000");
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

describe("the header search skips every block mermaid allows before the header", () => {
  const defs = ["classDef good fill:#000"];
  const multiInit = '%%{\n  init: {\n    "theme": "base"\n  }\n}%%\nflowchart LR\n  A --> B';
  const fmConfig = "---\nconfig:\n  theme: base\n  flowchart:\n    curve: basis\n---\nflowchart LR\n  A --> B";
  const blankThenFm = "\n\n---\ntitle: x\n---\ngraph RL\n  A --> B";
  test("a %%{ … }%% directive across several lines", () => {
    expect(flipToTopDown(multiInit)).toBe(multiInit.replace("flowchart LR", "flowchart TD"));
    expect(injectClassDefs(multiInit, defs).split("\n")[6]).toBe("  classDef good fill:#000");
  });
  test("a --- config front-matter block", () => {
    expect(flipToTopDown(fmConfig)).toBe(fmConfig.replace("flowchart LR", "flowchart TD"));
    expect(injectClassDefs(fmConfig, defs).split("\n")[7]).toBe("  classDef good fill:#000");
  });
  test("blank lines before the front matter", () => {
    expect(flipToTopDown(blankThenFm)).toBe(blankThenFm.replace("graph RL", "graph TD"));
    expect(injectClassDefs(blankThenFm, defs).split("\n")[6]).toBe("  classDef good fill:#000");
  });
  test("a directive and front matter together; an unclosed directive finds no header", () => {
    const both = "---\ntitle: t\n---\n%%{init:\n {}}%%\nflowchart LR\n  A";
    expect(flipToTopDown(both)).toBe(both.replace("flowchart LR", "flowchart TD"));
    expect(flipToTopDown("%%{init:\nflowchart LR\n  A")).toBeNull();
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
  });  test("the flip's 900 px cap holds for the height it is shown at once widened", () => {
    // Column-scaled the TD copy is 600 px tall; widened to 11 px text it is 1178.6 px.
    const wide = { width: 4000, height: 300 };
    const tall = { width: 2000, height: 1500 };
    const d = chooseLayout({ bodyWidth: 800, fontPx: 14, original: wide, flipped: tall });
    expect(d).toEqual({ flipped: false, widenTo: (4000 * 11) / 14 });
    // The same copy short enough once widened (≤ 900 px) still flips.
    const ok = { width: 2000, height: 1100 }; // widened 1571.4 → 864.3 px tall
    const f = chooseLayout({ bodyWidth: 800, fontPx: 14, original: wide, flipped: ok });
    expect(f.flipped).toBe(true);
    expect((ok.height * f.widenTo!) / ok.width).toBeLessThan(FLIP_MAX_HEIGHT_PX);
  });
});

describe("chooseLayout reads each drawing's smallest real text, not 14 px", () => {
  const original = { width: 1960, height: 200 };
  test("gantt (10 px ticks) at its natural width is widened to 11 px", () => {
    const gantt = { width: 1424, height: 148, minText: 10 };
    expect(chooseLayout({ bodyWidth: 1424, fontPx: 14, original: gantt })).toEqual({ flipped: false, widenTo: 1424 * 1.1 });
  });
  test("a page's 9 px init fits the column and is still widened to 11 px", () => {
    const small = { width: 300, height: 60, minText: 9 };
    const d = chooseLayout({ bodyWidth: 800, fontPx: 14, original: small });
    expect(d.widenTo).toBeCloseTo((300 * 11) / 9, 9);
    expect((9 * d.widenTo!) / 300, "drawn scaled up past natural size").toBeCloseTo(MERMAID_TEXT_MIN_PX, 9);
  });
  test("sequence (16 px) at 0.75 reads 12 px: no needless widen, no flip candidate", () => {
    const seq = { width: 1000, height: 300, minText: 16 };
    expect(chooseLayout({ bodyWidth: 750, fontPx: 14, original: seq })).toEqual({ flipped: false, widenTo: null });
    expect(needsFlipCandidate(750, 14, seq)).toBe(false);
  });
  test("no measured text falls back to the pass's font size", () => {
    expect(chooseLayout({ bodyWidth: 700, fontPx: 14, original: { ...original, minText: null } })).toEqual({ flipped: false, widenTo: 1540 });
    expect(chooseLayout({ bodyWidth: 700, fontPx: 14, original: { ...original, minText: 0 } })).toEqual({ flipped: false, widenTo: 1540 });
  });
  test("the flipped copy is judged by its own smallest text", () => {
    // TD copy 900 wide in 800: 14 px nodes → 12.4 px, but its 10 px label → 8.9 px: widened.
    const d = chooseLayout({ bodyWidth: 800, fontPx: 14, original, flipped: { width: 900, height: 400, minText: 10 } });
    expect(d.flipped).toBe(true);
    expect(d.widenTo).toBeCloseTo(990, 6);
  });
});

describe("hostWidthFor: a container-driven drawing widened to 11 px fills the body exactly", () => {
  test("10 px text in 800 px → drawn 727 wide", () => {
    expect(hostWidthFor(800, 10)).toBe(727);
    expect(hostWidthFor(800, 14)).toBe(800);
  });
  test("never a scrollbar, never under 11 px", () => {
    for (let w = 280; w <= 2400; w += 7) {
      for (const m of [7.07, 9, 10, 10.5, 11, 16]) {
        const host = hostWidthFor(w, m);
        const d = chooseLayout({ bodyWidth: w, fontPx: 14, original: { width: host, height: 100, minText: m } });
        const shownW = d.widenTo === null ? Math.min(w, host) : Math.ceil(d.widenTo - 1e-6);
        expect(shownW).toBeLessThanOrEqual(w);
        expect(m * (shownW / host)).toBeGreaterThanOrEqual(MERMAID_TEXT_MIN_PX - 0.02);
      }
    }
  });
});

/** A minimal element tree: tag, attributes in order, text, children. */
class FakeEl {
  attrs: { name: string; value: string }[];
  constructor(
    readonly tagName: string,
    attrs: Record<string, string> = {},
    public textContent: string | null = null,
    readonly children: FakeEl[] = [],
  ) {
    this.attrs = Object.entries(attrs).map(([name, value]) => ({ name, value }));
  }
  get attributes() {
    return this.attrs;
  }
  setAttribute(name: string, value: string): void {
    const a = this.attrs.find((x) => x.name === name);
    if (a) a.value = value;
    else this.attrs.push({ name, value });
  }
  attr(name: string): string | undefined {
    return this.attrs.find((x) => x.name === name)?.value;
  }
  querySelectorAll(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.querySelectorAll()]);
  }
}

describe("rescopeSvgIds", () => {
  const tree = () => {
    const style = new FakeEl("style", {}, "#wm-1 .node rect{fill:#fff} #wm-12 .x{} .dwm-1{}");
    const marker = new FakeEl("marker", { id: "wm-1_flowchart-v2-pointEnd" });
    const path = new FakeEl("path", { "marker-end": "url(#wm-1_flowchart-v2-pointEnd)", style: "fill:url('#wm-1-grad')" });
    const title = new FakeEl("title", { id: "chart-title-wm-1" });
    const use = new FakeEl("use", { "xlink:href": "#wm-1-sym", href: "https://example.com/wm-1" });
    const other = new FakeEl("g", { id: "wm-12" });
    const longer = new FakeEl("g", { id: "dwm-1", "aria-describedby": "dwm-1 wm-1" });
    const label = new FakeEl("span", { class: "nodeLabel", "data-note": "wm-1" }, "see wm-1 and wm-1x and dwm-1");
    const svg = new FakeEl("svg", { id: "wm-1", "aria-labelledby": "chart-title-wm-1 chart-desc-wm-1" }, null, [
      style, marker, path, title, use, other, longer, label,
    ]);
    return { svg, style, marker, path, title, use, other, longer, label };
  };

  test("renames ids and every id reference, bounded", () => {
    const t = tree();
    rescopeSvgIds(t.svg, "wm-1", "wm-dlg-0");
    expect(t.svg.attr("id")).toBe("wm-dlg-0");
    expect(t.svg.attr("aria-labelledby")).toBe("chart-title-wm-dlg-0 chart-desc-wm-dlg-0");
    expect(t.style.textContent).toBe("#wm-dlg-0 .node rect{fill:#fff} #wm-12 .x{} .dwm-1{}");
    expect(t.marker.attr("id")).toBe("wm-dlg-0_flowchart-v2-pointEnd");
    expect(t.path.attr("marker-end")).toBe("url(#wm-dlg-0_flowchart-v2-pointEnd)");
    expect(t.path.attr("style")).toBe("fill:url('#wm-dlg-0-grad')");
    expect(t.title.attr("id")).toBe("chart-title-wm-dlg-0");
    expect(t.use.attr("xlink:href")).toBe("#wm-dlg-0-sym");
    expect(t.other.attr("id"), "wm-12 is another id").toBe("wm-12");
    expect(t.longer.attr("id"), "dwm-1 is another id").toBe("dwm-1");
    expect(t.longer.attr("aria-describedby")).toBe("dwm-1 wm-dlg-0");
  });

  test("leaves text, a link off the page and plain attributes as written", () => {
    const t = tree();
    rescopeSvgIds(t.svg, "wm-1", "wm-dlg-0");
    expect(t.label.textContent).toBe("see wm-1 and wm-1x and dwm-1");
    expect(t.label.attr("data-note")).toBe("wm-1");
    expect(t.use.attr("href")).toBe("https://example.com/wm-1");
  });
});

describe("dialog size", () => {
  const box = dialogBox(1440, 900);

  test("the box is the dialog's max size less its chrome", () => {
    expect(box.width).toBeCloseTo(1440 * 0.96 - 66, 6);
    expect(box.height).toBeCloseTo(900 * 0.94 - 78, 6);
  });

  test("a small diagram is drawn at natural × 1.3", () => {
    const f = dialogFit({ width: 500, height: 300, minText: 14 }, box, 14);
    expect(f.scale).toBeCloseTo(1.3, 6);
    expect(f.overflow).toBe(0);
  });

  test("a large one shrinks to fit the window height, not below 11 px", () => {
    const f = dialogFit({ width: 600, height: 1200, minText: 20 }, box, 11);
    expect(f.height).toBeCloseTo(box.height, 6);
    expect(f.textPx).toBeGreaterThanOrEqual(11);
    expect(f.overflow).toBe(0);
  });

  test("too wide to fit at 11 px: drawn at the floor and spills (the dialog scrolls)", () => {
    const f = dialogFit({ width: 4000, height: 300, minText: 14 }, box, 11);
    expect(f.textPx).toBeCloseTo(11, 6);
    expect(f.width).toBeGreaterThan(box.width);
    expect(f.overflow).toBeGreaterThan(0);
  });

  test("never smaller than the page shows it", () => {
    const f = dialogFit({ width: 4000, height: 300, minText: 14 }, box, 12.5);
    expect(f.textPx).toBeCloseTo(12.5, 6);
  });

  test("a 9 px drawing reads at 11 px at least", () => {
    expect(dialogFit({ width: 200, height: 100, minText: 9 }, box, 0).textPx).toBeGreaterThanOrEqual(11);
  });

  test("the 11 px floor holds when the page shows less and the box would shrink it", () => {
    expect(dialogFit({ width: 4000, height: 300, minText: 20 }, box, 5).textPx).toBeCloseTo(11, 6);
  });

  test("a drawing that spills down counts as overflow", () => {
    const f = dialogFit({ width: 300, height: 4000, minText: 14 }, box, 11);
    expect(f.overflow).toBeCloseTo((f.height - box.height) / box.height, 6);
    expect(f.overflow).toBeGreaterThan(0);
  });

  test("the pick prefers the drawing that spills less, then the larger text", () => {
    const wide = { width: 4000, height: 300, minText: 14 };
    const tall = { width: 500, height: 900, minText: 14 };
    expect(pickDialogDrawing([wide, tall], box, 11)!.index).toBe(1);
    const small = { width: 300, height: 200, minText: 14 };
    const big = { width: 300, height: 200, minText: 16 };
    expect(pickDialogDrawing([small, big], box, 11)!.index).toBe(1);
    expect(pickDialogDrawing([], box, 11)).toBeNull();
  });

  test("a gantt is drawn for the dialog at the width that fills the box at 1.3 × its text", () => {
    const hw = dialogHostWidth(box.width, 10, 11);
    expect(hw).toBe(Math.floor(box.width / 1.3));
    const f = dialogFit({ width: hw, height: 200, minText: 10 }, box, 11);
    expect(f.textPx).toBeCloseTo(13, 6);
    expect(f.width).toBeLessThanOrEqual(box.width);
    expect(f.width).toBeGreaterThan(box.width - 2);
  });

  test("a gantt whose floor is over 1.3× is drawn narrower, so at the floor it still fills the box", () => {
    const hw = dialogHostWidth(box.width, 8, 11); // floor 11 ÷ 8 = 1.375
    expect(hw).toBe(Math.floor(box.width / 1.375));
    const f = dialogFit({ width: hw, height: 200, minText: 8 }, box, 11);
    expect(f.textPx).toBeCloseTo(11, 6);
    expect(f.width).toBeLessThanOrEqual(box.width);
  });
});
