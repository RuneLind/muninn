import { test, expect, describe } from "bun:test";
import { parseMcpConfig } from "./copilot-mcp.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

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
      const gmail = result.gmail as { type: string; command: string; args: string[]; cwd: string; env: Record<string, string>; tools: string[] };
      const calendar = result.calendar as { type: string; command: string; args: string[]; cwd: string; env: Record<string, string>; tools: string[] };

      expect(gmail.type).toBe("local");
      expect(gmail.command).toBe("npx");
      expect(gmail.args).toEqual(["-y", "@gongrzhe/server-gmail-autoauth-mcp"]);
      expect(gmail.cwd).toBe(dir);
      expect(gmail.tools).toEqual(["*"]);
      expect(gmail.env.HUGINN_TRACE_DEFAULT).toBe("1");
      expect(gmail.env.TOKEN_PATH).toBe("/tmp/token.json");

      expect(calendar.type).toBe("local");
      expect(calendar.command).toBe("node");
      expect(calendar.args).toEqual([]);
      expect(calendar.env.HUGINN_TRACE_DEFAULT).toBe("1");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("propagates trace-pointer env vars from process.env to spawned MCP children", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const mcpJson = { mcpServers: { huginn: { command: "uv", args: ["run", "x.py"] } } };
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcpJson));

    const previous = {
      HUGINN_TRACE_POINTER: process.env.HUGINN_TRACE_POINTER,
      YGGDRASIL_TRACE_POINTER: process.env.YGGDRASIL_TRACE_POINTER,
      YGGDRASIL_TRACE_DEFAULT: process.env.YGGDRASIL_TRACE_DEFAULT,
    };
    process.env.HUGINN_TRACE_POINTER = "1";
    process.env.YGGDRASIL_TRACE_POINTER = "1";
    process.env.YGGDRASIL_TRACE_DEFAULT = "1";

    try {
      const result = parseMcpConfig(dir);
      const huginn = result.huginn as { env: Record<string, string> };
      expect(huginn.env.HUGINN_TRACE_POINTER).toBe("1");
      expect(huginn.env.YGGDRASIL_TRACE_POINTER).toBe("1");
      expect(huginn.env.YGGDRASIL_TRACE_DEFAULT).toBe("1");
      // Forced flag still present.
      expect(huginn.env.HUGINN_TRACE_DEFAULT).toBe("1");
    } finally {
      rmSync(dir, { recursive: true });
      restoreEnv("HUGINN_TRACE_POINTER", previous.HUGINN_TRACE_POINTER);
      restoreEnv("YGGDRASIL_TRACE_POINTER", previous.YGGDRASIL_TRACE_POINTER);
      restoreEnv("YGGDRASIL_TRACE_DEFAULT", previous.YGGDRASIL_TRACE_DEFAULT);
    }
  });

  test("bot's .mcp.json env wins over inherited process.env on key collision", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const mcpJson = {
      mcpServers: { svc: { command: "node", env: { TOKEN_PATH: "/bot/specific" } } },
    };
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcpJson));

    const previous = process.env.TOKEN_PATH;
    process.env.TOKEN_PATH = "/from/process";

    try {
      const result = parseMcpConfig(dir);
      const svc = result.svc as { env: Record<string, string> };
      expect(svc.env.TOKEN_PATH).toBe("/bot/specific");
    } finally {
      rmSync(dir, { recursive: true });
      restoreEnv("TOKEN_PATH", previous);
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

  test("resolves relative cwd against bot dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const mcpJson = {
      mcpServers: {
        rel: { command: "uv", args: ["run", "x.py"], cwd: "../sibling" },
        abs: { command: "uv", args: ["run", "y.py"], cwd: "/opt/foo" },
      },
    };
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcpJson));
    try {
      const result = parseMcpConfig(dir);
      const rel = result.rel as { cwd: string };
      const abs = result.abs as { cwd: string };
      expect(rel.cwd).toBe(join(dir, "..", "sibling"));
      expect(abs.cwd).toBe("/opt/foo");
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
