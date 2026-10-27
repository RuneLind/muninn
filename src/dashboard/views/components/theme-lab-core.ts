/**
 * Theme lab — the pure half: slider state → token overrides, the meters, and
 * the `tokens: { … }` export for `palettes.ts`.
 *
 * The lab starts from the active theme's computed tokens (the reference) and
 * moves token FAMILIES, not single tokens, so the ladder a palette is built on
 * survives a slider: every background token shifts by the page's own HSL
 * delta, every text token by the body's (`--text-secondary`) lightness and
 * saturation delta and the background's hue delta. The inline-code chip sits
 * at its own lightness offset from the page, and its edge keeps its channel
 * colour at a new alpha.
 *
 * Injected into the lab script with `.toString()` (`theme-lab.ts`), so each
 * function refers only to its arguments, the other `LAB_FUNCTIONS` and the
 * `LAB_*` constants, which the script re-declares under the same names.
 */

export type Rgba = [number, number, number, number];

export interface LabState {
  bgL: number; bgH: number; bgS: number;
  textL: number; textS: number;
  strongLift: number; strongWeight: string;
  chipLift: number; chipEdge: number;
}

/** Background tokens: each shifts by the page's HSL delta. `--bg-code-inline` follows the chip slider. */
export const LAB_BG_TOKENS: readonly string[] = [
  "--bg-page", "--bg-panel", "--bg-surface", "--bg-deep", "--bg-inset", "--bg-gradient-end", "--bg-card",
  "--border-primary", "--border-secondary", "--border-subtle", "--scrollbar-thumb", "--tint-neutral",
  "--bg-code", "--bg-code-bar", "--bg-chat", "--bg-elevated", "--chat-assistant-bg", "--skeleton-shine",
];

/** Text tokens: each shifts by the body's lightness and saturation delta. */
export const LAB_TEXT_TOKENS: readonly string[] = [
  "--text-primary", "--text-secondary", "--text-tertiary", "--text-soft", "--text-muted",
  "--text-dim", "--text-faint", "--text-disabled", "--chat-assistant-text",
];

/** The lightness order the unit test holds every palette to (palettes.test.ts). */
export const LAB_LADDER: readonly string[] = ["--bg-page", "--bg-panel", "--bg-surface", "--bg-deep", "--bg-inset", "--bg-card", "--tint-neutral"];

