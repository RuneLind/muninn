import { describe, expect, test } from "bun:test";
import {
  EMBED_HEIGHT_DEFAULT,
  EMBED_HEIGHT_MAX,
  EMBED_HEIGHT_MIN,
  parseEmbedAttrs,
  planEmbeds,
  resolveEmbedRelPath,
  type EmbedFigure,
} from "./embed.ts";

describe("parseEmbedAttrs", () => {
  test("a relative .html src with defaults", () => {
    expect(parseEmbedAttrs({ src: "./arch.html" })).toEqual({
      src: "./arch.html",
      height: EMBED_HEIGHT_DEFAULT,
      title: "./arch.html",
    });
  });

  test("height is read, clamped both ways, and title is kept", () => {
    expect(parseEmbedAttrs({ src: "a.html", height: "900", title: "Arch" })).toEqual({
      src: "a.html",
      height: 900,
      title: "Arch",
    });
    expect(parseEmbedAttrs({ src: "a.html", height: "10" })!.height).toBe(EMBED_HEIGHT_MIN);
    expect(parseEmbedAttrs({ src: "a.html", height: "99999" })!.height).toBe(EMBED_HEIGHT_MAX);
  });

  test("a non-numeric height refuses the whole tag", () => {
    expect(parseEmbedAttrs({ src: "a.html", height: "tall" })).toBeNull();
    expect(parseEmbedAttrs({ src: "a.html", height: "50%" })).toBeNull();
  });

  test.each([
    ["", "empty"],
    ["https://example.com/x.html", "scheme"],
    ["javascript:alert(1)", "javascript scheme"],
    ["/blogs/x.html", "leading slash"],
    ["x.html?wiki=other", "query"],
    ["x.html#frag", "fragment"],
    ["x.htm", "not .html"],
    ["x.md", "markdown"],
    ["dir\\x.html", "backslash"],
  ])("refuses %j (%s)", (src) => {
    expect(parseEmbedAttrs({ src })).toBeNull();
  });

  test("`..` segments and spaces are allowed at the parse gate — containment is the resolver's job", () => {
    expect(parseEmbedAttrs({ src: "../assets/Explainer One.html" })).not.toBeNull();
  });
});

describe("resolveEmbedRelPath", () => {
  test("sibling and subdirectory of the page's folder", () => {
    expect(resolveEmbedRelPath("blogs/post.mdx", "arch.html")).toBe("blogs/arch.html");
    expect(resolveEmbedRelPath("blogs/post.mdx", "./arch.html")).toBe("blogs/arch.html");
    expect(resolveEmbedRelPath("blogs/post.mdx", "diagrams/arch.html")).toBe("blogs/diagrams/arch.html");
  });

  test("`..` climbs within the root", () => {
    expect(resolveEmbedRelPath("blogs/2026/post.mdx", "../arch.html")).toBe("blogs/arch.html");
    expect(resolveEmbedRelPath("blogs/post.mdx", "../assets/arch.html")).toBe("assets/arch.html");
  });

  test("a root-level page resolves flat", () => {
    expect(resolveEmbedRelPath("index.md", "arch.html")).toBe("arch.html");
    expect(resolveEmbedRelPath("", "arch.html")).toBe("arch.html");
  });

  test("escaping the root is refused, not clamped", () => {
    expect(resolveEmbedRelPath("blogs/post.mdx", "../../arch.html")).toBeNull();
    expect(resolveEmbedRelPath("index.md", "../arch.html")).toBeNull();
  });
});

describe("planEmbeds", () => {
  const item = (o: Partial<EmbedFigure>): EmbedFigure => ({
    hasFrame: false,
    src: "arch.html",
    height: "500",
    title: "T",
    ...o,
  });

  test("resolves each figure against the page and carries height/title", () => {
    expect(planEmbeds([item({})], "blogs/post.mdx")).toEqual([
      { index: 0, relPath: "blogs/arch.html", height: 500, title: "T" },
    ]);
  });

  test("a figure already carrying a frame is skipped — the enhancer is idempotent", () => {
    expect(planEmbeds([item({ hasFrame: true }), item({ src: "b.html" })], "blogs/post.mdx")).toEqual([
      { index: 1, relPath: "blogs/b.html", height: 500, title: "T" },
    ]);
  });

  test("an unknown page relPath plans nothing rather than resolving against the root", () => {
    expect(planEmbeds([item({})], "")).toEqual([]);
  });

  test("an escaping src is skipped; a bad height falls back to the default", () => {
    expect(planEmbeds([item({ src: "../../x.html" })], "blogs/post.mdx")).toEqual([]);
    expect(planEmbeds([item({ height: "NaN" })], "blogs/post.mdx")[0]!.height).toBe(EMBED_HEIGHT_DEFAULT);
  });
});
