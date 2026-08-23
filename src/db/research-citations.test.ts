import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  cleanupThreadCitations,
  insertResearchCitations,
  persistResearchCitations,
  getCitationsForTrace,
  getCitationsForThread,
} from "./research-citations.ts";

setupTestDb();

function makeCitation(n: number, overrides: Record<string, unknown> = {}) {
  return {
    n,
    collection: "anthropic-knowledge",
    docId: `doc-${n}.md`,
    url: `https://example.com/${n}`,
    title: `Source ${n}`,
    relevance: 0.75,
    ...overrides,
  };
}

describe("research-citations", () => {
  test("insertResearchCitations is a no-op on empty input", async () => {
    const count = await insertResearchCitations([]);
    expect(count).toBe(0);
  });

  test("persists cited AND uncited rows with the right flags", async () => {
    const traceId = crypto.randomUUID();
    await persistResearchCitations({
      botName: "jarvis",
      userId: "user-1",
      traceId,
      question: "What is MCP?",
      citations: [makeCitation(1), makeCitation(2), makeCitation(3)],
      citedIndices: [1, 3], // answer used [1] and [3], ignored [2]
    });

    const rows = await getCitationsForTrace(traceId);
    expect(rows.length).toBe(3);

    const byDoc = new Map(rows.map((r) => [r.docId, r]));
    expect(byDoc.get("doc-1.md")!.cited).toBe(true);
    expect(byDoc.get("doc-2.md")!.cited).toBe(false); // retrieved-but-ignored
    expect(byDoc.get("doc-3.md")!.cited).toBe(true);

    const first = byDoc.get("doc-1.md")!;
    expect(first.botName).toBe("jarvis");
    expect(first.userId).toBe("user-1");
    expect(first.question).toBe("What is MCP?");
    expect(first.collection).toBe("anthropic-knowledge");
    expect(first.relevance).toBeCloseTo(0.75, 5);
    expect(first.url).toBe("https://example.com/1");
  });

  test("declined path persists all sources as uncited (empty citedIndices)", async () => {
    const traceId = crypto.randomUUID();
    await persistResearchCitations({
      botName: "jarvis",
      traceId,
      question: "obscure question",
      citations: [makeCitation(1), makeCitation(2)],
      citedIndices: [],
    });

    const rows = await getCitationsForTrace(traceId);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.cited === false)).toBe(true);
    // userId omitted → null (Research ask has no per-user attribution)
    expect(rows[0]!.userId).toBeNull();
  });

  test("nullable fields (url/title/relevance) round-trip as null", async () => {
    const traceId = crypto.randomUUID();
    await persistResearchCitations({
      botName: "jarvis",
      traceId,
      question: null,
      citations: [{ n: 1, collection: "wiki", docId: "w.md" }],
      citedIndices: [1],
    });
    const rows = await getCitationsForTrace(traceId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.url).toBeNull();
    expect(rows[0]!.title).toBeNull();
    expect(rows[0]!.relevance).toBeNull();
    expect(rows[0]!.question).toBeNull();
    expect(rows[0]!.cited).toBe(true);
  });
});

/**
 * Retention for the CHAT half of the table.
 *
 * Every `research_knowledge` call in every thread now writes a row per hit, and
 * nothing deleted them — a table that only grows, on the hot path of ordinary
 * chat. The predicate is deliberately narrow: `/research` ask rows (`thread_id
 * IS NULL`) are the durable retrieval ledger the search-signal work rests on and
 * are never touched, and a `cited` row is the evidence that a conversation
 * actually used the source, which is the whole point of keeping any of them.
 */
describe("cleanupThreadCitations", () => {
  const THREAD = "11111111-2222-4333-8444-555555555555";

  async function seed(): Promise<void> {
    const sql = getDb();
    await insertResearchCitations([
      { threadId: THREAD, docId: "old-uncited.md", collection: "jira-issues", cited: false },
      { threadId: THREAD, docId: "old-cited.md", collection: "jira-issues", cited: true },
      { threadId: THREAD, docId: "fresh-uncited.md", collection: "jira-issues", cited: false },
      { traceId: crypto.randomUUID(), docId: "research-ask.md", collection: "wiki", cited: false },
    ]);
    // Backdate everything but the fresh row — `created_at` defaults to now().
    await sql`
      UPDATE research_citations
      SET created_at = now() - interval '30 days'
      WHERE doc_id IN ('old-uncited.md', 'old-cited.md', 'research-ask.md')
    `;
  }

  test("deletes only OLD, UNCITED, thread-scoped rows", async () => {
    await seed();
    expect(await cleanupThreadCitations(7)).toBe(1);

    const kept = await getCitationsForThread(THREAD);
    expect(kept.map((r) => r.docId).sort()).toEqual(["fresh-uncited.md", "old-cited.md"]);

    // The `/research` ask row is untouched whatever its age.
    const sql = getDb();
    const askRows = await sql`
      SELECT doc_id FROM research_citations WHERE thread_id IS NULL
    `;
    expect(askRows.map((r) => r.doc_id)).toEqual(["research-ask.md"]);
  });

  test("a wide retention window deletes nothing", async () => {
    await seed();
    expect(await cleanupThreadCitations(90)).toBe(0);
  });
});
