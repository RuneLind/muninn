import type { ClaudeResult } from "../types.ts";

interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

export type ModelUsage = Record<string, ModelUsageEntry>;

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
  modelUsage?: ModelUsage;
  // Legacy top-level fields (older CLI versions)
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
}

export function pickPrimaryModel(usage: ModelUsage): string | undefined {
  const entries = Object.entries(usage);
  const first = entries[0];
  if (!first) return undefined;
  if (entries.length === 1) return first[0];

  // Score by cost first — the auxiliary Haiku call is always orders of
  // magnitude cheaper than the primary model. Fall back to total tokens
  // (including cache) when cost isn't populated: output tokens alone
  // aren't enough because short primary responses can emit fewer output
  // tokens than the auxiliary call.
  const scored = entries.map(([name, u]) => {
    const cost = u.costUSD ?? 0;
    const totalTokens = (u.inputTokens ?? 0)
      + (u.outputTokens ?? 0)
      + (u.cacheReadInputTokens ?? 0)
      + (u.cacheCreationInputTokens ?? 0);
    return { name, cost, totalTokens };
  });

  const anyCost = scored.some((s) => s.cost > 0);
  if (anyCost) {
    return scored.reduce((a, b) => (b.cost > a.cost ? b : a)).name;
  }

  const anyTokens = scored.some((s) => s.totalTokens > 0);
  if (anyTokens) {
    return scored.reduce((a, b) => (b.totalTokens > a.totalTokens ? b : a)).name;
  }

  // Last-resort tie-breaker: prefer a non-haiku key (haiku is the
  // auxiliary-call model). Otherwise keep insertion order.
  const nonHaiku = entries.find(([name]) => !name.includes("haiku"));
  return nonHaiku ? nonHaiku[0] : first[0];
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

  // Claude CLI 2.1.107+ inserts a small auxiliary Haiku call as the first
  // modelUsage key before the main inference; pickPrimaryModel scores by
  // cost so we report the model that actually did the work.
  const model = parsed.model
    ?? (parsed.modelUsage ? pickPrimaryModel(parsed.modelUsage) : undefined)
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
