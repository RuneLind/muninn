import { test, expect, describe } from "bun:test";
import { parseMcpConfig } from "./claude-sdk-mcp.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("claude-sdk parseMcpConfig", () => {
  test("returns empty object when .mcp.json does not exist", () => {
    expect(parseMcpConfig("/nonexistent/path")).toEqual({});
  });

  test("converts stdio servers to Agent SDK shape with merged env", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-sdk-test-"));
    const mcpJson = {
      mcpServers: {
        gmail: {
          command: "npx",
          args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
          env: { TOKEN_PATH: "/tmp/token.json" },
        },
        calendar: { command: "node" },
      },
    };
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcpJson));
    try {
      const result = parseMcpConfig(dir);
      const gmail = result.gmail as { type: string; command: string; args: string[]; env: Record<string, string> };
      const calendar = result.calendar as { type: string; command: string; args: string[]; env: Record<string, string> };

      expect(gmail.type).toBe("stdio");
      expect(gmail.command).toBe("npx");
      expect(gmail.args).toEqual(["-y", "@gongrzhe/server-gmail-autoauth-mcp"]);
      expect(gmail.env.HUGINN_TRACE_DEFAULT).toBe("1");
      expect(gmail.env.TOKEN_PATH).toBe("/tmp/token.json");
      // Per-server cwd is dropped — Agent SDK doesn't expose it. No `cwd` field
      // should be set on the result.
      expect((gmail as Record<string, unknown>).cwd).toBeUndefined();

      expect(calendar.type).toBe("stdio");
      expect(calendar.command).toBe("node");
      expect(calendar.args).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("converts http servers to Agent SDK shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-sdk-test-"));
    const mcpJson = {
      mcpServers: {
        knowledge: { type: "http", url: "http://127.0.0.1:9120/mcp", headers: { "x-auth": "k" } },
      },
    };
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcpJson));
    try {
      const result = parseMcpConfig(dir);
      const knowledge = result.knowledge as { type: string; url: string; headers: Record<string, string> };
      expect(knowledge.type).toBe("http");
      expect(knowledge.url).toBe("http://127.0.0.1:9120/mcp");
      expect(knowledge.headers).toEqual({ "x-auth": "k" });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("converts sse servers", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-sdk-test-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { live: { type: "sse", url: "http://localhost:5000/sse" } } }),
    );
    try {
      const result = parseMcpConfig(dir);
      const live = result.live as { type: string; url: string };
      expect(live.type).toBe("sse");
      expect(live.url).toBe("http://localhost:5000/sse");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("skips http entries without url and stdio entries without command", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-sdk-test-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          broken_http: { type: "http" },
          broken_stdio: { type: "stdio" },
          ok: { command: "node" },
        },
      }),
    );
    try {
      const result = parseMcpConfig(dir);
      expect(result.broken_http).toBeUndefined();
      expect(result.broken_stdio).toBeUndefined();
      expect(result.ok).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("returns empty object on parse failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-sdk-test-"));
    writeFileSync(join(dir, ".mcp.json"), "{ not json");
    try {
      expect(parseMcpConfig(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
