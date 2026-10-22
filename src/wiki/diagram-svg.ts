/**
 * The `<Diagram>` picture: the one inline `<svg>` of an archify HTML file,
 * extracted and sanitized server-side. Bun's `HTMLRewriter` (an HTML parser,
 * never a regex) reads the source; the sanitizer builds its OWN tree from the
 * parse events under a fixed content model, and the output is that tree
 * serialized — never the source bytes with parts deleted. The pure renderer
 * (`src/format/diagram-block.ts`) receives only the string this module returns.
 *
 * The output is correct by construction across four dimensions, each a rule:
 *
 * 1. Attribute values. HTMLRewriter hands a value back RAW, character
 *    references undecoded, and the browser decodes them. A kept attribute whose
 *    value holds `&` in any form is refused (an unknown drop): there is no
 *    named-reference table here, and archify writes none in a kept attribute
 *    (0 in the three real files). With no `&`, the decoded value is the raw one
 *    after the tokenizer's own two rewrites (CR/CRLF to LF, NUL to U+FFFD), so
 *    every check below runs on the value the browser will hold.
 * 2. Elements. {@link CONTENT_MODEL} names, for each kept element, the kept
 *    elements it may contain and whether it holds text. An element in a
 *    position its parent does not allow is dropped with its subtree and counted
 *    (`parent>child`). `title` and `desc` hold text only: they are HTML
 *    integration points, where a child start tag would parse as an HTML
 *    element. Every element is written paired (`<x …></x>`), never self-closed.
 * 3. Text. Decoded the way the tokenizer does for a closed set of references
 *    (`&amp; &lt; &gt; &quot; &apos; &nbsp; &bull;` with `;`, and decimal or hex
 *    with `;` naming a plain scalar), a `&` that starts no reference kept as a
 *    `&`; any other reference (a semicolon-less `&lt b`, `&notit;`) drops the
 *    text node as `#charref`, since its reading depends on the full table.
 *    Text is allowed only where the content model says so; whitespace between
 *    elements is dropped.
 * 4. Line breaks. Every `\s*\n\s*` in a text or value reads as one space, the
 *    collapse `diagramViewHtml` applies to the whole string, so the output holds
 *    no line break and that collapse is a no-op on it.
 *
 * Serialization escapes `& < > "` in text and values alike, so a `<` or `"`
 * in the output is always markup this module wrote. {@link isWellFormedSanitizedSvg}
 * re-reads the output under the same model and nulls the picture if it ever
 * disagrees.
 *
 * Every attribute falls in one of three sets: KEPT, STRIPPED BY DESIGN
 * (archify's own viewer hooks, which the reader does not run), and UNKNOWN.
 * Only the unknown set is reported (the `diagram-svg` lint finding).
 * HTMLRewriter reports attribute names lower-cased, so the sets are lower-case;
 * the output restores SVG's camelCase ({@link CANONICAL_ATTR_NAME}).
 *
 * Every `id`, and every local reference to one (`url(#…)`, `href="#…"`, each
 * `aria-labelledby` token), is written with {@link DIAGRAM_ID_MARK} in front,
 * which the renderer replaces with a per-block prefix: two diagrams on one page
 * share `grid`, `arrowhead*` and node ids.
 */
import { DIAGRAM_CLASSES } from "../format/diagram-styles.ts";
import { DIAGRAM_ID_MARK, type DiagramSvgResult } from "../format/query-block.ts";

export { DIAGRAM_ID_MARK };

/** What archify draws in (its renderers and the three real files): groups,
 *  shapes and labels. */
const DRAWING = ["g", "rect", "path", "line", "polygon", "circle", "ellipse", "text"] as const;
/** What a marker or pattern tile draws with. */
const SHAPES = ["rect", "path", "line", "polygon", "circle", "ellipse"] as const;

/**
 * The content model: for each kept element, the kept elements it may contain
 * and whether it holds text. `#root` is the slice itself, which holds one svg.
 * Derived from archify's renderers (`renderers/shared/utils.mjs` defs and
 * sigils, the workflow phase line, `cli.mjs` title/desc) and the real files'
 * parent>child pairs; `marker`/`pattern` take any shape, `g` any drawing.
 */
