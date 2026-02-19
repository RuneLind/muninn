import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { searchKnowledge, formatKnowledgeResults } from "./knowledge-search.ts";

describe("formatKnowledgeResults", () => {
  test("returns empty string for empty results", () => {
    expect(formatKnowledgeResults([])).toBe("");
  });

  test("formats results with url and snippet", () => {
    const result = formatKnowledgeResults([
      {
        collection: "test",
        id: "1",
        title: "My Page",
        url: "https://notion.so/my-page",
        relevance: 0.9,
        matchedChunks: [{ content: "Some relevant content here", relevance: 0.9 }],
      },
    ]);
    expect(result).toContain("Relevant company knowledge");
    expect(result).toContain("My Page (https://notion.so/my-page)");
    expect(result).toContain("Some relevant content here");
  });

  test("formats results without url", () => {
    const result = formatKnowledgeResults([
      {
        collection: "test",
        id: "1",
        title: "No URL Page",
        url: "",
        relevance: 0.8,
        matchedChunks: [{ content: "Content", relevance: 0.8 }],
      },
    ]);
    expect(result).toContain("- No URL Page — Content");
    // No URL means no parenthetical link after the title
    expect(result).not.toContain("No URL Page (");
  });

  test("handles empty matchedChunks", () => {
    const result = formatKnowledgeResults([
      {
        collection: "test",
        id: "1",
        title: "Empty Chunks",
        url: "",
        relevance: 0,
        matchedChunks: [],
      },
    ]);
    expect(result).toContain("- Empty Chunks —");
  });

  test("truncates long snippets", () => {
    const longContent = "A".repeat(300);
    const result = formatKnowledgeResults([
      {
        collection: "test",
        id: "1",
        title: "Long",
        url: "",
        relevance: 0.9,
        matchedChunks: [{ content: longContent, relevance: 0.9 }],
      },
    ]);
    expect(result).toContain("...");
    // The snippet should be truncated to ~200 chars + "..."
    const snippetPart = result.split("— ")[1]!;
    expect(snippetPart.length).toBeLessThanOrEqual(210);
  });

  test("collapses newlines in snippet", () => {
    const result = formatKnowledgeResults([
      {
        collection: "test",
        id: "1",
        title: "Newlines",
        url: "",
        relevance: 0.9,
        matchedChunks: [{ content: "line one\n\n\nline two\nline three", relevance: 0.9 }],
      },
    ]);
    expect(result).toContain("line one line two line three");
  });
});

describe("searchKnowledge", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns results on successful API call", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({
        results: [
          { collection: "test", id: "1", title: "Page", url: "https://example.com", matchedChunks: [] },
        ],
      }), { status: 200 })),
    ) as unknown as typeof fetch;

    const result = await searchKnowledge("test query", ["test-collection"]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.title).toBe("Page");
    expect(result.searchMs).toBeGreaterThanOrEqual(0);
  });

  test("returns empty results on non-ok response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    ) as unknown as typeof fetch;

    const result = await searchKnowledge("test query");
    expect(result.results).toEqual([]);
    expect(result.searchMs).toBeGreaterThanOrEqual(0);
  });

  test("returns empty results when API is unreachable", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Connection refused")),
    ) as unknown as typeof fetch;

    const result = await searchKnowledge("test query");
    expect(result.results).toEqual([]);
    expect(result.searchMs).toBeGreaterThanOrEqual(0);
  });

  test("handles missing results field in response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    ) as unknown as typeof fetch;

    const result = await searchKnowledge("test query");
    expect(result.results).toEqual([]);
  });

  test("passes collections as query params", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock((url: string | URL | Request) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    }) as unknown as typeof fetch;

    await searchKnowledge("hello", ["col-a", "col-b"], 3);
    expect(capturedUrl).toContain("q=hello");
    expect(capturedUrl).toContain("limit=3");
    expect(capturedUrl).toContain("collection=col-a");
    expect(capturedUrl).toContain("collection=col-b");
  });
});
