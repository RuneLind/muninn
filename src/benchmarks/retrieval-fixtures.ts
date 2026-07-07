/**
 * Synthetic memory fixtures for the memory-target retrieval eval.
 *
 * The huginn/research golden rows reference real Jira/Confluence docs that
 * already live in the running knowledge base, so they need no seeding. The
 * memory target instead needs deterministic rows with *stable ids* so the
 * golden set can name them as `expected_doc_ids`. `saveMemory` mints random
 * UUIDs, so we insert these directly with fixed ids.
 *
 * These are seeded into the TEST database only (via the CLI's
 * `--seed-memories` flag or the db test). When they're absent — e.g. the CLI
 * pointed at a prod DB — the memory target is skipped rather than scored as a
 * miss (see `hasSeededMemoryFixtures`). Content is fully synthetic; no real
 * user data lives here, so this module is safe to commit.
 */

import { getDb } from "../db/client.ts";
import { ensureUser } from "../db/users.ts";

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

/** Golden queries for the memory target, referencing the fixture ids above. */
export const MEMORY_GOLDEN_QUERIES = [
  { id: "mem-coffee", query: "what coffee does the user like", expected: ["00000000-0000-4000-8000-000000000101"] },
  { id: "mem-marathon", query: "user marathon running training schedule", expected: ["00000000-0000-4000-8000-000000000102"] },
  { id: "mem-homelab", query: "user home server kubernetes cluster setup", expected: ["00000000-0000-4000-8000-000000000103"] },
] as const;

/**
 * Seed (or re-seed) the synthetic memory fixtures. Idempotent — deletes any
 * prior fixture rows first, then re-inserts. The search_vector column is
 * auto-populated by the memories trigger.
 */
export async function seedMemoryFixtures(): Promise<void> {
  await ensureUser({
    id: MEMORY_FIXTURE_USER_ID,
    username: "retrieval-eval-fixture",
    platform: "web",
  });

  const sql = getDb();
  const ids = MEMORY_FIXTURES.map((m) => m.id);
  await sql`DELETE FROM memories WHERE id = ANY(${ids})`;

  for (const m of MEMORY_FIXTURES) {
    await sql`
      INSERT INTO memories (id, user_id, bot_name, content, summary, tags, scope)
      VALUES (${m.id}, ${MEMORY_FIXTURE_USER_ID}, ${MEMORY_FIXTURE_BOT_NAME}, ${m.content}, ${m.summary}, ${m.tags}, 'personal')
    `;
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
