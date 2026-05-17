import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";

// Mock DB so trackUsage doesn't try to talk to Postgres.
mock.module("../db/client.ts", () => ({
  getDb: () => {
    const sql = (_strings: TemplateStringsArray, ..._values: unknown[]) =>
      Promise.resolve([]);
    return sql;
  },
}));

const sdkCalls: Array<{ params: unknown; options: unknown }> = [];
let sdkResponse: unknown = {
  content: [{ type: "text", text: "ok" }],
  model: "claude-haiku-4-5-20251001",
  usage: { input_tokens: 10, output_tokens: 5 },
};
let sdkThrow: Error | null = null;
let constructorOpts: unknown = null;

class FakeAnthropic {
  messages: { create: (params: unknown, options?: unknown) => Promise<unknown> };
  constructor(opts: unknown) {
    constructorOpts = opts;
    this.messages = {
      create: async (params: unknown, options?: unknown) => {
        sdkCalls.push({ params, options });
        if (sdkThrow) throw sdkThrow;
        return sdkResponse;
      },
    };
  }
}

mock.module("@anthropic-ai/sdk", () => ({
  default: FakeAnthropic,
}));

// Mock spawnHaiku — fallback path. We only check it's called with the same
// shape, not that the CLI actually runs.
const spawnCalls: Array<{ prompt: string; opts: unknown }> = [];
mock.module("../scheduler/executor.ts", () => ({
  DEFAULT_MODEL: "claude-haiku-4-5-20251001",
  HAIKU_TIMEOUT_MS: 60_000,
  spawnHaiku: async (prompt: string, opts: unknown) => {
    spawnCalls.push({ prompt, opts });
    return {
      result: "fallback-result",
      inputTokens: 1,
      outputTokens: 2,
      model: "claude-haiku-4-5-20251001",
    };
  },
}));

const {
  callHaikuDirect,
  callHaikuWithFallback,
  isHaikuDirectEnabled,
  hasHaikuDirectAuth,
  _resetClientForTests,
  _getAuthSourceForTests,
} = await import("./haiku-direct.ts");

beforeEach(() => {
  sdkCalls.length = 0;
  spawnCalls.length = 0;
  sdkThrow = null;
  constructorOpts = null;
  _resetClientForTests();
  delete process.env.HAIKU_DIRECT_ENABLED;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  delete process.env.HAIKU_DIRECT_ENABLED;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

describe("isHaikuDirectEnabled", () => {
  test("false when env var unset", () => {
    expect(isHaikuDirectEnabled()).toBe(false);
  });

  test("true when env var = '1'", () => {
    process.env.HAIKU_DIRECT_ENABLED = "1";
    expect(isHaikuDirectEnabled()).toBe(true);
  });

  test("true when env var = 'true'", () => {
    process.env.HAIKU_DIRECT_ENABLED = "true";
    expect(isHaikuDirectEnabled()).toBe(true);
  });

  test("false for other truthy strings", () => {
    process.env.HAIKU_DIRECT_ENABLED = "yes";
    expect(isHaikuDirectEnabled()).toBe(false);
  });
});

describe("hasHaikuDirectAuth", () => {
  test("false with no auth env", () => {
    expect(hasHaikuDirectAuth()).toBe(false);
  });

  test("true with API key", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(hasHaikuDirectAuth()).toBe(true);
  });

  test("true with OAuth token", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    expect(hasHaikuDirectAuth()).toBe(true);
  });
});

describe("callHaikuDirect auth selection", () => {
  test("uses API key when both are set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    await callHaikuDirect("hello", { source: "test" });
    expect(_getAuthSourceForTests()).toBe("api-key");
    expect((constructorOpts as { apiKey?: string }).apiKey).toBe("sk-test");
  });

  test("falls back to OAuth token when only it is set", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    await callHaikuDirect("hello", { source: "test" });
    expect(_getAuthSourceForTests()).toBe("oauth");
    expect((constructorOpts as { authToken?: string }).authToken).toBe("oauth-test");
  });

  test("throws when neither is set", async () => {
    await expect(callHaikuDirect("hello", { source: "test" })).rejects.toThrow(
      /neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN/,
    );
  });
});

describe("callHaikuDirect response handling", () => {
  test("concatenates text blocks and returns HaikuResult shape", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    sdkResponse = {
      content: [
        { type: "text", text: "part-A " },
        { type: "text", text: "part-B" },
      ],
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = await callHaikuDirect("hello", { source: "test" });
    expect(result.result).toBe("part-A part-B");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
  });

  test("ignores non-text blocks", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    sdkResponse = {
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "visible" },
      ],
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    const result = await callHaikuDirect("hello", { source: "test" });
    expect(result.result).toBe("visible");
  });

  test("sums cache tokens into inputTokens", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    sdkResponse = {
      content: [{ type: "text", text: "ok" }],
      model: "claude-haiku-4-5-20251001",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 50,
        output_tokens: 5,
      },
    };
    const result = await callHaikuDirect("hello", { source: "test" });
    expect(result.inputTokens).toBe(160);
    expect(result.outputTokens).toBe(5);
  });

  test("passes model + max_tokens + timeout to SDK", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    await callHaikuDirect("prompt-text", {
      source: "test",
      model: "claude-haiku-custom",
      timeoutMs: 12_345,
    });
    expect(sdkCalls).toHaveLength(1);
    const call = sdkCalls[0]!;
    expect((call.params as { model: string }).model).toBe("claude-haiku-custom");
    expect((call.params as { max_tokens: number }).max_tokens).toBeGreaterThan(0);
    expect((call.params as { messages: { content: string }[] }).messages[0]!.content).toBe("prompt-text");
    expect((call.options as { timeout: number }).timeout).toBe(12_345);
  });
});

describe("callHaikuWithFallback dispatch", () => {
  test("uses CLI when flag is off", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const result = await callHaikuWithFallback("hi", { source: "test" });
    expect(result.result).toBe("fallback-result");
    expect(sdkCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
  });

  test("uses CLI when flag is on but no auth", async () => {
    process.env.HAIKU_DIRECT_ENABLED = "1";
    const result = await callHaikuWithFallback("hi", { source: "test" });
    expect(result.result).toBe("fallback-result");
    expect(sdkCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
  });

  test("uses direct SDK when flag + auth are set", async () => {
    process.env.HAIKU_DIRECT_ENABLED = "1";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    sdkResponse = {
      content: [{ type: "text", text: "direct-result" }],
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const result = await callHaikuWithFallback("hi", { source: "test" });
    expect(result.result).toBe("direct-result");
    expect(sdkCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(0);
  });

  test("falls back to CLI when direct SDK throws", async () => {
    process.env.HAIKU_DIRECT_ENABLED = "1";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    sdkThrow = new Error("rate limited");
    const result = await callHaikuWithFallback("hi", { source: "test" });
    expect(result.result).toBe("fallback-result");
    expect(sdkCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(1);
  });
});
