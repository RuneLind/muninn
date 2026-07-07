/**
 * Synthetic memory fixtures for the memory-target retrieval eval.
 *
 * The huginn/research golden rows reference real Jira/Confluence docs that
 * already live in the running knowledge base, so they need no seeding. The
 * memory target instead needs deterministic rows with *stable ids* so the
 * golden set can name them as `expected_doc_ids`. `saveMemory` mints random
 * UUIDs, so we insert these directly with fixed ids.
 *
 * Seeding embeds each fixture via the real embeddings module so the vector
 * arm of `searchMemoriesHybrid` can rank them. If the embedding model is
 * unavailable the rows are seeded without embeddings (warn logged) — the
 * eval still works through the FTS arm, but the vector arm is then untested.
 *
 * The golden queries for this target live in {@link MEMORY_GOLDEN_QUERIES} —
 * the single source the local-only `benchmarks/retrieval/golden-queries.jsonl`
 * memory rows are copied from, and what the db test runs end-to-end against
 * seeded fixtures. Keep the query wording FTS-satisfiable: `searchMemories`
 * uses `plainto_tsquery('english', …)` AND-semantics, so EVERY content word
 * in a query must stem-match the fixture's summary/content/tags text.
 *
 * Seeding is intended for the TEST database; the CLI's `--seed-memories`
 * refuses non-`*_test` databases unless `--allow-live-seed` is passed. When
 * fixtures are absent the memory target is skipped rather than scored as a
 * miss (see `hasSeededMemoryFixtures`). Content is fully synthetic; no real
 * user data lives here, so this module is safe to commit.
 */

import { getLog } from "../logging.ts";
import { getDb } from "../db/client.ts";
import { ensureUser } from "../db/users.ts";
import { generateEmbedding } from "../ai/embeddings.ts";

const log = getLog("benchmarks", "retrieval-fixtures");

export const MEMORY_FIXTURE_USER_ID = "retrieval-eval-fixture-user";
export const MEMORY_FIXTURE_BOT_NAME = "retrieval-eval-bot";

export interface MemoryFixture {
  id: string;
  content: string;
  summary: string;
  tags: string[];
}

export const MEMORY_FIXTURES: MemoryFixture[] = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    content: "The user prefers dark roast coffee brewed with a French press every morning.",
    summary: "User prefers dark roast coffee brewed with a French press.",
    tags: ["coffee", "preferences"],
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    content: "The user is training for the Oslo marathon in September and runs long distances every Sunday.",
    summary: "User is training for the Oslo marathon in September.",
    tags: ["running", "marathon", "fitness"],
  },
  {
    id: "00000000-0000-4000-8000-000000000103",
    content: "The user's home server is a Raspberry Pi cluster managed with k3s Kubernetes.",
    summary: "User runs a Raspberry Pi home server cluster on k3s Kubernetes.",
    tags: ["homelab", "kubernetes", "raspberry-pi"],
  },
];

export interface MemoryGoldenQuery {
  id: string;
  query: string;
  expected: string[];
}

/**
 * Golden queries for the memory target — the single source of truth for the
 * memory rows in `benchmarks/retrieval/golden-queries.jsonl`, and run
 * end-to-end (real search against seeded fixtures) by the db test. Every
 * content word here appears (stem-wise) in the paired fixture's text so
 * plainto_tsquery's AND-semantics can match.
 */
export const MEMORY_GOLDEN_QUERIES: MemoryGoldenQuery[] = [
  { id: "mem-coffee", query: "user prefers dark roast coffee", expected: ["00000000-0000-4000-8000-000000000101"] },
  { id: "mem-marathon", query: "user training Oslo marathon", expected: ["00000000-0000-4000-8000-000000000102"] },
  { id: "mem-homelab", query: "home server raspberry pi kubernetes cluster", expected: ["00000000-0000-4000-8000-000000000103"] },
];

export interface SeedMemoryFixturesOptions {
  /**
   * Embedding function — defaults to the real model. Tests inject a
   * deterministic fake here: loading the HF/onnx model inside `bun test`
   * crashes the runtime (native C++ exception), which is also why every
   * other test file mocks `generateEmbedding` rather than calling it.
   */
  embed?: (text: string) => Promise<number[] | null>;
}

/**
 * Seed (or re-seed) the synthetic memory fixtures. Idempotent — deletes any
 * prior fixture rows first, then re-inserts. The search_vector column is
 * auto-populated by the memories trigger; embeddings are generated here (see
 * module doc for the null-tolerant fallback).
 */
export async function seedMemoryFixtures(opts: SeedMemoryFixturesOptions = {}): Promise<void> {
  const embed = opts.embed ?? generateEmbedding;
  await ensureUser({
    id: MEMORY_FIXTURE_USER_ID,
    username: "retrieval-eval-fixture",
    platform: "web",
  });

  const sql = getDb();
  const ids = MEMORY_FIXTURES.map((m) => m.id);
  await sql`DELETE FROM memories WHERE id = ANY(${ids})`;

  for (const m of MEMORY_FIXTURES) {
    const embedding = await embed(`${m.summary} ${m.content}`);
    if (embedding) {
      const embeddingStr = `[${embedding.join(",")}]`;
      await sql.unsafe(
        `INSERT INTO memories (id, user_id, bot_name, content, summary, tags, scope, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, 'personal', $7::vector)`,
        [m.id, MEMORY_FIXTURE_USER_ID, MEMORY_FIXTURE_BOT_NAME, m.content, m.summary, m.tags, embeddingStr],
      );
    } else {
      log.warn(
        "Embedding model unavailable — seeding fixture {id} without embedding (vector search arm untested)",
        { id: m.id },
      );
      await sql`
        INSERT INTO memories (id, user_id, bot_name, content, summary, tags, scope)
        VALUES (${m.id}, ${MEMORY_FIXTURE_USER_ID}, ${MEMORY_FIXTURE_BOT_NAME}, ${m.content}, ${m.summary}, ${m.tags}, 'personal')
      `;
    }
  }
}

/** True when all fixture memories are present in the current DB. */
export async function hasSeededMemoryFixtures(): Promise<boolean> {
  const sql = getDb();
  const ids = MEMORY_FIXTURES.map((m) => m.id);
  const [row] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM memories WHERE id = ANY(${ids})
  `;
  return (row?.n ?? 0) >= MEMORY_FIXTURES.length;
}
