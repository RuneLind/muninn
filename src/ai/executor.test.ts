import { test, expect, describe, mock, spyOn, afterEach } from "bun:test";

// Mock parseClaudeOutput to avoid needing real Claude output
mock.module("./result-parser.ts", () => ({
  parseClaudeOutput: mock((stdout: string) => {
    const parsed = JSON.parse(stdout);
    return {
      result: parsed.result ?? "mocked response",
      costUsd: 0,
      durationMs: parsed.duration_ms ?? 1000,
      durationApiMs: parsed.duration_api_ms ?? 800,
      numTurns: 1,
      model: "sonnet",
      inputTokens: 100,
      outputTokens: 50,
    };
  }),
}));

const { executeClaudePrompt } = await import("./executor.ts");

describe("executeClaudePrompt", () => {
  test("constructs correct CLI arguments", async () => {
    const spawnSpy = spyOn(Bun, "spawn");

    const mockStdout = JSON.stringify({
      result: "hello",
      duration_ms: 1000,
      duration_api_ms: 800,
    });

    spawnSpy.mockReturnValueOnce({
      pid: 123,
      stdout: new Response(mockStdout).body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(0),
      kill: mock(),
    } as any);

    const config = {
      claudeModel: "sonnet",
      claudeTimeoutMs: 30000,
      databaseUrl: "postgres://test",
    } as any;

    const botConfig = {
      name: "testbot",
      dir: "/tmp/testbot",
      model: undefined,
      timeoutMs: undefined,
      thinkingMaxTokens: undefined,
    } as any;

    const result = await executeClaudePrompt("test prompt", config, botConfig);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [args, opts] = spawnSpy.mock.calls[0]!;
    expect(args).toContain("claude");
    expect(args).toContain("-p");
    expect(args).toContain("test prompt");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--model");
    expect(args).toContain("sonnet");
    expect(opts!.cwd).toBe("/tmp/testbot");

    spawnSpy.mockRestore();
  });

  test("uses bot-specific model override", async () => {
    const spawnSpy = spyOn(Bun, "spawn");

    const mockStdout = JSON.stringify({
      result: "hello",
      duration_ms: 1000,
      duration_api_ms: 800,
    });

    spawnSpy.mockReturnValueOnce({
      pid: 123,
      stdout: new Response(mockStdout).body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(0),
      kill: mock(),
    } as any);

    const config = { claudeModel: "sonnet", claudeTimeoutMs: 30000 } as any;
    const botConfig = {
      name: "testbot",
      dir: "/tmp/testbot",
      model: "opus",
      timeoutMs: undefined,
      thinkingMaxTokens: undefined,
    } as any;

    await executeClaudePrompt("test", config, botConfig);

    const [args] = spawnSpy.mock.calls[0]!;
    expect(args).toContain("opus");

    spawnSpy.mockRestore();
  });

  test("includes system prompt flag when provided", async () => {
    const spawnSpy = spyOn(Bun, "spawn");

    const mockStdout = JSON.stringify({
      result: "hello",
      duration_ms: 1000,
      duration_api_ms: 800,
    });

    spawnSpy.mockReturnValueOnce({
      pid: 123,
      stdout: new Response(mockStdout).body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(0),
      kill: mock(),
    } as any);

    const config = { claudeModel: "sonnet", claudeTimeoutMs: 30000 } as any;
    const botConfig = { name: "testbot", dir: "/tmp/testbot" } as any;

    await executeClaudePrompt("test", config, botConfig, "You are a helpful assistant");

    const [args] = spawnSpy.mock.calls[0]!;
    expect(args).toContain("--system-prompt");
    expect(args).toContain("You are a helpful assistant");

    spawnSpy.mockRestore();
  });

  test("throws on non-zero exit code", async () => {
    const spawnSpy = spyOn(Bun, "spawn");

    spawnSpy.mockReturnValueOnce({
      pid: 123,
      stdout: new Response("").body!,
      stderr: new Response("Some error").body!,
      exited: Promise.resolve(1),
      kill: mock(),
    } as any);

    const config = { claudeModel: "sonnet", claudeTimeoutMs: 30000 } as any;
    const botConfig = { name: "testbot", dir: "/tmp/testbot" } as any;

    await expect(executeClaudePrompt("test", config, botConfig))
      .rejects.toThrow("Claude exited with code 1");

    spawnSpy.mockRestore();
  });

  test("sets thinking env var when configured", async () => {
    const spawnSpy = spyOn(Bun, "spawn");

    const mockStdout = JSON.stringify({
      result: "hello",
      duration_ms: 1000,
      duration_api_ms: 800,
    });

    spawnSpy.mockReturnValueOnce({
      pid: 123,
      stdout: new Response(mockStdout).body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(0),
      kill: mock(),
    } as any);

    const config = { claudeModel: "sonnet", claudeTimeoutMs: 30000 } as any;
    const botConfig = {
      name: "testbot",
      dir: "/tmp/testbot",
      thinkingMaxTokens: 16000,
    } as any;

    await executeClaudePrompt("test", config, botConfig);

    const [, opts] = spawnSpy.mock.calls[0]!;
    expect(opts!.env!.MAX_THINKING_TOKENS).toBe("16000");

    spawnSpy.mockRestore();
  });

  test("returns wallClockMs and startupMs", async () => {
    const spawnSpy = spyOn(Bun, "spawn");

    const mockStdout = JSON.stringify({
      result: "hello",
      duration_ms: 1000,
      duration_api_ms: 800,
    });

    spawnSpy.mockReturnValueOnce({
      pid: 123,
      stdout: new Response(mockStdout).body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(0),
      kill: mock(),
    } as any);

    const config = { claudeModel: "sonnet", claudeTimeoutMs: 30000 } as any;
    const botConfig = { name: "testbot", dir: "/tmp/testbot" } as any;

    const result = await executeClaudePrompt("test", config, botConfig);
    expect(result.wallClockMs).toBeGreaterThan(0);
    expect(typeof result.startupMs).toBe("number");

    spawnSpy.mockRestore();
  });
});
