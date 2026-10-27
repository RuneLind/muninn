/**
 * Palette registry — colour layers over the two bases (light, dark).
 *
 * A palette never becomes a third base: it names a `base`, the theme toggle sets
 * `data-theme="<base>"` beside `data-palette="<id>"`, and everything that asks
 * "light or dark?" (mermaid, wiki-visuals, blog accents, local overrides) keeps
 * reading `data-theme`. The palette only re-points tokens.
 *
 * `tokens` holds the palette's overrides. The CSS is generated from this list
 * (`paletteTokenStyles`), so a new palette is one entry here; the unit test
 * checks that every entry sets `PALETTE_REQUIRED_TOKENS` and names only tokens
 * the bases define, and the e2e contrast specs loop over `PALETTES`.
 *
 * Dependency-free on purpose: `theme.ts`'s init script and the specs import it.
 */

export type PaletteBase = "light" | "dark";

export interface Palette {
  /** Stored in localStorage `muninn-theme` and set as `data-palette`. */
  id: string;
  label: string;
  base: PaletteBase;
  /** The theme button's glyph while this palette is active. */
  glyph: string;
  /** CSS custom property → value. Overrides over the base's token block. */
  tokens: Readonly<Record<string, string>>;
}

/**
 * The tokens every palette must set: surfaces, borders, text, accent, tints,
 * chat, syntax and the bold/chip rule. Status colours (`--status-*`, `--tone-*`,
 * `--on-warning`, the date inks) carry meaning and stay the base's. The
 * `--island-*` badge fills and `--skeleton-shine` are optional: unset, a
 * palette shows the bases' dark islands, which read on any surface.
 */
export const PALETTE_REQUIRED_TOKENS: readonly string[] = [
  "--bg-page", "--bg-panel", "--bg-surface", "--bg-deep", "--bg-inset", "--bg-gradient-end", "--bg-card", "--bg-hover", "--graph-canvas",
  "--border-primary", "--border-secondary", "--border-subtle", "--scrollbar-thumb",
  "--text-primary", "--text-secondary", "--text-tertiary", "--text-soft", "--text-muted", "--text-dim", "--text-faint", "--text-disabled",
  "--accent", "--accent-hover", "--accent-light", "--accent-muted", "--on-accent", "--on-accent-primary",
  "--tint-success", "--tint-error", "--tint-warning", "--tint-info", "--tint-purple", "--tint-magenta", "--tint-cyan", "--tint-neutral",
  "--chat-user-bg", "--chat-user-text", "--chat-assistant-bg", "--chat-assistant-text",
  "--tok-com", "--tok-str", "--tok-kw", "--tok-num", "--tok-fn", "--tok-typ", "--tok-pun",
  "--bg-code", "--bg-code-bar",
  "--strong-lift", "--strong-pivot", "--strong-weight", "--bg-code-inline", "--code-inline-border",
  // Chat-only tokens (chat-styles.ts): without them the chat page shows the
  // base's chat surface under the palette's sidebar.
  "--bg-chat", "--bg-elevated",
];

/** The chat page's own tokens, re-emitted after its base blocks (chat-styles.ts). */
export const CHAT_PALETTE_TOKENS: readonly string[] = ["--bg-chat", "--bg-elevated"];

