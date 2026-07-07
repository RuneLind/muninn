import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  saveRetrievalRun,
  completeRetrievalRun,
  listRetrievalRuns,
  getRetrievalRun,
} from "./benchmark-retrieval-runs.ts";
import type { RetrievalMetrics, QueryMetrics } from "../benchmarks/retrieval.ts";
import {
  seedMemoryFixtures,
  hasSeededMemoryFixtures,
  MEMORY_FIXTURES,
  MEMORY_GOLDEN_QUERIES,
  MEMORY_FIXTURE_USER_ID,
  MEMORY_FIXTURE_BOT_NAME,
} from "../benchmarks/retrieval-fixtures.ts";
import { searchMemories, searchMemoriesHybrid } from "./memories.ts";

/**
 * Deterministic bag-of-words embedding for tests. Loading the real HF/onnx
 * model inside `bun test` crashes the runtime (native C++ exception — same
 * reason extractor/prompt-builder tests mock generateEmbedding), so the seed
 * takes an injectable embed fn. Shared words → shared dims → higher cosine
 * similarity, which is enough to exercise the pgvector arm end-to-end.
 */
async function fakeEmbed(text: string): Promise<number[]> {
  const v = new Array<number>(384).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0;
    v[h % 384]! += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

setupTestDb();

// benchmark_retrieval_runs is a benchmark_* table (migration-only, excluded
// from the drift guard AND from setup-db's truncate list). Ensure it exists
// and is clean per test so this file passes even against a shared test DB
// where migration 053 may not have been applied yet.
beforeAll(async () => {
  const sql = getDb();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS benchmark_retrieval_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      started_at      TIMESTAMPTZ NOT NULL,
      finished_at     TIMESTAMPTZ,
      status          TEXT NOT NULL DEFAULT 'running',
      error           TEXT,
      target_filter   TEXT,
      query_count     INTEGER NOT NULL DEFAULT 0,
      huginn_base_url TEXT,
      metrics         JSONB,
      per_query       JSONB,
      notes           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
});

beforeEach(async () => {
  await getDb().unsafe("TRUNCATE TABLE benchmark_retrieval_runs");
});

const sampleMetrics: RetrievalMetrics = {
  overall: { queryCount: 3, hitRate: 0.667, recallAtK: 0.5, mrr: 0.42 },
  perTarget: {
    huginn: { queryCount: 2, hitRate: 1, recallAtK: 0.75, mrr: 0.6 },
    research: { queryCount: 1, hitRate: 0, recallAtK: 0, mrr: 0 },
  },
};

const samplePerQuery: QueryMetrics[] = [
  { id: "h1", target: "huginn", k: 10, expectedCount: 1, returnedCount: 5, hitAtK: 1, recallAtK: 1, reciprocalRank: 1, matched: ["a.md"] },
  { id: "r1", target: "research", k: 10, expectedCount: 2, returnedCount: 0, hitAtK: 0, recallAtK: 0, reciprocalRank: 0, matched: [] },
];

describe("benchmark-retrieval-runs CRUD", () => {
  test("save → running row with nulls", async () => {
    const id = await saveRetrievalRun({
      startedAt: new Date(),
      targetFilter: "huginn",
      queryCount: 9,
      huginnBaseUrl: "http://localhost:8321",
      notes: "unit",
    });
    expect(id).toBeTruthy();

    const row = await getRetrievalRun(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("running");
    expect(row!.targetFilter).toBe("huginn");
    expect(row!.queryCount).toBe(9);
    expect(row!.huginnBaseUrl).toBe("http://localhost:8321");
    expect(row!.notes).toBe("unit");
    expect(row!.finishedAt).toBeNull();
    expect(row!.metrics).toBeNull();
    expect(row!.perQuery).toBeNull();
  });

  test("complete → done row with metrics + per_query JSONB round-trips", async () => {
    const id = await saveRetrievalRun({ startedAt: new Date(), queryCount: 3 });
    await completeRetrievalRun(id, {
      finishedAt: new Date(),
      status: "done",
      metrics: sampleMetrics,
      perQuery: samplePerQuery,
    });

    const row = await getRetrievalRun(id);
    expect(row!.status).toBe("done");
    expect(row!.finishedAt).not.toBeNull();
    expect(row!.metrics!.overall.hitRate).toBeCloseTo(0.667, 5);
    expect(row!.metrics!.perTarget.huginn!.queryCount).toBe(2);
    expect(row!.perQuery!.length).toBe(2);
    expect(row!.perQuery![0]!.matched).toEqual(["a.md"]);
    // target_filter left null on save is preserved
    expect(row!.targetFilter).toBeNull();
  });

  test("complete → error row keeps an error message", async () => {
    const id = await saveRetrievalRun({ startedAt: new Date(), queryCount: 1 });
    await completeRetrievalRun(id, {
      finishedAt: new Date(),
      status: "error",
      error: "huginn unreachable",
    });
    const row = await getRetrievalRun(id);
    expect(row!.status).toBe("error");
    expect(row!.error).toBe("huginn unreachable");
  });

  test("list orders newest-first and respects limit", async () => {
    const a = await saveRetrievalRun({ startedAt: new Date(Date.now() - 10_000), queryCount: 1 });
    const b = await saveRetrievalRun({ startedAt: new Date(), queryCount: 1 });
    const runs = await listRetrievalRuns(10);
    expect(runs[0]!.id).toBe(b);
    expect(runs[1]!.id).toBe(a);

    const limited = await listRetrievalRuns(1);
    expect(limited.length).toBe(1);
    expect(limited[0]!.id).toBe(b);
  });

  test("getRetrievalRun returns null for unknown id", async () => {
    expect(await getRetrievalRun("00000000-0000-4000-8000-0000000000ff")).toBeNull();
  });
});

describe("memory fixtures seeding", () => {
  test("hasSeededMemoryFixtures is false before seeding, true after", async () => {
    expect(await hasSeededMemoryFixtures()).toBe(false);
    await seedMemoryFixtures({ embed: fakeEmbed });
    expect(await hasSeededMemoryFixtures()).toBe(true);
  });

  test("every MEMORY_GOLDEN_QUERIES entry retrieves its expected doc end-to-end (hybrid)", async () => {
    // These are the exact query strings the golden set uses — if a query
    // stops being satisfiable against the fixture text, this fails instead
    // of the eval silently scoring 0 (adversarial-review finding).
    await seedMemoryFixtures({ embed: fakeEmbed });
    for (const golden of MEMORY_GOLDEN_QUERIES) {
      const embedding = await fakeEmbed(golden.query);
      const hits = await searchMemoriesHybrid(
        MEMORY_FIXTURE_USER_ID,
        golden.query,
        embedding,
        5,
        MEMORY_FIXTURE_BOT_NAME,
      );
      const ids = hits.map((h) => h.id);
      for (const expectedId of golden.expected) {
        expect(ids).toContain(expectedId);
      }
    }
  });

  test("golden queries are FTS-satisfiable on their own (vector arm may be absent)", async () => {
    // plainto_tsquery AND-semantics: every content word in a golden query
    // must stem-match its fixture. Run the pure FTS path so retrieval holds
    // even when the embedding model is unavailable at seed time.
    await seedMemoryFixtures({ embed: async () => null });
    for (const golden of MEMORY_GOLDEN_QUERIES) {
      const hits = await searchMemories(MEMORY_FIXTURE_USER_ID, golden.query, 5, MEMORY_FIXTURE_BOT_NAME);
      const ids = hits.map((h) => h.id);
      for (const expectedId of golden.expected) {
        expect(ids).toContain(expectedId);
      }
    }
  });

  test("seeding attaches embeddings so the vector arm can rank fixtures", async () => {
    await seedMemoryFixtures({ embed: fakeEmbed });
    const sql = getDb();
    const [row] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM memories
      WHERE user_id = ${MEMORY_FIXTURE_USER_ID} AND embedding IS NOT NULL
    `;
    expect(row!.n).toBe(MEMORY_FIXTURES.length);
  });

  test("null-embed fallback seeds rows without embeddings (warn path)", async () => {
    await seedMemoryFixtures({ embed: async () => null });
    const sql = getDb();
    const [row] = await sql<{ total: number; embedded: number }[]>`
      SELECT COUNT(*)::int AS total,
             COUNT(embedding)::int AS embedded
      FROM memories WHERE user_id = ${MEMORY_FIXTURE_USER_ID}
    `;
    expect(row!.total).toBe(MEMORY_FIXTURES.length);
    expect(row!.embedded).toBe(0);
  });

  test("re-seeding is idempotent (stable ids, no duplicates)", async () => {
    await seedMemoryFixtures({ embed: fakeEmbed });
    await seedMemoryFixtures({ embed: fakeEmbed });
    const sql = getDb();
    const [row] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM memories WHERE user_id = ${MEMORY_FIXTURE_USER_ID}
    `;
    expect(row!.n).toBe(MEMORY_FIXTURES.length);
  });
});
