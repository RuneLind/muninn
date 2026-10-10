import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { ResearchMcpServer, researchMcpPort } from "./mcp-server.ts";

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

describe("RESEARCH_MCP_PORT", () => {
  test("unset or blank is 9190; a number is taken; 0 asks the OS for a free port", () => {
    expect(researchMcpPort({})).toBe(9190);
    expect(researchMcpPort({ RESEARCH_MCP_PORT: " " })).toBe(9190);
    expect(researchMcpPort({ RESEARCH_MCP_PORT: "9191" })).toBe(9191);
    expect(researchMcpPort({ RESEARCH_MCP_PORT: "0" })).toBe(0);
  });

  test("anything else falls back to 9190", () => {
    for (const bad of ["abc", "-1", "70000", "91.5"]) expect(researchMcpPort({ RESEARCH_MCP_PORT: bad })).toBe(9190);
  });

  test("port 0 binds a free port, and url names it", async () => {
    const server = new ResearchMcpServer(0);
    server.start();
    try {
      expect(server.url).not.toBe("http://127.0.0.1:0");
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await server.stop();
    }
  });
});
