/**
 * The `<Diagram>` picture: the one inline `<svg>` of an archify HTML file,
 * extracted and sanitized server-side with Bun's `HTMLRewriter` (an HTML
 * parser, never a regex). The pure renderer (`src/format/diagram-block.ts`)
 * receives only the string this module returns.
 *
 * Every element and attribute falls in one of three sets: KEPT, STRIPPED BY
 * DESIGN (archify's own viewer hooks, which the reader does not run), and
 * UNKNOWN. Only the unknown set is reported (the `diagram-svg` lint finding).
 * HTMLRewriter reports attribute names lower-cased (`viewbox`, `refx`), so the
 * sets are lower-case; the browser's HTML parser restores SVG's camelCase when
 * it reads the markup.
 *
 * Every `id`, and every local reference to one (`url(#…)`, `href="#…"`, each
 * `aria-labelledby` token), is written with {@link DIAGRAM_ID_MARK} in front,
 * which the renderer replaces with a per-block prefix: two diagrams on one page
 * share `grid`, `arrowhead*` and node ids.
 */
import { DIAGRAM_CLASSES } from "../format/diagram-styles.ts";
import { DIAGRAM_ID_MARK, type DiagramSvgResult } from "../format/query-block.ts";

export { DIAGRAM_ID_MARK };

export const KEPT_ELEMENTS: ReadonlySet<string> = new Set([
  "svg", "g", "defs", "marker", "pattern", "rect", "path", "line", "polyline", "polygon",
  "circle", "ellipse", "text", "tspan", "title", "desc",
]);

const GEOMETRY = [
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "d", "points",
  "transform", "viewbox", "markerwidth", "markerheight", "refx", "refy", "orient", "patternunits",
  "preserveaspectratio", "dx", "dy",
];
const PRESENTATION = [
  "fill", "stroke", "marker-end", "marker-start", "stroke-dasharray", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity", "font-size", "font-weight",
  "font-family", "text-anchor", "dominant-baseline",
];
const HOOKS = ["class", "id", "aria-labelledby", "aria-hidden", "data-node-id", "data-edge-from", "data-edge-to"];
/** Attributes kept on every kept element. `role` is kept on the root only. */
export const KEPT_ATTRS: ReadonlySet<string> = new Set([...GEOMETRY, ...PRESENTATION, ...HOOKS, "href", "xlink:href", "xmlns", "xmlns:xlink"]);

/** Archify's viewer hooks: node interaction, the root's language and preset
 *  markers, and every `data-*` but the three the reader's views read. */
export const STRIPPED_BY_DESIGN_ATTRS: ReadonlySet<string> = new Set([
  "role", "tabindex", "aria-pressed", "aria-label", "lang", "data-preset", "data-quality-profile",
]);
const isStrippedByDesign = (name: string) => STRIPPED_BY_DESIGN_ATTRS.has(name) || name.startsWith("data-");

const CLASS_SET: ReadonlySet<string> = new Set(DIAGRAM_CLASSES);
const LOCAL_ID = /^[A-Za-z_][\w.:-]*$/;
const LOCAL_URL = /^url\(\s*#([A-Za-z_][\w.:-]*)\s*\)$/;
/** `url(` anywhere in a value: only a whole-value local `url(#id)` survives. */
const ANY_URL = /url\s*\(/i;

/** What one sanitize pass dropped, by set. Counts by name. */
export interface DiagramSvgDrops {
  strippedElements: Map<string, number>;
  strippedAttrs: Map<string, number>;
  unknownElements: Map<string, number>;
  unknownAttrs: Map<string, number>;
  unknownClasses: Map<string, number>;
}

const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** The `<svg>…</svg>` slice of an HTML file, or null unless the file holds
 *  exactly one `<svg` and one `</svg>` (a second picture, or a stray marker in
 *  a script, makes the slice ambiguous: the block falls back to its text form). */
export function extractSvgSlice(html: string): string | null {
  const open = html.indexOf("<svg");
  if (open < 0 || html.indexOf("<svg", open + 1) >= 0) return null;
  const close = html.indexOf("</svg>");
  if (close < open || html.indexOf("</svg>", close + 1) >= 0) return null;
  return html.slice(open, close + "</svg>".length);
}

/** Sanitize one `<svg>` slice. Null `svg` when the result does not start with
 *  an `<svg` element (the slice was not one). */
export async function sanitizeSvg(slice: string): Promise<{ svg: string | null; drops: DiagramSvgDrops }> {
  const drops: DiagramSvgDrops = {
    strippedElements: new Map(),
    strippedAttrs: new Map(),
    unknownElements: new Map(),
    unknownAttrs: new Map(),
    unknownClasses: new Map(),
  };
  if (slice.includes(DIAGRAM_ID_MARK)) return { svg: null, drops };
  let seenRoot = false;
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (!KEPT_ELEMENTS.has(tag)) {
          inc(drops.unknownElements, tag);
          el.remove();
          return;
        }
        // The slice starts with the root `<svg`, so the first element seen is it.
        const isRoot = !seenRoot;
        seenRoot = true;
        for (const [rawName, value] of [...el.attributes]) {
          const name = rawName.toLowerCase();
          if (name === "role" && isRoot) continue;
          if (!KEPT_ATTRS.has(name)) {
            el.removeAttribute(rawName);
            inc(isStrippedByDesign(name) ? drops.strippedAttrs : drops.unknownAttrs, name);
            continue;
          }
          const next = keptValue(name, value, drops);
          if (next === null) el.removeAttribute(rawName);
          else if (next !== value) el.setAttribute(rawName, next);
        }
      },
      comments(c) {
        c.remove();
      },
    })
    .onDocument({
      doctype() {},
    });
  // A NUL is the reader's wikilink sentinel delimiter (`page-files.ts` maps it the same way).
  const out = (await rewriter.transform(new Response(slice)).text()).trim().replaceAll("\0", "\uFFFD");
  return { svg: out.startsWith("<svg") ? out : null, drops };
}

