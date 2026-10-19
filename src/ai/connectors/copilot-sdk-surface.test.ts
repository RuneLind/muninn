/**
 * The copilot-sdk half of the declared tool surface, driven from the top layer
 * (`runCaptureOneShot` → `tracedOneShot` → `executeOneShot`) down to the
 * session options the connector hands `createSession`. `"none"` and `"bot"`
 * work as before; `{ read }` and `{ web }` never reach a session.
 *
 * Its own `bun test` link: it calls `mock.module` on the Copilot SDK, which
 * invalidates that module for the whole process (root `CLAUDE.md`, Testing).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sessions: Array<Record<string, unknown>> = [];

mock.module("@github/copilot-sdk", () => ({
  approveAll: () => ({ kind: "approved" }),
  CopilotClient: class {
    async start() {}
    async stop() {}
    async listModels() { return []; }
    async deleteSession() {}
    async createSession(opts: Record<string, unknown>) {
      sessions.push(opts);
      return {
        sessionId: `s${sessions.length}`,
        on: () => () => {},
        sendAndWait: async () => ({ data: { content: "ok" } }),
        abort: async () => {},
        disconnect: async () => {},
      };
    }
  },
}));

const { driveBot, driveCapture, driveConfig } = await import("../../test/one-shot-drive.ts");
const { executePrompt } = await import("./copilot-sdk.ts");

let botDir: string;

beforeAll(() => {
  botDir = mkdtempSync(join(tmpdir(), "copilot-surface-"));
  writeFileSync(join(botDir, ".mcp.json"), JSON.stringify({ mcpServers: { stub: { command: "true", args: [] } } }));
});

afterAll(() => {
  rmSync(botDir, { recursive: true, force: true });
});

beforeEach(() => {
  sessions.length = 0;
});

const copilotBot = () => driveBot(botDir, { connector: "copilot-sdk", model: "claude-sonnet-4.5" });

describe("copilot-sdk session options, driven from runCaptureOneShot", () => {
  test('"bot": the bot\'s MCP servers, nothing excluded', async () => {
    await driveCapture(copilotBot(), "bot");
    expect(Object.keys(sessions[0]!.mcpServers as object)).toEqual(["stub"]);
    expect("excludedTools" in sessions[0]!).toBe(false);
  });

  test('"none": every tool source excluded, no MCP servers', async () => {
    await driveCapture(copilotBot(), "none");
    expect("mcpServers" in sessions[0]!).toBe(false);
    expect(sessions[0]!.excludedTools).toEqual(["builtin:*", "mcp:*", "custom:*"]);
  });

  test("{ read } and { web } are refused before a session exists", async () => {
    await expect(driveCapture(copilotBot(), { read: ["/tmp/frames"] })).rejects.toThrow(/cannot run a \{ read \}/);
    await expect(driveCapture(copilotBot(), { web: true })).rejects.toThrow(/cannot run a \{ web \}/);
    expect(sessions).toHaveLength(0);
  });

  test("the connector refuses a fenced surface on its own, for a caller that skips executeOneShot", async () => {
    await expect(
      executePrompt("p", driveConfig, { ...copilotBot(), toolSurface: { web: true } }),
    ).rejects.toThrow(/copilot-sdk: the \{ web \} tool surface is not supported/);
    expect(sessions).toHaveLength(0);
  });
});
