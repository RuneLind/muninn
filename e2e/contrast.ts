/**
 * WCAG contrast, measured in the browser.
 *
 * Its own module because three rail specs (`wiki-rail-series`,
 * `wiki-rail-families`, `wiki-rail-attachments`) each carried a byte-identical
 * copy: the rule the rail is judged against is one rule, and three copies is
 * three places for it to drift while every spec keeps passing.
 */
import type { Locator, Page } from "@playwright/test";

/**
 * The contrast of an element's text against the nearest ancestor that really
 * PAINTS a background — including whatever a `:hover` has put there.
 *
 * Measured rather than asserted against a token name, because a
 * `toHaveCSS("color", …)` assertion cannot see what is behind the text and a
 * token that reads fine on one surface is unreadable on the next.
 */
export async function contrastOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const lum = (c: string): number => {
      const [r, g, b] = c.match(/[\d.]+/g)!.slice(0, 3).map(Number) as [number, number, number];
      const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    let node: HTMLElement | null = el as HTMLElement;
    let bg = "rgba(0, 0, 0, 0)";
    while (node) {
      const c = getComputedStyle(node).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) {
        bg = c;
        break;
      }
      node = node.parentElement;
    }
    const a = lum(getComputedStyle(el).color);
    const b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

/**
 * The contrast of an element's text against what is really painted behind it:
 * every translucent fill between it and the first opaque one composited, as the
 * browser does — the active row's fill is a 14% tint, which a walk that stops
 * at the first non-transparent colour would read as solid.
 *
 * `withOpacity` also fades the text by every ancestor's `opacity` (and its own
 * colour alpha) over that background — what a reader sees in a dimmed box with
 * no fill of its own. Off by default, so the rail specs measure what they did.
 *
 * `fill` measures the element's own BACKGROUND instead of its text — a graphic
 * such as a bar segment, which WCAG 1.4.11 holds to 3:1 — against what its
 * ancestors paint behind it, its own alpha composited over them.
 */
export async function paintedContrast(
  locator: Locator,
  opts?: { withOpacity?: boolean; fill?: boolean },
): Promise<number> {
  return locator.evaluate((el, [withOpacity, fill]) => {
    // A color-mix() computes to `color(srgb r g b / a)` with 0–1 channels,
    // not `rgb()`; read as 0–255 channels it is near-black.
    const rgba = (c: string) => {
      const n = c.match(/[\d.]+/g)!.map(Number);
      const k = c.startsWith("color(srgb") ? 255 : 1;
      return { r: n[0]! * k, g: n[1]! * k, b: n[2]! * k, a: n.length > 3 ? n[3]! : 1 };
    };
    const layers: ReturnType<typeof rgba>[] = [];
    const behind = fill ? (el as HTMLElement).parentElement : (el as HTMLElement);
    for (let n: HTMLElement | null = behind; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c.a === 0) continue;
      layers.push(c);
      if (c.a >= 1) break;
    }
    let bg = { r: 255, g: 255, b: 255 };
    for (const l of layers.reverse()) {
      bg = { r: l.r * l.a + bg.r * (1 - l.a), g: l.g * l.a + bg.g * (1 - l.a), b: l.b * l.a + bg.b * (1 - l.a) };
    }
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const ch = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    let fg = rgba(getComputedStyle(el)[fill ? "backgroundColor" : "color"]);
    if (fill) {
      fg = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
    } else if (withOpacity) {
      let alpha = fg.a;
      for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
        alpha *= Number(getComputedStyle(n).opacity);
      }
      fg = { r: fg.r * alpha + bg.r * (1 - alpha), g: fg.g * alpha + bg.g * (1 - alpha), b: fg.b * alpha + bg.b * (1 - alpha), a: 1 };
    }
    const a = lum(fg);
    const b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, [opts?.withOpacity ?? false, opts?.fill ?? false] as const);
}

/** A token's computed value, read off a probe on `body`: what a rule written
 *  `var(<name>)` resolves to, so a spec pins the token and not a literal. */
export async function token(page: Page, name: string, prop: "color" | "backgroundColor" = "color"): Promise<string> {
  return page.evaluate(
    ([n, p]) => {
      const probe = document.createElement("span");
      probe.style[p as "color"] = `var(${n})`;
      document.body.appendChild(probe);
      const c = getComputedStyle(probe)[p as "color"];
      probe.remove();
      return c;
    },
    [name, prop] as const,
  );
}
