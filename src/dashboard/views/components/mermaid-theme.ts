/**
 * The pure half of the mermaid enhancer (`wiki-mermaid.ts`): colour parsing,
 * the `base`-theme variables built from the reader's tokens, the four node
 * classes, and the readable-size arithmetic. No DOM: the enhancer reads the
 * computed colours and box widths and hands them in, so every rule here is
 * unit-tested (`mermaid-theme.test.ts`).
 *
 * mermaid derives its shades from `themeVariables` itself (khroma), so it cannot
 * read `var()` or `color-mix()`: every value handed to it is a `#rrggbb` built
 * here, never page text.
 */

export type Rgba = { r: number; g: number; b: number; a: number };

/** The tokens a pass needs, as the computed colour strings the browser gives
 *  (`rgb(…)`, `rgba(…)` or `color(srgb …)`). */
export interface TokenColors {
  panel: string;
  text: string;
  soft: string;
  accent: string;
  border: string;
  inset: string;
  good: string;
  warn: string;
  bad: string;
}

/** The CSS custom property behind each {@link TokenColors} field. */
export const MERMAID_TOKENS: Readonly<Record<keyof TokenColors, string>> = {
  panel: "--bg-panel",
  text: "--text-primary",
  soft: "--text-soft",
  accent: "--accent",
  border: "--border-primary",
  inset: "--bg-inset",
  good: "--status-success",
  warn: "--status-warning",
  bad: "--status-error",
};

/** Node text size under the `base` theme (the variables set it). */
export const THEMED_FONT_PX = 14;
/** Node text size under mermaid's own `default`/`dark` themes (the fallback). */
export const FALLBACK_FONT_PX = 16;
/** The smallest text (any label, measured) a page diagram is shown at without a scrollbar. */
export const MERMAID_TEXT_MIN_PX = 11;
/** A flipped (top-down) drawing taller than this stays left-to-right. */
export const FLIP_MAX_HEIGHT_PX = 900;
/** The full-window view draws at natural size × this when the window has room. */
export const DIALOG_SCALE = 1.3;
/** The dialog's own `max-width` / `max-height` (component-styles.ts `dialog.diagram-dialog`). */
export const DIALOG_MAX_VW = 0.96;
export const DIALOG_MAX_VH = 0.94;
/** Width the dialog spends on padding (2 × 24), border (2) and a vertical scrollbar (16). */
export const DIALOG_CHROME_W = 66;
/** Height: padding and border (50), the close button's float above the SVG (12), a horizontal scrollbar (16). */
export const DIALOG_CHROME_H = 78;

const NUM = String.raw`(-?[\d.]+(?:e-?\d+)?)(%?)`;

/** Parse a computed CSS colour. Accepts `#rgb`/`#rrggbb`, `rgb()`/`rgba()`
 *  (comma or space syntax, optional `/ alpha`) and `color(srgb r g b [/ a])`.
 *  Anything else (`oklch(…)`, a keyword, empty) is null. */
export function parseCssColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const alpha = (v: string | undefined, pct: string | undefined): number =>
    v === undefined ? 1 : pct ? Number(v) / 100 : Number(v);
  const rgb = new RegExp(String.raw`^rgba?\(\s*${NUM}[\s,]+${NUM}[\s,]+${NUM}(?:\s*[,/]\s*${NUM})?\s*\)$`).exec(s);
  if (rgb) {
    const ch = (v: string, pct: string) => (pct ? (Number(v) * 255) / 100 : Number(v));
    return { r: ch(rgb[1]!, rgb[2]!), g: ch(rgb[3]!, rgb[4]!), b: ch(rgb[5]!, rgb[6]!), a: alpha(rgb[7], rgb[8]) };
  }
  const srgb = new RegExp(String.raw`^color\(\s*srgb\s+${NUM}\s+${NUM}\s+${NUM}(?:\s*/\s*${NUM})?\s*\)$`).exec(s);
  if (srgb) {
    const ch = (v: string, pct: string) => (pct ? (Number(v) * 255) / 100 : Number(v) * 255);
    return { r: ch(srgb[1]!, srgb[2]!), g: ch(srgb[3]!, srgb[4]!), b: ch(srgb[5]!, srgb[6]!), a: alpha(srgb[7], srgb[8]) };
  }
  return null;
}

