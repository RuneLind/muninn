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
 * `--on-warning`, the date inks) carry meaning: a palette may retune a status
 * VALUE for its surfaces (paper-light darkens them) but never re-points one
 * meaning onto another token, and need not set them. The
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
  "--on-accent-inherit",
];

/**
 * Tokens the bases leave undefined on purpose: a rule that uses one computes
 * main's inherited colour in plain light and dark, and the palette's value
 * under a palette. `--on-accent-inherit` is the ink of the two chat hovers
 * (`.research-actions button:hover`, `.dev-run-resend:hover`) on the accent.
 */
export const PALETTE_ONLY_TOKENS: readonly string[] = ["--on-accent-inherit"];

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
      "--bg-deep": "#23211f",
      "--bg-inset": "#211f1d",
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
      "--on-accent-inherit": "#1e1c1a",

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
      // --tint-info. The shimmer #34322f is --border-primary #33302e plus 1/2/1 per
      // channel.
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
  {
    id: "paper-light",
    label: "Light reading mode",
    base: "light",
    glyph: "❧",
    tokens: {
      // The «Lesemodus lys» preset (owner pick, D5), on plain light's ladder:
      // the panel is the lightest paper, then page, card, and fields deepest.
      // The prototype sank the panel below the page, which read as a grey slab
      // with fields lost in it. Type stays 14px / 1.65 (D8).
      "--bg-page": "#f4f1ea",
      "--bg-panel": "#fcfaf6",
      "--bg-surface": "#f1ede4",
      "--bg-deep": "#ebe6dc",
      "--bg-inset": "#ebe6dc",
      "--bg-gradient-end": "#ece6da",
      "--bg-card": "#f1ede4",
      "--bg-hover": "rgba(0, 0, 0, 0.04)",
      "--graph-canvas": "#0a0a0f",

      "--border-primary": "#e7dfd0",
      "--border-secondary": "#ddd2bb",
      "--border-subtle": "#ece6da",
      "--scrollbar-thumb": "#d2cbbc",

      // Body hsl(40 12% 24%) and heading hsl(40 12% 9%) from the preset; the
      // steps between are spaced like the light ramp. --text-muted is #696357,
      // not the preset's #81796a (3.53:1 on the card): 5.10 card, 5.72 panel,
      // 5.28 page, and 4.70 on --tint-neutral, which sits darker than the card.
      "--text-primary": "#1a1814",
      "--text-secondary": "#454036",
      "--text-tertiary": "#524d42",
      "--text-soft": "#5f5a4e",
      "--text-muted": "#696357",
      "--text-dim": "#857d6f",
      "--text-faint": "#9f998f",
      "--text-disabled": "#c2beb7",

      // A step darker than the preset's #a35f2f (owner decision D18), which
      // read 4.07:1 as text on the card. #925427 measures 5.29 page, 5.72
      // panel, 5.11 card, and 4.64 as the active nav link on its own 15 %
      // tint (plain light 4.13). The hover keeps the preset's ~1.3 step
      // below it. White reads 5.97 on the accent and 7.86 on the hover, so
      // all three inks are white. --accent-light keeps the preset's text
      // accent, 5.99 page / 5.79 card.
      "--accent": "#925427",
      "--accent-hover": "#7c4318",
      "--accent-light": "#8a4b1f",
      "--accent-muted": "#7d6250",
      "--on-accent": "#fff",
      "--on-accent-primary": "#fff",
      "--on-accent-inherit": "#fff",

      // The light base's pale tints read on paper: their pill text (--tone-*,
      // 6.4–8.1:1 with the status values below) clears 4.5. --tint-purple
      // follows the accent to a copper wash darker than every surface, like
      // the base lavender: 1.154 page (plain light 1.109), 1.249 panel, 1.114
      // card; --accent 4.58 and --accent-light 5.19 on it. --tint-neutral is
      // darker than every surface by at least plain light's smallest step (1.038, its tint on its card):
      // 1.085 card, 1.216 panel, 1.124 page. Its inks: --text-muted 4.70,
      // --text-soft 5.41, --tok-fn 5.29.
      "--tint-success": "#dcfce7",
      "--tint-error": "#fee2e2",
      "--tint-warning": "#fef3c7",
      "--tint-info": "#dbeafe",
      "--tint-purple": "#eedfd3",
      "--tint-magenta": "#f3e8ff",
      "--tint-cyan": "#cffafe",
      "--tint-neutral": "#e8e4dc",

      // Status text, darkened toward black in its own hue because every
      // surface sits darker than plain light's: each reads at least plain
      // light's ratio on the same surface, and info, error and magenta (AA
      // somewhere in plain light) reach 4.5 everywhere. Page/panel/card:
      // success 3.44/3.72/3.32, error 5.06/5.47/4.88, warning 3.33/3.60/3.21,
      // info 5.41/5.85/5.22, tool 4.35/4.71/4.20, cyan 3.85/4.16/3.71,
      // magenta 5.62/6.08/5.43. --on-warning on the warning fill: 4.85.
      "--status-success": "#149544",
      "--status-error": "#c72222",
      "--status-warning": "#c66d05",
      "--status-info": "#2159d4",
      "--status-tool": "#b05909",
      "--status-cyan": "#0784a3",
      "--status-magenta": "#842ed3",
      // The GitHub badge's green ink on this island: 4.61 (plain light 4.58).
      "--island-success": "#0f1a0f",

      "--chat-user-bg": "#f3e3d2",
      "--chat-user-text": "#5c3a1e",
      "--chat-assistant-bg": "#f1ede4",
      "--chat-assistant-text": "#454036",

      // The preset's syntax set, on the #ede8df fence: 4.77–5.49:1 (--tok-typ
      // darkened from #0e7490, 4.39 there).
      "--tok-com": "#6b6258",
      "--tok-str": "#2f6b1f",
      "--tok-kw": "#8b2fd0",
      "--tok-num": "#9c4a07",
      "--tok-fn": "#1d4ed8",
      "--tok-typ": "#0d6e89",
      "--tok-pun": "#6b6258",

      "--bg-code": "#ede8df",
      "--bg-code-bar": "#e5ddce",

      // Bold darkens its context 0.08 in oklch lightness: body (L 0.373)
      // lands at 0.293, a 1.36 lead. The preset's strong ink (L 0.21) needs
      // 0.16, which bolds --text-soft (L 0.469) darker than body text; at
      // 0.08 every dimmed token's bold stays lighter (soft 0.389). The pivot
      // keeps light's 0.9, between --text-disabled (L 0.80) and the white
      // ink on the accent. The chip keeps its context's text colour (D14) on
      // a fill about 5 % darker than the page, with a 10 % black edge.
      "--strong-lift": "0.08",
      "--strong-pivot": "0.9",
      "--strong-weight": "bolder",
      "--bg-code-inline": "#ece6da",
      "--code-inline-border": "rgba(0, 0, 0, 0.1)",

      "--bg-chat": "#f9f7f3",
      "--bg-elevated": "#fbf9f7",
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
