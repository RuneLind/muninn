import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock the Agent SDK before importing the connector so the module-level import
// picks up the fake `query()`.
type FakeQueryParams = { prompt: string; options: unknown };
const queryCalls: FakeQueryParams[] = [];
let fakeEvents: unknown[] = [];
let fakeThrow: Error | null = null;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: FakeQueryParams) => {
    queryCalls.push(params);
    return (async function* () {
      if (fakeThrow) throw fakeThrow;
      for (const ev of fakeEvents) {
        // Make iteration awaitable so timers fire between yields
        await Promise.resolve();
        yield ev;
      }
    })();
  },
}));

// MCP preflight is a no-op for the in-test bot dir; mock it to avoid network calls.
mock.module("../mcp-status.ts", () => ({
  preflightMcpForRequest: async () => {},
}));

// Now import the connector under test.
import { executePrompt, assertHaveAuth } from "./claude-sdk.ts";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";

function makeBot(): { botConfig: BotConfig; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "claude-sdk-test-"));
  writeFileSync(join(dir, "CLAUDE.md"), "test persona");
  return {
    botConfig: {
      name: "testbot",
      dir,
      persona: "test persona",
      telegramAllowedUserIds: [],
      slackAllowedUserIds: [],
    },
    cleanup: () => rmSync(dir, { recursive: true }),
  };
}

const baseConfig = { claudeModel: "claude-sonnet-4-6", claudeTimeoutMs: 30_000 } as Config;

beforeEach(() => {
  queryCalls.length = 0;
  fakeEvents = [];
  fakeThrow = null;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("claude-sdk assertHaveAuth", () => {
  test("throws when neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    expect(() => assertHaveAuth()).toThrow(/neither ANTHROPIC_API_KEY/);
  });

  test("passes when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    expect(() => assertHaveAuth()).not.toThrow();
  });

  test("passes when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "y";
    expect(() => assertHaveAuth()).not.toThrow();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });
});