/** `#rrggbb`, each channel rounded and clamped. Alpha is dropped. */
export function toHex(c: Rgba): string {
  const ch = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${ch(c.r)}${ch(c.g)}${ch(c.b)}`;
}

/** `a` at weight `t` over `b` (t = 1 ⇒ a), as hex — `color-mix(in srgb, a t, b)`. */
export function mix(a: Rgba, b: Rgba, t: number): string {
  return toHex({ r: a.r * t + b.r * (1 - t), g: a.g * t + b.g * (1 - t), b: a.b * t + b.b * (1 - t), a: 1 });
}

/** Flatten a translucent colour onto `ground`. */
export function flatten(c: Rgba, ground: Rgba): Rgba {
  if (c.a >= 1) return c;
  return { r: c.r * c.a + ground.r * (1 - c.a), g: c.g * c.a + ground.g * (1 - c.a), b: c.b * c.a + ground.b * (1 - c.a), a: 1 };
}

/** WCAG relative luminance of an opaque colour. */
export function luminance(c: Rgba): number {
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio of two opaque colours (1–21). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

function toHsl(c: Rgba): { h: number; s: number; l: number } {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function fromHsl(h: number, s: number, l: number): Rgba {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
  return { r: f(0), g: f(8), b: f(4), a: 1 };
}

const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/**
 * `n` hues: the accent's, then each status tone's that is at least 30° from
 * the ones taken (a near-grey tone has no hue to give), then farthest-point
 * fill on a 5° grid, so the twelve spread round the whole circle.
 */
export function categoricalHues(seeds: Rgba[], n: number): number[] {
  const hues: number[] = [];
  for (const c of seeds) {
    const { h, s } = toHsl(c);
    if (s >= 0.25 && hues.every((x) => hueGap(x, h) >= 30)) hues.push(h);
  }
  const start = hues[0] ?? 250;
  if (hues.length === 0) hues.push(start);
  while (hues.length < n) {
    let best = start, bestGap = -1;
    for (let k = 0; k < 72; k++) {
      const h = (start + k * 5) % 360;
      const gap = Math.min(...hues.map((x) => hueGap(x, h)));
      if (gap > bestGap) [best, bestGap] = [h, gap];
    }
    hues.push(best);
  }
  return hues.slice(0, n);
}

/**
 * One hue drawn as an AREA (pie slice, timeline section, gantt bar): pale in
 * light, deep in dark, a little of the panel mixed in so it sits on Reading's
 * warm ground, then stepped away from the text until the text reads on it at
 * 4.5:1. (Alternating two lightness steps between hue neighbours was measured
 * and dropped: it lowered the smallest pairwise ΔE76 of the 12 in light.)
 */
function areaFill(h: number, dark: boolean, panel: Rgba, text: Rgba): Rgba {
  let l = dark ? 0.4 : 0.62;
  const s = dark ? 0.6 : 0.7;
  for (let i = 0; i < 60; i++) {
    const c = parseCssColor(mix(fromHsl(h, s, l), panel, 0.85))!;
    if (contrastRatio(c, text) >= 4.6) return c;
    l += dark ? -0.01 : 0.01;
  }
  return parseCssColor(mix(fromHsl(h, s, l), panel, 0.85))!;
}

/**
 * One hue drawn as a LINE or a small mark on the ground (xychart series, git
 * branch): 3:1 against the ground, and one of text / panel reads on it at 4.5:1
 * (a git branch label sits on it). Stepped away from the ground until both hold.
 */
function strokeColor(h: number, dark: boolean, ground: Rgba, text: Rgba, panel: Rgba): Rgba {
  let l = dark ? 0.66 : 0.42;
  const s = dark ? 0.7 : 0.68;
  let c = fromHsl(h, s, l);
  for (let i = 0; i < 60; i++) {
    c = parseCssColor(toHex(fromHsl(h, s, l)))!; // rounded, as mermaid will see it
    if (contrastRatio(c, ground) >= 3 && Math.max(contrastRatio(c, text), contrastRatio(c, panel)) >= 4.6) return c;
    l += dark ? 0.01 : -0.01;
  }
  return c;
}

/** Of text and panel, whichever reads better on `fill`. */
function labelOn(fill: Rgba, text: Rgba, panel: Rgba): Rgba {
  return contrastRatio(fill, text) >= contrastRatio(fill, panel) ? text : panel;
}

export type ThemeValue = string | boolean | Record<string, string>;

export interface MermaidPalette {
  /** `mermaid.initialize` options for the pass (minus security settings). */
  themeVariables: Record<string, ThemeValue>;
  /** The four `classDef` lines, injected after a flowchart header. */
  classDefs: string[];
  /** Identifies the resolved colours: equal keys draw identical diagrams. */
  key: string;
}

/**
 * Build the `base`-theme variables and node classes from the resolved tokens,
 * or null when any token is missing or unparseable (the caller then falls back
 * to mermaid's own `default`/`dark` theme for the pass). `ground` is the
 * `.diagram` box's own computed background (panel when empty or transparent).
 */
export function buildMermaidPalette(input: {
  tokens: Partial<Record<keyof TokenColors, string>>;
  ground: string;
  fontFamily: string;
  dark: boolean;
}): MermaidPalette | null {
  const parsed = {} as Record<keyof TokenColors, Rgba>;
  for (const k of Object.keys(MERMAID_TOKENS) as (keyof TokenColors)[]) {
    const c = parseCssColor(input.tokens[k] ?? "");
    if (!c) return null;
    parsed[k] = c;
  }
  const panel = flatten(parsed.panel, { r: input.dark ? 0 : 255, g: input.dark ? 0 : 255, b: input.dark ? 0 : 255, a: 1 });
  const on = (c: Rgba) => flatten(c, panel);
  const groundParsed = parseCssColor(input.ground);
  const ground = groundParsed && groundParsed.a > 0 ? on(groundParsed) : panel;
  const [text, soft, accent, border, inset, good, warn, bad] = [
    parsed.text, parsed.soft, parsed.accent, parsed.border, parsed.inset, parsed.good, parsed.warn, parsed.bad,
  ].map(on) as [Rgba, Rgba, Rgba, Rgba, Rgba, Rgba, Rgba, Rgba];
  const h = toHex;
  const themeVariables: Record<string, ThemeValue> = {
    darkMode: input.dark,
    fontFamily: input.fontFamily,
    fontSize: `${THEMED_FONT_PX}px`,
    background: h(ground),
    primaryColor: mix(accent, panel, 0.045),
    primaryBorderColor: mix(accent, panel, 0.6),
    primaryTextColor: h(text),
    secondaryColor: h(inset),
    secondaryBorderColor: h(border),
    secondaryTextColor: h(text),
    tertiaryColor: mix(accent, ground, 0.05),
    tertiaryBorderColor: h(border),
    tertiaryTextColor: h(text),
    lineColor: mix(soft, ground, 0.85),
    textColor: h(text),
    nodeTextColor: h(text),
    edgeLabelBackground: h(ground),
    clusterBkg: mix(accent, ground, 0.04),
    clusterBorder: h(border),
    noteBkgColor: mix(warn, panel, 0.14),
    noteBorderColor: mix(warn, panel, 0.6),
    noteTextColor: h(text),
    actorBkg: mix(accent, panel, 0.045),
    actorBorder: mix(accent, panel, 0.6),
    actorTextColor: h(text),
    signalColor: h(soft),
    signalTextColor: h(text),
    labelBoxBkgColor: h(panel),
    labelBoxBorderColor: h(border),
    labelTextColor: h(text),
  };
  Object.assign(themeVariables, categoricalVariables({ panel, ground, text, soft, accent, border, inset, good, warn, bad, dark: input.dark }));
  const classDefs = [
    `classDef good fill:${mix(good, panel, 0.16)},stroke:${h(good)},color:${h(text)},stroke-width:1.5px`,
    `classDef warn fill:${mix(warn, panel, 0.16)},stroke:${h(warn)},color:${h(text)},stroke-width:1.5px`,
    `classDef bad fill:${mix(bad, panel, 0.14)},stroke:${h(bad)},color:${h(text)},stroke-width:1.5px`,
    `classDef muted fill:${h(inset)},stroke:${h(border)},color:${h(soft)},stroke-dasharray:4 3`,
  ];
  return { themeVariables, classDefs, key: JSON.stringify([themeVariables, classDefs]) };
}

/**
 * The variables every non-flowchart diagram colours from. Unset, mermaid's
 * `base` theme derives them from `primaryColor` (here near the panel) and then
 * darkens them: in dark every timeline section came out `#000`, pie slices near
 * black, gantt section bands white. mermaid 11.16 `theme-base.js` names:
 * `pie1..12`, `cScale0..11` (timeline, mindmap, kanban, radar, treemap; with
 * `cScaleLabel*` for the first three and treemap, `cScaleInv*` for the first
 * three, `cScalePeer*` for treemap), `fillType0..7` (journey), `venn1..8`, `git0..7`
 * (+ `gitBranchLabel*`, `gitInv*`), the gantt `task*`/`section*`/`crit*` set,
 * `rowOdd`/`rowEven` (erDiagram attribute rows), `quadrant*` and `xyChart`.
 * An override survives mermaid's own darken pass (`calculate` re-applies it).
 */
function categoricalVariables(t: {
  panel: Rgba; ground: Rgba; text: Rgba; soft: Rgba; accent: Rgba; border: Rgba; inset: Rgba;
  good: Rgba; warn: Rgba; bad: Rgba; dark: boolean;
}): Record<string, ThemeValue> {
  const h = toHex;
  const hues = categoricalHues([t.accent, t.good, t.warn, t.bad], 12);
  const fills = hues.map((hue) => areaFill(hue, t.dark, t.panel, t.text));
  const labels = fills.map((f) => labelOn(f, t.text, t.panel));
  const strokes = hues.map((hue) => strokeColor(hue, t.dark, t.ground, t.text, t.panel));
  const strokeLabels = strokes.map((c) => labelOn(c, t.text, t.panel));
  const badHue = toHsl(t.bad).h;
  const crit = areaFill(badHue, t.dark, t.panel, t.text);
  const v: Record<string, ThemeValue> = {};
  fills.forEach((f, i) => {
    v[`pie${i + 1}`] = h(f);
    v[`cScale${i}`] = h(f);
    v[`cScaleLabel${i}`] = h(labels[i]!);
    v[`cScalePeer${i}`] = h(strokes[i]!);
    v[`cScaleInv${i}`] = h(strokes[i]!);
  });
  for (let i = 0; i < 8; i++) {
    v[`fillType${i}`] = h(fills[i]!);
    v[`venn${i + 1}`] = h(fills[i]!);
    v[`git${i}`] = h(strokes[i]!);
    v[`gitBranchLabel${i}`] = h(strokeLabels[i]!);
    v[`gitInv${i}`] = h(strokeLabels[i]!);
  }
  Object.assign(v, {
    // pie: full-strength slices (mermaid draws them at 0.7 over the ground,
    // which would wash the label contrast computed above), ground-coloured gaps.
    pieOpacity: "1",
    pieStrokeColor: h(t.ground),
    pieOuterStrokeColor: h(t.border),
    pieSectionTextColor: h(t.text),
    pieTitleTextColor: h(t.text),
    pieLegendTextColor: h(t.text),
    vennTitleTextColor: h(t.text),
    vennSetTextColor: h(t.text),
    // gantt: filled bars on faint bands.
    taskBkgColor: h(fills[0]!),
    taskBorderColor: h(strokes[0]!),
    taskTextColor: h(labels[0]!),
    taskTextDarkColor: h(t.text),
    taskTextOutsideColor: h(t.text),
    taskTextClickableColor: h(t.accent),
    activeTaskBkgColor: mix(fills[0]!, t.panel, 0.5),
    activeTaskBorderColor: h(strokes[0]!),
    doneTaskBkgColor: mix(t.soft, t.panel, 0.22),
    doneTaskBorderColor: h(t.soft),
    critBkgColor: h(crit),
    critBorderColor: h(t.bad),
    sectionBkgColor: mix(t.accent, t.panel, 0.07),
    sectionBkgColor2: mix(t.warn, t.panel, 0.07),
    altSectionBkgColor: h(t.panel),
    excludeBkgColor: h(t.inset),
    gridColor: mix(t.soft, t.ground, 0.35),
    todayLineColor: h(t.bad),
    vertLineColor: h(t.soft),
    titleColor: h(t.text),
    // erDiagram attribute rows: the panel and a faint stripe.
    rowOdd: h(t.panel),
    rowEven: mix(t.soft, t.panel, 0.08),
    // quadrantChart: four tints of the first four hues.
    quadrant1Fill: mix(fills[0]!, t.panel, 0.55),
    quadrant2Fill: mix(fills[1]!, t.panel, 0.55),
    quadrant3Fill: mix(fills[2]!, t.panel, 0.55),
    quadrant4Fill: mix(fills[3]!, t.panel, 0.55),
    quadrant1TextFill: h(t.text),
    quadrant2TextFill: h(t.text),
    quadrant3TextFill: h(t.text),
    quadrant4TextFill: h(t.text),
    // The point is drawn on all four tinted fills: the text colour reads on each
    // (≥ 4.5:1 above), where the hue-0 line colour measured 2.3:1 on some.
    quadrantPointFill: h(t.text),
    quadrantPointTextFill: h(t.text),
    quadrantXAxisTextFill: h(t.text),
    quadrantYAxisTextFill: h(t.text),
    quadrantTitleFill: h(t.text),
    quadrantInternalBorderStrokeFill: h(t.border),
    quadrantExternalBorderStrokeFill: h(t.border),
    // gitGraph chrome.
    commitLabelColor: h(t.text),
    commitLabelBackground: h(t.inset),
    tagLabelColor: h(labels[0]!),
    tagLabelBackground: h(fills[0]!),
    tagLabelBorder: h(strokes[0]!),
    // xychart: a whole object (mermaid merges it over its defaults).
    xyChart: {
      backgroundColor: h(t.ground),
      titleColor: h(t.text),
      dataLabelColor: h(t.text),
      xAxisTitleColor: h(t.text),
      xAxisLabelColor: h(t.text),
      xAxisTickColor: h(t.soft),
      xAxisLineColor: h(t.soft),
      yAxisTitleColor: h(t.text),
      yAxisLabelColor: h(t.text),
      yAxisTickColor: h(t.soft),
      yAxisLineColor: h(t.soft),
      plotColorPalette: strokes.map(h).join(","),
    },
  });
  return v;
}

/** Index of the diagram header line: past leading blank lines, an optional
 *  `---` front-matter block, blank lines, `%%` comments and `%%{ … }%%`
 *  directives (one line or several); -1 when there is none. */
function headerLineIndex(lines: string[]): number {
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (lines[i]?.trim() === "---") {
    const end = lines.findIndex((l, j) => j > i && l.trim() === "---");
    if (end < 0) return -1;
    i = end + 1;
  }
  for (; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.startsWith("%%{") && !t.includes("}%%")) {
      while (i < lines.length && !lines[i]!.includes("}%%")) i++;
      continue; // unclosed: runs off the end → -1
    }
    if (t === "" || t.startsWith("%%")) continue;
    return i;
  }
  return -1;
}

