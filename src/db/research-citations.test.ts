import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import { recordToolSpan } from "../ai/connectors/tool-span.ts";
import {
  _resetActiveTurnsForTests,
  currentActiveTurn,
  popActiveTurn,
  pushActiveTurn,
  runInActiveTurn,
  type ActiveTurnBinding,
} from "../hivemind/active-turn.ts";
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

/**
 * PR A acceptance 1, the DB-write half — "**zero** `research_citations` rows
 * carry a `thread_id` belonging to the other".
 *
 * This is the empirical pass on the fifth cross-user channel. It drives the REAL
 * seam — `recordToolSpan`, the completion tail every streaming connector funnels
 * its tool results through — with two turns interleaved on one bot, and then
 * reads the rows back out of Postgres. Before PR A the correlation input was
 * `peekActiveTurn(botName)`, a per-bot LIFO, so BOTH turns' hits landed on
 * whichever thread pushed last.
 *
 * The fixtures are the same synthetic huginn renderings the parser tests use —
 * never captured from the corpus (this repo is public).
 */
describe("thread citations under two concurrent turns on one bot", () => {
  const BOT = "melosys-concurrency-test";

  /** One rendered `search_knowledge` result, with a doc id we can trace back. */
  function huginnResult(marker: string): string {
    return [
      `Found 1 result:`,
      ``,
      `## ${marker} sak (91.4% relevant · high) | updated: 2026-01-01`,
      `https://jira.example.invalid/browse/${marker}-1`,
      "collection: `jira-issues` doc_id: `" + marker + "-1_sak.md`",
      ``,
    ].join("\n");
  }

  /** The tool-result tail, exactly as a connector calls it: with the binding the
   *  connector CAPTURED at entry, not one read here. */
  function runToolCall(marker: string, turn: ActiveTurnBinding | null): void {
    recordToolSpan({
      id: `tool-${marker}`,
      name: "mcp__knowledge__search_knowledge",
      input: "innlogging",
      rawResult: huginnResult(marker),
      startMs: 0,
      endMs: 1,
      wallStart: 0,
      botName: BOT,
      turn,
    });
  }

  /** The write is fire-and-forget; wait for it rather than racing it. */
  async function waitForRows(threadId: string, n: number) {
    for (let i = 0; i < 50; i++) {
      const rows = await getCitationsForThread(threadId);
      if (rows.length >= n) return rows;
      await Bun.sleep(20);
    }
    return getCitationsForThread(threadId);
  }

  test("each turn's hits land on ITS OWN thread, not the one that pushed last", async () => {
    _resetActiveTurnsForTests();
    const threadA = crypto.randomUUID();
    const threadB = crypto.randomUUID();

    // Both turns are in flight — this is the steady state the plan describes,
    // not an edge case, once one bot serves more than one person.
    pushActiveTurn(BOT, threadA);
    pushActiveTurn(BOT, threadB);

    // Each "connector" captures its own turn at entry, with real awaits in
    // between...
    const [capturedA, capturedB] = await Promise.all([
      runInActiveTurn(BOT, threadA, async () => {
        await Bun.sleep(15);
        return currentActiveTurn();
      }),
      runInActiveTurn(BOT, threadB, async () => {
        await Bun.sleep(1);
        return currentActiveTurn();
      }),
    ]);

    // ...and both tool results are then dispatched from a context belonging to
    // NEITHER turn. That is the copilot-sdk shape — one long-lived client whose
    // event loop was created inside whichever turn started it — and it is why
    // the binding is captured and passed rather than read at the point of use.
    runToolCall("AAA", capturedA);
    runToolCall("BBB", capturedB);

    const rowsA = await waitForRows(threadA, 1);
    const rowsB = await waitForRows(threadB, 1);

    expect(rowsA.map((r) => r.docId)).toEqual(["AAA-1_sak.md"]);
    expect(rowsB.map((r) => r.docId)).toEqual(["BBB-1_sak.md"]);
    // Stated as the acceptance states it: nothing of the other's, either way.
    expect(rowsA.some((r) => r.docId.startsWith("BBB"))).toBe(false);
    expect(rowsB.some((r) => r.docId.startsWith("AAA"))).toBe(false);

    popActiveTurn(BOT, threadA);
    popActiveTurn(BOT, threadB);
    _resetActiveTurnsForTests();
  });

  test("a single turn still files its hits — the fix is not a mute button", async () => {
    _resetActiveTurnsForTests();
    const thread = crypto.randomUUID();
    pushActiveTurn(BOT, thread);

    const captured = await runInActiveTurn(BOT, thread, async () => {
      await Bun.sleep(1);
      return currentActiveTurn();
    });
    runToolCall("CCC", captured);

    expect((await waitForRows(thread, 1)).map((r) => r.docId)).toEqual(["CCC-1_sak.md"]);

    popActiveTurn(BOT, thread);
    _resetActiveTurnsForTests();
  });

  test("a tool result with NO captured turn writes nothing, whatever the stack says", async () => {
    // The in-band seam does not fall back to the stack: a connector that could
    // not capture a turn has nothing to attribute to, and guessing from the
    // stack is what put a colleague's search in someone else's conversation.
    _resetActiveTurnsForTests();
    const threadA = crypto.randomUUID();
    const threadB = crypto.randomUUID();
    pushActiveTurn(BOT, threadA);
    pushActiveTurn(BOT, threadB);

    runToolCall("DDD", null);
    await Bun.sleep(200);

    expect(await getCitationsForThread(threadA)).toEqual([]);
    expect(await getCitationsForThread(threadB)).toEqual([]);

    _resetActiveTurnsForTests();
  });

  test("a THREADLESS turn files nothing rather than borrowing a neighbour's thread", async () => {
    // A turn whose `threadId` is null still binds — see ActiveTurnBinding. Left
    // unbound it would fall through to the stack, where one other turn in flight
    // reads as "unambiguous" and its thread gets the hits.
    _resetActiveTurnsForTests();
    const other = crypto.randomUUID();
    pushActiveTurn(BOT, other);

    const captured = await runInActiveTurn(BOT, null, async () => {
      await Bun.sleep(1);
      return currentActiveTurn();
    });
    runToolCall("EEE", captured);
    await Bun.sleep(200);

    expect(await getCitationsForThread(other)).toEqual([]);

    popActiveTurn(BOT, other);
    _resetActiveTurnsForTests();
  });
});
