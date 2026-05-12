import { test, expect, describe, afterEach } from "bun:test";
import {
  searchKnowledge,
  renderSearchResults,
  renderRetryHintsFooter,
  extractDocKeysFromRenderedText,
  parseQueryHintsFromFooter,
  docKey,
  type KnowledgeSearchResult,
} from "./knowledge-search-client.ts";

describe("renderSearchResults", () => {
  test("renders header, url, breadcrumb, the doc-id line and chunk bodies", () => {
    const r: KnowledgeSearchResult = {
      collection: "wiki",
      id: "abc-123",
      title: "Knowledge Graph RAG",
      url: "https://example.test/kg-rag",
      breadcrumb: "Architecture / Retrieval",
      relevance: 0.823,
      confidenceBand: "high",
      modifiedTime: "2026-05-01T12:00:00Z",
      matchedChunks: [{ heading: "Overview", content: "It combines a graph with vector search." }],
    };
    const out = renderSearchResults([r]);
    expect(out).toContain("## Knowledge Graph RAG (82.3% relevant · high) | updated: 2026-05-01");
    expect(out).toContain("https://example.test/kg-rag");
    expect(out).toContain("Architecture / Retrieval");
    expect(out).toContain("collection: `wiki` doc_id: `abc-123`");
    expect(out).toContain("**Overview**");
    expect(out).toContain("It combines a graph with vector search.");
  });

  test("falls back to snippet when there are no matched chunks", () => {
    const out = renderSearchResults([{ collection: "c", id: "1", title: "T", relevance: 0.5, confidenceBand: "medium", snippet: "a short snippet" }]);
    expect(out).toContain("a short snippet");
    expect(out).toContain("collection: `c` doc_id: `1`");
  });

  test("WIP metadata renders the marker; internal metadata keys are hidden", () => {
    const out = renderSearchResults([{ collection: "c", id: "1", title: "Draft", metadata: { wip: "true", page_id: "x", owner: "alice" }, matchedChunks: [{ content: "body" }] }]);
    expect(out).toContain("**[UNDER ARBEID]**");
    expect(out).not.toContain("page_id");
  });
});

describe("extractDocKeysFromRenderedText", () => {
  test("pulls collection/doc_id pairs out of rendered result text", () => {
    const text = renderSearchResults([
      { collection: "wiki", id: "1", title: "A", matchedChunks: [{ content: "x" }] },
      { collection: "confluence", id: "PAGE-2", title: "B", matchedChunks: [{ content: "y" }] },
    ]);
    const keys = extractDocKeysFromRenderedText(text);
    expect(keys.has("wiki/1")).toBe(true);
    expect(keys.has("confluence/PAGE-2")).toBe(true);
    expect(keys.size).toBe(2);
  });

  test("returns empty set for text with no doc-id lines", () => {
    expect(extractDocKeysFromRenderedText("just some prose").size).toBe(0);
  });

  test("docKey matches the rendered line format", () => {
    expect(docKey({ collection: "wiki", id: "1" })).toBe("wiki/1");
  });
});

describe("parseQueryHintsFromFooter", () => {
  test("extracts broader and narrower query hints", () => {
    const footer = '*No confident match — try: related terms: A, B · narrower query: "X Y narrow" · broader query: "X wide"*';
    expect(parseQueryHintsFromFooter(footer)).toEqual({ broaderQuery: "X wide", narrowerQuery: "X Y narrow" });
  });

  test("returns empty object when no hints present", () => {
    expect(parseQueryHintsFromFooter("no hints here")).toEqual({});
  });
});

describe("renderRetryHintsFooter", () => {
  test("renders a 'No confident match' line with hints", () => {
    const out = renderRetryHintsFooter({ noConfidentResults: true, retryHints: { relatedTerms: ["a", "b"], broaderQuery: "wider" } });
    expect(out).toContain("No confident match — try: related terms: a, b · broader query: \"wider\"");
  });

  test("renders a bare 'No confident match.' when there are no hints", () => {
    expect(renderRetryHintsFooter({ noConfidentResults: true })).toBe("\n\n*No confident match.*");
  });

  test("returns empty string when there's nothing to say", () => {
    expect(renderRetryHintsFooter({})).toBe("");
  });
});

describe("searchKnowledge", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("builds the query string and normalizes the response", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return new Response(
        JSON.stringify({
          results: [{ collection: "wiki", id: "1", title: "T", relevance: 0.7, confidenceBand: "high", matchedChunks: [{ content: "c" }] }],
          bestScore: 0.7,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const resp = await searchKnowledge("graph rag", { collections: ["wiki"], rerank: true, minRelevance: 0.4, limit: 5 });
    expect(seenUrl).toContain("/api/search?");
    expect(seenUrl).toContain("q=graph+rag");
    expect(seenUrl).toContain("collection=wiki");
    expect(seenUrl).toContain("rerank=true");
    expect(seenUrl).toContain("min_relevance=0.4");
    expect(resp.results.length).toBe(1);
    expect(resp.results[0]?.confidenceBand).toBe("high");
    expect(resp.bestScore).toBe(0.7);
  });

  test("parses noConfidentResults + retryHints", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [], bestScore: 0.75, noConfidentResults: true, retryHints: { detectedEntities: ["RAG"], broaderQuery: "wider" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const resp = await searchKnowledge("x");
    expect(resp.noConfidentResults).toBe(true);
    expect(resp.retryHints?.detectedEntities).toEqual(["RAG"]);
    expect(resp.retryHints?.broaderQuery).toBe("wider");
  });

  test("throws on a non-2xx response", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(searchKnowledge("x")).rejects.toThrow();
  });
});