export const LAB_WEIGHTS: readonly string[] = ["bolder", "600", "700", "800"];

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` (comma or space syntax) → channels; anything else → null. */
export function labParse(c: string): Rgba | null {
  const s = (c || "").trim().toLowerCase();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hex) {
    const h = hex[1]!.length === 3 ? hex[1]!.split("").map((x) => x + x).join("") : hex[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  const fn = s.match(/^rgba?\(([^)]*)\)$/);
  if (!fn) return null;
  const n = fn[1]!.split(/[\s,/]+/).filter(Boolean).map((v) => (v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v)));
  if (n.length < 3 || n.some((v) => isNaN(v))) return null;
  return [n[0]!, n[1]!, n[2]!, n.length > 3 ? n[3]! : 1];
}

export function labHex(r: number, g: number, b: number): string {
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return "#" + ch(r) + ch(g) + ch(b);
}

/** sRGB 0–255 → [hue 0–360, saturation 0–100, lightness 0–100]. */
export function labToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l * 100];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s * 100, l * 100];
}

export function labFromHsl(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return labHex(f(0) * 255, f(8) * 255, f(4) * 255);
}

/** HSL of a colour string, or null when it does not parse. */
export function labHsl(c: string): [number, number, number] | null {
  const p = labParse(c);
  return p ? labToHsl(p[0], p[1], p[2]) : null;
}

export function labLuminance(c: string): number {
  const p = labParse(c) || [0, 0, 0, 1];
  const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(p[0]) + 0.7152 * ch(p[1]) + 0.0722 * ch(p[2]);
}

export function labContrast(a: string, b: string): number {
  const x = labLuminance(a), y = labLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The slider state that reproduces the reference exactly (every delta 0). */
export function labInitialState(ref: Record<string, string>): LabState {
  const page = labHsl(ref["--bg-page"]!) || [0, 0, 10];
  const body = labHsl(ref["--text-secondary"]!) || [0, 0, 80];
  const chip = labHsl(ref["--bg-code-inline"]!) || page;
  const edge = labParse(ref["--code-inline-border"]!);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    bgL: r1(page[2]), bgH: Math.round(page[0]), bgS: r1(page[1]),
    textL: r1(body[2]), textS: r1(body[1]),
    strongLift: parseFloat(ref["--strong-lift"]!) || 0, strongWeight: (ref["--strong-weight"] || "bolder").trim(),
    chipLift: r1(chip[2] - page[2]), chipEdge: edge ? Math.round(edge[3] * 100) : 0,
  };
}

/**
 * The overrides for a slider state: every token the lab moves, as a value
 * ready for `style.setProperty`. A token the reference does not hold as a
 * parseable colour is left out (the base keeps it).
 */
export function labDerive(ref: Record<string, string>, st: LabState): Record<string, string> {
  const out: Record<string, string> = {};
  const page = labHsl(ref["--bg-page"]!);
  const body = labHsl(ref["--text-secondary"]!);
  if (!page || !body) return out;
  const dH = st.bgH - page[0], dS = st.bgS - page[1], dL = st.bgL - page[2];
  const shift = (name: string, h: number, s: number, l: number) => {
    const c = labHsl(ref[name] || "");
    if (c) out[name] = labFromHsl(c[0] + h, c[1] + s, c[2] + l);
  };
  for (const name of LAB_BG_TOKENS) shift(name, dH, dS, dL);
  // The graph canvas follows the page only where it IS the page (paper-light keeps a dark canvas).
  if ((ref["--graph-canvas"] || "").trim().toLowerCase() === (ref["--bg-page"] || "").trim().toLowerCase()) out["--graph-canvas"] = out["--bg-page"]!;
  for (const name of LAB_TEXT_TOKENS) shift(name, dH, st.textS - body[1], st.textL - body[2]);
  const chip = labHsl(ref["--bg-code-inline"] || "");
  if (chip) out["--bg-code-inline"] = labFromHsl(chip[0] + dH, chip[1] + dS, st.bgL + st.chipLift);
  const edge = labParse(ref["--code-inline-border"] || "");
  if (edge) out["--code-inline-border"] = "rgba(" + Math.round(edge[0]) + ", " + Math.round(edge[1]) + ", " + Math.round(edge[2]) + ", " + st.chipEdge / 100 + ")";
  out["--strong-lift"] = String(st.strongLift);
  out["--strong-weight"] = st.strongWeight;
  return out;
}

/**
 * Ladder pairs the overrides turn around: wherever the reference has `a`
 * strictly darker than `b`, the result must too. Returns `"a ≥ b"` strings.
 */
export function labLadderIssues(ref: Record<string, string>, tokens: Record<string, string>): string[] {
  const issues: string[] = [];
  for (const a of LAB_LADDER) {
    for (const b of LAB_LADDER) {
      if (!ref[a] || !ref[b] || !tokens[a] || !tokens[b]) continue;
      if (labLuminance(ref[a]!) < labLuminance(ref[b]!) && !(labLuminance(tokens[a]!) < labLuminance(tokens[b]!))) {
        issues.push(a.replace("--", "") + " ≥ " + b.replace("--", ""));
      }
    }
  }
  return issues;
}

/**
 * The `tokens: { … }` block for `palettes.ts`. `order` is the palette's own
 * key order (empty for a base), then every required and derived token it
 * lacks; a token with no value in `tokens` is listed in a comment instead.
 */
export function labExport(tokens: Record<string, string>, order: readonly string[], required: readonly string[], header: string): string {
  const keys: string[] = [];
  for (const k of [...order, ...required, ...Object.keys(tokens)]) if (keys.indexOf(k) < 0) keys.push(k);
  const lines = ["    tokens: {", "      // " + header];
  const missing: string[] = [];
  for (const k of keys) {
    const v = (tokens[k] || "").trim();
    if (v) lines.push("      " + JSON.stringify(k) + ": " + JSON.stringify(v) + ",");
    else missing.push(k);
  }
  if (missing.length) lines.push("      // No value in this theme, set by hand: " + missing.join(", "));
  lines.push("    },");
  return lines.join("\n");
}

/** Every function the lab script injects, in dependency-free order. */
export const LAB_FUNCTIONS = [labParse, labHex, labToHsl, labFromHsl, labHsl, labLuminance, labContrast, labInitialState, labDerive, labLadderIssues, labExport];
