import { test, expect, describe } from "bun:test";
import { matchesSearch, matchesUses, queryRuns } from "./wiki-query-explorer.ts";

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

  test("no chip pressed shows every card; pressed chips show a card using any of them", () => {
    expect(matchesUses([], new Set())).toBe(true);
    expect(matchesUses(["8045"], new Set(["8306", "8045"]))).toBe(true);
    expect(matchesUses(["8045"], new Set(["8306"]))).toBe(false);
    expect(matchesUses([], new Set(["8306"]))).toBe(false);
  });
});