export const CONTENT_MODEL: Readonly<Record<string, { children: ReadonlySet<string>; text: boolean }>> = (() => {
  const m = (children: readonly string[], text = false) => ({ children: new Set(children), text });
  return {
    "#root": m(["svg"]),
    svg: m(["title", "desc", "defs", ...DRAWING]),
    g: m(["title", ...DRAWING]),
    defs: m(["marker", "pattern"]),
    marker: m(SHAPES),
    pattern: m(SHAPES),
    text: m([], true),
    title: m([], true),
    desc: m([], true),
    ...Object.fromEntries(SHAPES.map((s) => [s, m([])])),
  };
})();

export const KEPT_ELEMENTS: ReadonlySet<string> = new Set(Object.keys(CONTENT_MODEL).filter((k) => k !== "#root"));

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

/** HTMLRewriter reports attribute names lower-cased; the output restores SVG's
 *  camelCase for the names that carry it (the browser's own foreign-content
 *  adjustment), so the bytes read markerWidth, refX, viewBox. */
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
/** A raw-text escaping element (`<plaintext>`, `<xmp>`) makes the source parser
 *  read everything after it as text: refused, like CDATA, rather than healed. */
const RAW_TEXT_ELEMENT = /<(?:plaintext|xmp)\b/i;

/** The tokenizer's input-stream rewrites (CR/CRLF to LF, NUL to U+FFFD), then
 *  the renderer's line-break collapse. */
const normalize = (s: string) => s.replace(/\r\n?/g, "\n").replaceAll("\0", "�").replace(/\s*\n\s*/g, " ");

/** The references text may carry, decoded; with `;` only. */
const NAMED_REFS: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", bull: "•" };
const NUMERIC_REF = /^#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));/;
const NAMED_REF = /^(amp|lt|gt|quot|apos|nbsp|bull);/;

/** A code point a numeric reference decodes to as itself: tab, LF, printable
 *  ASCII, and every scalar from U+00A0 that is no surrogate and no
 *  noncharacter. NUL, CR, the C0/C1 controls (C1 maps through windows-1252)
 *  and the rest have a reading of their own, so they are refused. */
function plainScalar(cp: number): boolean {
  if (cp === 0x9 || cp === 0xa) return true;
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp < 0xa0 || cp > 0x10ffff) return false;
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  if (cp >= 0xfdd0 && cp <= 0xfdef) return false;
  return (cp & 0xfffe) !== 0xfffe;
}

/** A text node's raw bytes as the browser reads them, or null when it holds a
 *  reference outside the closed set (see the module's rule 3). */
