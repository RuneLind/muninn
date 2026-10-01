import { test, expect, describe, afterEach } from "bun:test";
import { cardSearchText, enhanceQueryExplorer, matchesSearch, matchesUses, queryRuns } from "./wiki-query-explorer.ts";

/** The members `queryRuns` reads: element/text siblings and `matches`. The
 *  browser half (the bar, hiding, the reveal) is driven in e2e/wiki-caseboard. */
type Fake = { nodeType: number; textContent: string; previousSibling: Fake | null; isQuery: boolean; matches(s: string): boolean };
function children(spec: (string | "Q" | "P")[]): { root: { querySelectorAll(): Fake[] }; nodes: Fake[] } {
  const nodes: Fake[] = [];
  for (const s of spec) {
    const n: Fake = {
      nodeType: s === "Q" || s === "P" ? 1 : 3,
      textContent: s === "Q" || s === "P" ? "" : s,
      previousSibling: nodes[nodes.length - 1] ?? null,
      isQuery: s === "Q",
      matches(sel: string) {
        return sel === "section.query" && this.isQuery;
      },
    };
    nodes.push(n);
  }
  return { root: { querySelectorAll: () => nodes.filter((n) => n.isQuery) }, nodes };
}

describe("queryRuns", () => {
  test("two or more cards with only whitespace between them are one run", () => {
    const { root, nodes } = children(["Q", "\n\n", "Q", "\n", "Q"]);
    expect(queryRuns(root as never)).toEqual([[nodes[0], nodes[2], nodes[4]]] as never);
  });

  test("a paragraph between cards splits the run; a lone card is no run", () => {
    const { root, nodes } = children(["Q", "\n", "Q", "P", "Q", "text", "Q", "Q"]);
    expect(queryRuns(root as never)).toEqual([[nodes[0], nodes[2]], [nodes[6], nodes[7]]] as never);
  });

  test("a single card makes no run", () => {
    expect(queryRuns(children(["Q"]).root as never)).toEqual([]);
  });
});

describe("explorer matching", () => {
  test("every term must occur, case-insensitive, NFC-folded", () => {
    const text = "q-8\nhar de 46 sakene fått årsavregning?\ntre saker".normalize("NFC");
    expect(matchesSearch(text, "")).toBe(true);
    expect(matchesSearch(text, "  ")).toBe(true);
    expect(matchesSearch(text, "Q-8")).toBe(true);
    expect(matchesSearch(text, "årsavregning saker")).toBe(true);
    expect(matchesSearch(text, "årsavregning")).toBe(true);
    expect(matchesSearch(text, "årsavregning fakturaserie")).toBe(false);
  });

  test("a decomposed (NFD) query matches the precomposed text", () => {
    const text = "q-8\nhar de 46 sakene fått årsavregning?".normalize("NFC");
    expect(matchesSearch(text, "årsavregning")).toBe(true);
  });

  test("no chip pressed shows every card; pressed chips show a card using any of them", () => {
    expect(matchesUses([], new Set())).toBe(true);
    expect(matchesUses(["8045"], new Set(["8306", "8045"]))).toBe(true);
    expect(matchesUses(["8045"], new Set(["8306"]))).toBe(false);
    expect(matchesUses([], new Set(["8306"]))).toBe(false);
  });
});

/** A tree fake with real sibling links, for `enhanceQueryExplorer` itself:
 *  element (1), text (3) and comment (8) nodes, `before`, `append`, and the
 *  three selectors the explorer asks for. */
class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  hidden = false;
  className = "";
  type = "";
  placeholder = "";
  value = "";
  text = "";
  constructor(public nodeType: number, public tag = "") {}
  get previousSibling(): FakeNode | null {
    const sibs = this.parent?.children ?? [];
    return sibs[sibs.indexOf(this) - 1] ?? null;
  }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this.text = v; }
  matches(sel: string) { return sel === "section.query" && this.tag === "section" && this.className === "query"; }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  addEventListener() {}
  append(...nodes: FakeNode[]) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  before(n: FakeNode) {
    const sibs = this.parent!.children;
    n.parent = this.parent;
    sibs.splice(sibs.indexOf(this), 0, n);
  }
  all(): FakeNode[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel: string): FakeNode[] {
    if (sel === "section.query") return this.all().filter((n) => n.matches(sel));
    if (sel.startsWith(".")) return this.all().filter((n) => n.className === sel.slice(1));
    throw new Error(`fake DOM: unsupported selector ${sel}`);
  }
}
const elem = (tag: string, cls: string, text = "", ...kids: FakeNode[]) => {
  const n = new FakeNode(1, tag);
  n.className = cls;
  n.text = text;
  n.append(...kids);
  return n;
};
const textNode = (t: string) => Object.assign(new FakeNode(3), { text: t });
const card = (id: string, ...uses: string[]) =>
  elem("section", "query", "", elem("a", "query-id", id), ...uses.map((u) => elem("span", "query-use", u)));

const realDocument = (globalThis as { document?: unknown }).document;
afterEach(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

describe("fix round 1: the explorer", () => {
  test("enhancing the same DOM twice builds one bar", () => {
    (globalThis as { document?: unknown }).document = { createElement: (t: string) => new FakeNode(1, t) };
    const root = elem("article", "", "", card("Q-1"), textNode("\n"), card("Q-2"));
    enhanceQueryExplorer(root as unknown as ParentNode);
    enhanceQueryExplorer(root as unknown as ParentNode);
    expect(root.all().filter((n) => n.className === "qx-bar")).toHaveLength(1);
  });

  test("uses values are searchable text", () => {
    const text = cardSearchText(card("Q-1", "8045", "MELOSYS-8306") as unknown as Element);
    expect(matchesSearch(text, "melosys-8306")).toBe(true);
    expect(matchesSearch(text, "8045")).toBe(true);
  });

  test("the chips box is a labelled group", () => {
    (globalThis as { document?: unknown }).document = { createElement: (t: string) => new FakeNode(1, t) };
    const root = elem("article", "", "", card("Q-1", "8045"), textNode("\n"), card("Q-2", "8306"));
    enhanceQueryExplorer(root as unknown as ParentNode);
    const box = root.all().find((n) => n.className === "qx-chips")!;
    expect(box.getAttribute("role")).toBe("group");
    expect(box.getAttribute("aria-label")).toBe("Filter by uses");
  });

  test("a comment node between cards splits the run (comments never reach the reader as nodes)", () => {
    const comment = Object.assign(new FakeNode(8), { text: "x" });
    const root = elem("article", "", "", card("Q-1"), comment, card("Q-2"));
    expect(queryRuns(root as unknown as ParentNode)).toEqual([]);
  });
});
