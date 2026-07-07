import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeQueryMetrics,
  aggregateMetrics,
  parseRetrievalRow,
  parseRetrievalSet,
  discoverRetrievalSets,
  runRetrievalEval,
  DEFAULT_K,
  type QueryMetrics,
  type RetrievalQuery,
  type SearchRunners,
} from "./retrieval.ts";

describe("computeQueryMetrics", () => {
  const q = (expected: string[], k?: number): Pick<RetrievalQuery, "id" | "target" | "expectedDocIds" | "k"> => ({
    id: "q1",
    target: "huginn",
    expectedDocIds: expected,
    ...(k ? { k } : {}),
  });

  test("perfect single-hit at rank 1", () => {
    const m = computeQueryMetrics(q(["a"]), ["a", "b", "c"]);
    expect(m.hitAtK).toBe(1);
    expect(m.recallAtK).toBe(1);
    expect(m.reciprocalRank).toBe(1);
    expect(m.matched).toEqual(["a"]);
  });

  test("hit at rank 3 → reciprocal rank 1/3", () => {
    const m = computeQueryMetrics(q(["c"]), ["a", "b", "c"]);
    expect(m.hitAtK).toBe(1);
    expect(m.reciprocalRank).toBeCloseTo(1 / 3, 10);
  });

  test("empty results → all zero", () => {
    const m = computeQueryMetrics(q(["a"]), []);
    expect(m.hitAtK).toBe(0);
    expect(m.recallAtK).toBe(0);
    expect(m.reciprocalRank).toBe(0);
    expect(m.returnedCount).toBe(0);
  });

  test("partial recall — 2 of 3 expected found", () => {
    const m = computeQueryMetrics(q(["a", "b", "x"]), ["a", "z", "b"]);
    expect(m.recallAtK).toBeCloseTo(2 / 3, 10);
    expect(m.hitAtK).toBe(1);
    expect(m.reciprocalRank).toBe(1); // first expected ("a") at rank 1
    expect(m.matched.sort()).toEqual(["a", "b"]);
  });

  test("k truncation drops a match beyond the cutoff", () => {
    // expected doc sits at rank 3, but k=2 → not counted
    const m = computeQueryMetrics(q(["c"], 2), ["a", "b", "c"]);
    expect(m.hitAtK).toBe(0);
    expect(m.recallAtK).toBe(0);
    expect(m.reciprocalRank).toBe(0);
    expect(m.k).toBe(2);
  });

  test("k defaults to DEFAULT_K when unset", () => {
    const m = computeQueryMetrics(q(["a"]), ["a"]);
    expect(m.k).toBe(DEFAULT_K);
  });

  test("no expected ids → recall 0, no hit", () => {
    const m = computeQueryMetrics(q([]), ["a", "b"]);
    expect(m.expectedCount).toBe(0);
    expect(m.recallAtK).toBe(0);
    expect(m.hitAtK).toBe(0);
  });

  test("duplicate expected id in results counted once", () => {
    const m = computeQueryMetrics(q(["a"]), ["a", "a", "b"]);
    expect(m.matched).toEqual(["a"]);
    expect(m.recallAtK).toBe(1);
  });
});

describe("aggregateMetrics", () => {
  const mk = (over: Partial<QueryMetrics>): QueryMetrics => ({
    id: "q",
    target: "huginn",
    k: 10,
    expectedCount: 1,
    returnedCount: 1,
    hitAtK: 0,
    recallAtK: 0,
    reciprocalRank: 0,
    matched: [],
    ...over,
  });

  test("means over overall + per-target", () => {
    const rows = [
      mk({ target: "huginn", hitAtK: 1, recallAtK: 1, reciprocalRank: 1 }),
      mk({ target: "huginn", hitAtK: 0, recallAtK: 0, reciprocalRank: 0 }),
      mk({ target: "research", hitAtK: 1, recallAtK: 0.5, reciprocalRank: 0.5 }),
    ];
    const agg = aggregateMetrics(rows);
    expect(agg.overall.queryCount).toBe(3);
    expect(agg.overall.hitRate).toBeCloseTo(2 / 3, 10);
    expect(agg.perTarget.huginn!.queryCount).toBe(2);
    expect(agg.perTarget.huginn!.hitRate).toBe(0.5);
    expect(agg.perTarget.huginn!.mrr).toBe(0.5);
    expect(agg.perTarget.research!.recallAtK).toBe(0.5);
    expect(agg.perTarget.memories).toBeUndefined();
  });

  test("skipped queries excluded from aggregates", () => {
    const rows = [
      mk({ target: "huginn", hitAtK: 1, recallAtK: 1, reciprocalRank: 1 }),
      mk({ target: "memories", skipped: true }),
    ];
    const agg = aggregateMetrics(rows);
    expect(agg.overall.queryCount).toBe(1);
    expect(agg.overall.hitRate).toBe(1);
    expect(agg.perTarget.memories).toBeUndefined();
  });

  test("empty input → zeroed overall", () => {
    const agg = aggregateMetrics([]);
    expect(agg.overall.queryCount).toBe(0);
    expect(agg.overall.hitRate).toBe(0);
    expect(agg.overall.mrr).toBe(0);
  });
});