export function decodeText(raw: string): string | null {
  let out = "";
  let i = 0;
  for (;;) {
    const amp = raw.indexOf("&", i);
    if (amp < 0) return normalize(out + raw.slice(i));
    out += raw.slice(i, amp);
    const rest = raw.slice(amp + 1);
    const num = NUMERIC_REF.exec(rest);
    if (num) {
      const cp = num[1] !== undefined ? parseInt(num[1], 10) : parseInt(num[2]!, 16);
      if (!plainScalar(cp)) return null;
      out += String.fromCodePoint(cp);
      i = amp + 1 + num[0].length;
      continue;
    }
    const named = NAMED_REF.exec(rest);
    if (named) {
      out += NAMED_REFS[named[1]!];
      i = amp + 1 + named[0].length;
      continue;
    }
    // `&` + alphanumeric or `#` starts a reference this module cannot read; any
    // other `&` is a literal one in the tokenizer too.
    if (/^[A-Za-z0-9#]/.test(rest)) return null;
    out += "&";
    i = amp + 1;
  }
}

/** A kept attribute's raw value as the browser reads it, or null when it holds
 *  any `&` (see the module's rule 1). */
export function decodeAttrValue(raw: string): string | null {
  return raw.includes("&") ? null : normalize(raw);
}

/** Text and attribute values alike: every byte that could be read as markup. */
const escapeMarkup = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** One element of the sanitizer's tree: a kept name, kept attributes (canonical
 *  names, decoded values, source order) and children (a string is text). */
export interface SvgTreeNode {
  tag: string;
  attrs: [string, string][];
  kids: (SvgTreeNode | string)[];
}

/** The tree as markup: every element paired, every value double-quoted, `& < > "`
 *  escaped everywhere. */
export function serializeSvgTree(node: SvgTreeNode): string {
  const attrs = node.attrs.map(([n, v]) => ` ${n}="${escapeMarkup(v)}"`).join("");
  const kids = node.kids.map((k) => (typeof k === "string" ? escapeMarkup(k) : serializeSvgTree(k))).join("");
  return `<${node.tag}${attrs}>${kids}</${node.tag}>`;
}

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

/**
 * Sanitize one `<svg>` slice: build the tree under {@link CONTENT_MODEL}, then
 * serialize it. Null `svg` (and `tree`) when the slice holds the id mark
 * (`problem: "id-mark"`, so the author is told what is wrong), a CDATA section
 * or a raw-text escaping element, when no root svg was kept, or when the
 * self-check refuses the serialized string.
 *
 * `serialize` exists for the test that pins the self-check call; callers never
 * pass it.
 */
export async function sanitizeSvg(
  slice: string,
  serialize: (tree: SvgTreeNode) => string = serializeSvgTree,
): Promise<{ svg: string | null; tree: SvgTreeNode | null; drops: DiagramSvgDrops; problem?: "id-mark" }> {
  const drops: DiagramSvgDrops = {
    strippedElements: new Map(),
    strippedAttrs: new Map(),
    unknownElements: new Map(),
    unknownAttrs: new Map(),
    unknownClasses: new Map(),
  };
  const none = { svg: null, tree: null, drops };
  if (slice.includes(DIAGRAM_ID_MARK)) return { ...none, problem: "id-mark" };
  if (CDATA.test(slice)) {
    inc(drops.unknownElements, "#cdata");
    return none;
  }
  if (RAW_TEXT_ELEMENT.test(slice)) {
    inc(drops.unknownElements, "#rawtext");
    return none;
  }
  const root: SvgTreeNode = { tag: "#root", attrs: [], kids: [] };
  const stack: SvgTreeNode[] = [root];
  // >0 inside a dropped element's subtree: its descendants, kept or not, are
  // dropped with it. Only the outermost dropped element tracks its end tag.
  let skipDepth = 0;
  let text = "";

  const addText = (raw: string) => {
    const parent = stack[stack.length - 1]!;
    const decoded = decodeText(raw);
    if (decoded === null) {
      inc(drops.unknownElements, "#charref");
      return;
    }
    if (!CONTENT_MODEL[parent.tag]!.text) {
      // Whitespace between elements is layout in the source, nothing drawn.
      if (!/^[\t\n\f\r ]*$/.test(raw)) inc(drops.unknownElements, `${parent.tag}>#text`);
      return;
    }
    if (decoded.includes(DIAGRAM_ID_MARK)) {
      inc(drops.unknownElements, "#charref");
      return;
    }
    if (decoded === "") return;
    const kids = parent.kids;
    if (typeof kids[kids.length - 1] === "string") kids[kids.length - 1] += decoded;
    else kids.push(decoded);
  };

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (skipDepth > 0) {
          if (!KEPT_ELEMENTS.has(tag)) inc(drops.unknownElements, tag);
          return;
        }
        const parent = stack[stack.length - 1]!;
        const allowed = KEPT_ELEMENTS.has(tag) && CONTENT_MODEL[parent.tag]!.children.has(tag) && !(parent === root && root.kids.length > 0);
        if (!allowed) {
          inc(drops.unknownElements, KEPT_ELEMENTS.has(tag) ? `${parent.tag}>${tag}` : tag);
          if (!el.selfClosing && registerEnd(el, () => skipDepth--)) skipDepth++;
          return;
        }
        const node: SvgTreeNode = { tag, attrs: keptAttrs(el.attributes, parent === root, drops), kids: [] };
        parent.kids.push(node);
        // An end tag closes this element and anything still open inside it.
        if (!el.selfClosing && registerEnd(el, () => {
          const at = stack.lastIndexOf(node);
          if (at > 0) stack.length = at;
        })) {
          stack.push(node);
        }
      },
      comments(c) {
        c.remove();
      },
    })
    .onDocument({
      doctype() {},
      // One text node may arrive in several chunks: decode it whole, so a split
      // reference is read as one.
      text(chunk) {
        text += chunk.text;
        if (!chunk.lastInTextNode) return;
        if (skipDepth === 0) addText(text);
        text = "";
      },
    });
  // The rewriter's own transformed output is discarded: the tree is the result.
  await rewriter.transform(new Response(slice)).text();
  const tree = root.kids[0];
  if (!tree || typeof tree === "string") return none;
  const out = serialize(tree);
  return isWellFormedSanitizedSvg(out) ? { svg: out, tree, drops } : none;
}

/** The kept attributes of one element, decoded and checked, first occurrence
 *  of a name winning (the tokenizer drops a repeated name the same way). */
