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
import type { ConnectorType } from "../bots/config.ts";

const log = getLog("ai", "haiku-router");

// Decomposer / memory / goal / schedule extractors all emit small JSON blobs.
// 4096 is comfortable headroom without inviting runaway outputs.
const DEFAULT_MAX_TOKENS = 4096;

// Copilot's model registry uses dotted ids ("claude-haiku-4.5") rather than
// Anthropic's full date-suffixed form ("claude-haiku-4-5-20251001"). Verified
// 2026-05-17 via `client.listModels()` — see scripts/smoke-haiku-copilot.ts.
// Sending an unknown id silently substitutes Sonnet, so this must match exactly.
const COPILOT_HAIKU_MODEL = "claude-haiku-4.5";

export type HaikuBackend = "cli" | "anthropic" | "copilot";

export interface HaikuRouterOptions extends SpawnHaikuOptions {
  /** Explicit backend override (top-priority in resolution). */
  backend?: HaikuBackend;
  /** Per-bot override from `BotConfig.haikuBackend`. See `resolveBackend` for priority. */
  haikuBackend?: HaikuBackend;
  /** Bot's main connector — selects the connector-derived fallback. */
  connector?: ConnectorType;
}

let cachedAnthropic: Anthropic | null = null;
let cachedAuthSource: "api-key" | "oauth" | null = null;

export function isHaikuDirectEnabled(): boolean {
  const flag = process.env.HAIKU_DIRECT_ENABLED;
  return flag === "1" || flag === "true";
}

export function hasHaikuDirectAuth(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
}

function parseHaikuBackendEnv(): HaikuBackend | null {
  const raw = process.env.HAIKU_BACKEND?.trim().toLowerCase();
  if (raw === "cli" || raw === "anthropic" || raw === "copilot") return raw;
  return null;
}

/**
 * Resolution order (top wins):
 *   1. explicit opts.backend
 *   2. HAIKU_BACKEND env (cli|anthropic|copilot) — debug knob
 *   3. opts.haikuBackend (per-bot config from `BotConfig.haikuBackend`)
 *   4. legacy HAIKU_DIRECT_ENABLED=1 → anthropic
 *   5. opts.connector === "copilot-sdk" → copilot
 *   6. floor → cli
 */
export function resolveBackend(opts: {
  backend?: HaikuBackend;
  haikuBackend?: HaikuBackend;
  connector?: ConnectorType;
}): HaikuBackend {
  if (opts.backend) return opts.backend;
  const fromEnv = parseHaikuBackendEnv();
  if (fromEnv) return fromEnv;
  if (opts.haikuBackend) return opts.haikuBackend;
  if (isHaikuDirectEnabled()) return "anthropic";
  if (opts.connector === "copilot-sdk") return "copilot";
  return "cli";
}

function buildAnthropic(): { client: Anthropic; authSource: "api-key" | "oauth" } {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return { client: new Anthropic({ apiKey }), authSource: "api-key" };
  }
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) {
    return { client: new Anthropic({ apiKey: null, authToken: oauth }), authSource: "oauth" };
  }
  throw new Error("haiku-router: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set");
}

// Client cache is process-lifetime — rotating ANTHROPIC_API_KEY /
// CLAUDE_CODE_OAUTH_TOKEN at runtime requires a process restart.
function getAnthropic(): Anthropic {
  if (cachedAnthropic) return cachedAnthropic;
  const { client, authSource } = buildAnthropic();
  cachedAnthropic = client;
  cachedAuthSource = authSource;
  return client;
}

/** Drop the cached Anthropic client so the next call rebuilds it from current
 *  env. Used both by the production 401 recovery path and by tests. */
export function resetAnthropicClient(): void {
  cachedAnthropic = null;
  cachedAuthSource = null;
}

/** @deprecated test-facing alias for {@link resetAnthropicClient}. */
export const _resetClientForTests = resetAnthropicClient;

export function _getAuthSourceForTests(): "api-key" | "oauth" | null {
  return cachedAuthSource;
}

