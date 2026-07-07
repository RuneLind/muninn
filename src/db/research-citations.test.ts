import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import {
  insertResearchCitations,
  persistResearchCitations,
  getCitationsForTrace,
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
