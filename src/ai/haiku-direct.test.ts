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

class FakeAPIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

mock.module("@anthropic-ai/sdk", () => {
  const ctor = FakeAnthropic as unknown as { APIError: typeof FakeAPIError };
  ctor.APIError = FakeAPIError;
  return { default: ctor };
});

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
  trackUsage: () => {},
}));

// Mock the Copilot connector — exposes a `getCopilotClient` returning a fake
// CopilotClient whose `createSession` returns a fake session.
type FakeUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
};

const copilotCalls: Array<{
  sessionConfig: unknown;
  prompt: string;
  timeout?: number;
}> = [];
let copilotResponseContent = "copilot-result";
let copilotUsageEvents: FakeUsage[] = [
  { inputTokens: 7, outputTokens: 3, model: "claude-haiku-4-5-20251001" },
];
let copilotSessionThrow: Error | null = null;
let copilotDestroyCount = 0;

mock.module("./connectors/copilot-sdk.ts", () => ({
  getCopilotClient: async () => ({
    createSession: async (sessionConfig: unknown) => {
      copilotCalls.push({ sessionConfig, prompt: "", timeout: undefined });
      let handler: ((event: unknown) => void) | null = null;
      return {
        on(h: (event: unknown) => void) {
          handler = h;
          return () => { handler = null; };
        },
        async sendAndWait(opts: { prompt: string }, timeout?: number) {
          const lastCall = copilotCalls[copilotCalls.length - 1]!;
          lastCall.prompt = opts.prompt;
          lastCall.timeout = timeout;
          if (copilotSessionThrow) throw copilotSessionThrow;
          for (const usage of copilotUsageEvents) {
            handler?.({ type: "assistant.usage", data: usage });
          }
          return { data: { content: copilotResponseContent } };
        },
        async destroy() {
          copilotDestroyCount++;
        },
      };
    },
  }),
}));

const {
  callHaikuDirect,
  callHaikuViaCopilot,
  callHaikuWithFallback,
  resolveBackend,
  isHaikuDirectEnabled,
  hasHaikuDirectAuth,
  _resetClientForTests,
  _getAuthSourceForTests,
} = await import("./haiku-direct.ts");

