/**
 * WCAG contrast, measured in the browser.
 *
 * Its own module because three rail specs (`wiki-rail-series`,
 * `wiki-rail-families`, `wiki-rail-attachments`) each carried a byte-identical
 * copy: the rule the rail is judged against is one rule, and three copies is
 * three places for it to drift while every spec keeps passing.
 */
import type { JSHandle, Locator, Page } from "@playwright/test";

/** A computed CSS colour as sRGB 0–255 channels plus a 0–1 alpha. */
type Rgba = [number, number, number, number];

/**
 * A function, living in the page, that reads ANY computed colour as sRGB.
 *
 * `rgb()`/`rgba()` and `color(srgb …)` are read exactly. Every other colour
 * space goes through one canvas pixel, so the browser does the conversion: a
 * relative colour such as bold's `oklch(from currentColor …)` computes to
 * `oklch(…)`, whose numbers read as RGB channels are near-black.
 *
 * Pass the handle into an `evaluate` to share one parser across specs.
 */
export function colorParser(page: Page): Promise<JSHandle<(c: string) => Rgba>> {
  return page.evaluateHandle(() => {
    const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    return (c: string): Rgba => {
      const n = c.match(/[\d.]+/g)?.map(Number) ?? [];
      if (/^rgba?\(/.test(c)) return [n[0]!, n[1]!, n[2]!, n.length > 3 ? n[3]! : 1];
      if (c.startsWith("color(srgb ")) return [n[0]! * 255, n[1]! * 255, n[2]! * 255, n.length > 3 ? n[3]! : 1];
      cv.clearRect(0, 0, 1, 1);
      cv.fillStyle = c;
      cv.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = cv.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255];
    };
  });
}

/**
 * The contrast of an element's text against the nearest ancestor that really
 * PAINTS a background — including whatever a `:hover` has put there.
 *
 * Measured rather than asserted against a token name, because a
 * `toHaveCSS("color", …)` assertion cannot see what is behind the text and a
 * token that reads fine on one surface is unreadable on the next.
 */
export async function contrastOf(locator: Locator): Promise<number> {
  const parse = await colorParser(locator.page());
  return locator.evaluate((el, parse) => {
    const lum = (c: string): number => {
      const [r, g, b] = parse(c);
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
      if (c && parse(c)[3] > 0) {
        bg = c;
        break;
      }
      node = node.parentElement;
    }
    const a = lum(getComputedStyle(el).color);
    const b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, parse);
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
  const parse = await colorParser(locator.page());
  return locator.evaluate((el, [withOpacity, fill, parse]) => {
    const rgba = (c: string) => {
      const [r, g, b, a] = parse(c);
      return { r, g, b, a };
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
  }, [opts?.withOpacity ?? false, opts?.fill ?? false, parse] as const);
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
