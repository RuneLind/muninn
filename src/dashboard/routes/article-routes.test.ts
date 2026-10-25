import { describe, expect, test } from "bun:test";
import { deriveTitle } from "./article-routes.ts";

// The pasted text is the walk's markdown (`html-to-markdown.ts`), so its first
// line can carry link, emphasis and code syntax that must not reach the title.
describe("deriveTitle", () => {
  test("a linked heading gives the link's text", () => {
    expect(deriveTitle("# [Real title of the post](https://blog.example/p/real)\n\nBody.")).toBe(
      "Real title of the post",
    );
  });

  test("emphasis, code and escapes are removed", () => {
    expect(deriveTitle("**Bold lede**\n\nBody.")).toBe("Bold lede");
    expect(deriveTitle("*Why* `bun test` and __this__ [path C:\\\\dir\\\\](https://ex.com/p)")).toBe(
      "Why bun test and this path C:\\dir\\",
    );
  });

  test("a bare first line is unchanged, and the cap holds", () => {
    expect(deriveTitle("\n  Plain first line  \nsecond")).toBe("Plain first line");
    expect(deriveTitle(`[${"a".repeat(100)}](https://ex.com/p)`)).toBe(`${"a".repeat(77)}…`);
    expect(deriveTitle("**\n\n")).toBe("Untitled article");
  });
});
