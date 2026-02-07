import type { ClaudeResult } from "../types.ts";

interface ClaudeJsonOutput {
  result: string;
  total_cost_usd?: number;
  cost_usd?: number;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  session_id: string;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
  }>;
  // Legacy top-level fields (older CLI versions)
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
}

export function parseClaudeOutput(stdout: string): ClaudeResult {
  const parsed: ClaudeJsonOutput = JSON.parse(stdout);

  if (parsed.is_error) {
    throw new Error(`Claude error: ${parsed.result}`);
  }

  // Tokens: prefer usage object, fall back to top-level fields
  // Include cache tokens in total for accurate tracking
  const inputTokens = parsed.usage
    ? (parsed.usage.input_tokens ?? 0)
      + (parsed.usage.cache_creation_input_tokens ?? 0)
      + (parsed.usage.cache_read_input_tokens ?? 0)
    : (parsed.input_tokens ?? 0);
  const outputTokens = parsed.usage?.output_tokens ?? parsed.output_tokens ?? 0;

  // Model: extract from modelUsage keys, fall back to top-level
  const model = parsed.model
    ?? (parsed.modelUsage ? Object.keys(parsed.modelUsage)[0] : undefined)
    ?? "unknown";

  return {
    result: parsed.result,
    costUsd: parsed.total_cost_usd ?? parsed.cost_usd ?? 0,
    durationMs: parsed.duration_ms ?? 0,
    durationApiMs: parsed.duration_api_ms ?? 0,
    numTurns: parsed.num_turns ?? 1,
    model,
    inputTokens,
    outputTokens,
  };
}