describe("parseRetrievalRow", () => {
  test("valid row parses to camelCase", () => {
    const row = parseRetrievalRow({
      id: "x1",
      target: "huginn",
      query: "hello",
      collection: "jira-issues",
      expected_doc_ids: ["a.md", "b.md"],
      k: 5,
      note: "n",
    });
    expect(row).toEqual({
      id: "x1",
      target: "huginn",
      query: "hello",
      collection: "jira-issues",
      expectedDocIds: ["a.md", "b.md"],
      k: 5,
      note: "n",
    });
  });

  test("rejects invalid target", () => {
    expect(parseRetrievalRow({ id: "x", target: "nope", query: "q", expected_doc_ids: [] })).toBeNull();
  });

  test("rejects missing id", () => {
    expect(parseRetrievalRow({ target: "huginn", query: "q", expected_doc_ids: [] })).toBeNull();
  });

  test("rejects empty query", () => {
    expect(parseRetrievalRow({ id: "x", target: "huginn", query: "  ", expected_doc_ids: [] })).toBeNull();
  });

  test("rejects non-string expected_doc_ids", () => {
    expect(parseRetrievalRow({ id: "x", target: "huginn", query: "q", expected_doc_ids: [1, 2] })).toBeNull();
  });

  test("drops non-positive k and empty collection", () => {
    const row = parseRetrievalRow({ id: "x", target: "memories", query: "q", expected_doc_ids: ["m"], k: 0, collection: "" });
    expect(row?.k).toBeUndefined();
    expect(row?.collection).toBeUndefined();
  });
});

describe("parseRetrievalSet", () => {
  test("skips blank + malformed lines, keeps valid", () => {
    const text = [
      `{"id":"a","target":"huginn","query":"q","expected_doc_ids":["d"]}`,
      ``,
      `not json`,
      `{"id":"b","target":"bad","query":"q","expected_doc_ids":[]}`,
      `{"id":"c","target":"research","query":"q2","expected_doc_ids":["e"]}`,
    ].join("\n");
    const rows = parseRetrievalSet(text, "test.jsonl");
    expect(rows.map((r) => r.id)).toEqual(["a", "c"]);
  });
});

describe("discoverRetrievalSets", () => {
  test("globs jsonl files and returns empty when dir missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "retrieval-"));
    try {
      // No benchmarks/retrieval dir yet → empty
      expect(await discoverRetrievalSets(join(tmp, "benchmarks"))).toEqual([]);

      const dir = join(tmp, "benchmarks", "retrieval");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "golden-queries.jsonl"),
        `{"id":"a","target":"huginn","query":"q","expected_doc_ids":["d"]}\n`,
      );
      const sets = await discoverRetrievalSets(join(tmp, "benchmarks"));
      expect(sets.length).toBe(1);
      expect(sets[0]!.label).toBe("golden-queries");
      expect(sets[0]!.queries.length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runRetrievalEval (injected runners, no persistence)", () => {
  const queries: RetrievalQuery[] = [
    { id: "h1", target: "huginn", query: "q", expectedDocIds: ["a.md"] },
    { id: "r1", target: "research", query: "q", expectedDocIds: ["b.md"] },
    { id: "m1", target: "memories", query: "q", expectedDocIds: ["m1id"] },
  ];

  test("scores injected results and marks null-return as skipped", async () => {
    const runners: SearchRunners = {
      huginn: async () => ["a.md", "z.md"],
      research: async () => ["x.md", "b.md"],
      memories: async () => null, // not seeded → skipped
    };
    const { metrics, perQuery } = await runRetrievalEval({
      queries,
      knowledgeApiUrl: "http://unused",
      botName: "test",
      persist: false,
      runners,
    });
    const byId = Object.fromEntries(perQuery.map((q) => [q.id, q]));
    expect(byId.h1!.hitAtK).toBe(1);
    expect(byId.h1!.reciprocalRank).toBe(1);
    expect(byId.r1!.reciprocalRank).toBeCloseTo(1 / 2, 10);
    expect(byId.m1!.skipped).toBe(true);
    // memory skipped → only huginn + research in aggregates
    expect(metrics.overall.queryCount).toBe(2);
    expect(metrics.perTarget.memories).toBeUndefined();
  });

  test("search error is captured as a zero-score query, not a throw", async () => {
    const runners: SearchRunners = {
      huginn: async () => {
        throw new Error("huginn down");
      },
      research: async () => [],
      memories: async () => null,
    };
    const { perQuery } = await runRetrievalEval({
      queries: [queries[0]!],
      knowledgeApiUrl: "http://unused",
      botName: "test",
      persist: false,
      runners,
    });
    expect(perQuery[0]!.error).toContain("huginn down");
    expect(perQuery[0]!.hitAtK).toBe(0);
  });

  test("target filter restricts which queries run", async () => {
    const runners: SearchRunners = {
      huginn: async () => ["a.md"],
      research: async () => {
        throw new Error("should not run");
      },
      memories: async () => null,
    };
    const { perQuery } = await runRetrievalEval({
      queries,
      knowledgeApiUrl: "http://unused",
      botName: "test",
      target: "huginn",
      persist: false,
      runners,
    });
    expect(perQuery.map((q) => q.id)).toEqual(["h1"]);
  });
});
