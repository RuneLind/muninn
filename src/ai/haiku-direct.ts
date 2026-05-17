import Anthropic from "@anthropic-ai/sdk";
import { getLog } from "../logging.ts";
import {
  DEFAULT_MODEL,
  HAIKU_TIMEOUT_MS,
  spawnHaiku,
  trackUsage,
  type HaikuResult,
  type SpawnHaikuOptions,
} from "../scheduler/executor.ts";

const log = getLog("ai", "haiku-direct");

// Decomposer / memory / goal / schedule extractors all emit small JSON blobs.
// 4096 is comfortable headroom without inviting runaway outputs.
const DEFAULT_MAX_TOKENS = 4096;

let cachedClient: Anthropic | null = null;
let cachedAuthSource: "api-key" | "oauth" | null = null;

export function isHaikuDirectEnabled(): boolean {
  const flag = process.env.HAIKU_DIRECT_ENABLED;
  return flag === "1" || flag === "true";
}

export function hasHaikuDirectAuth(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
}

function buildClient(): { client: Anthropic; authSource: "api-key" | "oauth" } {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return { client: new Anthropic({ apiKey }), authSource: "api-key" };
  }
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) {
    return { client: new Anthropic({ apiKey: null, authToken: oauth }), authSource: "oauth" };
  }
  throw new Error("haiku-direct: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set");
}

// Client cache is process-lifetime — rotating ANTHROPIC_API_KEY /
// CLAUDE_CODE_OAUTH_TOKEN at runtime requires a process restart.
function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const { client, authSource } = buildClient();
  cachedClient = client;
  cachedAuthSource = authSource;
  return client;
}

export function _resetClientForTests(): void {
  cachedClient = null;
  cachedAuthSource = null;
}

export function _getAuthSourceForTests(): "api-key" | "oauth" | null {
  return cachedAuthSource;
}

export async function callHaikuDirect(
  prompt: string,
  opts: SpawnHaikuOptions,
): Promise<HaikuResult> {
  const { source, botName, timeoutMs = HAIKU_TIMEOUT_MS, model } = opts;
  const effectiveModel = model || DEFAULT_MODEL;

  const client = getClient();

  const response = await client.messages.create(
    {
      model: effectiveModel,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    },
    { timeout: timeoutMs },
  );

  const inputTokens = (response.usage.input_tokens ?? 0)
    + (response.usage.cache_creation_input_tokens ?? 0)
    + (response.usage.cache_read_input_tokens ?? 0);
  const outputTokens = response.usage.output_tokens ?? 0;

  let resultText = "";
  for (const block of response.content) {
    if (block.type === "text") {
      resultText += block.text;
    }
  }

  trackUsage(source, response.model, inputTokens, outputTokens, botName);

  return {
    result: resultText,
    inputTokens,
    outputTokens,
    model: response.model,
  };
}

/**
 * Drop-in replacement for `spawnHaiku` that routes through the Anthropic SDK
 * when `HAIKU_DIRECT_ENABLED=1` and auth is available, falling back to the CLI
 * subprocess on any error. Call sites that don't need MCP tools can use this
 * to skip the multi-second CLI cold-start.
 */
export async function callHaikuWithFallback(
  prompt: string,
  opts: SpawnHaikuOptions,
): Promise<HaikuResult> {
  if (isHaikuDirectEnabled() && hasHaikuDirectAuth()) {
    try {
      return await callHaikuDirect(prompt, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        "haiku-direct failed, falling back to spawnHaiku: {error}",
        { botName: opts.botName ?? "haiku", error: message },
      );
    }
  }
  return spawnHaiku(prompt, opts);
}
