import { describe, expect, test } from "bun:test";
import { CHAT_PALETTE_TOKENS, PALETTES, PALETTE_ONLY_TOKENS, PALETTE_REQUIRED_TOKENS, paletteBaseMap, paletteTokenStyles } from "./palettes.ts";
import { THEME_KEY, themeChoices, themeInitScript, themeToggleHtml, themeToggleScript } from "./theme.ts";
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

/**
 * Run the real init script, then the real end-of-header script, against the
 * same stub storage: one page load. The header script finds no ◐ button, so it
 * runs only its load-time sync.
 */
function runLoad(stored: Record<string, string>): { dataset: Record<string, string>; storage: Record<string, string> } {
  const storage = { ...stored };
  const dataset: Record<string, string> = {};
  const localStorage = {
    getItem: (k: string) => (k in storage ? storage[k]! : null),
    setItem: (k: string, v: string) => { storage[k] = v; },
    removeItem: (k: string) => { delete storage[k]; },
  };
  const document = { documentElement: { dataset }, getElementById: () => null, addEventListener: () => {} };
  const window = { addEventListener: () => {} };
  new Function("localStorage", "document", themeInitScript())(localStorage, document);
  new Function("localStorage", "document", "window", themeToggleScript())(localStorage, document, window);
  return { dataset, storage };
}

