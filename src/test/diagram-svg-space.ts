/**
 * The input space of the `<Diagram>` picture, enumerated: what an archify
 * HTML sibling can put into `src/wiki/diagram-svg.ts`, and what a page body
 * can put around the picture `src/wiki/render.ts` parks and restores.
 *
 * Five dimensions, each enumerated exhaustively over a fixed alphabet, plus a
 * seeded random soup that mixes them:
 *   attr    — kept attribute names × values in every character-reference form × quoting
 *   element — every parent position × kept, dropped, void, raw-text, integration-point
 *             and breakout children × paired, self-closed and unclosed forms
 *   text    — text in every reference form × every parent
 *   page    — NUL tokens in prose, links, code spans, fences, headings, lists, tables
 *             and callouts × no, one or two diagrams around them
 *   soup    — seeded random trees over all of the above
 *
 * Pure data: no Bun API, so the Chromium spec's builder
 * (`e2e/diagram-sanitizer-build.ts`) and the `bun test` over the sanitizer's own
 * tree (`src/wiki/diagram-svg-space.test.ts`) read the same cases. Every remote
 * reference names {@link PROBE_ORIGIN}, which the spec routes and counts and
 * never lets out.
 */

export const PROBE_ORIGIN = "http://dgm-probe.test";
const P = PROBE_ORIGIN;

/** The text that must stay visible after every picture. */
export const AFTER_MARK = "AFTERMARK";

export type SpaceDim = "attr" | "element" | "text" | "page" | "soup";

export interface SpaceCase {
  id: string;
  dim: SpaceDim;
  /** One archify-shaped HTML body per `<Diagram>` on the page, in order
   *  (`./d0.architecture.json`, `./d1.architecture.json`). */
  slices: string[];
  /** The page's markdown. */
  body: string;
  /** Text the rendered page must show outside any picture. */
  mustShow: string[];
}

/** A diagram block on the page, for slice `i`. */
export const diagramRef = (i: number) => `./d${i}.architecture.json`;
const block = (i: number) => `<Diagram src="${diagramRef(i)}" />`;

const svgOf = (inner: string, rootAttrs = 'viewBox="0 0 10 10"') => `<svg xmlns="http://www.w3.org/2000/svg" ${rootAttrs}>${inner}</svg>`;

const pageWith = (slicesCount: number, extra = "") =>
  ["# P", "", "BEFOREMARK", "", extra, "", ...Array.from({ length: slicesCount }, (_, i) => [block(i), ""]).flat(), `${AFTER_MARK} closing words.`, ""].join("\n");

// ---------------------------------------------------------------- attributes

/** Kept attribute names, one per rule the sanitizer applies to a value. */
export const ATTR_NAMES = ["fill", "stroke", "marker-end", "font-family", "d", "transform", "x", "id", "href", "xlink:href", "class", "aria-labelledby"] as const;

/** Attribute values as written in the source, before quoting. Every way to
 *  spell `(`, `\`, `/`, `#`, `"`, `<`, `>`, `&`, NUL and a line break, named
 *  (with and without `;`), decimal, hex, zero-padded and unterminated. */
export const ATTR_VALUES: readonly string[] = [
  "url(#ok)", "red", "1", "#ok", "c-frontend", "c-frontend mystery", "t d",
  `url(${P}/a.svg#p)`,
  `url&#40;${P}/a.svg#p)`, `url&#x28;${P}/a.svg#p)`, `url&#X28;${P}/a.svg#p)`, `url&#0040;${P}/a.svg#p)`,
  `url&lpar;${P}/a.svg#p)`, `url&#40${P}/a.svg#p)`, `u&#114;l(${P}/a.svg#p)`, `&#117;rl(${P}/a.svg#p)`,
  `u\\72 l(${P}/a.svg#p)`, `u&#92;72 l(${P}/a.svg#p)`, `u&bsol;72 l(${P}/a.svg#p)`, `u&#x5c;72 l(${P}/a.svg#p)`,
  `ur&#47;**&#47;l(${P}/a.svg#p)`, `ur/**/l(${P}/a.svg#p)`, `image(${P}/i.png)`,
  "&#35;ok", "url(&#35;ok)", "javascript:alert(1)", "java&#115;cript:alert(1)",
  'a"b', "a&quot;b", "a&quot b", "a'b", "a&apos;b", "a<b", "a&lt;b", "a&lt b", "a>b", "a&gt;b",
  "a&amp;b", "a&ampb", "a&amp", "&notit;", "&notin;", "a&b", "a&",
  "a\0b", "a&#0;b", "a&#x110000;b", "a&#128;b", "a&#13;b", "a\r\nb", "a\nb", "a\tb", "",
];

