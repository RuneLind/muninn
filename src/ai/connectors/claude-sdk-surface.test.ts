/**
 * The claude-sdk half of the declared tool surface, driven from the top layer
 * (`runCaptureOneShot` → `tracedOneShot` → `executeOneShot`) down to the
 * Options the connector hands the Agent SDK's `query()`.
 *
 * Its own `bun test` link: it calls `mock.module` on the Agent SDK, which
 * invalidates that module for the whole process (root `CLAUDE.md`, Testing).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const { driveBot, driveCapture } = await import("../../test/one-shot-drive.ts");
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "sdk-surface-")));
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
  });

  test('"none": no tools, no MCP server, and strictMcpConfig so no project .mcp.json loads', async () => {
    await driveCapture(sdkBot(), "none");
    const o = queryCalls[0]!.options;
    expect(o.tools).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect("mcpServers" in o).toBe(false);
    expect(o.settingSources).toEqual([]);
  });

  test("{ read }: Read only, no MCP, no settings files, default mode, the dirs added, an empty agent home", async () => {
    await driveCapture(sdkBot(), { read: [framesDir] });
    const o = queryCalls[0]!.options;
    expect(o.tools).toEqual(["Read"]);
    expect(o.mcpServers).toEqual({});
    expect(o.strictMcpConfig).toBe(true);
    expect(o.settingSources).toEqual([]);
    expect(o.cwd).toBe(join(agentRoot, "capture"));
    expect(o.additionalDirectories).toEqual([framesDir]);
    expect(o.permissionMode).toBe("default");
    expect("allowDangerouslySkipPermissions" in o).toBe(false);
    expect("settings" in o).toBe(false);
    expect((await ask(o, "Read", { file_path: join(framesDir, "x.jpg") })).behavior).toBe("allow");
    expect((await ask(o, "Read", { file_path: join(botDir, "config.json") })).behavior).toBe("deny");
    expect((await ask(o, "Read", { file_path: join(framesDir, "..", "..", "x") })).behavior).toBe("deny");
    expect((await ask(o, "Bash", { command: "ls" })).behavior).toBe("deny");
    expect((await ask(o, "WebFetch", { url: "https://x" })).behavior).toBe("deny");
  });

  test("{ web }: the web tools only, the allow rule in settings, no MCP, default mode", async () => {
    toolSurfaceTestSeam.extraSettings = { skipWebFetchPreflight: true };
    await driveCapture(sdkBot(), { web: true });
    const o = queryCalls[0]!.options;
    expect(o.tools).toEqual(["WebFetch", "WebSearch"]);
    expect(o.mcpServers).toEqual({});
    expect(o.strictMcpConfig).toBe(true);
    expect(o.permissionMode).toBe("default");
    expect(o.cwd).toBe(join(agentRoot, "capture"));
    expect("additionalDirectories" in o).toBe(false);
    expect(o.settings).toEqual({ permissions: { allow: ["WebFetch", "WebSearch"] }, skipWebFetchPreflight: true });
    expect((await ask(o, "WebFetch", { url: "https://x" })).behavior).toBe("allow");
    expect((await ask(o, "Read", { file_path: join(framesDir, "x.jpg") })).behavior).toBe("deny");
  });

  test("{ read } with extraDirs beside it never reaches the SDK", async () => {
    await expect(driveCapture(sdkBot(), { read: [framesDir] }, { extraDirs: [root] })).rejects.toThrow(/only allowed/);
    expect(queryCalls).toHaveLength(0);
  });
});