const FLOW_HEADER = /^\s*(?:flowchart|graph)\b/;

/** Every class name the source's own `classDef` statements define (`classDef a,b …`).
 *  A statement starts at a line start or after a `;`; a `;` inside a label
 *  (`"…"`, `[…]`, `(…)`, `{…}`, `>…]`, an edge's `|…|`) or a `%%` comment
 *  starts none. A heuristic, not mermaid's grammar. Known gaps (pinned in the
 *  tests): `<br>`, `>` or `(` in unquoted edge text (`|a<br>b|`, `-- a (b -->`)
 *  leaves the depth raised, so a later `; classDef` on that line is missed; and
 *  `-- text; classDef x -->` edge text counts as a classDef. */
function definedClasses(source: string): Set<string> {
  const names = new Set<string>();
  const take = (i: number) => {
    const m = /^[ \t]*classDef\s+([^\s;]+)/.exec(source.slice(i));
    if (m) for (const n of m[1]!.split(",")) if (n) names.add(n);
  };
  let depth = 0, inStr = false, inPipe = false, inComment = false;
  take(0);
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\n") {
      depth = 0; inPipe = false; inComment = false;
      if (!inStr) take(i + 1);
    } else if (inComment) continue;
    else if (c === '"') inStr = !inStr;
    else if (inStr) continue;
    else if (c === "%" && source[i + 1] === "%" && depth === 0 && !inPipe) inComment = true;
    else if ("[({".includes(c) || (c === ">" && depth === 0 && /\w/.test(source[i - 1] ?? ""))) depth++;
    else if ("])}".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === "|" && depth === 0) inPipe = !inPipe;
    else if (c === ";" && depth === 0 && !inPipe) take(i + 1);
  }
  return names;
}

