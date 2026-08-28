import { test, expect, describe, mock, beforeEach } from "bun:test";

// Force the CLI Haiku backend so the spawnHaiku mock below is actually exercised.
// Without this the dev's ambient .env (HAIKU_BACKEND / ANTHROPIC_API_KEY) makes
// the decomposer hit a real backend, bypassing the mock — flaky + env-sensitive.
process.env.HAIKU_BACKEND = "cli";

interface MockHaikuResult {
  result: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** Optional, exactly as on the real `HaikuResult` — so a per-test override may
   *  omit it, and the default below can still mirror production's "cli" tag. */
  backend?: string;
}
const mockSpawnHaiku = mock((): Promise<MockHaikuResult> => Promise.resolve({
  result: '{"subQuestions": ["What is BUC 02?"], "rationale": "Single lookup"}',
  inputTokens: 10,
  outputTokens: 10,
  model: "claude-haiku-4-5-20251001",
  // Production `spawnHaiku` tags every CLI result "cli", and the decomposer
  // forwards it onto the span — a mock that omits it makes the span's backend
  // field untestable here for a reason that exists only in the mock.
  backend: "cli",
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
  // Imported transitively too (haiku-direct.ts → the non-CLI backends' output
  // ceiling). A module factory REPLACES the module, so every named export a
  // consumer in the graph imports has to appear here or the import fails.
  HAIKU_DEFAULT_MAX_TOKENS: 4096,
  // trackUsage is imported transitively (haiku-direct.ts) — stub it so the
  // partial module mock doesn't drop the export and break the import.
  trackUsage: () => {},
}));

mock.module("./knowledge-api-client.ts", () => ({
  fetchKnowledgeApi: mockFetch,
  KnowledgeApiError: class KnowledgeApiError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

// Spans are CAPTURED, not discarded — and `tracingEnabled` is true below for the
// same reason: the attribute rule being right is worth nothing if nothing
// attaches it, and that wiring is invisible to both tsc and the pure test.
const savedSpans: Array<{ name: string; attributes?: Record<string, unknown> }> = [];
mock.module("../db/traces.ts", () => ({
  saveSpan: async (params: { name: string; attributes?: Record<string, unknown> }) => { savedSpans.push(params); },
  updateSpan: async () => {},
}));

// Spread the REAL module rather than replacing it: `mock.module` swaps the whole
// registry entry, so a two-key stub silently deletes every other export for this
// process — and `research-knowledge.ts` reaches `config.ts` transitively through
// the Haiku router, which reads `resolveProfile`. That failure surfaces as
// `SyntaxError: Export named '…' not found`, from a module this file never
// mentions, the moment an unrelated PR adds an export.
const realConfig = await import("../config.ts");
mock.module("../config.ts", () => ({
  ...realConfig,
  // ON, so the span-wiring case below observes a real `addChildSpan`.
  loadConfig: () => ({ tracingEnabled: true }),
}));

const { researchKnowledge, mergeHit, decomposeSpanAttributes } = await import("./research-knowledge.ts");

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

// The span this suite cannot observe (it runs with `tracingEnabled: false`), so
// the RULE is tested directly. `passthrough` and `rationale` cannot separate a
// decomposer that gave up from one that correctly took the cheap single-lookup
// path: the valid path sets `passthrough` too, and three of the four
// degradations carry a rationale the MODEL wrote. Without `degraded` on the
// span, a decomposition that lost its entire fan-out renders on /traces exactly
// like a healthy lookup — and a pod is not a place where anyone runs the probe.
describe("decomposeSpanAttributes", () => {
  const base = { subQuestions: ["a"], rationale: "r", haikuMs: 1, passthrough: true };

  test("a degradation and the backend that ran are both recorded", () => {
    expect(decomposeSpanAttributes("q", { ...base, degraded: "malformed", backend: "vertex" }))
      .toEqual({ question: "q", subQuestions: ["a"], rationale: "r", passthrough: true, degraded: "malformed", backend: "vertex" });
  });

  // Omitted, not falsified: a healthy result has no degradation, and a chain
  // that threw outright has no backend to name.
  test("absent fields are omitted rather than written as undefined", () => {
    const attrs = decomposeSpanAttributes("q", { ...base, passthrough: false, subQuestions: ["a", "b"] });
    expect(Object.keys(attrs).sort()).toEqual(["passthrough", "question", "rationale", "subQuestions"]);
  });
});

describe("the knowledge_decompose span actually carries it", () => {
  // The rule above is only useful if `researchKnowledge` attaches it. Nothing
  // else would notice a call site that went back to the old four-field literal:
  // tsc accepts it, and the pure test passes either way.
  test("a degraded decomposition reaches the span", async () => {
    savedSpans.length = 0;
    mockSpawnHaiku.mockResolvedValueOnce({
      result: '{"sub_questions": ["a", "b"], "rationale": "Two focused queries."}',
      inputTokens: 10, outputTokens: 10, model: "claude-haiku-4-5-20251001", backend: "cli" as const,
    });
    mockFetch.mockResolvedValueOnce({ results: [] });

    await researchKnowledge({ question: "original", botName: "testbot", knowledgeApiUrl: "http://huginn" });

    const span = savedSpans.find((sp) => sp.name === "knowledge_decompose");
    expect(span?.attributes).toMatchObject({ passthrough: true, degraded: "malformed", backend: "cli" });
  });

  test("a healthy decomposition reaches it with no degradation", async () => {
    savedSpans.length = 0;
    mockFetch.mockResolvedValueOnce({ results: [] });

    await researchKnowledge({ question: "original", botName: "testbot", knowledgeApiUrl: "http://huginn" });

    const span = savedSpans.find((sp) => sp.name === "knowledge_decompose");
    expect(span?.attributes?.degraded).toBeUndefined();
    expect(span?.attributes?.backend).toBe("cli");
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
