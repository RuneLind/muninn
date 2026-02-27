import { test, expect, describe } from "bun:test";
import { parseMcpConfig } from "./copilot-mcp.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parseMcpConfig", () => {
  test("returns empty object when .mcp.json does not exist", () => {
    const result = parseMcpConfig("/nonexistent/path");
    expect(result).toEqual({});
  });

  test("returns empty object when .mcp.json has no mcpServers", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ other: "stuff" }));
    try {
      const result = parseMcpConfig(dir);
      expect(result).toEqual({});
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("converts mcpServers to Copilot SDK format", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const mcpJson = {
      mcpServers: {
        gmail: {
          command: "npx",
          args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
          env: { TOKEN_PATH: "/tmp/token.json" },
        },
        calendar: {
          command: "node",
        },
      },
    };
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcpJson));
    try {
      const result = parseMcpConfig(dir);
      expect(result).toEqual({
        gmail: {
          type: "local",
          command: "npx",
          args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
          env: { TOKEN_PATH: "/tmp/token.json" },
          tools: ["*"],
        },
        calendar: {
          type: "local",
          command: "node",
          args: [],
          env: undefined,
          tools: ["*"],
        },
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("returns empty object for invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    writeFileSync(join(dir, ".mcp.json"), "not json{{{");
    try {
      const result = parseMcpConfig(dir);
      expect(result).toEqual({});
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
