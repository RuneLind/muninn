/**
 * The copilot-sdk half of the declared tool surface, driven from the top layer
 * (`runCaptureOneShot` → `tracedOneShot` → `executeOneShot`) down to the
 * session options the connector hands `createSession`. `"none"` and `"bot"`
 * work as before; `{ read }`, `{ web }` and `{ readSearch }` never reach a
 * session; `{ mcpTools }` builds an allow-listed session and reads its tool
 * list back before the prompt is sent.
 *
 * Its own `bun test` link: it calls `mock.module` on the Copilot SDK, which
 * invalidates that module for the whole process (root `CLAUDE.md`, Testing).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";

const sessions: Array<Record<string, unknown>> = [];
const deleted: string[] = [];
const sent: string[] = [];
/** What the fake runtime reports as the session's tools; by default, what `availableTools` allowed. */
let reportTools: ((opts: Record<string, unknown>) => Array<{ name: string }> | null) | undefined;

mock.module("@github/copilot-sdk", () => ({
  approveAll: () => ({ kind: "approved" }),
  CopilotClient: class {
    async start() {}
    async stop() {}
    async listModels() { return []; }
    async deleteSession(id: string) { deleted.push(id); }
    async createSession(opts: Record<string, unknown>) {
      sessions.push(opts);
      const id = `s${sessions.length}`;
      const allowed = ((opts.availableTools as string[] | undefined) ?? []).map((t) => ({ name: t.replace(/^mcp:/, "") }));
      return {
        sessionId: id,
        on: () => () => {},
        sendAndWait: async () => { sent.push(id); return { data: { content: "ok" } }; },
        abort: async () => {},
        disconnect: async () => {},
        rpc: { tools: {
          initializeAndValidate: async () => ({}),
          getCurrentMetadata: async () => ({ tools: reportTools ? reportTools(opts) : allowed }),
        } },
      };
    }
  },
}));

const { driveBot, driveCapture, driveConfig } = await import("../../test/one-shot-drive.ts");
const { executePrompt } = await import("./copilot-sdk.ts");

let botDir: string;
let agentRoot: string;
const savedAgentCwd = process.env.MUNINN_AGENT_CWD;

beforeAll(() => {
  botDir = testTempDirSync(join(tmpdir(), "copilot-surface-"));
  agentRoot = join(botDir, "agent-home");
  process.env.MUNINN_AGENT_CWD = agentRoot;
  writeFileSync(join(botDir, ".mcp.json"), JSON.stringify({ mcpServers: {
    stub: { command: "true", args: [] },
    yggdrasil: { type: "http", url: "http://127.0.0.1:1/mcp" },
    hivemind: { type: "http", url: "http://127.0.0.1:2/mcp" },
  } }));
});

afterAll(() => {
  rmSync(botDir, { recursive: true, force: true });
  if (savedAgentCwd === undefined) delete process.env.MUNINN_AGENT_CWD;
  else process.env.MUNINN_AGENT_CWD = savedAgentCwd;
});

beforeEach(() => {
  sessions.length = 0;
  deleted.length = 0;
  sent.length = 0;
  reportTools = undefined;
});

const copilotBot = () => driveBot(botDir, { connector: "copilot-sdk", model: "claude-sonnet-4.5" });

describe("copilot-sdk session options, driven from runCaptureOneShot", () => {
  test('"bot": the bot\'s MCP servers, nothing excluded', async () => {
    await driveCapture(copilotBot(), "bot");
    expect(Object.keys(sessions[0]!.mcpServers as object)).toEqual(["stub", "yggdrasil", "hivemind"]);
    expect(sessions[0]!.workingDirectory).toBe(botDir);
    expect("availableTools" in sessions[0]!).toBe(false);
    expect("excludedTools" in sessions[0]!).toBe(false);
  });

  test('"none": every tool source excluded, no MCP servers', async () => {
    await driveCapture(copilotBot(), "none");
    expect("mcpServers" in sessions[0]!).toBe(false);
    expect(sessions[0]!.excludedTools).toEqual(["builtin:*", "mcp:*", "custom:*"]);
  });

  test("{ read }, { web } and { readSearch } are refused before a session exists", async () => {
    await expect(driveCapture(copilotBot(), { read: ["/tmp/frames"] })).rejects.toThrow(/cannot run a \{ read \}/);
    await expect(driveCapture(copilotBot(), { web: true })).rejects.toThrow(/cannot run a \{ web \}/);
    await expect(driveCapture(copilotBot(), { readSearch: ["/tmp/snap"] })).rejects.toThrow(/cannot run a \{ readSearch \}/);
    expect(sessions).toHaveLength(0);
  });

  test("the connector refuses a fenced surface on its own, for a caller that skips executeOneShot", async () => {
    await expect(
      executePrompt("p", driveConfig, { ...copilotBot(), toolSurface: { web: true } }),
    ).rejects.toThrow(/copilot-sdk: the \{ web \} tool surface is not supported/);
    expect(sessions).toHaveLength(0);
  });
});

