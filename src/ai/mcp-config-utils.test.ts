import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildInlineMcpConfig, buildInlineSettings, loadRawMcpServers, resolveBotCwd } from "./mcp-config-utils.ts";

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

  test("relocates a relative `command`, not just relative args", () => {
    // `"command": "./scripts/mcp.sh"` resolved against the bot dir under the old
    // spawn cwd; left alone it now resolves against the agent home and the server
    // simply fails to start — which reads downstream as "the tool wasn't there".
    const botDir = scratchBot({
      mcpServers: { local: { type: "stdio", command: "./scripts/mcp.sh", args: ["--flag"] } },
    });
    const entry = JSON.parse(buildInlineMcpConfig(botDir)!).mcpServers.local;

    expect(entry.command).toBe(join(botDir, "scripts/mcp.sh"));
    expect(entry.args).toEqual(["--flag"]); // a plain flag is not a path
  });

  test("treats a url-only entry as remote even with no `type`", () => {
    // `{"url": "..."}` with no `type` is legal shorthand; reading `type` alone
    // drops it into the stdio branch and stamps a meaningless `cwd` on it.
    const botDir = scratchBot({ mcpServers: { remote: { url: "http://127.0.0.1:9121/mcp" } } });

    expect(JSON.parse(buildInlineMcpConfig(botDir)!).mcpServers.remote).toEqual({
      url: "http://127.0.0.1:9121/mcp",
    });
  });
});

describe("buildInlineSettings", () => {
  const write = (botDir: string, name: string, json: unknown) => {
    mkdirSync(join(botDir, ".claude"), { recursive: true });
    writeFileSync(join(botDir, ".claude", name), JSON.stringify(json));
  };

  test("merges settings.local.json over settings.json, UNIONING the permission lists", () => {
    // `--settings` is not repeatable, and settings.local.json is the file Claude
    // Code writes when a permission is approved in place — passing only the shared
    // file denies an interactively-granted tool on the next watcher run.
    const botDir = scratchBot();
    write(botDir, "settings.json", {
      permissions: { allow: ["mcp__gmail__search_emails"], deny: ["Bash"] },
      enableAllProjectMcpServers: true,
    });
    write(botDir, "settings.local.json", {
      permissions: { allow: ["mcp__jetbrains__execute_terminal_command"] },
    });

    const merged = JSON.parse(buildInlineSettings(botDir)!);
    // A local file granting ONE extra tool must not revoke what the shared file granted.
    expect(merged.permissions.allow).toEqual([
      "mcp__gmail__search_emails",
      "mcp__jetbrains__execute_terminal_command",
    ]);
    expect(merged.permissions.deny).toEqual(["Bash"]);
    expect(merged.enableAllProjectMcpServers).toBe(true);
  });

  test("de-duplicates a permission listed in both files", () => {
    const botDir = scratchBot();
    write(botDir, "settings.json", { permissions: { allow: ["A", "B"] } });
    write(botDir, "settings.local.json", { permissions: { allow: ["B", "C"] } });

    expect(JSON.parse(buildInlineSettings(botDir)!).permissions.allow).toEqual(["A", "B", "C"]);
  });

  test("works with either file alone, and a non-permission key is local-wins", () => {
    const onlyShared = scratchBot();
    write(onlyShared, "settings.json", { permissions: { allow: ["A"] } });
    const onlyLocal = scratchBot();
    write(onlyLocal, "settings.local.json", { permissions: { allow: ["B"] } });
    const both = scratchBot();
    write(both, "settings.json", { enableAllProjectMcpServers: true });
    write(both, "settings.local.json", { enableAllProjectMcpServers: false });

    expect(JSON.parse(buildInlineSettings(onlyShared)!).permissions.allow).toEqual(["A"]);
    expect(JSON.parse(buildInlineSettings(onlyLocal)!).permissions.allow).toEqual(["B"]);
    expect(JSON.parse(buildInlineSettings(both)!).enableAllProjectMcpServers).toBe(false);
  });

  test("returns null when neither file is readable, and ignores a broken or non-object one", () => {
    const none = scratchBot();
    const broken = scratchBot();
    mkdirSync(join(broken, ".claude"), { recursive: true });
    writeFileSync(join(broken, ".claude", "settings.json"), "{ not json");
    const array = scratchBot();
    write(array, "settings.json", ["not", "an", "object"]);

    expect(buildInlineSettings(none)).toBeNull();
    expect(buildInlineSettings(broken)).toBeNull();
    expect(buildInlineSettings(array)).toBeNull();
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
