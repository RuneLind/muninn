/**
 * WCAG contrast, measured in the browser.
 *
 * Its own module because three rail specs (`wiki-rail-series`,
 * `wiki-rail-families`, `wiki-rail-attachments`) each carried a byte-identical
 * copy: the rule the rail is judged against is one rule, and three copies is
 * three places for it to drift while every spec keeps passing.
 */
import type { Locator } from "@playwright/test";

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
 */
export async function paintedContrast(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const rgba = (c: string) => {
      const n = c.match(/[\d.]+/g)!.map(Number);
      return { r: n[0]!, g: n[1]!, b: n[2]!, a: n.length > 3 ? n[3]! : 1 };
    };
    const layers: ReturnType<typeof rgba>[] = [];
    for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
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
    const a = lum(rgba(getComputedStyle(el).color));
    const b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}
