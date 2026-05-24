import { test, expect, describe, mock, beforeEach } from "bun:test";

// Force the CLI Haiku backend so the spawnHaiku mock below is actually exercised.
// Without this the dev's ambient .env (HAIKU_BACKEND / ANTHROPIC_API_KEY) makes
// the decomposer hit a real backend, bypassing the mock — flaky + env-sensitive.
process.env.HAIKU_BACKEND = "cli";

const mockSpawnHaiku = mock(() => Promise.resolve({
  result: '{"subQuestions": ["What is BUC 02?"], "rationale": "Single lookup"}',
  inputTokens: 10,
  outputTokens: 10,
  model: "claude-haiku-4-5-20251001",
}));

type FetchResult = { results?: unknown[]; bestScore?: number; lowConfidence?: boolean; traceId?: string };
const mockFetch = mock(
  (_baseUrl: string, _path: string, _options?: unknown): Promise<FetchResult> =>
    Promise.resolve({ results: [] }),
);

mock.module("../scheduler/executor.ts", () => ({
  spawnHaiku: mockSpawnHaiku,
  DEFAULT_MODEL: "claude-haiku-4-5-20251001",
  HAIKU_TIMEOUT_MS: 60_000,
  // trackUsage is imported transitively (haiku-direct.ts) — stub it so the
  // partial module mock doesn't drop the export and break the import.
  trackUsage: () => {},
}));