type Quote = '"' | "'" | "";
const QUOTES: readonly Quote[] = ['"', "'", ""];

/** The attribute as written, or null when the quoting cannot carry the value. */
export function writeAttr(name: string, value: string, q: Quote): string | null {
  if (q === '"' && value.includes('"')) return null;
  if (q === "'" && value.includes("'")) return null;
  if (q === "" && (value === "" || /[\s"'=<>`]/.test(value))) return null;
  return `${name}=${q}${value}${q}`;
}

function attrCases(): SpaceCase[] {
  const out: SpaceCase[] = [];
  let n = 0;
  for (const name of ATTR_NAMES) {
    for (const value of ATTR_VALUES) {
      for (const q of QUOTES) {
        const a = writeAttr(name, value, q);
        if (a === null) continue;
        // A rendered rect, so a paint server is fetched if it survives; a path, so a marker is.
        const host = name === "marker-end" || name === "href" || name === "xlink:href" || name === "d" ? "path" : "rect";
        const geo = host === "path" ? (name === "d" ? "" : 'd="M0 0L5 5" stroke="black"') : 'width="5" height="5"';
        const inner =
          `<defs><marker id="ok" markerWidth="4" markerHeight="4" refX="2" refY="2"><polygon points="0 0, 4 2, 0 4"></polygon></marker>` +
          `<pattern id="p" width="2" height="2" patternUnits="userSpaceOnUse"><path d="M0 0L2 2"></path></pattern></defs>` +
          `<${host} ${geo} ${a}></${host}><rect x="6" y="6" width="2" height="2" class="c-frontend"></rect>`;
        out.push({ id: `attr-${n++}`, dim: "attr", slices: [svgOf(inner)], body: pageWith(1), mustShow: [] });
      }
    }
  }
  // The root's own attributes: role (kept on the root only) and viewBox.
  for (const value of ATTR_VALUES) {
    for (const q of QUOTES) {
      const role = writeAttr("role", value, q);
      const vb = writeAttr("viewBox", value, q);
      if (role) out.push({ id: `attr-${n++}`, dim: "attr", slices: [svgOf('<rect width="5" height="5"></rect>', `viewBox="0 0 10 10" ${role}`)], body: pageWith(1), mustShow: [] });
      if (vb) out.push({ id: `attr-${n++}`, dim: "attr", slices: [svgOf('<rect width="5" height="5"></rect>', vb)], body: pageWith(1), mustShow: [] });
    }
  }
  return out;
}

// ------------------------------------------------------------------ elements

/** How to reach each parent position in the source. `%` is the hole. */
export const PARENTS: Readonly<Record<string, string>> = {
  svg: "%",
  g: "<g>%</g>",
  defs: "<defs>%</defs>",
  marker: '<defs><marker id="m" markerWidth="4" markerHeight="4">%</marker></defs>',
  pattern: '<defs><pattern id="pt" width="2" height="2">%</pattern></defs>',
  text: '<text x="1" y="5">%</text>',
  title: "<title>%</title>",
  desc: "<desc>%</desc>",
  rect: '<rect width="5" height="5">%</rect>',
  path: '<path d="M0 0L5 5">%</path>',
  line: '<line x1="0" y1="0" x2="5" y2="5">%</line>',
  polygon: '<polygon points="0 0, 4 2, 0 4">%</polygon>',
  circle: '<circle cx="5" cy="5" r="2">%</circle>',
  ellipse: '<ellipse cx="5" cy="5" rx="2" ry="1">%</ellipse>',
  // Inside a dropped subtree, a kept element must stay dropped.
  foreignObject: "<foreignObject>%</foreignObject>",
  a: '<a href="#x">%</a>',
};

/** Children by kind. `svg` itself is left out: a second `<svg` makes the slice ambiguous (no picture). */
export const CHILDREN: Readonly<Record<string, readonly string[]>> = {
  kept: ["g", "defs", "marker", "pattern", "rect", "path", "line", "polygon", "circle", "ellipse", "text", "title", "desc"],
  formerlyKept: ["tspan", "polyline"],
  dropped: ["script", "style", "foreignObject", "image", "use", "a", "switch", "animate", "set", "filter", "lineargradient", "textPath", "mystery"],
  void: ["br", "img", "input", "hr", "meta", "link", "embed", "source"],
  rawText: ["textarea", "xmp", "noscript", "iframe", "noembed", "noframes"],
  breakout: ["p", "b", "div", "table", "span", "h1", "ul", "font"],
};

type Form = "paired" | "self" | "unclosed";
const FORMS: readonly Form[] = ["paired", "self", "unclosed"];

/** One child element in a form, carrying a probe attribute and remote refs. */
export function writeChild(tag: string, form: Form): string {
  const attrs = `data-probe="1" width="2" height="2" x="1" y="1" class="c-backend" fill="url(#ok)" src="${P}/c.png" href="${P}/c.svg#c" color="red"`;
  if (form === "self") return `<${tag} ${attrs}/>`;
  if (form === "unclosed") return `<${tag} ${attrs}>kid`;
  return `<${tag} ${attrs}>kid</${tag}>`;
}

function elementCases(): SpaceCase[] {
  const out: SpaceCase[] = [];
  let n = 0;
  for (const [parent, shape] of Object.entries(PARENTS)) {
    for (const kids of Object.values(CHILDREN)) {
      for (const child of kids) {
        for (const form of FORMS) {
          const inner = shape.replace("%", writeChild(child, form)) + '<rect x="6" y="6" width="2" height="2" class="c-frontend"></rect><text x="1" y="9">tail</text>';
          out.push({ id: `element-${n++}`, dim: "element", slices: [svgOf(inner)], body: pageWith(1), mustShow: [] });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------- text

/** Text as written in the source: every reference form, the markup bytes, NUL and line breaks. */
export const TEXT_FORMS: readonly string[] = [
  "plain", "a < b", "a > b", "a & b", "a &amp; b", "&lt;x&gt;", "&lt x", "&ltx", "&amp", "&ampx", "&notit;", "&notin;",
  "&bull;", "&nbsp;x", "&#65;", "&#x41;", "&#X41;", "&#0065;", "&#65", "&#0;", "&#x110000;", "&#xD800;", "&#128;",
  "&#13;", "&#10;", "&#9;", "a\0b", "a\r\nb", "a\rb", "a\n  b", "&#60;rect/&#62;", "&lt;title/&gt;", "&lt;/svg&gt;",
  "  ", "&quot;&apos;", "&;", "&#;", "&#x;", "a&", " \n ",
];

const TEXT_PARENTS = ["text", "title", "desc", "g", "svg", "rect", "marker"] as const;

function textCases(): SpaceCase[] {
  const out: SpaceCase[] = [];
  let n = 0;
  for (const parent of TEXT_PARENTS) {
    for (const t of TEXT_FORMS) {
      const inner = PARENTS[parent]!.replace("%", t) + '<text x="1" y="9">tail</text>';
      out.push({ id: `text-${n++}`, dim: "text", slices: [svgOf(inner)], body: pageWith(1), mustShow: [] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------- page

/** A picture with every kind of id reference, the one each page case draws. */
export const PAGE_PICTURE = svgOf(
  '<title id="t">T</title><desc id="d">D</desc><defs><marker id="ah" markerWidth="4" markerHeight="4" refX="2" refY="2"><polygon points="0 0, 4 2, 0 4"></polygon></marker></defs>' +
    '<g data-node-id="a"><rect width="5" height="5" class="c-frontend"></rect><text x="1" y="4" class="t-primary">A</text></g>' +
    '<path d="M0 0L5 5" class="a-default" marker-end="url(#ah)" data-edge-from="a" data-edge-to="b"></path>',
  'viewBox="0 0 10 10" role="img" aria-labelledby="t d"',
);

/** NUL-delimited strings a page could carry: the picture's and the wikilink's parking tokens. */
export const PAGE_TOKENS: readonly string[] = ["\0DGMPIC0\0", "\0DGMPIC1\0", "\0WIKIPAGELINK0\0", "\0", "\0DGMPIC0"];

/** Each place a token can sit, as markdown. */
export const PAGE_POSITIONS: Readonly<Record<string, (t: string) => string>> = {
  prose: (t) => `Prose ${t} end.`,
  linkHref: (t) => `[click](https://example.com/${t})`,
  linkText: (t) => `[x${t}y](https://example.com/)`,
  codeSpan: (t) => "`code " + t + "`",
  fence: (t) => "```\nfence " + t + "\n```",
  heading: (t) => `## H ${t}`,
  list: (t) => `- item ${t}`,
  table: (t) => `| a |\n|---|\n| ${t} |`,
  callout: (t) => `> [!note] T ${t}\n> body`,
};

/** The letters of a token as the page must show them (a NUL is dropped). */
const tokenLetters = (t: string) => t.replace(/\0/g, "").trim();

function pageCases(): SpaceCase[] {
  const out: SpaceCase[] = [];
  let n = 0;
  for (const t of PAGE_TOKENS) {
    for (const [pos, write] of Object.entries(PAGE_POSITIONS)) {
      for (const placement of ["none", "before", "after", "two"] as const) {
        const slices = placement === "none" ? [] : placement === "two" ? [PAGE_PICTURE, PAGE_PICTURE] : [PAGE_PICTURE];
        const tokenMd = write(t);
        const blocks = slices.map((_, i) => block(i));
        const parts =
          placement === "before" ? [blocks[0]!, tokenMd] : placement === "after" ? [tokenMd, blocks[0]!] : placement === "two" ? [blocks[0]!, tokenMd, blocks[1]!] : [tokenMd];
        const body = ["# P", "", "BEFOREMARK", "", ...parts.flatMap((p) => [p, ""]), `${AFTER_MARK} closing words.`, ""].join("\n");
        const letters = tokenLetters(t);
        // In an href the letters are percent-encoded or dropped by the link rule; elsewhere they are text.
        const mustShow = pos === "linkHref" || letters === "" ? [] : [letters];
        out.push({ id: `page-${n++}`, dim: "page", slices, body, mustShow });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------- soup

/** mulberry32: a small deterministic PRNG, so a failing case is reproducible from its id. */
export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL_TAGS = Object.values(CHILDREN).flat();
const SOUP_ATTR_NAMES = [...ATTR_NAMES, "role", "data-node-id", "onload", "style", "data-probe"];

function soupNode(rnd: () => number, depth: number): string {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const r = rnd();
  if (r < 0.3 || depth > 3) return pick(TEXT_FORMS);
  if (r < 0.36) return pick(["</div>", "</g>", "</text>", "</title>", '</g data-x="z>Hold y">', "<!-- c -->", "<![CDATA[x]]>", "<", ">", "&"]);
  const tag = rnd() < 0.55 ? pick(CHILDREN.kept!) : pick(ALL_TAGS);
  let attrs = "";
  for (let i = Math.floor(rnd() * 3); i > 0; i--) {
    const a = writeAttr(pick(SOUP_ATTR_NAMES), pick(ATTR_VALUES), pick(QUOTES));
    if (a) attrs += ` ${a}`;
  }
  const form = pick(FORMS);
  if (form === "self") return `<${tag}${attrs}/>`;
  let kids = "";
  for (let i = Math.floor(rnd() * 4); i > 0; i--) kids += soupNode(rnd, depth + 1);
  return form === "unclosed" ? `<${tag}${attrs}>${kids}` : `<${tag}${attrs}>${kids}</${tag}>`;
}

export const SOUP_SEED = 0xd1a9;
export const SOUP_COUNT = 500;

function soupCases(): SpaceCase[] {
  const rnd = prng(SOUP_SEED);
  const out: SpaceCase[] = [];
  for (let i = 0; i < SOUP_COUNT; i++) {
    let inner = "";
    for (let j = 1 + Math.floor(rnd() * 5); j > 0; j--) inner += soupNode(rnd, 0);
    const glossary = rnd() < 0.5 ? "<Glossary>\n\n- **Hold:** a book kept back\n\n</Glossary>" : "";
    const token = rnd() < 0.3 ? PAGE_POSITIONS[Object.keys(PAGE_POSITIONS)[Math.floor(rnd() * 9)]!]!(PAGE_TOKENS[Math.floor(rnd() * PAGE_TOKENS.length)]!) : "";
    out.push({ id: `soup-${i}`, dim: "soup", slices: [svgOf(inner)], body: pageWith(1, [glossary, token].filter(Boolean).join("\n\n")), mustShow: [] });
  }
  return out;
}

/** Every case, in a fixed order. */
export function diagramSpaceCases(): SpaceCase[] {
  return [...attrCases(), ...elementCases(), ...textCases(), ...pageCases(), ...soupCases()];
}

// ------------------------------------------------------------- reading a tree

/** An element as a parser builds it: name, attributes sorted by name, children
 *  (a string is a text node; adjacent text is merged, empty text is absent). */
export interface SvgNode {
  tag: string;
  attrs: [string, string][];
  kids: (SvgNode | string)[];
}

const XML_REFS: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** A numeric reference no scalar value holds reads as U+FFFD. */
const scalar = (n: number) => (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? "\uFFFD" : String.fromCodePoint(n));
const decodeXml = (s: string) =>
  s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (m, d?: string, h?: string, nm?: string) =>
    d || h ? scalar(d ? Number(d) : parseInt(h!, 16)) : (XML_REFS[nm!] ?? m),
  );

/**
 * The tree the sanitizer's output string MEANS under the model it writes in:
 * tags as written (`/>` closes), double-quoted attribute values, the five XML
 * escapes and numeric references decoded, anything else literal. This is the
 * tree the sanitizer believes it wrote; the Chromium spec compares the page's
 * parsed DOM to it, and the `bun test` compares it to the sanitizer's own tree.
 * Throws on a string outside that model.
 */
export function readSanitizedTree(svg: string): SvgNode {
  const root: SvgNode = { tag: "#root", attrs: [], kids: [] };
  const stack: SvgNode[] = [root];
  const pushText = (t: string) => {
    if (!t) return;
    const kids = stack[stack.length - 1]!.kids;
    if (typeof kids[kids.length - 1] === "string") kids[kids.length - 1] += t;
    else kids.push(t);
  };
  const TAG = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[^\s=/>]+="[^"]*")*)\s*(\/?)>/y;
  let i = 0;
  while (i < svg.length) {
    const lt = svg.indexOf("<", i);
    pushText(decodeXml(svg.slice(i, lt < 0 ? svg.length : lt)));
    if (lt < 0) break;
    TAG.lastIndex = lt;
    const m = TAG.exec(svg);
    if (!m) throw new Error(`not a tag at ${lt}: ${svg.slice(lt, lt + 40)}`);
    if (m[1]) {
      const top = stack.pop();
      if (!top || top.tag !== m[2]) throw new Error(`mis-nested </${m[2]}>`);
    } else {
      const attrs = [...m[3]!.matchAll(/\s+([^\s=/>]+)="([^"]*)"/g)].map((a) => [a[1]!, decodeXml(a[2]!)] as [string, string]);
      const node: SvgNode = { tag: m[2]!, attrs: attrs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)), kids: [] };
      stack[stack.length - 1]!.kids.push(node);
      if (!m[4]) stack.push(node);
    }
    i = lt + m[0].length;
  }
  if (stack.length !== 1 || root.kids.length !== 1 || typeof root.kids[0] === "string") throw new Error("not one closed root element");
  return root.kids[0] as SvgNode;
}
