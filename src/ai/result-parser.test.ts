import { test, expect, describe } from "bun:test";
import { parseClaudeOutput } from "./result-parser.ts";

describe("parseClaudeOutput", () => {
  test("parses minimal valid output", () => {
    const input = JSON.stringify({
      result: "Hello world",
      duration_ms: 1000,
      duration_api_ms: 800,
      is_error: false,
      num_turns: 1,
      session_id: "test-session",
    });

    const result = parseClaudeOutput(input);
    expect(result.result).toBe("Hello world");
    expect(result.durationMs).toBe(1000);
    expect(result.durationApiMs).toBe(800);
    expect(result.numTurns).toBe(1);
    expect(result.costUsd).toBe(0);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.model).toBe("unknown");
  });

  test("throws on error output", () => {
    const input = JSON.stringify({
      result: "Something went wrong",
      is_error: true,
      duration_ms: 100,
      duration_api_ms: 50,
      num_turns: 1,
      session_id: "test",
    });

    expect(() => parseClaudeOutput(input)).toThrow("Claude error: Something went wrong");
  });

  test("parses usage object for tokens", () => {
    const input = JSON.stringify({
      result: "test",
      duration_ms: 1000,
      duration_api_ms: 800,
      is_error: false,
      num_turns: 1,
      session_id: "test",
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 25,
        output_tokens: 200,
      },
    });

    const result = parseClaudeOutput(input);
    expect(result.inputTokens).toBe(175); // 100 + 50 + 25
    expect(result.outputTokens).toBe(200);
  });

  test("falls back to top-level token fields", () => {
    const input = JSON.stringify({
      result: "test",
      duration_ms: 1000,
      duration_api_ms: 800,
      is_error: false,
      num_turns: 1,
      session_id: "test",
      input_tokens: 300,
      output_tokens: 150,
    });

    const result = parseClaudeOutput(input);
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(150);
  });

  test("parses cost from total_cost_usd", () => {
    const input = JSON.stringify({
      result: "test",
      duration_ms: 100,
      duration_api_ms: 50,
      is_error: false,
      num_turns: 1,
      session_id: "test",
      total_cost_usd: 0.0045,
    });

    const result = parseClaudeOutput(input);
    expect(result.costUsd).toBe(0.0045);
  });

  test("falls back to cost_usd", () => {
    const input = JSON.stringify({
      result: "test",
      duration_ms: 100,
      duration_api_ms: 50,
      is_error: false,
      num_turns: 1,
      session_id: "test",
      cost_usd: 0.003,
    });

    const result = parseClaudeOutput(input);
    expect(result.costUsd).toBe(0.003);
  });

  test("extracts model from modelUsage keys", () => {
    const input = JSON.stringify({
      result: "test",
      duration_ms: 100,
      duration_api_ms: 50,
      is_error: false,
      num_turns: 1,
      session_id: "test",
      modelUsage: {
        "claude-sonnet-4-5-20250929": {
          inputTokens: 100,
          outputTokens: 50,
        },
      },
    });

    const result = parseClaudeOutput(input);
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
  });

  test("picks Sonnet over auxiliary Haiku call using costUSD", () => {
    // Real envelope shape: Claude CLI inserts an auxiliary Haiku call as
    // the first modelUsage key. For short responses the aux call can
    // even have more output tokens than the primary call, so cost is
    // the only reliable discriminator.
    const input = JSON.stringify({
      result: "test",
      duration_ms: 100,
      duration_api_ms: 50,
      is_error: false,
      num_turns: 1,
      session_id: "test",
      modelUsage: {
        "claude-haiku-4-5-20251001": {
          inputTokens: 350,
          outputTokens: 11,
          costUSD: 0.000405,
        },
        "claude-sonnet-4-6": {
          inputTokens: 3,
          outputTokens: 8,
          cacheCreationInputTokens: 20406,
          costUSD: 0.07665,
        },
      },
    });

    const result = parseClaudeOutput(input);
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  test("picks Sonnet over Haiku via total tokens when cost is absent", () => {
    // Older CLI envelopes may not include costUSD — fall back to total
    // tokens (including cache).
    const input = JSON.stringify({
      result: "test",
      duration_ms: 100,
      duration_api_ms: 50,
      is_error: false,
      num_turns: 1,
      session_id: "test",
      modelUsage: {
        "claude-haiku-4-5-20251001": { inputTokens: 350, outputTokens: 11 },
        "claude-sonnet-4-6": {
          inputTokens: 3,
          outputTokens: 17700,
          cacheCreationInputTokens: 7306,
          cacheReadInputTokens: 13302,
        },
      },
    });

    const result = parseClaudeOutput(input);
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  test("returns genuine Haiku-only call correctly", () => {
    const input = JSON.stringify({
      result: "test",
      duration_ms: 100,
      duration_api_ms: 50,
      is_error: false,
      num_turns: 1,
      session_id: "test",
      modelUsage: {
        "claude-haiku-4-5-20251001": {
          inputTokens: 100,
          outputTokens: 50,
          costUSD: 0.0002,
        },
      },
    });

    const result = parseClaudeOutput(input);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
  });

  test("tie-breaker prefers non-haiku key when all fields are absent", () => {
    const input = JSON.stringify({
      result: "test",
      duration_ms: 100,
      duration_api_ms: 50,
      is_error: false,
      num_turns: 1,
      session_id: "test",
      modelUsage: {
        "claude-haiku-4-5-20251001": {},
        "claude-sonnet-4-6": {},
      },
    });

    const result = parseClaudeOutput(input);
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  test("prefers top-level model field", () => {
    const input = JSON.stringify({
      result: "test",
      duration_ms: 100,
      duration_api_ms: 50,
      is_error: false,
      num_turns: 1,
      session_id: "test",
      model: "claude-opus-4-6",
      modelUsage: {
        "claude-sonnet-4-5-20250929": {},
      },
    });

    const result = parseClaudeOutput(input);
    expect(result.model).toBe("claude-opus-4-6");
  });

  test("handles missing optional fields gracefully", () => {
    const input = JSON.stringify({
      result: "test",
      is_error: false,
      session_id: "test",
    });

    const result = parseClaudeOutput(input);
    expect(result.durationMs).toBe(0);
    expect(result.durationApiMs).toBe(0);
    expect(result.numTurns).toBe(1);
  });

  test("throws on invalid JSON", () => {
    expect(() => parseClaudeOutput("not json")).toThrow();
  });
});
