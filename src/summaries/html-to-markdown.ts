/**
 * An HTML element tree to markdown — pure and import-free.
 *
 * One walk, two callers (plan muninn-summary-links, PR 2): the X extension's
 * content script builds an article's text with it instead of `innerText`, so
 * a link keeps its href, and the `/summaries` paste form converts a pasted
 * `text/html` clipboard with it. Anchors become `[text](href)`, and lists,
 * headings, quotes, tables and code keep their markdown shape.
 *
 * The walk reads the node interface every DOM has (`nodeType`, `nodeName`,
 * `childNodes`, `textContent`, `getAttribute`), so it runs on a live page, on
 * a `DOMParser` document and on a test shim alike.
 *
 * **Everything is inside {@link htmlToMarkdown}**: the paste form injects the
 * function by its source (`htmlToMarkdown.toString()`), so a helper or a
 * constant at module level would be missing on the page. The X extension gets
 * it through `html-to-markdown.extension.ts`, emitted as an IIFE by
 * `bun run build:extension`.
 *
 * **`t.co` anchors.** X links every URL through `t.co` and renders the real
 * target as the anchor's text, partly in hidden spans
 * (`https://` hidden, the host and path visible, the tail hidden, then `…`).
 * The anchor's FULL `textContent` therefore spells the expanded URL, and the
 * walk uses it when it does — with a scheme, and not on `t.co` itself. Any
 * other `t.co` anchor keeps its `t.co` href, which the server resolves with
 * `safeResolveRedirect`.
 */

/** The DOM node surface the walk reads. */
export interface MarkdownSourceNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly childNodes: ArrayLike<MarkdownSourceNode>;
  readonly textContent: string | null;
  getAttribute?(name: string): string | null;
}

export interface HtmlToMarkdownOptions {
  /**
   * Whether an element is invisible on the page (computed style on a live
   * page). Hidden elements are skipped; an anchor's `t.co` recovery still
   * reads its whole `textContent`, hidden spans included.
   */
  readonly isHidden?: (el: MarkdownSourceNode) => boolean;
}