describe("copilot-sdk { mcpTools }: an allow list of tool names", () => {
  const surface = { mcpTools: { yggdrasil: ["search", "list_files"] } };

  test("only the named servers, each filtered to its tools; availableTools names exactly those; nothing discovered from disk", async () => {
    await driveCapture(copilotBot(), surface);
    const o = sessions[0]!;
    expect(Object.keys(o.mcpServers as object)).toEqual(["yggdrasil"]);
    expect((o.mcpServers as Record<string, { tools: string[] }>).yggdrasil!.tools).toEqual(["search", "list_files"]);
    expect(o.availableTools).toEqual(["mcp:yggdrasil-search", "mcp:yggdrasil-list_files"]);
    expect(o.excludedTools).toEqual(["builtin:*", "custom:*"]);
    expect(o.customAgents).toEqual([]);
    expect(o.skipCustomInstructions).toBe(true);
    expect(o.enableSkills).toBe(false);
    expect(o.skillDirectories).toEqual([]);
    expect(o.enableSessionStore).toBe(false);
    expect(o.memory).toEqual({ enabled: false });
    expect(o.pluginDirectories).toEqual([]);
    expect(o.instructionDirectories).toEqual([]);
    expect(o.enableConfigDiscovery).toBe(false);
    expect(o.enableOnDemandInstructionDiscovery).toBe(false);
    expect(o.enableFileHooks).toBe(false);
    // Its working directory is an empty agent home, not the bot folder with its CLAUDE.md.
    expect(o.workingDirectory).toBe(join(agentRoot, ".mcp-tools"));
    expect(sent).toEqual(["s1"]);
  });

  test("the permission handler approves a listed MCP tool and rejects everything else", async () => {
    await driveCapture(copilotBot(), surface);
    const handle = sessions[0]!.onPermissionRequest as (r: Record<string, unknown>, i: unknown) => { kind: string };
    const inv = { sessionId: "s1" };
    // The runtime names the tool by its wire name (measured): server + "-" + tool.
    expect(handle({ kind: "mcp", serverName: "yggdrasil", toolName: "yggdrasil-search", toolTitle: "search" }, inv).kind).toBe("approve-once");
    expect(handle({ kind: "mcp", serverName: "yggdrasil", toolName: "yggdrasil-read_source", toolTitle: "read_source" }, inv).kind).toBe("reject");
    expect(handle({ kind: "mcp", serverName: "hivemind", toolName: "hivemind-search", toolTitle: "search" }, inv).kind).toBe("reject");
    expect(handle({ kind: "mcp", serverName: "yggdrasil", toolName: "search", toolTitle: "search" }, inv).kind).toBe("reject");
    expect(handle({ kind: "shell", fullCommandText: "ls" }, inv).kind).toBe("reject");
    expect(handle({ kind: "read", path: "/etc/hosts" }, inv).kind).toBe("reject");
  });

  test("a session that reports a tool it was not given is deleted and refused before the prompt", async () => {
    reportTools = () => [{ name: "yggdrasil-search" }, { name: "bash" }];
    await expect(driveCapture(copilotBot(), surface)).rejects.toThrow(/holds tools it was not given \(bash\)/);
    expect(deleted).toEqual(["s1"]);
    expect(sent).toEqual([]);
  });

  test("a runtime that reports no tool list is refused (fails closed)", async () => {
    reportTools = () => null;
    await expect(driveCapture(copilotBot(), surface)).rejects.toThrow(/reported no tool list/);
    expect(sent).toEqual([]);
  });

  test("a server the bot's .mcp.json does not hold, or a never-listed tool, is refused before a session exists", async () => {
    await expect(driveCapture(copilotBot(), { mcpTools: { serena: ["find_symbol"] } })).rejects.toThrow(/names server "serena"/);
    await expect(driveCapture(copilotBot(), { mcpTools: { yggdrasil: ["read_source"] } })).rejects.toThrow(/may not list yggdrasil\/read_source/);
    expect(sessions).toHaveLength(0);
  });
});
