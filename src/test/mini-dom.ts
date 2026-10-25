/**
 * A minimal HTML parser for tests: well-formed fixture markup in, a tree with
 * the node surface `htmlToMarkdown` reads out (`nodeType`, `nodeName`,
 * `childNodes`, `textContent`, `getAttribute`). Bun has no DOM and the repo
 * carries no DOM library, so the walk's tests parse their invented fixtures
 * with this.
 *
 * Not a browser parser: no implicit end tags beyond closing the nearest open
 * match, no foster parenting. Fixtures must be written well-formed.
 */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

export class MiniNode {
  readonly childNodes: MiniNode[] = [];
  parentNode: MiniNode | null = null;
  readonly attributes = new Map<string, string>();
  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    private readonly data = "",
  ) {}

  get textContent(): string {
    return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join("");
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }

  append(child: MiniNode): void {
    child.parentNode = this;
    this.childNodes.push(child);
  }

  /** Every descendant element whose tag is `tag` (lowercase), in document order. */
  find(tag: string): MiniNode[] {
    const out: MiniNode[] = [];
    for (const c of this.childNodes) {
      if (c.nodeType === 1 && c.nodeName.toLowerCase() === tag) out.push(c);
      out.push(...c.find(tag));
    }
    return out;
  }
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}

/** Parse `html` into a document node (nodeType 9) whose children are the top-level nodes. */
export function parseHtml(html: string): MiniNode {
  const doc = new MiniNode(9, "#document");
  const stack: MiniNode[] = [doc];
  const top = () => stack[stack.length - 1]!;
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", i)) {
      const end = html.indexOf(">", i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith("</", i)) {
      const end = html.indexOf(">", i);
      const name = html.slice(i + 2, end).trim().toLowerCase();
      i = end + 1;
      for (let j = stack.length - 1; j > 0; j--) {
        if (stack[j]!.nodeName.toLowerCase() === name) {
          stack.length = j;
          break;
        }
      }
      continue;
    }
    if (html[i] === "<" && /[a-z]/i.test(html[i + 1] ?? "")) {
      const tagRe = /<([a-z][a-z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/iy;
      tagRe.lastIndex = i;
      const m = tagRe.exec(html);
      if (!m) throw new Error(`mini-dom: unparseable tag at ${i}: ${html.slice(i, i + 40)}`);
      const name = m[1]!.toLowerCase();
      const el = new MiniNode(1, name.toUpperCase());
      for (const a of m[2]!.matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        el.attributes.set(a[1]!.toLowerCase(), decodeEntities(a[2] ?? a[3] ?? a[4] ?? ""));
      }
      top().append(el);
      i = tagRe.lastIndex;
      if (RAW_TEXT.has(name)) {
        const close = html.toLowerCase().indexOf(`</${name}`, i);
        const end = close < 0 ? html.length : close;
        el.append(new MiniNode(3, "#text", html.slice(i, end)));
        i = close < 0 ? html.length : html.indexOf(">", close) + 1;
        continue;
      }
      if (!VOID.has(name) && m[3] !== "/") stack.push(el);
      continue;
    }
    const next = html.indexOf("<", i + 1);
    const end = next < 0 ? html.length : next;
    top().append(new MiniNode(3, "#text", decodeEntities(html.slice(i, end))));
    i = end;
  }
  return doc;
}