describe("claude-sdk executePrompt", () => {
  test("returns text result and usage from result event", async () => {
    const { botConfig, cleanup } = makeBot();
    fakeEvents = [
      {
        type: "system",
        subtype: "init",
        model: "claude-sonnet-4-6-20251001",
      },
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6-20251001",
          content: [{ type: "text", text: "Hello!" }],
          usage: { input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "Hello!",
        num_turns: 1,
        duration_ms: 200,
        duration_api_ms: 180,
        total_cost_usd: 0.001,
        is_error: false,
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    ];
    try {
      const res = await executePrompt("hi", baseConfig, botConfig);
      expect(res.result).toBe("Hello!");
      expect(res.inputTokens).toBe(100);
      expect(res.outputTokens).toBe(5);
      expect(res.numTurns).toBe(1);
      expect(res.model).toBe("claude-sonnet-4-6-20251001");
      expect(res.costUsd).toBe(0.001);
      expect(res.toolCalls).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("passes systemPrompt, cwd, model and bypassPermissions to query options", async () => {
    const { botConfig, cleanup } = makeBot();
    fakeEvents = [
      {
        type: "result",
        subtype: "success",
        result: "done",
        num_turns: 1,
        duration_ms: 0,
        duration_api_ms: 0,
        total_cost_usd: 0,
        is_error: false,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    ];
    try {
      await executePrompt("hi", baseConfig, { ...botConfig, model: "claude-opus-4-7" }, "SYS");
      const call = queryCalls[0]!;
      expect(call.prompt).toBe("hi");
      const opts = call.options as Record<string, unknown>;
      expect(opts.systemPrompt).toBe("SYS");
      expect(opts.cwd).toBe(botConfig.dir);
      expect(opts.model).toBe("claude-opus-4-7");
      expect(opts.permissionMode).toBe("bypassPermissions");
      expect(opts.allowDangerouslySkipPermissions).toBe(true);
      expect(opts.settingSources).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("falls back to preset systemPrompt when none provided", async () => {
    const { botConfig, cleanup } = makeBot();
    fakeEvents = [
      {
        type: "result",
        subtype: "success",
        result: "",
        num_turns: 1,
        duration_ms: 0,
        duration_api_ms: 0,
        total_cost_usd: 0,
        is_error: false,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    ];
    try {
      await executePrompt("hi", baseConfig, botConfig);
      const opts = queryCalls[0]!.options as Record<string, unknown>;
      expect(opts.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    } finally {
      cleanup();
    }
  });

  test("extracts tool calls with timing and ordering", async () => {
    const { botConfig, cleanup } = makeBot();
    fakeEvents = [
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "mcp__knowledge__search",
              input: { query: "hello" },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "search result body",
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "found it" }],
          usage: { input_tokens: 60, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "found it",
        num_turns: 2,
        duration_ms: 500,
        duration_api_ms: 480,
        total_cost_usd: 0.002,
        is_error: false,
        usage: { input_tokens: 110, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    ];
    try {
      const res = await executePrompt("hi", baseConfig, botConfig);
      expect(res.result).toBe("found it");
      expect(res.toolCalls).toHaveLength(1);
      const tc = res.toolCalls![0]!;
      expect(tc.id).toBe("toolu_1");
      expect(tc.name).toBe("mcp__knowledge__search");
      expect(tc.displayName).toBe("search (knowledge)");
      expect(tc.input).toBe(JSON.stringify({ query: "hello" }));
      expect(tc.output).toBe("search result body");
      expect(tc.durationMs).toBeGreaterThanOrEqual(0);
      expect(tc.startOffsetMs).toBeGreaterThanOrEqual(0);
    } finally {
      cleanup();
    }
  });

  test("flags is_error tool_result content as an error envelope", async () => {
    const { botConfig, cleanup } = makeBot();
    fakeEvents = [
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          content: [{ type: "tool_use", id: "toolu_e", name: "Bash", input: { cmd: "x" } }],
          usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_e",
              is_error: true,
              content: "command not found",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "",
        num_turns: 1,
        duration_ms: 0,
        duration_api_ms: 0,
        total_cost_usd: 0,
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    ];
    try {
      const res = await executePrompt("hi", baseConfig, botConfig);
      const tc = res.toolCalls![0]!;
      expect(tc.output).toContain("command not found");
      expect(tc.output).toContain("error");
    } finally {
      cleanup();
    }
  });

  test("emits intent events for report_intent tool calls", async () => {
    const { botConfig, cleanup } = makeBot();
    fakeEvents = [
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          content: [
            {
              type: "tool_use",
              id: "toolu_i",
              name: "mcp__sys__report_intent",
              input: { intent: "Looking at memories" },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_i", content: "ok" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "",
        num_turns: 1,
        duration_ms: 0,
        duration_api_ms: 0,
        total_cost_usd: 0,
        is_error: false,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    ];
    try {
      const seen: Array<{ type: string; text?: string }> = [];
      await executePrompt("hi", baseConfig, botConfig, undefined, (ev) => {
        seen.push({ type: ev.type, text: (ev as { text?: string }).text });
      });
      const intents = seen.filter((s) => s.type === "intent");
      expect(intents).toHaveLength(1);
      expect(intents[0]!.text).toBe("Looking at memories");
    } finally {
      cleanup();
    }
  });

  test("throws timeout error when query never returns", async () => {
    const { botConfig, cleanup } = makeBot();
    fakeEvents = [];
    fakeThrow = null;
    // Build a long-running generator that aborts when the abortController fires.
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: ({ options }: { options: { abortController?: AbortController } }) =>
        (async function* () {
          await new Promise<void>((resolve, reject) => {
            const ac = options.abortController!;
            ac.signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        })(),
    }));
    try {
      const start = Date.now();
      const res = executePrompt("hi", { ...baseConfig, claudeTimeoutMs: 50 }, botConfig);
      await expect(res).rejects.toThrow(/timed out after 50ms/);
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      cleanup();
      // Restore default fake
      mock.module("@anthropic-ai/claude-agent-sdk", () => ({
        query: (params: FakeQueryParams) => {
          queryCalls.push(params);
          return (async function* () {
            for (const ev of fakeEvents) {
              await Promise.resolve();
              yield ev;
            }
          })();
        },
      }));
    }
  });

  test("forwards excludedTools as disallowedTools", async () => {
    const { botConfig, cleanup } = makeBot();
    fakeEvents = [
      {
        type: "result",
        subtype: "success",
        result: "",
        num_turns: 1,
        duration_ms: 0,
        duration_api_ms: 0,
        total_cost_usd: 0,
        is_error: false,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    ];
    try {
      await executePrompt(
        "hi",
        baseConfig,
        { ...botConfig, excludedTools: ["Bash", "Read"] },
      );
      const opts = queryCalls[0]!.options as Record<string, unknown>;
      expect(opts.disallowedTools).toEqual(["Bash", "Read"]);
    } finally {
      cleanup();
    }
  });
});
