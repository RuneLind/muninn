import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { resolveAgentCwd } from "./agent-cwd.ts";

// Mock DB so trackUsage doesn't try to talk to Postgres.
//
// RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test` and
// `test:unit` chains, like `src/scheduler/executor.test.ts`) — and it MUST stay
// that way; `src/test/mock-isolation.test.ts` pins every `mock.module` file to
// a process of its own. `mock.module` applies to every file loaded after this
// one in the same process, and `bun test` runs files in an order of its own
// that changes with the SET of files in the run — so in the first unit chunk
// this file ran AFTER the two `setupTestDb` files on macOS and in main run
// #508 (green) and BEFORE them in #507 and #509 onward, where `getDb()` then
// answered this mock: `TypeError: getDb().unsafe is not a function`, 19 red
// `test` jobs on main 2026-09-03 → 09-05.
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
// A hung backend (A7): `create` never answers, and rejects only when the
// request's `signal` aborts, the way the real SDK does.
let sdkHang = false;
let constructorOpts: unknown = null;

class FakeAnthropic {
  messages: { create: (params: unknown, options?: unknown) => Promise<unknown> };
  constructor(opts: unknown) {
    constructorOpts = opts;
    this.messages = {
      create: async (params: unknown, options?: unknown) => {
        sdkCalls.push({ params, options });
        if (sdkThrow) throw sdkThrow;
        if (sdkHang) {
          const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
          return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("Request was aborted."))));
        }
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
/** The fake CLI never answers (routedStaleModel's own deadline race, A15). */
let spawnHang = false;
// trackUsage calls captured so we can assert the trace_id join (6th param).
const trackUsageCalls: Array<{
  source: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  botName?: string;
  traceId?: string;
}> = [];
mock.module("../scheduler/executor.ts", () => ({
  DEFAULT_MODEL: "claude-haiku-4-5-20251001",
  HAIKU_DEFAULT_MAX_TOKENS: 4096,
  HAIKU_TIMEOUT_MS: 60_000,
  spawnHaiku: async (prompt: string, opts: unknown) => {
    spawnCalls.push({ prompt, opts });
    if (spawnHang) await new Promise(() => {});
    return {
      result: "fallback-result",
      inputTokens: 1,
      outputTokens: 2,
      model: "claude-haiku-4-5-20251001",
      // Mirror production spawnHaiku, which tags every CLI result "cli" — the
      // router's fallback path relies on this for an honest backend.
      backend: "cli",
    };
  },
  trackUsage: (
    source: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    botName?: string,
    traceId?: string,
  ) => {
    trackUsageCalls.push({ source, model, inputTokens, outputTokens, botName, traceId });
  },
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
let copilotDeleteSessionCount = 0;
let copilotCatalog: string[] | Error = ["claude-haiku-4.5", "claude-sonnet-5.5"];

// The REAL `copilotSessionTools`, captured before the mock replaces the module:
// `callHaikuViaCopilot` builds its tool fence with it, so the assertion below
// reads the shipped exclusion list rather than a copy of it.
const { copilotSessionTools: realCopilotSessionTools } = await import("./connectors/copilot-sdk.ts");

mock.module("./connectors/copilot-sdk.ts", () => ({
  copilotSessionTools: realCopilotSessionTools,
  getCopilotClient: async () => ({
    listModels: async () => {
      if (copilotCatalog instanceof Error) throw copilotCatalog;
      return copilotCatalog.map((id) => ({ id }));
    },
    createSession: async (sessionConfig: unknown) => {
      copilotCalls.push({ sessionConfig, prompt: "", timeout: undefined });
      let handler: ((event: unknown) => void) | null = null;
      return {
        sessionId: "fake-session-id",
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
      };
    },
    async deleteSession(_sessionId: string) {
      copilotDeleteSessionCount++;
    },
  }),
}));

const {
  callHaikuDirect,
  callHaikuViaCopilot,
  callHaikuWithFallback,
  HaikuCliUnavailableError,
  resolveBackend,
  resolveBackendWithReason,
  resolveBackendChain,
  isHaikuDirectEnabled,
  hasHaikuDirectAuth,
  _resetClientForTests,
  _getAuthSourceForTests,
} = await import("./haiku-direct.ts");

beforeEach(() => {
  sdkCalls.length = 0;
  spawnCalls.length = 0;
  trackUsageCalls.length = 0;
  copilotCalls.length = 0;
  copilotResponseContent = "copilot-result";
  copilotUsageEvents = [{ inputTokens: 7, outputTokens: 3, model: "claude-haiku-4-5-20251001" }];
  copilotSessionThrow = null;
  copilotDeleteSessionCount = 0;
  copilotCatalog = ["claude-haiku-4.5", "claude-sonnet-5.5"];
  sdkThrow = null;
  sdkHang = false;
  spawnHang = false;
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

describe("resolveBackendWithReason", () => {
  test("default → cli with reason 'default'", () => {
    expect(resolveBackendWithReason({})).toEqual({ backend: "cli", reason: "default" });
  });

  test("explicit opts.backend → reason 'explicit override'", () => {
    expect(resolveBackendWithReason({ backend: "cli", connector: "copilot-sdk" })).toEqual({
      backend: "cli",
      reason: "explicit override",
    });
  });

  test("HAIKU_BACKEND env → reason 'HAIKU_BACKEND env'", () => {
    process.env.HAIKU_BACKEND = "anthropic";
    expect(resolveBackendWithReason({ connector: "copilot-sdk" })).toEqual({
      backend: "anthropic",
      reason: "HAIKU_BACKEND env",
    });
  });

  test("per-bot haikuBackend → reason 'bot config haikuBackend'", () => {
    expect(resolveBackendWithReason({ connector: "claude-cli", haikuBackend: "copilot" })).toEqual({
      backend: "copilot",
      reason: "bot config haikuBackend",
    });
  });

  test("legacy flag → reason 'legacy HAIKU_DIRECT_ENABLED'", () => {
    process.env.HAIKU_DIRECT_ENABLED = "1";
    expect(resolveBackendWithReason({})).toEqual({
      backend: "anthropic",
      reason: "legacy HAIKU_DIRECT_ENABLED",
    });
  });

  test("connector copilot-sdk → reason 'connector default (copilot-sdk)'", () => {
    expect(resolveBackendWithReason({ connector: "copilot-sdk" })).toEqual({
      backend: "copilot",
      reason: "connector default (copilot-sdk)",
    });
  });

  test("resolveBackend stays in lockstep with resolveBackendWithReason", () => {
    process.env.HAIKU_BACKEND = "copilot";
    const opts = { connector: "claude-cli" as const };
    expect(resolveBackend(opts)).toBe(resolveBackendWithReason(opts).backend);
  });
});

describe("resolveBackendChain (derive-from-chain invariant)", () => {
  // Representative inputs spanning every precedence level. The last two exercise
  // the invalid-enum fall-through the refactor MUST preserve exactly.
  const cases: Array<{ name: string; env?: Record<string, string>; opts: Parameters<typeof resolveBackend>[0]; expectWinner: ReturnType<typeof resolveBackendChain>[number]["source"] }> = [
    { name: "floor", opts: {}, expectWinner: "default" },
    { name: "explicit", opts: { backend: "cli", connector: "copilot-sdk" }, expectWinner: "explicit" },
    { name: "env", env: { HAIKU_BACKEND: "anthropic" }, opts: { connector: "copilot-sdk" }, expectWinner: "env" },
    { name: "config", opts: { connector: "claude-cli", haikuBackend: "copilot" }, expectWinner: "config" },
    { name: "legacy", env: { HAIKU_DIRECT_ENABLED: "1" }, opts: {}, expectWinner: "legacy" },
    { name: "connector", opts: { connector: "copilot-sdk" }, expectWinner: "connector" },
    { name: "invalid env falls through to connector", env: { HAIKU_BACKEND: "bogus" }, opts: { connector: "copilot-sdk" }, expectWinner: "connector" },
    { name: "invalid env falls through to floor", env: { HAIKU_BACKEND: "bogus" }, opts: { connector: "claude-cli" }, expectWinner: "default" },
    // Empty strings must fall through like the old truthy checks did — a
    // `"haikuBackend": ""` in config.json survives discovery's falsy-skip guard
    // and reaches the resolver (review finding on #321).
    { name: "empty explicit falls through to connector", opts: { backend: "" as never, connector: "copilot-sdk" }, expectWinner: "connector" },
    { name: "empty config falls through to floor", opts: { connector: "claude-cli", haikuBackend: "" as never }, expectWinner: "default" },
  ];

  for (const c of cases) {
    test(`winner === resolveBackend for '${c.name}'`, () => {
      for (const [k, v] of Object.entries(c.env ?? {})) process.env[k] = v;
      const chain = resolveBackendChain(c.opts);
      const winner = chain.find((x) => x.wins)!;
      // Exactly one winner.
      expect(chain.filter((x) => x.wins)).toHaveLength(1);
      expect(winner.source).toBe(c.expectWinner);
      // The derived winner value + reason cannot diverge from resolveBackend*.
      expect(winner.value).toBe(resolveBackend(c.opts));
      expect(winner.reason).toBe(resolveBackendWithReason(c.opts).reason);
    });
  }

  test("chain always enumerates all 7 levels, non-short-circuiting", () => {
    const chain = resolveBackendChain({ backend: "anthropic", connector: "copilot-sdk" });
    expect(chain.map((c) => c.source)).toEqual([
      "explicit", "override", "env", "config", "legacy", "connector", "default",
    ]);
  });

  test("invalid HAIKU_BACKEND override contributes null (falls through)", () => {
    // A DB override set to an invalid value must not win — parseHaikuBackendOverride
    // returns null, same fall-through as env.
    process.env.HAIKU_BACKEND = "copilot"; // env is valid; override is what we test via config
    const chain = resolveBackendChain({ connector: "claude-cli" });
    // override link (no DB override in this test) is null; env wins.
    expect(chain.find((c) => c.source === "override")!.value).toBeNull();
    expect(chain.find((c) => c.wins)!.source).toBe("env");
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

  test("OAuth puts the Claude Code identity first, before the caller's persona", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    await callHaikuDirect("hello", { source: "test", system: "You are Jarvis." });
    expect((sdkCalls[0]!.params as { system: unknown }).system).toEqual([
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "You are Jarvis." },
    ]);
  });

  test("OAuth sends the identity block even with no persona", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    await callHaikuDirect("hello", { source: "test" });
    expect((sdkCalls[0]!.params as { system: unknown }).system).toEqual([
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ]);
  });

  test("an API key sends the persona alone, and no system field without one", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    await callHaikuDirect("hello", { source: "test", system: "You are Jarvis." });
    await callHaikuDirect("hello", { source: "test" });
    expect((sdkCalls[0]!.params as { system: unknown }).system).toBe("You are Jarvis.");
    expect(sdkCalls[1]!.params).not.toHaveProperty("system");
  });

  test("runs at effort low", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    await callHaikuDirect("hello", { source: "test" });
    expect((sdkCalls[0]!.params as { output_config: unknown }).output_config).toEqual({ effort: "low" });
  });

  test("leaves effort to the model when the caller names one (the Sonnet fact-checks)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    await callHaikuDirect("hello", { source: "test", model: "claude-sonnet-5-5" });
    expect(sdkCalls[0]!.params).not.toHaveProperty("output_config");
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
  });

  test("runs tool-less in the agent home: every tool source excluded, no MCP, no custom agents", async () => {
    await callHaikuViaCopilot("hi", { source: "test", botName: "melosys" });
    const cfg = copilotCalls[0]!.sessionConfig as {
      excludedTools?: string[];
      mcpServers?: unknown;
      customAgents?: unknown;
      workingDirectory?: string;
    };
    expect(cfg.excludedTools).toEqual(["builtin:*", "mcp:*", "custom:*"]);
    expect(cfg.mcpServers).toBeUndefined();
    expect(cfg.customAgents).toBeUndefined();
    expect(cfg.workingDirectory).toBe(resolveAgentCwd("melosys"));
    expect(cfg.workingDirectory!.startsWith(process.cwd())).toBe(false);
  });

  test("deletes the session even when sendAndWait throws", async () => {
    copilotSessionThrow = new Error("copilot boom");
    await expect(callHaikuViaCopilot("hi", { source: "test" })).rejects.toThrow("copilot boom");
    expect(copilotDeleteSessionCount).toBe(1);
  });

  test("forwards opts.model and opts.timeoutMs", async () => {
    await callHaikuViaCopilot("hi", { source: "test", model: "custom-model", timeoutMs: 9999 });
    const call = copilotCalls[0]!;
    expect((call.sessionConfig as { model: string }).model).toBe("custom-model");
    expect(call.timeout).toBe(9999);
  });

  test("maps an explicit dash-form model to the catalog's dotted id", async () => {
    // Copilot serves its default model for an id not in its catalog, silently.
    await callHaikuViaCopilot("hi", { source: "test", model: "claude-sonnet-5-5" });
    expect((copilotCalls[0]!.sessionConfig as { model: string }).model).toBe("claude-sonnet-5.5");
  });

  test("sends the explicit model as-is when the catalog cannot be listed", async () => {
    copilotCatalog = new Error("listModels down");
    await callHaikuViaCopilot("hi", { source: "test", model: "claude-sonnet-5-5" });
    expect((copilotCalls[0]!.sessionConfig as { model: string }).model).toBe("claude-sonnet-5-5");
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
    // A successful anthropic run reports the anthropic backend.
    expect(result.backend).toBe("anthropic");
    expect(sdkCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(0);
  });

  test("anthropic backend falls back to CLI when SDK throws — result.backend reports the FALLBACK backend (cli), not the requested one", async () => {
    process.env.HAIKU_DIRECT_ENABLED = "1";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    sdkThrow = new Error("rate limited");
    const result = await callHaikuWithFallback("hi", { source: "test" });
    expect(result.result).toBe("fallback-result");
    // Gate (a): the primary (anthropic) threw → the CLI fallback ran → the
    // returned backend is the one that ACTUALLY produced the result.
    expect(result.backend).toBe("cli");
    expect(sdkCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(1);
  });

  test("connector copilot-sdk routes to copilot backend", async () => {
    const result = await callHaikuWithFallback("hi", { source: "test", connector: "copilot-sdk" });
    expect(result.result).toBe("copilot-result");
    expect(result.backend).toBe("copilot");
    expect(copilotCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(0);
  });

  test("copilot backend falls back to CLI on error — result.backend is 'cli'", async () => {
    copilotSessionThrow = new Error("copilot unreachable");
    const result = await callHaikuWithFallback("hi", { source: "test", connector: "copilot-sdk" });
    expect(result.result).toBe("fallback-result");
    expect(result.backend).toBe("cli");
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

describe("callHaikuWithFallback deadlineAt (the Stale check's whole-call bound)", () => {
  test("the CLI fallback gets only what is left of the deadline, not a second full timeoutMs", async () => {
    copilotSessionThrow = new Error("copilot unreachable");
    const deadlineAt = Date.now() + 10_000;
    await callHaikuWithFallback("hi", { source: "test", connector: "copilot-sdk", timeoutMs: 60_000, deadlineAt });
    expect(spawnCalls).toHaveLength(1);
    const t = (spawnCalls[0]!.opts as { timeoutMs: number }).timeoutMs;
    expect(t).toBeLessThanOrEqual(10_000);
    expect(t).toBeGreaterThan(9_000);
  });

  test("a fallback that would start past the deadline throws instead of spawning", async () => {
    copilotSessionThrow = new Error("copilot unreachable");
    await expect(
      callHaikuWithFallback("hi", { source: "test", connector: "copilot-sdk", timeoutMs: 60_000, deadlineAt: Date.now() - 1 }),
    ).rejects.toThrow(/deadline passed before the CLI fallback/);
    expect(spawnCalls).toHaveLength(0);
  });

  test("A7: a hung backend is cut at half the time left, so the CLI fallback keeps the other half", async () => {
    process.env.HAIKU_BACKEND = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    sdkHang = true;
    const t0 = Date.now();
    const call = callHaikuWithFallback("hi", { source: "test", timeoutMs: 60_000, deadlineAt: t0 + 600 });
    const res = await Promise.race([call, Bun.sleep(2_000).then(() => "still hung")]);
    expect(res).toMatchObject({ result: "fallback-result", backend: "cli" });
    const sdkOpts = sdkCalls[0]!.options as { timeout: number; signal?: AbortSignal };
    expect(sdkOpts.timeout).toBeLessThanOrEqual(300);
    expect(sdkOpts.signal?.aborted).toBe(true);
    const cliMs = (spawnCalls[0]!.opts as { timeoutMs: number }).timeoutMs;
    expect(cliMs).toBeGreaterThan(200);
    expect(cliMs).toBeLessThanOrEqual(330);
  });

  test("without deadlineAt the fallback keeps the caller's timeoutMs", async () => {
    copilotSessionThrow = new Error("copilot unreachable");
    await callHaikuWithFallback("hi", { source: "test", connector: "copilot-sdk", timeoutMs: 60_000 });
    expect((spawnCalls[0]!.opts as { timeoutMs: number }).timeoutMs).toBe(60_000);
  });
});

describe("routedStaleModel (A7: the Stale check's call)", () => {
  const bot = (over: Record<string, unknown>) => ({ name: "b", dir: "/tmp", persona: "", telegramAllowedUserIds: [], slackAllowedUserIds: [], ...over }) as unknown as import("../bots/config.ts").BotConfig;

  test("a CLI-only bot gives the CLI the whole time left, not half", async () => {
    const { routedStaleModel } = await import("../wiki/stale-confirm.ts");
    await routedStaleModel("p", { bot: bot({ connector: "claude-cli" }), deadlineAt: Date.now() + 10_000, source: "test" });
    expect(spawnCalls).toHaveLength(1);
    expect((spawnCalls[0]!.opts as { timeoutMs: number }).timeoutMs).toBeGreaterThan(9_000);
  });

  test("an anthropic bot with no credentials gives the CLI the whole time left", async () => {
    const { routedStaleModel } = await import("../wiki/stale-confirm.ts");
    await routedStaleModel("p", { bot: bot({ connector: "claude-cli", haikuBackend: "anthropic" }), deadlineAt: Date.now() + 10_000, source: "test" });
    expect(sdkCalls).toHaveLength(0);
    expect((spawnCalls[0]!.opts as { timeoutMs: number }).timeoutMs).toBeGreaterThan(9_000);
  });

  // A15: the gaps batch 3 left — the no-time refusal, the call's own deadline
  // race, and what the call carries to the router and back.
  test("A15: with a second or less left it refuses and makes no call", async () => {
    const { routedStaleModel } = await import("../wiki/stale-confirm.ts");
    await expect(routedStaleModel("p", { bot: bot({ connector: "claude-cli" }), deadlineAt: Date.now() + 900, source: "test" })).rejects.toThrow(/no time left/);
    expect(spawnCalls).toHaveLength(0);
    expect(sdkCalls).toHaveLength(0);
  });

  test("A15: a call that never answers rejects at its deadline", async () => {
    spawnHang = true;
    const { routedStaleModel } = await import("../wiki/stale-confirm.ts");
    const t0 = Date.now();
    const call = routedStaleModel("p", { bot: bot({ connector: "claude-cli" }), deadlineAt: t0 + 1_300, source: "test" });
    const res = await Promise.race([call.then(() => "answered", (e: Error) => e.message), Bun.sleep(3_000).then(() => "still hung")]);
    expect(res).toMatch(/passed its deadline/);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("A15: the call carries the bot and source to the router and returns the answer text", async () => {
    const { routedStaleModel } = await import("../wiki/stale-confirm.ts");
    const out = await routedStaleModel("the prompt", { bot: bot({ name: "kode", connector: "claude-cli" }), deadlineAt: Date.now() + 10_000, source: "wiki_stale_check" });
    expect(out).toBe("fallback-result");
    expect(spawnCalls[0]!.prompt).toBe("the prompt");
    expect(spawnCalls[0]!.opts).toMatchObject({ source: "wiki_stale_check", entrypoint: "kode-wiki_stale_check", botName: "kode" });
  });
});

describe("trackUsage trace_id join (obs-tail #1)", () => {
  // A structural stand-in for a Tracer — only `.traceId` is read by the backends.
  const tracer = { traceId: "trace-abc-123" } as unknown as import("../tracing/index.ts").Tracer;

  test("callHaikuDirect threads opts.tracer.traceId into trackUsage", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    sdkResponse = {
      content: [{ type: "text", text: "ok" }],
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 4, output_tokens: 2 },
    };
    await callHaikuDirect("hi", { source: "memory", botName: "jarvis", tracer });
    expect(trackUsageCalls).toHaveLength(1);
    expect(trackUsageCalls[0]!.traceId).toBe("trace-abc-123");
    expect(trackUsageCalls[0]!.source).toBe("memory");
  });

  test("callHaikuDirect passes undefined traceId when no tracer", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    await callHaikuDirect("hi", { source: "memory" });
    expect(trackUsageCalls).toHaveLength(1);
    expect(trackUsageCalls[0]!.traceId).toBeUndefined();
  });

  test("callHaikuViaCopilot threads opts.tracer.traceId into trackUsage", async () => {
    copilotUsageEvents = [{ inputTokens: 3, outputTokens: 1, model: "claude-haiku-4-5-20251001" }];
    await callHaikuViaCopilot("hi", { source: "knowledge-decompose", tracer });
    expect(trackUsageCalls).toHaveLength(1);
    expect(trackUsageCalls[0]!.traceId).toBe("trace-abc-123");
    expect(trackUsageCalls[0]!.source).toBe("knowledge-decompose");
  });

  test("callHaikuViaCopilot passes undefined traceId when no tracer", async () => {
    await callHaikuViaCopilot("hi", { source: "knowledge-decompose" });
    expect(trackUsageCalls).toHaveLength(1);
    expect(trackUsageCalls[0]!.traceId).toBeUndefined();
  });
});

/**
 * The CLI fallback and the `nais` profile.
 *
 * The REFUSAL is not here: it lives in `spawnHaiku`, ONE door, so the watchers
 * and the scheduler — five call sites that never pass through this router — are
 * covered too (`src/scheduler/executor.test.ts` pins the throw). What the router
 * owes it is the CONTEXT: which backend it tried and why it fell through, so a
 * pod's error names the missing CREDENTIAL (`ANTHROPIC_API_KEY`, `gh auth
 * login`) rather than the missing binary.
 *
 * `spawnHaiku` is mocked in this file, so these assert the HANDOFF — the only
 * half this module decides.
 */
describe("callHaikuWithFallback hands its fallback reason to spawnHaiku", () => {
  /** The `cliFallback` on the single spawn this file's mock recorded. */
  function handedDown(): { backend?: string; reason?: string; cause?: unknown } | undefined {
    expect(spawnCalls).toHaveLength(1);
    return (spawnCalls[0]!.opts as { cliFallback?: { backend?: string; reason?: string; cause?: unknown } }).cliFallback;
  }

  test("the no-auth skip names the backend and the missing credential", async () => {
    process.env.HAIKU_BACKEND = "anthropic";
    // No ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN — the hasHaikuDirectAuth
    // branch, which is exactly what a pod with a missing secret looks like.
    expect((await callHaikuWithFallback("hi", { source: "test" })).result).toBe("fallback-result");
    expect(handedDown()).toMatchObject({ backend: "anthropic", reason: expect.stringContaining("no Anthropic auth") });
  });

  test("a thrown non-CLI backend carries the upstream message AND the cause", async () => {
    process.env.HAIKU_BACKEND = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    sdkThrow = new Error("rate limited");
    expect((await callHaikuWithFallback("hi", { source: "test" })).result).toBe("fallback-result");
    expect(sdkCalls).toHaveLength(1);
    const handed = handedDown();
    expect(handed).toMatchObject({ backend: "anthropic", reason: "rate limited" });
    expect(handed?.cause).toBe(sdkThrow);
  });

  test("asking FOR the cli backend hands nothing down — there was no fallback", async () => {
    // The guard's own default reason covers this case and the direct watcher
    // callers in one sentence; inventing a fallback here would report a backend
    // that was never tried.
    process.env.HAIKU_BACKEND = "cli";
    expect((await callHaikuWithFallback("hi", { source: "test" })).result).toBe("fallback-result");
    expect(handedDown()).toBeUndefined();
  });

  test("a successful non-CLI backend never reaches the spawn at all", async () => {
    process.env.HAIKU_BACKEND = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    sdkResponse = {
      content: [{ type: "text", text: "direct-result" }],
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const result = await callHaikuWithFallback("hi", { source: "test" });
    expect(result.result).toBe("direct-result");
    expect(result.backend).toBe("anthropic");
    expect(spawnCalls).toHaveLength(0);
  });

  test("HaikuCliUnavailableError is re-exported here, where callers catch it", () => {
    // The refusal moved modules; a caller that catches it imports from the
    // router, and a lost re-export would be a silent `undefined` in a catch.
    expect(new HaikuCliUnavailableError("anthropic", "melosys", "why").name).toBe("HaikuCliUnavailableError");
  });
});

describe("vertex backend resolution", () => {
  // Resolution only. The DISPATCH tests live in `haiku-vertex.test.ts`, which
  // has its own `bun test` link: driving them here needs `./haiku-vertex.ts`
  // mocked, and in this file's chunk that module is already loaded through
  // another importer by the time a `mock.module` here could take — measured, the
  // dispatch ran the real backend and the case passed or failed by luck.
  test("HAIKU_BACKEND=vertex resolves", () => {
    process.env.HAIKU_BACKEND = "vertex";
    expect(resolveBackendWithReason({})).toEqual({ backend: "vertex", reason: "HAIKU_BACKEND env" });
  });

  test("per-bot haikuBackend picks it too", () => {
    expect(resolveBackend({ haikuBackend: "vertex" })).toBe("vertex");
  });

  // No connector implies it: `openai-compat` is equally the local-Ollama shape,
  // and the router is not given the bot's baseUrl to tell them apart.
  test("no connector derives it", () => {
    for (const connector of ["openai-compat", "claude-sdk", "claude-cli", "copilot-sdk"] as const) {
      expect(resolveBackend({ connector })).not.toBe("vertex");
    }
  });
});