/** Insert `classDefs` right after a `flowchart`/`graph` header line. Any other
 *  diagram type comes back unchanged (`classDef` is flowchart syntax). A class
 *  the page defines itself is left out: mermaid merges two `classDef`s of one
 *  name property by property, so a page's partial `classDef good stroke:…`
 *  would otherwise keep our fill. */
export function injectClassDefs(source: string, classDefs: readonly string[]): string {
  if (classDefs.length === 0) return source;
  const lines = source.split("\n");
  const i = headerLineIndex(lines);
  if (i < 0 || !FLOW_HEADER.test(lines[i]!)) return source;
  const own = definedClasses(source);
  const keep = classDefs.filter((d) => !own.has(/^classDef\s+(\S+)/.exec(d)?.[1] ?? ""));
  if (keep.length === 0) return source;
  lines.splice(i + 1, 0, ...keep.map((d) => `  ${d}`));
  return lines.join("\n");
}

/** The same source drawn top-down when its header is a `flowchart`/`graph`
 *  `LR` or `RL`; null for any other diagram or direction. */
export function flipToTopDown(source: string): string | null {
  const lines = source.split("\n");
  const i = headerLineIndex(lines);
  if (i < 0) return null;
  const m = /^(\s*(?:flowchart|graph)\s+)(LR|RL)\b/.exec(lines[i]!);
  if (!m) return null;
  lines[i] = m[1] + "TD" + lines[i]!.slice(m[0].length);
  return lines.join("\n");
}