export const PALETTES: readonly Palette[] = [
  {
    id: "reading",
    label: "Reading mode",
    base: "dark",
    glyph: "❦",
    tokens: {
      // Warm dark preset (owner pick, D5). Type stays 14px / 1.65 (D8).
      "--bg-page": "#1e1c1a",
      "--bg-panel": "#262422",
      "--bg-surface": "#2b2826",
      "--bg-deep": "#1a1816",
      "--bg-inset": "#191715",
      "--bg-gradient-end": "#2a2725",
      "--bg-card": "#2b2826",
      "--bg-hover": "rgba(255, 255, 255, 0.04)",
      "--graph-canvas": "#1e1c1a",

      "--border-primary": "#33302e",
      "--border-secondary": "#413d3a",
      "--border-subtle": "#2c2927",
      "--scrollbar-thumb": "#413d3a",

      // Body and muted from the preset; the steps between are spaced like the
      // dark ramp. Headings are #fdfcfb (L 0.992), not the preset's #f8f7f7
      // (L 0.977): at 0.977 a heading's bold can only lift to white, a 1.07
      // lead, while from 0.99 up it is at the ink limit and carries its bold
      // by weight (the e2e bold property test). --text-disabled (L 0.44)
      // stays above the 0.29 pivot, so its bold still lightens.
      "--text-primary": "#fdfcfb",
      "--text-secondary": "#d4d1ce",
      "--text-tertiary": "#c4c0bc",
      "--text-soft": "#aca7a2",
      // #9a938c, not the preset's #918a83 (4.30:1 on the #2b2826 card):
      // 4.83 on card/surface, 5.10 on panel, 5.60 on page.
      "--text-muted": "#9a938c",
      "--text-dim": "#7a746e",
      "--text-faint": "#6a645f",
      "--text-disabled": "#57524d",

      // Text on an accent fill is dark ink (owner decision D17), not white:
      // #fff on #c8875a is 2.97:1, #1e1c1a 5.72:1. So the hover fill lightens
      // instead of darkening: #1e1c1a on #d4976a is 6.82:1 (on the old
      // #9a5c36 it would be 3.20).
      "--accent": "#c8875a",
      "--accent-hover": "#d4976a",
      "--accent-light": "#e3a87c",
      "--accent-muted": "#b09a87",
      "--on-accent": "#1e1c1a",
      "--on-accent-primary": "#1e1c1a",

      // Every dark tint measured >= 4.5:1 under its text (status colour, or
      // the accent for --tint-purple); kept. --tint-purple follows the accent's
      // hue to copper (accent 4.81:1, accent-light 6.91:1 on it).
      "--tint-success": "#1a3a2a",
      "--tint-error": "#3a1a1a",
      "--tint-warning": "#2a2a1a",
      "--tint-info": "#1e3a5f",
      "--tint-purple": "#342820",
      "--tint-magenta": "#2a1a3a",
      "--tint-cyan": "#1a2e3a",
      "--tint-neutral": "#1a1a1a",

      // The dark-island badges take the dark tints (text on each, measured:
      // deadline 8.59, Slack 8.14, GitHub 7.16, X 6.20). --island-info keeps
      // the bases' #1a2a3e: Telegram's #54a9eb is 5.71:1 there, 4.52 on
      // --tint-info. The shimmer is the warm border lifted 4% toward white.
      "--island-warning": "#2a2a1a",
      "--island-magenta": "#2a1a3a",
      "--island-success": "#1a3a2a",
      "--island-neutral": "#1a1a1a",
      "--skeleton-shine": "#34322f",

      "--chat-user-bg": "#3a2f26",
      "--chat-user-text": "#ecdccb",
      "--chat-assistant-bg": "#2b2826",
      "--chat-assistant-text": "#d4d1ce",

      // Against the #2b2826 fence: only --tok-com fell under 4.5:1 (4.04);
      // #9a938c measures 4.83. The rest keep the dark ramp (4.53–8.77).
      "--tok-com": "#9a938c",
      "--tok-str": "#4ade80",
      "--tok-kw": "#c084fc",
      "--tok-num": "#fbbf24",
      "--tok-fn": "#60a5fa",
      "--tok-typ": "#22d3ee",
      "--tok-pun": "#8e8e9c",

      "--bg-code": "#2b2826",
      "--bg-code-bar": "#33302e",

      // Dark's values. Body #d4d1ce (L 0.862) + 0.1 lands at L 0.96, near the
      // preset's #faf8f5 (L 0.98); 0.12 would hit it but turns an amber
      // callout title's bold 15.x° in hue once clipped to sRGB. bolder takes
      // the 400 body to 700. The pivot keeps 0.29: every text token sits
      // above it and --on-warning (L 0.20) below.
      "--strong-lift": "0.1",
      "--strong-pivot": "0.29",
      "--strong-weight": "bolder",
      "--bg-code-inline": "#33302e",
      "--code-inline-border": "rgba(255, 255, 255, 0.14)",

      "--bg-chat": "#1b1917",
      "--bg-elevated": "#33302e",
    },
  },
];

/** id → base, for the init script that runs before first paint. */
export function paletteBaseMap(): Record<string, PaletteBase> {
  const map: Record<string, PaletteBase> = {};
  for (const p of PALETTES) map[p.id] = p.base;
  return map;
}

/**
 * `html[data-palette="<id>"] { … }` for every palette. Specificity (0,1,1)
 * equals `html[data-theme="dark"]`'s, so the caller emits this AFTER the base
 * blocks and it wins on source order. `only` narrows the tokens emitted (the
 * chat page re-emits its own after its base blocks).
 */
export function paletteTokenStyles(only?: readonly string[]): string {
  return PALETTES.map((p) => {
    const lines = Object.entries(p.tokens)
      .filter(([name]) => !only || only.includes(name))
      .map(([name, value]) => `      ${name}: ${value};`);
    return `    html[data-palette="${p.id}"] {\n${lines.join("\n")}\n    }`;
  }).join("\n");
}