function keptAttrs(attributes: Iterable<[string, string]>, isRoot: boolean, drops: DiagramSvgDrops): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const [rawName, raw] of attributes) {
    const name = rawName.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    const keptHere = KEPT_ATTRS.has(name) || (name === "role" && isRoot);
    if (!keptHere) {
      inc(isStrippedByDesign(name) ? drops.strippedAttrs : drops.unknownAttrs, name);
      continue;
    }
    const value = decodeAttrValue(raw);
    const next = value === null ? refuse(name, drops) : name === "role" ? value : keptValue(name, value, drops);
    if (next !== null) out.push([canonicalAttr(name), next]);
  }
  return out;
}

/** A kept attribute's decoded value after the reference and class rules, or
 *  null to drop it (an unknown drop: a value archify never writes). */
function keptValue(name: string, value: string, drops: DiagramSvgDrops): string | null {
  if (name === "id") return LOCAL_ID.test(value) ? DIAGRAM_ID_MARK + value : refuse(name, drops);
  if (name === "href" || name === "xlink:href") {
    return value.startsWith("#") && LOCAL_ID.test(value.slice(1)) ? `#${DIAGRAM_ID_MARK}${value.slice(1)}` : refuse(name, drops);
  }
  if (name === "aria-labelledby") {
    const ids = value.split(/\s+/).filter(Boolean);
    return ids.length && ids.every((t) => LOCAL_ID.test(t)) ? ids.map((t) => DIAGRAM_ID_MARK + t).join(" ") : refuse(name, drops);
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

const START_TAG = /^<([a-z]+)((?: [A-Za-z][\w:-]*="[^<>"]*")*)>/;
const END_TAG = /^<\/([a-z]+)>/;
const ATTR = / ([A-Za-z][\w:-]*)="([^<>"]*)"/g;
/** A run of text or a value: no markup byte, and `&` only in the four escapes. */
const ESCAPED = /^(?:[^<>"&]|&(?:amp|lt|gt|quot);)*$/;

/**
 * The sanitizer's self-check: re-read the output under {@link CONTENT_MODEL}
 * and answer whether it has the shape the serializer writes. One root `<svg>`
 * and nothing after it; every element kept, allowed in its parent, written as
 * a start tag with allowlisted, double-quoted, escaped attributes (`role` on
 * the root only) and closed by its own end tag in nesting order, never
 * self-closed; text only where the parent holds text, escaped. Anything else
 * answers false, so a regression in structure or escaping fails closed. It
 * checks names and escaping only: an attribute value that breaks the `url(`,
 * `href`, id or class rules, or a repeated attribute, still passes.
 */
export function isWellFormedSanitizedSvg(out: string): boolean {
  const stack: string[] = ["#root"];
  let rootSeen = false;
  let i = 0;
  while (i < out.length) {
    const lt = out.indexOf("<", i);
    const run = out.slice(i, lt < 0 ? out.length : lt);
    if (run) {
      if (!CONTENT_MODEL[stack[stack.length - 1]!]!.text || !ESCAPED.test(run)) return false;
    }
    if (lt < 0) break;
    const rest = out.slice(lt);
    const end = END_TAG.exec(rest);
    if (end) {
      if (stack.length < 2 || stack.pop() !== end[1]) return false;
      i = lt + end[0].length;
      continue;
    }
    const start = START_TAG.exec(rest);
    if (!start) return false;
    const tag = start[1]!;
    const parent = stack[stack.length - 1]!;
    if (!KEPT_ELEMENTS.has(tag) || !CONTENT_MODEL[parent]!.children.has(tag)) return false;
    const isRoot = parent === "#root";
    if (isRoot) {
      if (rootSeen) return false;
      rootSeen = true;
    }
    for (const a of start[2]!.matchAll(ATTR)) {
      const name = a[1]!.toLowerCase();
      if (!(KEPT_ATTRS.has(name) || (name === "role" && isRoot)) || !ESCAPED.test(a[2]!)) return false;
    }
    stack.push(tag);
    i = lt + start[0].length;
  }
  return rootSeen && stack.length === 1;
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
  const { svg, drops, problem } = await sanitizeSvg(slice);
  const names = (m: Map<string, number>) => [...m.keys()].sort();
  return {
    svg,
    ...(svg ? {} : { problem: problem ?? ("unparsable" as const) }),
    unknownElements: names(drops.unknownElements),
    unknownAttrs: names(drops.unknownAttrs),
    unknownClasses: names(drops.unknownClasses),
  };
}