/** A kept attribute's value after the reference and class rules, or null to
 *  drop it (an unknown drop: a value archify never writes). */
function keptValue(name: string, value: string, drops: DiagramSvgDrops): string | null {
  if (name === "id") return LOCAL_ID.test(value) ? DIAGRAM_ID_MARK + value : refuse(name, drops);
  if (name === "href" || name === "xlink:href") {
    return value.startsWith("#") && LOCAL_ID.test(value.slice(1)) ? `#${DIAGRAM_ID_MARK}${value.slice(1)}` : refuse(name, drops);
  }
  if (name === "aria-labelledby") {
    const ids = value.split(/\s+/).filter(Boolean);
    return ids.every((t) => LOCAL_ID.test(t)) ? ids.map((t) => DIAGRAM_ID_MARK + t).join(" ") : refuse(name, drops);
  }
  if (name === "class") {
    const kept: string[] = [];
    for (const c of value.split(/\s+/).filter(Boolean)) {
      if (CLASS_SET.has(c)) kept.push(c);
      else inc(drops.unknownClasses, c);
    }
    return kept.length ? kept.join(" ") : null;
  }
  if (ANY_URL.test(value)) {
    const m = LOCAL_URL.exec(value.trim());
    return m ? `url(#${DIAGRAM_ID_MARK}${m[1]})` : refuse(name, drops);
  }
  if (/javascript:/i.test(value)) return refuse(name, drops);
  return value;
}

function refuse(name: string, drops: DiagramSvgDrops): null {
  inc(drops.unknownAttrs, `${name}=<value>`);
  return null;
}

const MAX_CACHE = 200;
const cache = new Map<string, { mtimeMs: number; size: number; result: DiagramSvgResult }>();

/** The {@link DiagramSvgResult} for an HTML sibling's text, cached by the
 *  file's real path and mtime (a 700 KB archify file sanitizes once per edit). */
export async function diagramSvgFromHtml(html: string, key?: { path: string; mtimeMs: number; size: number }): Promise<DiagramSvgResult> {
  if (key) {
    const hit = cache.get(key.path);
    if (hit && hit.mtimeMs === key.mtimeMs && hit.size === key.size) return hit.result;
  }
  const result = await computeDiagramSvg(html);
  if (key) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
    cache.set(key.path, { mtimeMs: key.mtimeMs, size: key.size, result });
  }
  return result;
}

async function computeDiagramSvg(html: string): Promise<DiagramSvgResult> {
  const slice = extractSvgSlice(html);
  const empty = { unknownElements: [], unknownAttrs: [], unknownClasses: [] };
  if (!slice) return { svg: null, problem: "unparsable", ...empty };
  const { svg, drops } = await sanitizeSvg(slice);
  const names = (m: Map<string, number>) => [...m.keys()].sort();
  return {
    svg,
    ...(svg ? {} : { problem: "unparsable" as const }),
    unknownElements: names(drops.unknownElements),
    unknownAttrs: names(drops.unknownAttrs),
    unknownClasses: names(drops.unknownClasses),
  };
}
