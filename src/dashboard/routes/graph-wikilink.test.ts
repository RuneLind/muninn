import { test, expect, describe } from "bun:test";
import { WIKILINK_RE } from "./graph-routes.ts";

/**
 * The graph route's own `[[wikilink]]` scan runs over WHOLE huginn documents, so
 * it is the copy where a missing `\n` exclusion does the most damage: a dangling
 * opener pairs with a LATER line's `]]` and the extractor emits an edge to a page
 * nobody linked, while hiding the real link it swallowed.
 */
function targets(content: string): string[] {
  return [...content.matchAll(WIKILINK_RE)].map((m) => m[1]!.trim());
}

describe("graph-routes WIKILINK_RE", () => {
  test("extracts ordinary and piped targets", () => {
    expect(targets("See [[Claude Code]] and [[Skills System|skills]].")).toEqual([
      "Claude Code",
      "Skills System",
    ]);
  });

  test("a dangling [[ never swallows the next line's link", () => {
    const doc = ["- [[Entry One]] — cut at [[Cordis", "- [[Entry Two]] — more prose."].join("\n");
    expect(targets(doc)).toEqual(["Entry One", "Entry Two"]);
  });

  test("a piped alias does not span lines either", () => {
    const doc = ["Prose with [[Target|label", "- [[Next Entry]] tail."].join("\n");
    expect(targets(doc)).toEqual(["Next Entry"]);
  });
});