beforeEach(() => {
  sdkCalls.length = 0;
  spawnCalls.length = 0;
  copilotCalls.length = 0;
  copilotResponseContent = "copilot-result";
  copilotUsageEvents = [{ inputTokens: 7, outputTokens: 3, model: "claude-haiku-4-5-20251001" }];
  copilotSessionThrow = null;
  copilotDestroyCount = 0;
  sdkThrow = null;
  constructorOpts = null;
  _resetClientForTests();
  delete process.env.HAIKU_DIRECT_ENABLED;
  delete process.env.HAIKU_BACKEND;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  delete process.env.HAIKU_DIRECT_ENABLED;
  delete process.env.HAIKU_BACKEND;
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

describe("resolveBackend", () => {
  test("defaults to cli with nothing set", () => {
    expect(resolveBackend({})).toBe("cli");
  });

  test("opts.backend wins over everything", () => {
    process.env.HAIKU_BACKEND = "anthropic";
    process.env.HAIKU_DIRECT_ENABLED = "1";
    expect(resolveBackend({ backend: "cli", connector: "copilot-sdk" })).toBe("cli");
  });

  test("HAIKU_BACKEND env wins over legacy flag and connector", () => {
    process.env.HAIKU_BACKEND = "anthropic";
    process.env.HAIKU_DIRECT_ENABLED = "1";
    expect(resolveBackend({ connector: "copilot-sdk" })).toBe("anthropic");
  });

  test("HAIKU_BACKEND=cli forces cli even on copilot bot", () => {
    process.env.HAIKU_BACKEND = "cli";
    expect(resolveBackend({ connector: "copilot-sdk" })).toBe("cli");
  });

  test("HAIKU_BACKEND=copilot forces copilot on claude-cli bot", () => {
    process.env.HAIKU_BACKEND = "copilot";
    expect(resolveBackend({ connector: "claude-cli" })).toBe("copilot");
  });

  test("ignores invalid HAIKU_BACKEND values", () => {
    process.env.HAIKU_BACKEND = "bogus";
    expect(resolveBackend({ connector: "copilot-sdk" })).toBe("copilot");
  });

  test("legacy HAIKU_DIRECT_ENABLED=1 → anthropic", () => {
    process.env.HAIKU_DIRECT_ENABLED = "1";
    expect(resolveBackend({})).toBe("anthropic");
  });

  test("legacy flag wins over connector default", () => {
    process.env.HAIKU_DIRECT_ENABLED = "1";
    expect(resolveBackend({ connector: "copilot-sdk" })).toBe("anthropic");
  });

  test("connector copilot-sdk → copilot", () => {
    expect(resolveBackend({ connector: "copilot-sdk" })).toBe("copilot");
  });

  test("connector claude-cli → cli", () => {
    expect(resolveBackend({ connector: "claude-cli" })).toBe("cli");
  });

  test("connector openai-compat → cli", () => {
    expect(resolveBackend({ connector: "openai-compat" })).toBe("cli");
  });

  test("per-bot haikuBackend wins over connector default", () => {
    expect(resolveBackend({ connector: "claude-cli", haikuBackend: "anthropic" })).toBe("anthropic");
  });

  test("per-bot haikuBackend wins over legacy HAIKU_DIRECT_ENABLED", () => {
    process.env.HAIKU_DIRECT_ENABLED = "1";
    expect(resolveBackend({ connector: "claude-cli", haikuBackend: "copilot" })).toBe("copilot");
  });

  test("HAIKU_BACKEND env still trumps per-bot haikuBackend", () => {
    process.env.HAIKU_BACKEND = "cli";
    expect(resolveBackend({ connector: "copilot-sdk", haikuBackend: "anthropic" })).toBe("cli");
  });

  test("explicit opts.backend trumps per-bot haikuBackend", () => {
    expect(resolveBackend({ backend: "cli", haikuBackend: "anthropic" })).toBe("cli");
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

  test("honors caller-supplied maxTokens", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    await callHaikuDirect("prompt-text", { source: "test", maxTokens: 256 });
    expect((sdkCalls[0]!.params as { max_tokens: number }).max_tokens).toBe(256);
  });

  test("ignores non-positive maxTokens and uses the default", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    await callHaikuDirect("prompt-text", { source: "test", maxTokens: 0 });
    expect((sdkCalls[0]!.params as { max_tokens: number }).max_tokens).toBeGreaterThan(0);
  });
});

describe("callHaikuDirect 401 handling", () => {
  test("clears cached client on a 401 so a rotated key recovers", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-rotated-out";
    sdkThrow = new FakeAPIError(401, "invalid x-api-key");
    await expect(callHaikuDirect("hi", { source: "test" })).rejects.toThrow("invalid x-api-key");
    // Cache was cleared — auth source is null until the next build.
    expect(_getAuthSourceForTests()).toBeNull();

    // Next call (key "rotated in") should rebuild the client from current env.
    sdkThrow = null;
    process.env.ANTHROPIC_API_KEY = "sk-rotated-in";
    await callHaikuDirect("hi", { source: "test" });
    expect((constructorOpts as { apiKey?: string }).apiKey).toBe("sk-rotated-in");
  });

  test("does not clear cache on non-401 errors", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    // Prime the cache with a successful call.
    sdkThrow = null;
    await callHaikuDirect("hi", { source: "test" });
    expect(_getAuthSourceForTests()).toBe("api-key");

    sdkThrow = new FakeAPIError(429, "rate limited");
    await expect(callHaikuDirect("hi", { source: "test" })).rejects.toThrow("rate limited");
    // Cache survives — auth source still set.
    expect(_getAuthSourceForTests()).toBe("api-key");
  });
});

