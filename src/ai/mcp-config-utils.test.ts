import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildInlineMcpConfig, loadRawMcpServers, resolveBotCwd } from "./mcp-config-utils.ts";

/**
 * A throwaway `<tmp>/bots/jarvis` holding one `.mcp.json`. Every root is recorded
 * so cleanup removes exactly the mkdtemp dirs this file created — never a path
 * derived by walking upward from a bot dir (which is how a cleanup ends up
 * pointed at `$TMPDIR` itself).
 */
const scratchRoots: string[] = [];
function scratchBot(mcpJson?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "muninn-mcp-cfg-"));
  scratchRoots.push(root);
  const botDir = join(root, "bots", "jarvis");
  mkdirSync(botDir, { recursive: true });
  if (mcpJson !== undefined) {
    writeFileSync(join(botDir, ".mcp.json"), JSON.stringify(mcpJson));
  }
  return botDir;
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.length = 0;
});

describe("buildInlineMcpConfig", () => {
  test("resolves relative arg paths and cwd against the bot dir", () => {
    // jarvis's real shape: `uv --directory ../../../huginn run adapter.py`, which
    // only resolves while the CLI itself runs in the bot folder.
    const botDir = scratchBot({
      mcpServers: {
        knowledge: {
          type: "stdio",
          command: "uv",
          args: ["--directory", "../../../huginn", "run", "adapter.py"],
          env: { KNOWLEDGE_API_URL: "http://localhost:8321" },
        },
      },
    });
    const entry = JSON.parse(buildInlineMcpConfig(botDir)!).mcpServers.knowledge;

    expect(entry.args[1]).toBe(join(botDir, "../../../huginn"));
    expect(entry.args[1].startsWith("/")).toBe(true);
    // Non-path tokens survive verbatim — only ./ and ../ tokens are rewritten.
    expect(entry.args[0]).toBe("--directory");
    expect(entry.args[2]).toBe("run");
    expect(entry.args[3]).toBe("adapter.py");
    // env is read literally by convention (root CLAUDE.md, "Config Sync") —
    // rewriting it would change meaning, not preserve it.
    expect(entry.env).toEqual({ KNOWLEDGE_API_URL: "http://localhost:8321" });
    // An absent cwd defaults to the bot dir, so a consumer that DOES honour cwd
    // keeps behaving as it did under the old bot-dir spawn cwd.
    expect(entry.cwd).toBe(botDir);
  });

  test("leaves absolute args and an absolute cwd untouched", () => {
    const botDir = scratchBot({
      mcpServers: {
        gmail: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
          cwd: "/opt/gmail",
        },
      },
    });
    const entry = JSON.parse(buildInlineMcpConfig(botDir)!).mcpServers.gmail;

    expect(entry.args).toEqual(["-y", "@gongrzhe/server-gmail-autoauth-mcp"]);
    expect(entry.cwd).toBe("/opt/gmail");
  });

  test("passes http/sse servers through without inventing a cwd", () => {
    // A URL-only entry has no filesystem meaning; stamping `cwd` on it would be
    // noise the CLI has to ignore.
    const botDir = scratchBot({
      mcpServers: { code: { type: "http", url: "http://127.0.0.1:9121/mcp" } },
    });

    expect(JSON.parse(buildInlineMcpConfig(botDir)!).mcpServers.code).toEqual({
      type: "http",
      url: "http://127.0.0.1:9121/mcp",
    });
  });

  test("returns null for a missing, unparseable, key-less or empty config", () => {
    const missing = scratchBot();
    const empty = scratchBot({ mcpServers: {} });
    const noKey = scratchBot({ somethingElse: true });
    const broken = scratchBot();
    writeFileSync(join(broken, ".mcp.json"), "{ not json");

    // All four must be indistinguishable from "caller passed no botDir", so the
    // spawn falls through to --strict-mcp-config rather than handing the CLI an
    // empty server set.
    expect(buildInlineMcpConfig(missing)).toBeNull();
    expect(buildInlineMcpConfig(empty)).toBeNull();
    expect(buildInlineMcpConfig(noKey)).toBeNull();
    expect(buildInlineMcpConfig(broken)).toBeNull();
  });

  test("emits a single-line JSON document (it is passed as one argv element)", () => {
    const botDir = scratchBot({ mcpServers: { a: { type: "stdio", command: "x" } } });
    const out = buildInlineMcpConfig(botDir)!;

    expect(out).not.toContain("\n");
    expect(JSON.parse(out).mcpServers.a.command).toBe("x");
  });
});

describe("loadRawMcpServers / resolveBotCwd", () => {
  test("still behave as before (regression guard for the shared helpers)", () => {
    const botDir = scratchBot({ mcpServers: { a: { command: "x" } } });

    expect(loadRawMcpServers(botDir)).toEqual({ a: { command: "x" } });
    expect(resolveBotCwd(undefined, botDir)).toBe(botDir);
    expect(resolveBotCwd("../sib", botDir)).toBe(join(botDir, "../sib"));
    expect(resolveBotCwd("/abs", botDir)).toBe("/abs");
  });
});
