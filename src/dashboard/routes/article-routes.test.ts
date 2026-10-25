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

  test("a leading code fence is skipped to the first prose line", () => {
    expect(deriveTitle("```\nconst x = 1;\n```\nBody")).toBe("Body");
    expect(deriveTitle("```js\nconst x = 1;\n```\n\nBody line")).toBe("Body line");
    expect(deriveTitle("~~~\ncode\n~~~\nAfter tilde")).toBe("After tilde");
    expect(deriveTitle("````\n```\n````\nAfter long fence")).toBe("After long fence");
    expect(deriveTitle("```\nnever closed\n")).toBe("Untitled article");
    expect(deriveTitle("```\n~~~\n```\nAfter mixed")).toBe("After mixed");
    expect(deriveTitle("```\n```js\n```\nAfter info")).toBe("After info");
  });

  test("inline syntax is stripped only where it is paired", () => {
    expect(deriveTitle("`` a`b ``")).toBe("a`b");
    expect(deriveTitle("2**10 is big")).toBe("2**10 is big");
    expect(deriveTitle("a ` lone tick")).toBe("a ` lone tick");
    expect(deriveTitle("`[not](a link)` here")).toBe("[not](a link) here");
  });

  test("a leading quote, bullet or number marker is stripped", () => {
    expect(deriveTitle("> Quoted lede")).toBe("Quoted lede");
    expect(deriveTitle("- item one")).toBe("item one");
    expect(deriveTitle("1. first step")).toBe("first step");
  });

  test("runs of whitespace collapse to one space", () => {
    expect(deriveTitle("a  b\t c")).toBe("a b c");
  });
});
