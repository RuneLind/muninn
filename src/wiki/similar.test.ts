import { test, expect, describe } from "bun:test";
import {
  buildSimilarQuery,
  buildSimilarSearchPath,
  firstBodyParagraph,
  resolveSimilarHits,
  type SimilarSearchHit,
} from "./similar.ts";
import type { WikiIndex, WikiPageMeta } from "./store.ts";

function meta(over: Partial<WikiPageMeta>): WikiPageMeta {
  return {
    name: "page",
    title: "Page",
    type: "concept",
    domain: "ai",
    tags: [],
    aliases: [],
    relPath: "page.md",
    ...over,
  };
}

/** Minimal fake index: resolve by name (lowercased), resolveRelPath by relPath. */
function fakeIndex(pages: WikiPageMeta[]): WikiIndex {
  const byName = new Map(pages.map((p) => [p.name.toLowerCase(), p]));
  const byRel = new Map(pages.map((p) => [p.relPath.toLowerCase(), p]));
  return {
    pages,
    outgoing: new Map(),
    backlinks: new Map(),
    resolve: (t: string) => byName.get(t.toLowerCase()),
    resolveRelPath: (rp: string) => byRel.get(rp.toLowerCase()),
    scannedAt: 0,
    root: "/tmp/fake",
  };
}

describe("firstBodyParagraph", () => {
  test("skips frontmatter and leading heading, returns first real paragraph", () => {
    const md = "---\ntype: concept\n---\n\n# Title\n\nThe first real paragraph.\n\nSecond.";
    expect(firstBodyParagraph(md)).toBe("The first real paragraph.");
  });

  test("collapses whitespace and caps length", () => {
    const md = "line one\nline two   with    spaces";
    expect(firstBodyParagraph(md, 12)).toBe("line one lin");
  });

  test("heading-only / empty page → empty string", () => {
    expect(firstBodyParagraph("# Only a heading")).toBe("");
    expect(firstBodyParagraph("")).toBe("");
  });
});

describe("buildSimilarQuery", () => {
  test("title + tags + first paragraph for a markdown page", () => {
    const q = buildSimilarQuery(
      meta({ title: "Wiki Gardener", tags: ["gardener", "wiki"] }),
      "# Wiki Gardener\n\nClusters recent summaries into draft pages.",
    );
    expect(q).toContain("Wiki Gardener");
    expect(q).toContain("gardener wiki");
    expect(q).toContain("Clusters recent summaries");
  });

  test("empty body (explainer) → title (+ tags) only", () => {
    const q = buildSimilarQuery(meta({ title: "Some Explainer", tags: [] }), "");
    expect(q).toBe("Some Explainer");
  });
});

describe("buildSimilarSearchPath", () => {
  test("one repeated collection param per collection (never comma-joined), limit param", () => {
    const p = buildSimilarSearchPath("hello world", ["wiki", "wiki-life"], 8);
    expect(p).toBe("/api/search?q=hello+world&limit=8&collection=wiki&collection=wiki-life");
    expect(p).not.toContain("wiki%2Cwiki-life");
    expect(p).not.toContain("max_number_of_documents");
  });
});

describe("resolveSimilarHits", () => {
  const current = meta({ name: "current", relPath: "current.md", title: "Current" });
  const a = meta({ name: "cousin-a", relPath: "cousin-a.md", title: "Cousin A" });
  const b = meta({ name: "cousin-b", relPath: "sub/cousin-b.md", title: "Cousin B" });
  const index = fakeIndex([current, a, b]);

  test("happy path resolves hits, ordered by relevance desc", () => {
    const hits: SimilarSearchHit[] = [
      { collection: "wiki", id: "cousin-a.md", relevance: 0.6 },
      { collection: "wiki", id: "sub/cousin-b.md", relevance: 0.9 },
    ];
    const out = resolveSimilarHits(hits, index, current);
    expect(out.map((p) => p.name)).toEqual(["cousin-b", "cousin-a"]);
    expect(out[0]!.relPath).toBe("sub/cousin-b.md");
  });

  test("drops the current page (self)", () => {
    const hits: SimilarSearchHit[] = [
      { collection: "wiki", id: "current.md", relevance: 0.99 },
      { collection: "wiki", id: "cousin-a.md", relevance: 0.5 },
    ];
    const out = resolveSimilarHits(hits, index, current);
    expect(out.map((p) => p.name)).toEqual(["cousin-a"]);
  });

  test("drops unresolved external hits", () => {
    const hits: SimilarSearchHit[] = [
      { collection: "wiki", id: "external/not-in-wiki.md", title: "Nope", relevance: 0.8 },
      { collection: "wiki", id: "cousin-a.md", relevance: 0.4 },
    ];
    const out = resolveSimilarHits(hits, index, current);
    expect(out.map((p) => p.name)).toEqual(["cousin-a"]);
  });

  test("dedupes by relPath and caps at limit", () => {
    const hits: SimilarSearchHit[] = [
      { collection: "wiki", id: "cousin-a.md", relevance: 0.7 },
      { collection: "other", id: "cousin-a.md", relevance: 0.3 },
      { collection: "wiki", id: "sub/cousin-b.md", relevance: 0.6 },
    ];
    const out = resolveSimilarHits(hits, index, current, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("cousin-a");
  });

  test("carries a snippet from the first matched chunk", () => {
    const hits: SimilarSearchHit[] = [
      {
        collection: "wiki",
        id: "cousin-a.md",
        relevance: 0.5,
        matchedChunks: [{ content: "  a  matched   snippet " }],
      },
    ];
    const out = resolveSimilarHits(hits, index, current);
    expect(out[0]!.snippet).toBe("a matched snippet");
  });
});
