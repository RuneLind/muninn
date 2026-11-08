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
/** The smallest node text a page diagram is shown at without a scrollbar. */
export const MERMAID_TEXT_MIN_PX = 11;
/** A flipped (top-down) drawing taller than this stays left-to-right. */
export const FLIP_MAX_HEIGHT_PX = 900;
/** The full-window view draws at natural size × this… */
export const DIALOG_SCALE = 1.3;
/** …capped at this share of the window width. */
export const DIALOG_MAX_VW = 0.92;

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

export interface MermaidPalette {
  /** `mermaid.initialize` options for the pass (minus security settings). */
  themeVariables: Record<string, string | boolean>;
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
  const themeVariables: Record<string, string | boolean> = {
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
  const classDefs = [
    `classDef good fill:${mix(good, panel, 0.16)},stroke:${h(good)},color:${h(text)},stroke-width:1.5px`,
    `classDef warn fill:${mix(warn, panel, 0.16)},stroke:${h(warn)},color:${h(text)},stroke-width:1.5px`,
    `classDef bad fill:${mix(bad, panel, 0.14)},stroke:${h(bad)},color:${h(text)},stroke-width:1.5px`,
    `classDef muted fill:${h(inset)},stroke:${h(border)},color:${h(soft)},stroke-dasharray:4 3`,
  ];
  return { themeVariables, classDefs, key: JSON.stringify([themeVariables, classDefs]) };
}

/** Index of the first line after an optional `---` front-matter block and any
 *  blank or `%%` comment/directive lines; -1 when there is none. */
function headerLineIndex(lines: string[]): number {
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, j) => j > 0 && l.trim() === "---");
    if (end < 0) return -1;
    i = end + 1;
  }
  for (; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === "" || t.startsWith("%%")) continue;
    return i;
  }
  return -1;
}

const FLOW_HEADER = /^\s*(?:flowchart|graph)\b/;

/** Insert `classDefs` right after a `flowchart`/`graph` header line. Any other
 *  diagram type comes back unchanged (`classDef` is flowchart syntax). The page's
 *  own `classDef` of the same name sits later in the source and wins. */
export function injectClassDefs(source: string, classDefs: readonly string[]): string {
  if (classDefs.length === 0) return source;
  const lines = source.split("\n");
  const i = headerLineIndex(lines);
  if (i < 0 || !FLOW_HEADER.test(lines[i]!)) return source;
  lines.splice(i + 1, 0, ...classDefs.map((d) => `  ${d}`));
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

/** Node text size as drawn: mermaid scales the SVG down to the column, never up. */
export function renderedTextPx(fontPx: number, bodyWidth: number, viewBoxWidth: number): number {
  return fontPx * Math.min(1, bodyWidth / viewBoxWidth);
}

/** The width (CSS px) that draws the SVG's text at exactly the floor. */
export function widenedWidth(viewBoxWidth: number, fontPx: number, minPx = MERMAID_TEXT_MIN_PX): number {
  return (viewBoxWidth * minPx) / fontPx;
}

export interface Layout {
  /** Show the top-down copy instead of the page's own orientation. */
  flipped: boolean;
  /** Width to force on the SVG (it then scrolls sideways), or null to fit. */
  widenTo: number | null;
}

/**
 * Decide orientation and width from the page's own drawing and, when there is
 * one, its top-down copy. Pure: always decided from the original orientation,
 * so a resize wider un-flips and un-widens. `bodyWidth` must be > 0 — a box with
 * no layout (closed fold, hidden lens) is never measured.
 */
export function chooseLayout(input: {
  bodyWidth: number;
  fontPx: number;
  original: { width: number; height: number };
  flipped?: { width: number; height: number } | null;
}): Layout {
  const { bodyWidth, fontPx, original, flipped } = input;
  const pxOrig = renderedTextPx(fontPx, bodyWidth, original.width);
  let chosen = original;
  let px = pxOrig;
  let isFlipped = false;
  if (pxOrig < MERMAID_TEXT_MIN_PX && flipped) {
    const pxFlip = renderedTextPx(fontPx, bodyWidth, flipped.width);
    const heightFlip = flipped.height * Math.min(1, bodyWidth / flipped.width);
    if (pxFlip > pxOrig && heightFlip < FLIP_MAX_HEIGHT_PX) {
      chosen = flipped;
      px = pxFlip;
      isFlipped = true;
    }
  }
  return { flipped: isFlipped, widenTo: px < MERMAID_TEXT_MIN_PX ? widenedWidth(chosen.width, fontPx) : null };
}

/** True when an un-flipped layout needs the top-down copy to decide. */
export function needsFlipCandidate(bodyWidth: number, fontPx: number, original: { width: number }): boolean {
  return renderedTextPx(fontPx, bodyWidth, original.width) < MERMAID_TEXT_MIN_PX;
}

/**
 * Rename an SVG's root id everywhere it is used. mermaid scopes the SVG's own
 * `<style>` (`#id .node rect{…}`) and its arrow markers (`url(#id_flowchart-…)`)
 * by the root id, so a copy that drops the id loses its styling and a copy that
 * keeps it duplicates ids. A token match only: `wm-1` never touches `wm-12`.
 */
export function rewriteSvgId(svg: string, from: string, to: string): string {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return svg.replace(new RegExp(`${esc}(?![0-9])`, "g"), to);
}

/** The full-window view's SVG width: natural × {@link DIALOG_SCALE}, capped. */
export function dialogWidth(viewBoxWidth: number, windowWidth: number): number {
  return Math.min(viewBoxWidth * DIALOG_SCALE, windowWidth * DIALOG_MAX_VW);
}
