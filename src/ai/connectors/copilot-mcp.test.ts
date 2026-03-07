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

  test("converts http entries to remote server format", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const mcpJson = {
      mcpServers: {
        "serena-api": {
          type: "http",
          url: "http://127.0.0.1:9121/mcp",
        },
        "serena-sse": {
          type: "sse",
          url: "http://127.0.0.1:9122/sse",
          headers: { Authorization: "Bearer test" },
        },
      },
    };
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcpJson));
    try {
      const result = parseMcpConfig(dir);
      expect(result).toEqual({
        "serena-api": {
          type: "http",
          url: "http://127.0.0.1:9121/mcp",
          headers: undefined,
          tools: ["*"],
        },
        "serena-sse": {
          type: "sse",
          url: "http://127.0.0.1:9122/sse",
          headers: { Authorization: "Bearer test" },
          tools: ["*"],
        },
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("skips http entry without url", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const mcpJson = {
      mcpServers: {
        broken: { type: "http" },
        valid: { command: "node", args: ["server.js"] },
      },
    };
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcpJson));
    try {
      const result = parseMcpConfig(dir);
      expect(Object.keys(result)).toEqual(["valid"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("skips stdio entry without command", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const mcpJson = {
      mcpServers: {
        broken: { args: ["--flag"] },
        valid: { type: "http", url: "http://localhost:9000/mcp" },
      },
    };
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcpJson));
    try {
      const result = parseMcpConfig(dir);
      expect(Object.keys(result)).toEqual(["valid"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("handles mixed local and remote entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const mcpJson = {
      mcpServers: {
        gmail: { command: "npx", args: ["-y", "gmail-mcp"] },
        serena: { type: "http", url: "http://127.0.0.1:9121/mcp" },
      },
    };
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcpJson));
    try {
      const result = parseMcpConfig(dir);
      expect(result.gmail!.type).toBe("local");
      expect(result.serena!.type).toBe("http");
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
