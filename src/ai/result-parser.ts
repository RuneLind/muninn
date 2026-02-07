import type { ClaudeResult } from "../types.ts";

interface ClaudeJsonOutput {
  result: string;
  cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export function parseClaudeOutput(stdout: string): ClaudeResult {
  const parsed: ClaudeJsonOutput = JSON.parse(stdout);

  if (parsed.is_error) {
    throw new Error(`Claude error: ${parsed.result}`);
  }

  return {
    result: parsed.result,
    costUsd: parsed.cost_usd ?? 0,
    durationMs: parsed.duration_ms ?? 0,
    durationApiMs: parsed.duration_api_ms ?? 0,
    numTurns: parsed.num_turns ?? 1,
    model: parsed.model ?? "unknown",
    inputTokens: parsed.input_tokens ?? 0,
    outputTokens: parsed.output_tokens ?? 0,
  };
}
