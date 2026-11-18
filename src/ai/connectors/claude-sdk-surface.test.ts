/**
 * The claude-sdk half of the declared tool surface, driven from the top layer
 * (`runCaptureOneShot` → `tracedOneShot` → `executeOneShot`) down to the
 * Options the connector hands the Agent SDK's `query()`.
 *
 * Its own `bun test` link: it calls `mock.module` on the Agent SDK, which
 * invalidates that module for the whole process (root `CLAUDE.md`, Testing).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";

const queryCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: { prompt: string; options: Record<string, unknown> }) => {
    queryCalls.push(params);
    return (async function* () {
      yield {
        type: "result", subtype: "success", result: "ok", num_turns: 1,
        duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, is_error: false,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      };
    })();
  },
}));

const { driveBot, driveCapture, driveConfig } = await import("../../test/one-shot-drive.ts");
const { toolSurfaceTestSeam } = await import("../tool-surface.ts");

let root: string;
let botDir: string;
let framesDir: string;
let agentRoot: string;
const saved = {
  agent: process.env.MUNINN_AGENT_CWD,
  key: process.env.ANTHROPIC_API_KEY,
};

beforeAll(() => {
  root = realpathSync(testTempDirSync(join(tmpdir(), "sdk-surface-")));
  botDir = join(root, "bot");
  framesDir = join(root, "frames");
  agentRoot = join(root, "agent-home");
  mkdirSync(botDir);
  mkdirSync(framesDir);
  writeFileSync(join(botDir, ".mcp.json"), JSON.stringify({ mcpServers: { stub: { command: "true" } } }));
  process.env.MUNINN_AGENT_CWD = agentRoot;
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [name, value] of [["MUNINN_AGENT_CWD", saved.agent], ["ANTHROPIC_API_KEY", saved.key]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  queryCalls.length = 0;
  delete toolSurfaceTestSeam.extraSettings;
});

const sdkBot = () => driveBot(botDir, { connector: "claude-sdk" });
const ask = (options: Record<string, unknown>, tool: string, input: Record<string, unknown>) =>
  (options.canUseTool as (t: string, i: Record<string, unknown>, o: unknown) => Promise<{ behavior: string }>)(
    tool, input, { signal: new AbortController().signal },
  );

describe("claude-sdk options, driven from runCaptureOneShot", () => {
  test('"bot": bypassPermissions in the bot folder with its MCP servers (today\'s surface)', async () => {
    await driveCapture(sdkBot(), "bot");
    const o = queryCalls[0]!.options;
    expect(o.cwd).toBe(botDir);
    expect(o.permissionMode).toBe("bypassPermissions");
    expect(Object.keys(o.mcpServers as object)).toEqual(["stub"]);
    expect("tools" in o).toBe(false);
    expect("strictMcpConfig" in o).toBe(false);
    expect("canUseTool" in o).toBe(false);
    // A chat-shaped run keeps whatever settings the SDK resolves (fix round 1 batch 4 scope).
    expect("settings" in o).toBe(false);
  });

  test('"none": no tools, no MCP server, and strictMcpConfig so no project .mcp.json loads', async () => {
    await driveCapture(sdkBot(), "none");
    const o = queryCalls[0]!.options;
    expect(o.tools).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect("mcpServers" in o).toBe(false);
    expect(o.settingSources).toEqual([]);
    // `settingSources: []` leaves auto memory on: a bot folder inside a git
    // checkout loaded that repo's MEMORY.md into every tool-less one-shot.
    expect(o.settings).toEqual({ autoMemoryEnabled: false });
  });

  test("{ read }: Read only, no MCP, no settings files, default mode, the dirs added, an empty agent home", async () => {
    await driveCapture(sdkBot(), { read: [framesDir] });
    const o = queryCalls[0]!.options;
    expect(o.tools).toEqual(["Read"]);
    expect(o.mcpServers).toEqual({});
    expect(o.strictMcpConfig).toBe(true);
    expect(o.settingSources).toEqual([]);
    expect(o.cwd).toBe(join(agentRoot, ".fenced"));
    expect(o.additionalDirectories).toEqual([framesDir]);
    expect(o.permissionMode).toBe("default");
    expect("allowDangerouslySkipPermissions" in o).toBe(false);
    expect(o.settings).toEqual({ autoMemoryEnabled: false });
    expect((await ask(o, "Read", { file_path: join(framesDir, "x.jpg") })).behavior).toBe("allow");
    expect((await ask(o, "Read", { file_path: join(botDir, "config.json") })).behavior).toBe("deny");
    expect((await ask(o, "Read", { file_path: join(framesDir, "..", "..", "x") })).behavior).toBe("deny");
    expect((await ask(o, "Bash", { command: "ls" })).behavior).toBe("deny");
    expect((await ask(o, "WebFetch", { url: "https://x" })).behavior).toBe("deny");
  });

  test("{ web }: the web tools only, no allow rule (canUseTool decides), no MCP, default mode", async () => {
    toolSurfaceTestSeam.extraSettings = { skipWebFetchPreflight: true };
    await driveCapture(sdkBot(), { web: true });
    const o = queryCalls[0]!.options;
    expect(o.tools).toEqual(["WebFetch", "WebSearch"]);
    expect(o.mcpServers).toEqual({});
    expect(o.strictMcpConfig).toBe(true);
    expect(o.permissionMode).toBe("default");
    expect(o.cwd).toBe(join(agentRoot, ".fenced"));
    expect("additionalDirectories" in o).toBe(false);
    // No allow rule: it would approve WebFetch before canUseTool is asked.
    expect(o.settings).toEqual({ skipWebFetchPreflight: true, autoMemoryEnabled: false });
    expect((await ask(o, "WebFetch", { url: "https://x" })).behavior).toBe("allow");
    expect((await ask(o, "WebFetch", { url: "https://127.0.0.1:8443/page" })).behavior).toBe("deny");
    expect((await ask(o, "Read", { file_path: join(framesDir, "x.jpg") })).behavior).toBe("deny");
  });

  test("{ readSearch }: Read, Grep and Glob, the snapshots added, the handler and a PreToolUse hook running one check", async () => {
    await driveCapture(sdkBot(), { readSearch: [framesDir] });
    const o = queryCalls[0]!.options;
    expect(o.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(o.mcpServers).toEqual({});
    expect(o.strictMcpConfig).toBe(true);
    expect(o.settingSources).toEqual([]);
    expect(o.cwd).toBe(join(agentRoot, ".fenced"));
    expect(o.additionalDirectories).toEqual([framesDir]);
    expect(o.permissionMode).toBe("default");
    expect(o.settings).toEqual({ autoMemoryEnabled: false });
    expect((await ask(o, "Grep", { pattern: "x", path: framesDir })).behavior).toBe("allow");
    expect((await ask(o, "Glob", { pattern: "../*", path: framesDir })).behavior).toBe("deny");
    expect((await ask(o, "Read", { file_path: join(botDir, "config.json") })).behavior).toBe("deny");
    // The hook sees the calls default mode approves without asking the handler.
    const matchers = (o.hooks as { PreToolUse: Array<{ matcher?: string; hooks: Array<(i: unknown, id: string, opts: unknown) => Promise<Record<string, unknown>>> }> }).PreToolUse;
    expect(matchers).toHaveLength(1);
    expect(matchers[0]!.matcher).toBeUndefined(); // every tool, not a name pattern
    const hook = (tool: string, input: Record<string, unknown>) =>
      matchers[0]!.hooks[0]!({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "t" }, "t", { signal: new AbortController().signal });
    expect(await hook("Glob", { pattern: "*.jpg", path: framesDir })).toEqual({});
    expect(await hook("Glob", { pattern: "../*", path: framesDir })).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    expect(await hook("Grep", { pattern: "x" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await hook("Bash", { command: "ls" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  test("{ read } and { web } carry no hook (their fences are unchanged)", async () => {
    await driveCapture(sdkBot(), { read: [framesDir] });
    await driveCapture(sdkBot(), { web: true });
    expect(queryCalls.map((c) => "hooks" in c.options)).toEqual([false, false]);
  });

  test("{ mcpTools } is refused before query(), by capability and by the connector itself", async () => {
    await expect(driveCapture(sdkBot(), { mcpTools: { stub: ["record"] } })).rejects.toThrow(/cannot run a \{ mcpTools \}/);
    const { executePrompt } = await import("./claude-sdk.ts");
    await expect(
      executePrompt("p", driveConfig, { ...sdkBot(), toolSurface: { mcpTools: { stub: ["record"] } } }),
    ).rejects.toThrow(/claude-sdk: the \{ mcpTools \} tool surface is not supported/);
    expect(queryCalls).toHaveLength(0);
  });

  test("a degraded agent home refuses a fenced run before query()", async () => {
    // mkdir in a read-only root fails (EACCES), so the agent home degrades to $TMPDIR.
    const readOnly = join(root, "read-only-home");
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    process.env.MUNINN_AGENT_CWD = readOnly;
    try {
      await expect(driveCapture(sdkBot(), { read: [framesDir] })).rejects.toThrow(/agent home/);
      await expect(driveCapture(sdkBot(), { web: true })).rejects.toThrow(/agent home/);
      expect(queryCalls).toHaveLength(0);
      await driveCapture(sdkBot(), "none");
      expect(queryCalls).toHaveLength(1);
    } finally {
      chmodSync(readOnly, 0o700);
      process.env.MUNINN_AGENT_CWD = agentRoot;
    }
  });
});