describe("callHaikuViaCopilot", () => {
  test("creates a lean session (no MCP, no streaming) and sums usage events", async () => {
    copilotUsageEvents = [
      { inputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 4, model: "claude-haiku-4-5-20251001" },
      { inputTokens: 1, outputTokens: 1 },
    ];
    const result = await callHaikuViaCopilot("hi", { source: "test", botName: "melosys" });
    expect(result.result).toBe("copilot-result");
    expect(result.inputTokens).toBe(5 + 2 + 1 + 1);
    expect(result.outputTokens).toBe(4 + 1);
    expect(result.model).toBe("claude-haiku-4-5-20251001");

    expect(copilotCalls).toHaveLength(1);
    const { sessionConfig } = copilotCalls[0]!;
    expect((sessionConfig as { streaming?: boolean }).streaming).toBe(false);
    expect((sessionConfig as { mcpServers?: unknown }).mcpServers).toBeUndefined();
    expect((sessionConfig as { workingDirectory?: string }).workingDirectory).toBeUndefined();
  });

  test("destroys the session even when sendAndWait throws", async () => {
    copilotSessionThrow = new Error("copilot boom");
    await expect(callHaikuViaCopilot("hi", { source: "test" })).rejects.toThrow("copilot boom");
    expect(copilotDestroyCount).toBe(1);
  });

  test("forwards opts.model and opts.timeoutMs", async () => {
    await callHaikuViaCopilot("hi", { source: "test", model: "custom-model", timeoutMs: 9999 });
    const call = copilotCalls[0]!;
    expect((call.sessionConfig as { model: string }).model).toBe("custom-model");
    expect(call.timeout).toBe(9999);
  });

  test("still returns the result when the served model is not Haiku (warn-only guard)", async () => {
    // A registry rename downgrades to Sonnet — the guard logs but must not throw
    // or alter the returned result.
    copilotUsageEvents = [{ inputTokens: 1, outputTokens: 1, model: "claude-sonnet-4-6" }];
    const result = await callHaikuViaCopilot("hi", { source: "test" });
    expect(result.result).toBe("copilot-result");
    expect(result.model).toBe("claude-sonnet-4-6");
  });
});

describe("callHaikuWithFallback dispatch", () => {
  test("cli backend uses CLI even with auth present", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const result = await callHaikuWithFallback("hi", { source: "test" });
    expect(result.result).toBe("fallback-result");
    expect(sdkCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
  });

  test("legacy flag without auth falls through to CLI", async () => {
    process.env.HAIKU_DIRECT_ENABLED = "1";
    const result = await callHaikuWithFallback("hi", { source: "test" });
    expect(result.result).toBe("fallback-result");
    expect(sdkCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
  });

  test("legacy flag + auth routes to anthropic", async () => {
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

  test("anthropic backend falls back to CLI when SDK throws", async () => {
    process.env.HAIKU_DIRECT_ENABLED = "1";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    sdkThrow = new Error("rate limited");
    const result = await callHaikuWithFallback("hi", { source: "test" });
    expect(result.result).toBe("fallback-result");
    expect(sdkCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(1);
  });

  test("connector copilot-sdk routes to copilot backend", async () => {
    const result = await callHaikuWithFallback("hi", { source: "test", connector: "copilot-sdk" });
    expect(result.result).toBe("copilot-result");
    expect(copilotCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(0);
  });

  test("copilot backend falls back to CLI on error", async () => {
    copilotSessionThrow = new Error("copilot unreachable");
    const result = await callHaikuWithFallback("hi", { source: "test", connector: "copilot-sdk" });
    expect(result.result).toBe("fallback-result");
    expect(copilotCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(1);
  });

  test("HAIKU_BACKEND=copilot forces copilot on a claude-cli bot", async () => {
    process.env.HAIKU_BACKEND = "copilot";
    const result = await callHaikuWithFallback("hi", { source: "test", connector: "claude-cli" });
    expect(result.result).toBe("copilot-result");
    expect(copilotCalls).toHaveLength(1);
  });

  test("HAIKU_BACKEND=cli overrides copilot connector default", async () => {
    process.env.HAIKU_BACKEND = "cli";
    const result = await callHaikuWithFallback("hi", { source: "test", connector: "copilot-sdk" });
    expect(result.result).toBe("fallback-result");
    expect(copilotCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
  });

  test("explicit opts.backend wins over env + connector", async () => {
    process.env.HAIKU_BACKEND = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const result = await callHaikuWithFallback("hi", {
      source: "test",
      connector: "copilot-sdk",
      backend: "cli",
    });
    expect(result.result).toBe("fallback-result");
    expect(sdkCalls).toHaveLength(0);
    expect(copilotCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
  });
});