/** `viewBox` width and height of an SVG string; null when absent or degenerate. */
export function parseViewBox(svg: string): { width: number; height: number } | null {
  const m = /<svg\b[^>]*?\sviewBox="\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*"/i.exec(svg);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Text size as drawn: mermaid scales the SVG down to the column, never up.
 *  `fontPx` is the drawing's smallest text in SVG user units. */
export function renderedTextPx(fontPx: number, bodyWidth: number, viewBoxWidth: number): number {
  return fontPx * Math.min(1, bodyWidth / viewBoxWidth);
}

/** The width (CSS px) that draws the SVG's smallest text at exactly the floor. */
export function widenedWidth(viewBoxWidth: number, fontPx: number, minPx = MERMAID_TEXT_MIN_PX): number {
  return (viewBoxWidth * minPx) / fontPx;
}

/** One drawing as `chooseLayout` sees it. `minText` is its smallest rendered
 *  text in SVG user units (measured after render); absent → the pass's fontPx. */
export interface Drawing {
  width: number;
  height: number;
  minText?: number | null;
}

export interface Layout {
  /** Show the top-down copy instead of the page's own orientation. */
  flipped: boolean;
  /** Width to force on the SVG (it then scrolls sideways), or null to fit. */
  widenTo: number | null;
}

/** Text px, widen width and displayed height of one drawing in `bodyWidth`. */
function shown(d: Drawing, fontPx: number, bodyWidth: number): { px: number; widenTo: number | null; height: number } {
  const text = d.minText && d.minText > 0 ? d.minText : fontPx;
  const px = renderedTextPx(text, bodyWidth, d.width);
  if (px >= MERMAID_TEXT_MIN_PX) return { px, widenTo: null, height: d.height * Math.min(1, bodyWidth / d.width) };
  const widenTo = widenedWidth(d.width, text);
  return { px, widenTo, height: (d.height * widenTo) / d.width };
}

/**
 * Decide orientation and width from the page's own drawing and, when there is
 * one, its top-down copy. Pure: always decided from the original orientation,
 * so a resize wider un-flips and un-widens. `bodyWidth` must be > 0 — a box with
 * no layout (closed fold, hidden lens) is never measured. The flip's height cap
 * is checked on the height it is SHOWN at, widened or not.
 */
export function chooseLayout(input: {
  bodyWidth: number;
  fontPx: number;
  original: Drawing;
  flipped?: Drawing | null;
}): Layout {
  const { bodyWidth, fontPx, original, flipped } = input;
  const orig = shown(original, fontPx, bodyWidth);
  if (orig.px < MERMAID_TEXT_MIN_PX && flipped) {
    const flip = shown(flipped, fontPx, bodyWidth);
    if (flip.px > orig.px && flip.height < FLIP_MAX_HEIGHT_PX) return { flipped: true, widenTo: flip.widenTo };
  }
  return { flipped: false, widenTo: orig.widenTo };
}

/** True when an un-flipped layout needs the top-down copy to decide. */
export function needsFlipCandidate(bodyWidth: number, fontPx: number, original: Drawing): boolean {
  return shown(original, fontPx, bodyWidth).px < MERMAID_TEXT_MIN_PX;
}

/**
 * The width to draw a diagram whose viewBox follows its container (gantt) at,
 * so that widened to the floor it fills `bodyWidth` exactly: its smallest text
 * then reads at 11 px without a scrollbar. Text already ≥ 11 px → `bodyWidth`.
 * Floored, so `ceil(widenedWidth(result, minText))` never exceeds `bodyWidth`.
 */
export function hostWidthFor(bodyWidth: number, minText: number, minPx = MERMAID_TEXT_MIN_PX): number {
  return Math.floor(bodyWidth * Math.min(1, minText / minPx));
}

/** One element as {@link rescopeSvgIds} touches it (a DOM `Element` fits). */
export interface IdElement {
  readonly tagName: string;
  readonly attributes: ArrayLike<{ readonly name: string; readonly value: string }>;
  setAttribute(name: string, value: string): void;
  textContent: string | null;
}

/** Attributes whose whole value is an id or a space-separated id list. */
const ID_LIST_ATTRS = new Set([
  "id",
  "aria-labelledby",
  "aria-describedby",
  "aria-controls",
  "aria-owns",
  "aria-activedescendant",
  "aria-details",
  "aria-errormessage",
  "aria-flowto",
]);

/**
 * Rename an SVG's root id in every id reference of a parsed copy, never in its
 * text. mermaid scopes the SVG's own `<style>` (`#id .node rect{…}`), its
 * markers (`url(#id_flowchart-…)`) and its a11y title (`chart-title-id`) by the
 * root id, so a copy that drops the id loses its styling and one that keeps it
 * duplicates ids. Rewritten: `id` and the aria id-list attributes (bounded:
 * `wm-1` is not `wm-12` or `dwm-1`), an `href`/`xlink:href` that starts with
 * `#`, every `url(#…)` in any attribute, and `#id` in `<style>` text. A label
 * that names the id string is text, so it is left as written.
 */
export function rescopeSvgIds(
  svg: IdElement & { querySelectorAll(sel: string): ArrayLike<IdElement> },
  from: string,
  to: string,
): void {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(`(^|[^A-Za-z0-9])${esc}(?![0-9])`, "g");
  const hash = new RegExp(`#${esc}(?![0-9])`, "g");
  const ids = (v: string) => v.replace(token, (_m, pre: string) => pre + to);
  for (const el of [svg, ...Array.from(svg.querySelectorAll("*"))]) {
    if (el.tagName.toLowerCase() === "style") {
      el.textContent = (el.textContent ?? "").replace(hash, `#${to}`);
      continue;
    }
    for (const { name, value } of Array.from(el.attributes)) {
      let next = value;
      if (ID_LIST_ATTRS.has(name)) next = ids(value);
      else if ((name === "href" || name === "xlink:href") && value.startsWith("#")) next = "#" + ids(value.slice(1));
      else if (value.includes("url(")) next = value.replace(/url\(\s*(['"]?)#([^)'"]*)\1\s*\)/g, (_m, q: string, ref: string) => `url(${q}#${ids(ref)}${q})`);
      if (next !== value) el.setAttribute(name, next);
    }
  }
}

/** The room the dialog gives its SVG in a `windowWidth` × `windowHeight` window. */
export function dialogBox(windowWidth: number, windowHeight: number): { width: number; height: number } {
  return {
    width: Math.max(1, windowWidth * DIALOG_MAX_VW - DIALOG_CHROME_W),
    height: Math.max(1, windowHeight * DIALOG_MAX_VH - DIALOG_CHROME_H),
  };
}

/** A drawing as the dialog sizes it: viewBox size and smallest text, user units. */
export interface DialogDrawing {
  width: number;
  height: number;
  minText: number;
}

export interface DialogFit {
  /** CSS px per user unit. */
  scale: number;
  width: number;
  height: number;
  /** The smallest text as shown. */
  textPx: number;
  /** How far it spills past the box: overflow ÷ box, summed over both axes. */
  overflow: number;
}

/** The scale the dialog aims for: natural × {@link DIALOG_SCALE}, or more when
 *  that would show text under the floor or under what the page shows (`pagePx`). */
function dialogFloor(minText: number, pagePx: number): { lo: number; hi: number } {
  const lo = Math.max(MERMAID_TEXT_MIN_PX, pagePx) / minText;
  return { lo, hi: Math.max(DIALOG_SCALE, lo) };
}

/**
 * Size one drawing for the dialog: as large as {@link DIALOG_SCALE} × natural
 * while it fits the box (both axes), smaller to fit, but never under
 * `max(11 px, pagePx)` smallest text: past that it spills and the dialog scrolls.
 */
export function dialogFit(d: DialogDrawing, box: { width: number; height: number }, pagePx: number): DialogFit {
  const { lo, hi } = dialogFloor(d.minText, pagePx);
  const fit = Math.min(box.width / d.width, box.height / d.height);
  const scale = Math.max(lo, Math.min(hi, fit));
  const width = d.width * scale;
  const height = d.height * scale;
  const overflow = Math.max(0, width - box.width) / box.width + Math.max(0, height - box.height) / box.height;
  return { scale, width, height, textPx: d.minText * scale, overflow };
}

/** Pick the drawing that spills least, then the one with the larger text, then the first. */
export function pickDialogDrawing(
  ds: readonly DialogDrawing[],
  box: { width: number; height: number },
  pagePx: number,
): { index: number; fit: DialogFit } | null {
  let best: { index: number; fit: DialogFit } | null = null;
  ds.forEach((d, index) => {
    const fit = dialogFit(d, box, pagePx);
    if (
      !best ||
      fit.overflow < best.fit.overflow - 1e-6 ||
      (Math.abs(fit.overflow - best.fit.overflow) <= 1e-6 && fit.textPx > best.fit.textPx + 1e-6)
    ) {
      best = { index, fit };
    }
  });
  return best;
}

/** A diagram whose viewBox follows its box (gantt) is drawn for the dialog at
 *  this width, so that scaled to fill `boxWidth` its text reads at the aimed size. */
export function dialogHostWidth(boxWidth: number, minText: number, pagePx: number): number {
  return Math.max(1, Math.floor(boxWidth / dialogFloor(minText, pagePx).hi));
}
