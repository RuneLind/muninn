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

/** HTMLRewriter reports attribute names lower-cased, so a rebuild must restore
 *  SVG's camelCase for the names that carry it — the browser's own foreign-
 *  content attribute adjustment, applied here so the serialized bytes read the
 *  way the e2e and the drawnSize reader expect (markerWidth, refX, viewBox). */
const CANONICAL_ATTR_NAME: Readonly<Record<string, string>> = {
  viewbox: "viewBox",
  markerwidth: "markerWidth",
  markerheight: "markerHeight",
  refx: "refX",
  refy: "refY",
  patternunits: "patternUnits",
  preserveaspectratio: "preserveAspectRatio",
};
const canonicalAttr = (name: string) => CANONICAL_ATTR_NAME[name] ?? name;

const CLASS_SET: ReadonlySet<string> = new Set(DIAGRAM_CLASSES);
const LOCAL_ID = /^[A-Za-z_][\w.:-]*$/;
const LOCAL_URL = /^url\(\s*#([A-Za-z_][\w.:-]*)\s*\)$/;
/** `url(` anywhere in a value: only a whole-value local `url(#id)` survives. */
const ANY_URL = /url\s*\(/i;
// A CSS escape, a function call or a comment: in a presentation value each can
// spell a remote reference past ANY_URL (`u\72 l(...)`, `ur/**/l(...)`, `image(...)`).
const CSS_SYNTAX = /[\\(]|\/\*/;
const PRESENTATION_SET: ReadonlySet<string> = new Set(PRESENTATION);
/** A CDATA section in SVG is text the parser hands through raw: it is refused. */
const CDATA = /<!\[CDATA\[/i;
/** A raw-text escaping element (`<plaintext>`, `<xmp>`) makes a browser read
 *  everything after it as text, so the one `</svg>` the slice is sliced on no
 *  longer closes the root there: refused, like CDATA, rather than healed. */
const RAW_TEXT_ELEMENT = /<(?:plaintext|xmp)\b/i;
/** `&` that does not start a character reference. */
const BARE_AMP = /&(?!(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);)/g;
const escapeText = (t: string) => t.replace(BARE_AMP, "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/** An attribute value in a double-quoted context: as `escapeText`, plus `"`.
 *  HTMLRewriter never hands back a value with a literal `"` (the parser ends the
 *  value at one), so the `"` arm is a belt-and-braces guard, never load-bearing;
 *  the `<`/`>`/bare-`&` arms re-serialize what a value may legally carry raw. */
const escapeAttr = (v: string) => escapeText(v).replaceAll('"', "&quot;");

/** What one sanitize pass dropped, by set. Counts by name. */
export interface DiagramSvgDrops {
  strippedElements: Map<string, number>;
  strippedAttrs: Map<string, number>;
  unknownElements: Map<string, number>;
  unknownAttrs: Map<string, number>;
  unknownClasses: Map<string, number>;
}

const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** Register an end-tag handler, returning false when the element has none
 *  (`onEndTag` throws "No end tag" for a void or raw-text element). */
function registerEnd(el: { onEndTag(cb: () => void): void }, cb: () => void): boolean {
  try {
    el.onEndTag(cb);
    return true;
  } catch {
    return false;
  }
}

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

/** Sanitize one `<svg>` slice. Null `svg` when the slice holds a CDATA section,
 *  or the rebuilt output does not start with an `<svg` element and end with
 *  `</svg>`, or the final structural self-check fails.
 *
 *  The output is REBUILT from HTMLRewriter's parse events — a start tag I write
 *  from kept, re-escaped attributes, an end tag I write from my own open stack,
 *  escaped text, nothing else — never the source bytes with parts deleted. So a
 *  stray, unmatched or attribute-carrying end tag, a comment, a doctype, a PI or
 *  CDATA produces no output at all (it is dropped; a stray end tag is not an
 *  element event, so it is not counted — see the PR Decisions). The parser's
 *  corrected tree is what I re-emit, so the result is well-formed by
 *  construction, and no `<`/`>`/`"` in it is anything but a tag I wrote. The
 *  self-check at the end makes a future regression fail closed. */
export async function sanitizeSvg(slice: string): Promise<{ svg: string | null; drops: DiagramSvgDrops }> {
  const drops: DiagramSvgDrops = {
    strippedElements: new Map(),
    strippedAttrs: new Map(),
    unknownElements: new Map(),
    unknownAttrs: new Map(),
    unknownClasses: new Map(),
  };
  if (slice.includes(DIAGRAM_ID_MARK)) return { svg: null, drops };
  if (CDATA.test(slice)) {
    inc(drops.unknownElements, "#cdata");
    return { svg: null, drops };
  }
  if (RAW_TEXT_ELEMENT.test(slice)) {
    inc(drops.unknownElements, "#rawtext");
    return { svg: null, drops };
  }
  let out = "";
  let text = "";
  let seenRoot = false;
  // Suppress output inside a dropped (unknown) element's subtree, including its
  // kept descendants, which the old `el.remove()` also dropped. The dropped
  // element's own end tag decrements it; a kept element inside skip emits
  // nothing and registers no end tag, so it never writes an orphan close.
  let skipDepth = 0;
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        const selfClosing = el.selfClosing;
        if (skipDepth > 0 || !KEPT_ELEMENTS.has(tag)) {
          // Dropped: emit nothing. An unknown element is counted wherever it
          // sits (the lint reports it), but only the OUTERMOST dropped element
          // opens a skip region — a dropped or kept descendant is already
          // suppressed by it, so it tracks no end tag of its own.
          if (!KEPT_ELEMENTS.has(tag)) inc(drops.unknownElements, tag);
          if (skipDepth === 0 && !selfClosing && registerEnd(el, () => skipDepth--)) skipDepth++;
          return;
        }
        // The slice starts with the root `<svg`, so the first kept element is it.
        const isRoot = !seenRoot;
        seenRoot = true;
        let attrs = "";
        for (const [rawName, value] of [...el.attributes]) {
          const name = rawName.toLowerCase();
          if (name === "role" && isRoot) {
            attrs += ` role="${escapeAttr(value)}"`;
            continue;
          }
          if (!KEPT_ATTRS.has(name)) {
            inc(isStrippedByDesign(name) ? drops.strippedAttrs : drops.unknownAttrs, name);
            continue;
          }
          const next = keptValue(name, value, drops);
          if (next !== null) attrs += ` ${canonicalAttr(name)}="${escapeAttr(next)}"`;
        }
        // A kept element with no end tag (void, or implicitly closed at EOF with
        // no event) is emitted self-closed, so the output never carries a start
        // tag it does not close.
        const paired = !selfClosing && registerEnd(el, () => (out += `</${tag}>`));
        out += paired ? `<${tag}${attrs}>` : `<${tag}${attrs}/>`;
      },
      comments(c) {
        c.remove();
      },
    })
    .onDocument({
      doctype() {},
      // One text node may arrive in several chunks: escape it whole, so a split
      // character reference is not read as a bare `&`. The handler fires for
      // text inside a dropped element too, so it is emitted only outside skip.
      text(chunk) {
        text += chunk.text;
        if (!chunk.lastInTextNode) return;
        if (skipDepth === 0) out += escapeText(text);
        text = "";
      },
    });
  // The rewriter's own transformed output is discarded: `out` is the rebuild.
  await rewriter.transform(new Response(slice)).text();
  // A NUL is the reader's wikilink sentinel delimiter (`page-files.ts` maps it the same way).
  out = out.trim().replaceAll("\0", "\uFFFD");
  const ok = out.startsWith("<svg") && out.endsWith("</svg>") && isWellFormedSanitizedSvg(out);
  return { svg: ok ? out : null, drops };
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
  if (PRESENTATION_SET.has(name) && CSS_SYNTAX.test(value)) return refuse(name, drops);
  if (/javascript:/i.test(value)) return refuse(name, drops);
  return value;
}

function refuse(name: string, drops: DiagramSvgDrops): null {
  inc(drops.unknownAttrs, `${name}=<value>`);
  return null;
}

/** A start tag of a kept element: name, then zero or more ` name="value"`
 *  attributes whose value is double-quoted and holds no raw `<`, `>` or `"`
 *  (a `&` is kept — it begins an escaped entity), then an optional `/` and `>`.
 *  Anchored whole. */
const WELL_FORMED_START = /^<([a-z][\w:-]*)((?:\s+[a-z][\w:-]*="[^<>"]*")*)\s*\/?>$/;
const WELL_FORMED_END = /^<\/([a-z][\w:-]*)>$/;
const WELL_FORMED_ATTR = /\s+([a-z][\w:-]*)="[^<>"]*"/g;

/**
 * The sanitizer's structural self-check: re-tokenize the output and confirm it
 * is only start tags of kept elements (with allowlisted, double-quoted,
 * escaped attributes), end tags that close an element opened earlier in
 * nesting order and carry no attributes, and escaped text with no raw `<`/`>`.
 * A single root `<svg>` must wrap it all. Any other shape — a stray or
 * attribute-carrying end tag, a comment, an unknown element or attribute, a raw
 * markup byte — answers false, so a future regression in {@link sanitizeSvg}
 * fails closed instead of inlining the malformed bytes.
 *
 * The output never puts `<`/`>`/`"` inside an attribute value (escaped), so the
 * `<[^>]*>` tokenizer is exact here; a malformed string that does would make a
 * token that fails {@link WELL_FORMED_START}/`_END`, i.e. still fail closed.
 */
export function isWellFormedSanitizedSvg(out: string): boolean {
  const stack: string[] = [];
  let i = 0;
  let sawRoot = false;
  while (i < out.length) {
    const lt = out.indexOf("<", i);
    if (lt < 0) {
      // Trailing text must be escaped (no raw `<`/`>`; `>` cannot appear here).
      return !/[<>]/.test(out.slice(i));
    }
    // Text between tags: no raw `<` (we're at the next `<`) is guaranteed; a raw
    // `>` in it would be a markup byte that escaping should have removed.
    if (out.slice(i, lt).includes(">")) return false;
    const gt = out.indexOf(">", lt);
    if (gt < 0) return false;
    const tag = out.slice(lt, gt + 1);
    if (tag.startsWith("<!") || tag.startsWith("<?")) return false; // comment, doctype, PI
    if (tag[1] === "/") {
      const m = WELL_FORMED_END.exec(tag);
      if (!m) return false; // an end tag with attributes, or a malformed one
      if (stack.pop() !== m[1]) return false; // unmatched or mis-nested
    } else {
      const m = WELL_FORMED_START.exec(tag);
      if (!m) return false;
      const name = m[1]!;
      if (!KEPT_ELEMENTS.has(name)) return false;
      // Every attribute name must be allowlisted (role allowed on the root only).
      // Names are re-emitted in SVG camelCase, so fold to the lower-case allowlist.
      for (const am of (m[2] ?? "").matchAll(WELL_FORMED_ATTR)) {
        const an = am[1]!.toLowerCase();
        if (an === "role") {
          if (sawRoot) return false;
        } else if (!KEPT_ATTRS.has(an)) {
          return false;
        }
      }
      if (name === "svg" && sawRoot) return false; // only one root
      if (name !== "svg" && !sawRoot) return false; // nothing before the root
      sawRoot = true;
      const selfClosing = tag.endsWith("/>");
      if (!selfClosing) stack.push(name);
    }
    i = gt + 1;
  }
  return sawRoot && stack.length === 0;
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