mock.module("../dashboard/routes/knowledge-api-client.ts", () => ({
  fetchKnowledgeApi: mockFetch,
  KnowledgeApiError: class KnowledgeApiError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

mock.module("../db/traces.ts", () => ({
  saveSpan: async () => {},
  updateSpan: async () => {},
}));

mock.module("../config.ts", () => ({
  loadConfig: () => ({ tracingEnabled: false }),
}));

const { researchKnowledge, mergeHit } = await import("./research-knowledge.ts");

interface RawHit {
  collection: string;
  id: string;
  relevance: number;
  title?: string;
  url?: string;
}

function hit(collection: string, id: string, relevance: number, extra: Partial<RawHit> = {}): RawHit {
  return { collection, id, relevance, title: `${collection}/${id}`, ...extra };
}

beforeEach(() => {
  mockSpawnHaiku.mockClear();
  mockFetch.mockClear();
});

describe("mergeHit", () => {
  test("adds a new hit with provenance", () => {
    const merged = new Map();
    mergeHit(merged, hit("w", "a", 0.9), "sub-1");
    expect(merged.size).toBe(1);
    const entry = merged.get("w\x00a");
    expect(entry?.viaSubQuestion).toEqual(["sub-1"]);
    expect(entry?.relevance).toBe(0.9);
  });

  test("dedupes by (collection, id) and unions provenance", () => {
    const merged = new Map();
    mergeHit(merged, hit("w", "a", 0.5), "sub-1");
    mergeHit(merged, hit("w", "a", 0.8), "sub-2");
    expect(merged.size).toBe(1);
    const entry = merged.get("w\x00a");
    expect(entry?.viaSubQuestion).toEqual(["sub-1", "sub-2"]);
    // Higher relevance wins
    expect(entry?.relevance).toBe(0.8);
  });

  test("does not duplicate the same sub-question in provenance", () => {
    const merged = new Map();
    mergeHit(merged, hit("w", "a", 0.5), "sub-1");
    mergeHit(merged, hit("w", "a", 0.6), "sub-1");
    expect(merged.get("w\x00a")?.viaSubQuestion).toEqual(["sub-1"]);
  });

  test("ignores malformed hits", () => {
    const merged = new Map();
    mergeHit(merged, { collection: "w" } as any, "sub-1");
    mergeHit(merged, { id: "a" } as any, "sub-1");
    mergeHit(merged, {} as any, "sub-1");
    expect(merged.size).toBe(0);
  });
});

describe("researchKnowledge passthrough", () => {
  test("single sub-question → exactly one /api/search call", async () => {
    mockSpawnHaiku.mockResolvedValueOnce({
      result: '{"subQuestions": ["What is BUC 02?"], "rationale": "Single lookup"}',
      inputTokens: 10,
      outputTokens: 10,
      model: "claude-haiku-4-5-20251001",
    });
    mockFetch.mockResolvedValueOnce({
      results: [hit("wiki", "buc-02", 0.92, { url: "https://example/buc-02" })],
      bestScore: 0.92,
    });

    const result = await researchKnowledge({
      question: "What is BUC 02?",
      botName: "testbot",
      knowledgeApiUrl: "http://huginn",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.decomposition.passthrough).toBe(true);
    expect(result.decomposition.subQuestions).toEqual(["What is BUC 02?"]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.viaSubQuestion).toEqual(["What is BUC 02?"]);
    expect(result.subSearches).toHaveLength(1);
    expect(result.subSearches[0]?.bestScore).toBe(0.92);
  });
});

describe("researchKnowledge fan-out", () => {
  test("multiple sub-questions → parallel searches, merged results", async () => {
    mockSpawnHaiku.mockResolvedValueOnce({
      result: '{"subQuestions": ["a-q", "b-q", "c-q"], "rationale": "fan-out"}',
      inputTokens: 10,
      outputTokens: 10,
      model: "claude-haiku-4-5-20251001",
    });
    mockFetch.mockImplementation((_baseUrl: string, path: string) => {
      if (path.includes("a-q")) return Promise.resolve({ results: [hit("wiki", "doc-a", 0.9)] });
      if (path.includes("b-q")) return Promise.resolve({ results: [hit("wiki", "doc-b", 0.8)] });
      if (path.includes("c-q")) return Promise.resolve({ results: [hit("wiki", "doc-c", 0.7)] });
      return Promise.resolve({ results: [] });
    });

    const result = await researchKnowledge({
      question: "compare a, b, and c",
      botName: "testbot",
      knowledgeApiUrl: "http://huginn",
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.decomposition.passthrough).toBe(false);
    expect(result.results).toHaveLength(3);
    // Sorted by relevance descending
    expect(result.results.map((r) => r.id)).toEqual(["doc-a", "doc-b", "doc-c"]);
    // Provenance tagged correctly
    expect(result.results.find((r) => r.id === "doc-a")?.viaSubQuestion).toEqual(["a-q"]);
    expect(result.results.find((r) => r.id === "doc-b")?.viaSubQuestion).toEqual(["b-q"]);
  });

  test("dedupe across sub-questions unions provenance", async () => {
    mockSpawnHaiku.mockResolvedValueOnce({
      result: '{"subQuestions": ["q1", "q2"], "rationale": "fan-out"}',
      inputTokens: 10,
      outputTokens: 10,
      model: "claude-haiku-4-5-20251001",
    });
    // Both sub-queries return the same doc; q2 has higher relevance
    mockFetch
      .mockResolvedValueOnce({ results: [hit("wiki", "shared", 0.6), hit("wiki", "only-q1", 0.5)] })
      .mockResolvedValueOnce({ results: [hit("wiki", "shared", 0.9), hit("wiki", "only-q2", 0.7)] });

    const result = await researchKnowledge({
      question: "double-covered question",
      botName: "testbot",
      knowledgeApiUrl: "http://huginn",
    });

    expect(result.results).toHaveLength(3);
    const shared = result.results.find((r) => r.id === "shared");
    expect(shared?.relevance).toBe(0.9);
    expect(shared?.viaSubQuestion).toEqual(["q1", "q2"]);
  });

  test("bounded fan-out — 5+ sub-questions get clamped to 4 searches", async () => {
    mockSpawnHaiku.mockResolvedValueOnce({
      result: '{"subQuestions": ["a", "b", "c", "d", "e", "f"], "rationale": "too many"}',
      inputTokens: 10,
      outputTokens: 10,
      model: "claude-haiku-4-5-20251001",
    });
    mockFetch.mockResolvedValue({ results: [] });

    const result = await researchKnowledge({
      question: "way too many parts",
      botName: "testbot",
      knowledgeApiUrl: "http://huginn",
    });

    expect(result.decomposition.subQuestions).toHaveLength(4);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  test("one sub-search failure doesn't abort the others", async () => {
    mockSpawnHaiku.mockResolvedValueOnce({
      result: '{"subQuestions": ["good", "bad"], "rationale": "fan-out"}',
      inputTokens: 10,
      outputTokens: 10,
      model: "claude-haiku-4-5-20251001",
    });
    mockFetch.mockImplementation((_baseUrl: string, path: string) => {
      if (path.includes("good")) return Promise.resolve({ results: [hit("wiki", "ok", 0.5)] });
      return Promise.reject(new Error("upstream boom"));
    });

    const result = await researchKnowledge({
      question: "one good, one bad",
      botName: "testbot",
      knowledgeApiUrl: "http://huginn",
    });

    expect(result.results).toHaveLength(1);
    expect(result.subSearches.find((s) => s.subQuestion === "bad")?.error).toBe("upstream boom");
    expect(result.subSearches.find((s) => s.subQuestion === "good")?.resultCount).toBe(1);
  });

  test("passes collections + limit through to /api/search", async () => {
    mockSpawnHaiku.mockResolvedValueOnce({
      result: '{"subQuestions": ["q"], "rationale": ""}',
      inputTokens: 10,
      outputTokens: 10,
      model: "claude-haiku-4-5-20251001",
    });
    mockFetch.mockResolvedValue({ results: [] });

    await researchKnowledge({
      question: "q",
      botName: "testbot",
      knowledgeApiUrl: "http://huginn",
      collections: ["wiki", "jira-issues"],
      limit: 5,
    });

    const firstCall = mockFetch.mock.calls[0];
    expect(firstCall).toBeDefined();
    const calledPath = firstCall![1];
    expect(calledPath).toContain("collection=wiki");
    expect(calledPath).toContain("collection=jira-issues");
    expect(calledPath).toContain("limit=5");
  });
});

describe("researchKnowledge degradation paths", () => {
  test("Haiku decompose failure → falls back to passthrough on the original question", async () => {
    mockSpawnHaiku.mockRejectedValueOnce(new Error("haiku exploded"));
    mockFetch.mockResolvedValueOnce({ results: [hit("wiki", "fallback", 0.5)] });

    const result = await researchKnowledge({
      question: "original",
      botName: "testbot",
      knowledgeApiUrl: "http://huginn",
    });

    expect(result.decomposition.passthrough).toBe(true);
    expect(result.decomposition.subQuestions).toEqual(["original"]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("malformed Haiku JSON → falls back to passthrough", async () => {
    mockSpawnHaiku.mockResolvedValueOnce({
      result: "not json at all",
      inputTokens: 10,
      outputTokens: 10,
      model: "claude-haiku-4-5-20251001",
    });
    mockFetch.mockResolvedValueOnce({ results: [] });

    const result = await researchKnowledge({
      question: "original",
      botName: "testbot",
      knowledgeApiUrl: "http://huginn",
    });

    expect(result.decomposition.passthrough).toBe(true);
    expect(result.decomposition.subQuestions).toEqual(["original"]);
  });
});