export async function callHaikuDirect(
  prompt: string,
  opts: SpawnHaikuOptions,
): Promise<HaikuResult> {
  const { source, botName, timeoutMs = HAIKU_TIMEOUT_MS, model, maxTokens } = opts;
  const effectiveModel = model || DEFAULT_MODEL;
  const effectiveMaxTokens = maxTokens && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS;

  const client = getAnthropic();

  let response;
  try {
    response = await client.messages.create(
      {
        model: effectiveModel,
        max_tokens: effectiveMaxTokens,
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: timeoutMs },
    );
  } catch (err) {
    // A rotated/revoked key authenticates the cached client forever otherwise —
    // drop the cache on a 401 so the next call rebuilds from current env.
    if (err instanceof Anthropic.APIError && err.status === 401) {
      log.warn("haiku-router anthropic auth rejected (401), clearing cached client", {
        botName: botName ?? "haiku",
      });
      resetAnthropicClient();
    }
    throw err;
  }

  if (response.stop_reason === "max_tokens") {
    log.warn("haiku-router anthropic response truncated at max_tokens ({maxTokens}) — JSON parse may fail", {
      botName: botName ?? "haiku",
      maxTokens: effectiveMaxTokens,
    });
  }

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
 * Routes a one-shot Haiku call through the shared CopilotClient singleton.
 * Reuses the same auth surface the bot's main chat uses. Session is lean —
 * no MCP servers, no custom agents — and is destroyed in `finally`.
 */
export async function callHaikuViaCopilot(
  prompt: string,
  opts: SpawnHaikuOptions,
): Promise<HaikuResult> {
  // Lazy import: avoids pulling @github/copilot-sdk into bots that never use it.
  const { getCopilotClient } = await import("./connectors/copilot-sdk.ts");
  const cl = await getCopilotClient();
  const model = opts.model ?? COPILOT_HAIKU_MODEL;
  const timeoutMs = opts.timeoutMs ?? HAIKU_TIMEOUT_MS;

  const session = await cl.createSession({
    model,
    streaming: false,
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let reportedModel = model;

  const unsubscribe = session.on((event) => {
    if (event.type === "assistant.usage") {
      inputTokens += (event.data.inputTokens ?? 0)
        + (event.data.cacheReadTokens ?? 0)
        + (event.data.cacheWriteTokens ?? 0);
      outputTokens += event.data.outputTokens ?? 0;
      if (event.data.model) reportedModel = event.data.model;
    }
  });

  try {
    const response = await session.sendAndWait({ prompt }, timeoutMs);
    const resultText = response?.data?.content ?? "";
    // The hardcoded COPILOT_HAIKU_MODEL id is what we requested; if Copilot's
    // registry renames it the request silently downgrades to Sonnet. The usage
    // event reports the model actually served — flag a mismatch loudly.
    if (!/haiku/i.test(reportedModel)) {
      log.warn(
        "haiku-router copilot served a non-Haiku model ({model}) — registry id may have changed, extraction is running on the wrong model",
        { botName: opts.botName ?? "haiku", model: reportedModel },
      );
    }
    trackUsage(opts.source, reportedModel, inputTokens, outputTokens, opts.botName);
    return {
      result: resultText,
      inputTokens,
      outputTokens,
      model: reportedModel,
    };
  } finally {
    unsubscribe();
    session.destroy().catch((e) => {
      log.warn("Failed to destroy Copilot Haiku session: {error}", { error: String(e) });
    });
  }
}

/**
 * Drop-in replacement for `spawnHaiku` that routes through a backend picked
 * by `resolveBackend()`. Falls back to the CLI subprocess on any error.
 */
export async function callHaikuWithFallback(
  prompt: string,
  opts: HaikuRouterOptions,
): Promise<HaikuResult> {
  const backend = resolveBackend(opts);

  if (backend === "anthropic") {
    if (!hasHaikuDirectAuth()) {
      log.warn(
        "haiku-router anthropic backend requested but no auth, falling back to CLI",
        { botName: opts.botName ?? "haiku" },
      );
    } else {
      try {
        return await callHaikuDirect(prompt, opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          "haiku-router anthropic failed, falling back to CLI: {error}",
          { botName: opts.botName ?? "haiku", error: message },
        );
      }
    }
  } else if (backend === "copilot") {
    try {
      return await callHaikuViaCopilot(prompt, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        "haiku-router copilot failed, falling back to CLI: {error}",
        { botName: opts.botName ?? "haiku", error: message },
      );
    }
  }
  return spawnHaiku(prompt, opts);
}