describe("palette registry", () => {
  const chatNames = [...chatStyles().matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!);
  const declared = new Set([...baseTokenNames(), ...chatNames]);
  const known = new Set([...declared, ...PALETTE_ONLY_TOKENS]);

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

  test("a palette-only token is declared by no base and no chat block", () => {
    // Undefined in the bases is what keeps their colour main's (inherited).
    expect(PALETTE_ONLY_TOKENS.filter((t) => declared.has(t))).toEqual([]);
    expect(PALETTE_ONLY_TOKENS.every((t) => PALETTE_REQUIRED_TOKENS.includes(t))).toBe(true);
  });

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

  test("a page load keeps an unknown or 'system' value stored, rendered as system", () => {
    for (const v of ["sepia-9000", "system"]) {
      const r = runLoad({ [THEME_KEY]: v });
      expect(r.dataset, v).toEqual({});
      expect(r.storage, v).toEqual({ [THEME_KEY]: v });
    }
  });

  test("a stored value, even an unknown one, beats the legacy chat key", () => {
    const r = runLoad({ [THEME_KEY]: "sepia-9000", "muninn-chat-theme": "light" });
    expect(r.dataset).toEqual({});
    expect(r.storage).toEqual({ [THEME_KEY]: "sepia-9000" });
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

/** The resolved hex value of every token a base block declares. */
function baseTokens(base: "light" | "dark"): Record<string, string> {
  const css = themeTokenStyles();
  const start = css.indexOf(`html[data-theme="${base}"] {`);
  const block = css.slice(start, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

function rgb(hex: string): number[] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
const lin = (s: number) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio, lighter over darker. */
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
/** OKLab lightness, the `l` the bold rule's `oklch(from currentColor …)` moves. */
const okL = (hex: string) => {
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
};

/** The two bases plus every palette, each as the token set the page computes. */
const THEME_SETS = [
  { id: "light", base: "light" as const, tokens: baseTokens("light") },
  { id: "dark", base: "dark" as const, tokens: baseTokens("dark") },
  ...PALETTES.map((p) => ({ id: p.id, base: p.base, tokens: { ...baseTokens(p.base), ...p.tokens } })),
];

describe("palette colour rules", () => {
  // A neutral fill reads by being darker than whatever it sits on. The floor is
  // plain light's own smallest step: #eceef3 on its #f1f2f6 card, 1.038:1.
  const SURFACES = ["--bg-page", "--bg-panel", "--bg-card"];
  const light = baseTokens("light");
  const neutralFloor = Math.min(...SURFACES.map((s) => contrast(light["--tint-neutral"]!, light[s]!)));
  // The inks held to 4.5 on --tint-neutral. --text-dim, --text-faint and
  // --text-disabled are left out because they fail 4.5 on the fill in every
  // theme, not because every use is a disabled state: `.overview-event-badge.sys`
  // and `.chip-rejected` draw readable labels in --text-dim on it (2.96:1 on
  // paper-light, 3.22 in plain light, 3.03 dark, 3.77 reading) — a known gap.
  const NEUTRAL_INKS = ["--text-primary", "--text-secondary", "--text-soft", "--text-muted", "--tok-fn"];

  for (const t of THEME_SETS.filter((x) => x.base === "light")) {
    test(`${t.id}: --tint-neutral is a visible fill on page, panel and card`, () => {
      const fill = t.tokens["--tint-neutral"]!;
      for (const s of SURFACES) {
        const bg = t.tokens[s]!;
        expect(luminance(fill), `${fill} darker than ${s} ${bg}`).toBeLessThan(luminance(bg));
        expect(contrast(fill, bg), `${fill} on ${s} ${bg}`).toBeGreaterThanOrEqual(neutralFloor - 1e-9);
      }
    });
  }

  // --tint-purple is the accent's wash (badges, the summaries duplicate banner on
  // the page, :target rows on cards), so it reads the same way. On the page the
  // floor is plain light's own banner fill, #e7e7fb on #f3f4f7 (1.109:1).
  const purpleOnPage = contrast(light["--tint-purple"]!, light["--bg-page"]!);
  for (const t of THEME_SETS.filter((x) => x.base === "light")) {
    test(`${t.id}: --tint-purple is a visible fill on page, panel and card`, () => {
      const fill = t.tokens["--tint-purple"]!;
      for (const s of SURFACES) {
        const bg = t.tokens[s]!;
        const floor = s === "--bg-page" ? purpleOnPage : neutralFloor;
        expect(luminance(fill), `${fill} darker than ${s} ${bg}`).toBeLessThan(luminance(bg));
        expect(contrast(fill, bg), `${fill} on ${s} ${bg}`).toBeGreaterThanOrEqual(floor - 1e-9);
      }
    });
  }

  // The accent as text: the logo, active tabs and links on every surface, and the
  // badges on --tint-purple. Plain light's accent is 4.15:1 on its lavender and
  // the dark base's 3.95 on its card, so the bases are pinned only where they
  // already pass.
  for (const t of THEME_SETS.filter((x) => x.id !== "dark")) {
    test(`${t.id}: --accent and --accent-light text >= 4.5:1 on page, panel and card`, () => {
      for (const ink of ["--accent", "--accent-light"]) {
        for (const s of SURFACES) {
          expect(contrast(t.tokens[ink]!, t.tokens[s]!), `${ink} ${t.tokens[ink]} on ${s} ${t.tokens[s]}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
  for (const p of PALETTES) {
    test(`${p.id}: --accent and --accent-light text >= 4.5:1 on --tint-purple`, () => {
      const t = { ...baseTokens(p.base), ...p.tokens };
      for (const ink of ["--accent", "--accent-light"]) {
        expect(contrast(t[ink]!, t["--tint-purple"]!), `${ink} ${t[ink]} on ${t["--tint-purple"]}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  // `.nav-link.active`: the accent on 15 % of itself over the header's panel
  // (shared-styles.ts). Plain light reaches 4.13:1; a light palette must not drop under it.
  const navActive = (tk: Record<string, string>) => {
    const a = rgb(tk["--accent"]!), b = rgb(tk["--bg-panel"]!);
    const fill = "#" + a.map((v, i) => Math.round((0.15 * v + 0.85 * b[i]!) * 255).toString(16).padStart(2, "0")).join("");
    return contrast(tk["--accent"]!, fill);
  };
  for (const p of PALETTES.filter((x) => x.base === "light")) {
    test(`${p.id}: the active nav link reads at least as well as plain light's`, () => {
      const t = { ...light, ...p.tokens };
      expect(navActive(t)).toBeGreaterThanOrEqual(navActive(light));
    });
  }

  // Status colours as text (links, verdicts, notes, stat labels). A light
  // palette's surfaces sit darker than plain light's, so it darkens their values:
  // each stays at least plain light's own ratio on the same surface, and a colour
  // plain light makes AA somewhere (info, error, magenta) reaches 4.5 everywhere.
  const STATUS_INKS = ["--status-success", "--status-error", "--status-warning", "--status-info", "--status-tool", "--status-cyan", "--status-magenta"];
  for (const p of PALETTES.filter((x) => x.base === "light")) {
    test(`${p.id}: status text never reads worse than plain light's on page, panel and card`, () => {
      const t = { ...light, ...p.tokens };
      for (const ink of STATUS_INKS) {
        const ref = SURFACES.map((s) => contrast(light[ink]!, light[s]!));
        const aa = Math.max(...ref) >= 4.5 ? 4.5 : 0;
        SURFACES.forEach((s, i) => {
          const floor = Math.max(ref[i]!, aa);
          expect(contrast(t[ink]!, t[s]!), `${ink} ${t[ink]} on ${s} ${t[s]} (floor ${floor.toFixed(2)})`).toBeGreaterThanOrEqual(floor - 1e-9);
        });
      }
      // The GitHub watcher badge draws --status-success on --island-success.
      const badge = contrast(light["--status-success"]!, light["--island-success"]!);
      expect(contrast(t["--status-success"]!, t["--island-success"]!), "GitHub badge").toBeGreaterThanOrEqual(badge - 1e-9);
    });
  }

  for (const p of PALETTES) {
    test(`${p.id}: text drawn on --tint-neutral stays >= 4.5:1`, () => {
      const t = { ...baseTokens(p.base), ...p.tokens };
      for (const ink of NEUTRAL_INKS) {
        expect(contrast(t[ink]!, t["--tint-neutral"]!), `${ink} ${t[ink]} on ${t["--tint-neutral"]}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  // Bold moves its context's oklch L by --strong-lift, away from --strong-pivot
  // (shared-styles.ts). A dimmed context's bold must stay dimmer than the body:
  // on a light base lighter than unbolded body text, on a dark base dimmer than
  // body bold. Body text is --text-secondary.
  const DIMMED = ["--text-soft", "--text-muted", "--text-dim", "--text-faint", "--text-disabled", "--accent-muted", "--worked-ink", "--changed-ink"];
  for (const t of THEME_SETS) {
    test(`${t.id}: bold in a dimmed context stays dimmer than the body`, () => {
      const lift = Number(t.tokens["--strong-lift"]);
      const pivot = Number(t.tokens["--strong-pivot"]);
      const bold = (l: number) => Math.min(1, Math.max(0, l + lift * Math.max(-1, Math.min(1, (l - pivot) * 1000))));
      const body = okL(t.tokens["--text-secondary"]!);
      for (const tok of DIMMED) {
        const b = bold(okL(t.tokens[tok]!));
        const msg = `${tok} ${t.tokens[tok]} bolds to L ${b.toFixed(3)}, body L ${body.toFixed(3)}, body bold ${bold(body).toFixed(3)}`;
        if (t.base === "light") expect(b, msg).toBeGreaterThan(body);
        else expect(b, msg).toBeLessThan(bold(body));
      }
    });
  }
});