export function htmlToMarkdown(root: MarkdownSourceNode, options: HtmlToMarkdownOptions = {}): string {
  const ELEMENT = 1;
  const TEXT = 3;
  // Tabs mark what the line trim must keep: a text node's whitespace is
  // collapsed to spaces, so the only tabs before the last step are a list
  // item's continuation indent and the slot a protected code block is
  // restored into.
  const INDENT = "\t";
  const slot = (i: number): string => `\t\t${i}\t\t`;
  const SKIP = new Set([
    "script", "style", "noscript", "template", "svg", "head", "title", "meta", "link", "button",
    "iframe", "img", "picture", "video", "audio", "canvas", "input", "select", "textarea", "nav",
  ]);
  const BLOCK = new Set([
    "p", "section", "article", "main", "header", "footer", "aside", "figure", "figcaption",
    "address", "details", "summary", "dl", "dt", "dd", "form", "fieldset",
  ]);
  const codeBlocks: string[] = [];
  const isHidden = options.isHidden;

  const tagOf = (node: MarkdownSourceNode): string => node.nodeName.toLowerCase();
  const attr = (node: MarkdownSourceNode, name: string): string | null =>
    typeof node.getAttribute === "function" ? node.getAttribute(name) : null;
  const children = (node: MarkdownSourceNode): MarkdownSourceNode[] => Array.from(node.childNodes);

  function hidden(node: MarkdownSourceNode): boolean {
    if (attr(node, "hidden") !== null) return true;
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attr(node, "style") ?? "")) return true;
    return isHidden ? isHidden(node) : false;
  }

  /** Trim every line, collapse runs of spaces and blank lines. */
  function normalize(text: string): string {
    return text
      .split("\n")
      .map((line) => line.replace(/^ +| +$/g, "").replace(/ {2,}/g, " "))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      // Spaces and newlines only: a code slot's tabs at either end must stay.
      .replace(/^[ \n]+|[ \n]+$/g, "");
  }

  /** An absolute http(s) URL, or null (a relative href, `javascript:`, `mailto:`). */
  function absoluteHttp(href: string): string | null {
    if (!/^https?:\/\//i.test(href)) return null;
    try {
      const url = new URL(href);
      return url.protocol === "http:" || url.protocol === "https:" ? href : null;
    } catch {
      return null;
    }
  }

  function isTco(url: string): boolean {
    try {
      return new URL(url).hostname.toLowerCase() === "t.co";
    } catch {
      return false;
    }
  }

  /** The expanded URL an X anchor spells in its text (hidden spans included), or null. */
  function expandedFromText(text: string | null): string | null {
    const spelled = (text ?? "").replace(/\s+/g, "").replace(/(?:…|\.\.\.)+$/, "");
    if (!/^https?:\/\/\S+$/i.test(spelled)) return null;
    const url = absoluteHttp(spelled);
    return url !== null && !isTco(url) ? url : null;
  }

  /** `(`, `)` and spaces percent-encoded, so the link's own `)` closes it. */
  function encodeHref(url: string): string {
    return url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
  }

  /** Whether an anchor's visible text is just its URL (`github.com/acme/x…`). */
  function textIsUrl(text: string, url: string): boolean {
    const bare = (s: string) => s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
    const shown = bare(text.replace(/(?:…|\.\.\.)+$/, ""));
    if (shown === "") return true;
    return /^[^\s]+$/.test(shown) && bare(url).toLowerCase().startsWith(shown.toLowerCase());
  }

  /** Inline content's leading and trailing whitespace, kept outside a marker. */
  function wrap(inner: string, open: string, close: string): string {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
    return m[2] === "" ? inner : `${m[1]}${open}${m[2]}${close}${m[3]}`;
  }

  function anchor(node: MarkdownSourceNode, ctx: Ctx): string {
    const text = walkChildren(node, ctx);
    let target = absoluteHttp((attr(node, "href") ?? "").trim());
    if (target !== null && isTco(target)) target = expandedFromText(node.textContent) ?? target;
    if (target === null) return text;
    const href = encodeHref(target);
    const label = text.replace(/\s+/g, " ").trim().replace(/\[/g, "(").replace(/\]/g, ")");
    const lead = /^\s/.test(text) ? " " : "";
    const tail = /\s$/.test(text) ? " " : "";
    if (label === "" || textIsUrl(label, target)) return `${lead}${href}${tail}`;
    return `${lead}[${label}](${href})${tail}`;
  }

  function list(node: MarkdownSourceNode, ctx: Ctx, ordered: boolean): string {
    const items = children(node).filter((c) => c.nodeType === ELEMENT && tagOf(c) === "li" && !hidden(c));
    const start = Number.parseInt(attr(node, "start") ?? "1", 10);
    const lines = items.map((li, i) => {
      const marker = ordered ? `${(Number.isFinite(start) ? start : 1) + i}. ` : "- ";
      // A blank line inside an item would end the list in a reader; the item stays one block.
      const body = normalize(walkChildren(li, ctx)).replace(/\n{2,}/g, "\n").split("\n");
      const pad = INDENT.repeat(marker.length);
      return marker + body.map((l, j) => (j === 0 || l === "" ? l : pad + l)).join("\n");
    });
    return `\n\n${lines.join("\n")}\n\n`;
  }

  function table(node: MarkdownSourceNode, ctx: Ctx): string {
    const rows: MarkdownSourceNode[] = [];
    const collect = (n: MarkdownSourceNode) => {
      for (const c of children(n)) {
        if (c.nodeType !== ELEMENT || hidden(c)) continue;
        const tag = tagOf(c);
        if (tag === "tr") rows.push(c);
        else if (tag === "thead" || tag === "tbody" || tag === "tfoot") collect(c);
      }
    };
    collect(node);
    if (rows.length === 0) return "";
    const out: string[] = [];
    rows.forEach((row, i) => {
      const cells = children(row).filter((c) => c.nodeType === ELEMENT && (tagOf(c) === "td" || tagOf(c) === "th"));
      const text = cells.map((c) => normalize(walkChildren(c, ctx)).replace(/\n+/g, " ").replace(/\|/g, "\\|"));
      out.push(`| ${text.join(" | ")} |`);
      if (i === 0) out.push(`| ${cells.map(() => "---").join(" | ")} |`);
    });
    return `\n\n${out.join("\n")}\n\n`;
  }

  interface Ctx {
    readonly pre: boolean;
  }

  function walkChildren(node: MarkdownSourceNode, ctx: Ctx): string {
    let out = "";
    for (const child of children(node)) out += walk(child, ctx);
    return out;
  }

  function walk(node: MarkdownSourceNode, ctx: Ctx): string {
    if (node.nodeType === TEXT) {
      const text = node.textContent ?? "";
      return ctx.pre ? text : text.replace(/[\s ]+/g, " ");
    }
    if (node.nodeType !== ELEMENT && node.nodeType !== 9 && node.nodeType !== 11) return "";
    if (node.nodeType !== ELEMENT) return walkChildren(node, ctx);
    const tag = tagOf(node);
    if (SKIP.has(tag) || hidden(node)) return "";
    if (ctx.pre) return tag === "br" ? "\n" : walkChildren(node, ctx);
    switch (tag) {
      case "br":
        return "\n";
      case "hr":
        return "\n\n---\n\n";
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const text = normalize(walkChildren(node, ctx)).replace(/\n+/g, " ");
        return text === "" ? "" : `\n\n${"#".repeat(Number(tag[1]))} ${text}\n\n`;
      }
      case "div":
      case "li":
      case "tr":
        return `\n${walkChildren(node, ctx)}\n`;
      case "blockquote": {
        const inner = normalize(walkChildren(node, ctx));
        return inner === "" ? "" : `\n\n${inner.split("\n").map((l) => (l === "" ? ">" : `> ${l}`)).join("\n")}\n\n`;
      }
      case "ul":
      case "menu":
        return list(node, ctx, false);
      case "ol":
        return list(node, ctx, true);
      case "table":
        return table(node, ctx);
      case "pre": {
        const code = walkChildren(node, { pre: true }).replace(/^\n+|\n+$/g, "");
        if (code.trim() === "") return "";
        const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((r) => r.length));
        const fence = "`".repeat(longest + 1);
        codeBlocks.push(`${fence}\n${code}\n${fence}`);
        return `\n\n${slot(codeBlocks.length - 1)}\n\n`;
      }
      case "code":
      case "kbd":
      case "samp": {
        const code = (node.textContent ?? "").replace(/\s+/g, " ");
        if (code.trim() === "") return code;
        const tick = code.includes("`") ? "``" : "`";
        return `${tick}${code}${tick}`;
      }
      case "strong":
      case "b":
        return wrap(walkChildren(node, ctx), "**", "**");
      case "em":
      case "i":
        return wrap(walkChildren(node, ctx), "*", "*");
      case "a":
        return anchor(node, ctx);
      default:
        return BLOCK.has(tag) ? `\n\n${walkChildren(node, ctx)}\n\n` : walkChildren(node, ctx);
    }
  }

  const text = normalize(walk(root, { pre: false }));
  return text.replace(/\t\t(\d+)\t\t|\t/g, (_m, i: string | undefined) =>
    i === undefined ? " " : (codeBlocks[Number(i)] ?? ""),
  );
}
