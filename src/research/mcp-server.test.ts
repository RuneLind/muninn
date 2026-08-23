import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { ResearchMcpServer } from "./mcp-server.ts";

// The HTTP surface tests below only exercise /health and the unknown-bot 404
// path — neither triggers a Tracer construction or DB write, so no mocks are
// needed. mock.module on db/traces or config.ts would leak across the test
// chunk and break sibling tests (huginn-trace, stream-parser, db/traces).
const TEST_PORT = 9899;

const server = new ResearchMcpServer(TEST_PORT);
const base = `http://127.0.0.1:${TEST_PORT}`;

beforeAll(async () => {
  server.start();
});

afterAll(async () => {
  await server.stop();
});

describe("ResearchMcpServer HTTP surface", () => {
  test("/health returns the registered bot list", async () => {
    server.registerBot({ botName: "alpha", knowledgeApiUrl: "http://huginn" });
    server.registerBot({ botName: "beta", knowledgeApiUrl: "http://huginn" });

    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; bots: string[]; sessions: number };
    expect(body.status).toBe("ok");
    expect(body.bots).toContain("alpha");
    expect(body.bots).toContain("beta");
  });

  test("unknown bot path returns 404", async () => {
    const res = await fetch(`${base}/mcp/nonexistent`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }) });
    expect(res.status).toBe(404);
  });

  test("unregisterBot removes the bot from /health", async () => {
    server.registerBot({ botName: "gamma", knowledgeApiUrl: "http://huginn" });
    server.unregisterBot("gamma");
    const res = await fetch(`${base}/health`);
    const body = await res.json() as { bots: string[] };
    expect(body.bots).not.toContain("gamma");
  });

  test("non-MCP path returns 404", async () => {
    const res = await fetch(`${base}/random`);
    expect(res.status).toBe(404);
  });
});

/**
 * The citation signal a chat thread leaves behind.
 *
 * `research_citations` is written today only by `/research` ask; the chat's own
 * `research_knowledge` call wrote nothing, and the trace's tool-span outputs are
 * truncated to a `_truncated` head — so after a refinement discussion the hits the
 * conversation saw were unrecoverable. The row shaping is tested here rather than
 * the write, because the write is fire-and-forget by design and mocking
 * `db/research-citations.ts` in this file would leak across the test chunk.
 */
describe("threadCitationRows", () => {
  const result = {
    results: [
      { collection: "jira-issues", id: "MELOSYS-8150_x.md", title: "T", url: "https://jira.adeo.no/browse/MELOSYS-8150", relevance: 0.8, viaSubQuestion: ["q"] },
      { collection: "nav-wiki", id: "concepts/MEDL.md", relevance: 0.4, viaSubQuestion: ["q"] },
    ],
    decomposition: { subQuestions: ["q"], rationale: "", passthrough: true, haikuMs: 1 },
    subSearches: [{ subQuestion: "q", durationMs: 1, resultCount: 2 }],
    traceId: "9f1d8a0e-0000-4000-8000-000000000000",
  } as never;

  test("one row per hit, stamped with the thread and OUR trace id", async () => {
    const { threadCitationRows } = await import("./mcp-server.ts");
    const rows = threadCitationRows("melosys", "hvordan?", result, "t-1");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      botName: "melosys",
      threadId: "t-1",
      traceId: "9f1d8a0e-0000-4000-8000-000000000000",
      question: "hvordan?",
      docId: "MELOSYS-8150_x.md",
      collection: "jira-issues",
      url: "https://jira.adeo.no/browse/MELOSYS-8150",
      title: "T",
      relevance: 0.8,
      // Always false here: the assistant's reply does not exist yet, and unlike
      // /research there are no [n] markers to read back. It is derived later,
      // from the reply itself (`seedThreadCitations`).
      cited: false,
    });
    expect(rows[1]!.title).toBeNull();
    expect(rows[1]!.url).toBeNull();
  });

  test("no active turn ⇒ no rows at all, never an unattributed write", async () => {
    const { threadCitationRows } = await import("./mcp-server.ts");
    expect(threadCitationRows("melosys", "q", result, null)).toEqual([]);
  });
});
