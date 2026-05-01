import { test, expect, describe } from "bun:test";
import { planSearchTraceSpans } from "./search-trace-spans.ts";

describe("planSearchTraceSpans", () => {
  test("returns empty for unknown schema versions", () => {
    expect(planSearchTraceSpans(null)).toEqual([]);
    expect(planSearchTraceSpans({})).toEqual([]);
    expect(planSearchTraceSpans({ schemaVersion: 2, collections: [] })).toEqual([]);
    expect(planSearchTraceSpans("not-an-object")).toEqual([]);
  });

  test("emits one span per non-zero stage in trace order", () => {
    const trace = {
      schemaVersion: 1,
      collections: [
        {
          name: "jira-issues",
          indexer: "hybrid",
          fetchK: 10,
          candidates: [],
          confidence: { lowConfidence: false, bestScore: -2 },
          timingsMs: { indexFetch: 80, chunkLoad: 30, rerank: 1400, titleBoost: 0, assembly: 1, total: 1511 },
        },
      ],
    };

    const spans = planSearchTraceSpans(trace);
    const names = spans.map((s) => s.name);
    expect(names).toEqual(["index.fetch", "chunk.load", "rerank.ce", "assemble"]);
  });

  test("walks startOffsetMs sequentially within a collection", () => {
    const trace = {
      schemaVersion: 1,
      collections: [
        {
          name: "x",
          timingsMs: { indexFetch: 50, chunkLoad: 25, rerank: 200 },
        },
      ],
    };

    const spans = planSearchTraceSpans(trace);
    expect(spans[0]!.startOffsetMs).toBe(0);
    expect(spans[1]!.startOffsetMs).toBe(50);
    expect(spans[2]!.startOffsetMs).toBe(75);
  });

  test("attaches collection summary attributes including drop count", () => {
    const trace = {
      schemaVersion: 1,
      collections: [
        {
          name: "jira-issues",
          indexer: "hybrid",
          fetchK: 10,
          candidates: [
            { kept: true },
            { kept: false },
            { kept: false },
          ],
          confidence: { lowConfidence: true, bestScore: -0.05 },
          timingsMs: { rerank: 100 },
        },
      ],
    };

    const spans = planSearchTraceSpans(trace);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes).toEqual({
      collection: "jira-issues",
      indexer: "hybrid",
      fetchK: 10,
      candidateCount: 3,
      droppedCount: 2,
      lowConfidence: true,
      bestScore: -0.05,
      synthesized: true,
      stage: "rerank",
    });
  });

  test("concatenates spans across multiple collections", () => {
    const trace = {
      schemaVersion: 1,
      collections: [
        { name: "a", timingsMs: { rerank: 100 } },
        { name: "b", timingsMs: { rerank: 200 } },
      ],
    };

    const spans = planSearchTraceSpans(trace);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.attributes.collection).toBe("a");
    expect(spans[0]!.startOffsetMs).toBe(0);
    expect(spans[1]!.attributes.collection).toBe("b");
    expect(spans[1]!.startOffsetMs).toBe(100);
  });

  test("skips zero and negative durations", () => {
    const trace = {
      schemaVersion: 1,
      collections: [{ name: "x", timingsMs: { indexFetch: 0, chunkLoad: -5, rerank: 50 } }],
    };

    const spans = planSearchTraceSpans(trace);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("rerank.ce");
  });
});
