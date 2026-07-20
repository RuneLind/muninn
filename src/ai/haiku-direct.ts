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
import { getRoleOverride } from "../db/role-overrides.ts";

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

function parseHaikuBackendValue(raw: string | undefined): HaikuBackend | null {
  const v = raw?.trim().toLowerCase();
  if (v === "cli" || v === "anthropic" || v === "copilot") return v;
  return null;
}

function parseHaikuBackendEnv(): HaikuBackend | null {
  return parseHaikuBackendValue(process.env.HAIKU_BACKEND);
}

/** DB override (edited from /models) for the process-wide Haiku backend. Beats
 *  the HAIKU_BACKEND env var; read from the sync in-memory snapshot. */
function parseHaikuBackendOverride(): HaikuBackend | null {
  return parseHaikuBackendValue(getRoleOverride("HAIKU_BACKEND"));
}

export interface BackendResolutionInput {
  backend?: HaikuBackend;
  haikuBackend?: HaikuBackend;
  connector?: ConnectorType;
}

export interface BackendResolution {
  backend: HaikuBackend;
  /** Which precedence rule won — surfaced by the startup diagnostic. */
  reason: string;
}

/** A stable id for each precedence level, for keying + UI mapping. */
export type BackendChainSource =
  | "explicit"
  | "override"
  | "env"
  | "config"
  | "legacy"
  | "connector"
  | "default";

/** One precedence level in the backend-resolution chain. `value` is what the
 *  level contributes (null when the level is inactive/unset/invalid — e.g. an
 *  invalid `HAIKU_BACKEND` env value parses to null and the chain falls through
 *  exactly as the old short-circuit did). Exactly one link has `wins: true`. */
export interface BackendChainLink {
  source: BackendChainSource;
  reason: string;
  value: HaikuBackend | null;
  wins: boolean;
}

/**
 * Non-short-circuiting enumerator over EVERY precedence level (top wins).
 * The single source of truth for backend precedence — `resolveBackendWithReason`
 * (and thus `resolveBackend` + the startup diagnostic + the /models "why" chain)
 * all derive from `chain.find(c => c.wins)`, so the order lives in exactly one
 * place. Levels, top to bottom:
 *   1. explicit opts.backend
 *   2. HAIKU_BACKEND DB override (edited from /models) — hot, beats env
 *   3. HAIKU_BACKEND env (cli|anthropic|copilot) — debug knob
 *   4. opts.haikuBackend (per-bot config from `BotConfig.haikuBackend`)
 *   5. legacy HAIKU_DIRECT_ENABLED=1 → anthropic
 *   6. opts.connector === "copilot-sdk" → copilot
 *   7. floor → cli (always contributes, so a winner is guaranteed)
 *
 * Invalid-enum fall-through is preserved by reusing `parseHaikuBackendOverride`
 * / `parseHaikuBackendEnv` (both return null on an unrecognised value).
 */
export function resolveBackendChain(opts: BackendResolutionInput): BackendChainLink[] {
  const links: Array<Omit<BackendChainLink, "wins">> = [
    { source: "explicit", reason: "explicit override", value: opts.backend || null },
    { source: "override", reason: "HAIKU_BACKEND override", value: parseHaikuBackendOverride() },
    { source: "env", reason: "HAIKU_BACKEND env", value: parseHaikuBackendEnv() },
    { source: "config", reason: "bot config haikuBackend", value: opts.haikuBackend || null },
    { source: "legacy", reason: "legacy HAIKU_DIRECT_ENABLED", value: isHaikuDirectEnabled() ? "anthropic" : null },
    { source: "connector", reason: "connector default (copilot-sdk)", value: opts.connector === "copilot-sdk" ? "copilot" : null },
    { source: "default", reason: "default", value: "cli" },
  ];
  const winnerIdx = links.findIndex((l) => l.value != null);
  return links.map((l, i) => ({ ...l, wins: i === winnerIdx }));
}

/**
 * Resolve the effective Haiku backend + the winning precedence rule. Derived
 * from {@link resolveBackendChain} so ordering has one home. The `default` floor
 * always contributes "cli", so a winner is guaranteed.
 */
export function resolveBackendWithReason(opts: BackendResolutionInput): BackendResolution {
  const winner = resolveBackendChain(opts).find((c) => c.wins);
  if (!winner || winner.value == null) return { backend: "cli", reason: "default" };
  return { backend: winner.value, reason: winner.reason };
}

/** Resolve the effective Haiku backend. See {@link resolveBackendWithReason}. */
export function resolveBackend(opts: BackendResolutionInput): HaikuBackend {
  return resolveBackendWithReason(opts).backend;
}

/**
 * Log the effective Haiku backend for each bot at startup. The 6-level
 * precedence is a recurring "why is my bot on the wrong backend?" puzzle —
 * naming the winning rule per bot makes it answerable from the boot log instead
 * of by reverse-engineering the chain.
 */
export function logResolvedHaikuBackends(
  bots: Array<{ name: string; connector?: ConnectorType; haikuBackend?: HaikuBackend }>,
): void {
  for (const bot of bots) {
    const { backend, reason } = resolveBackendWithReason({
      connector: bot.connector,
      haikuBackend: bot.haikuBackend,
    });
    log.info("{botName} Haiku backend: {backend} ({reason})", { botName: bot.name, backend, reason });
  }
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

  // Thread the telemetry Tracer's trace id so the haiku_usage row ties back to
  // the request trace (NULL without a tracer). Mirrors spawnHaiku's trackUsage
  // call — before this, the anthropic backend (the active HAIKU_DIRECT_ENABLED
  // path) wrote every extractor/decomposer row with a NULL trace_id.
  trackUsage(source, response.model, inputTokens, outputTokens, botName, opts.tracer?.traceId);

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
 * no MCP servers, no custom agents — and is deleted in `finally`.
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
    // Thread the telemetry Tracer's trace id (NULL without a tracer) — same join
    // as callHaikuDirect / spawnHaiku so the copilot backend's rows tie back too.
    trackUsage(opts.source, reportedModel, inputTokens, outputTokens, opts.botName, opts.tracer?.traceId);
    return {
      result: resultText,
      inputTokens,
      outputTokens,
      model: reportedModel,
    };
  } finally {
    unsubscribe();
    // One-shot extraction session — delete permanently (disk state included).
    cl.deleteSession(session.sessionId).catch((e: unknown) => {
      // A failed delete leaves the session (and its handler closures) in the
      // singleton client's registry — disconnect releases them, best-effort.
      session.disconnect().catch(() => {});
      log.warn("Failed to delete Copilot Haiku session: {error}", { error: String(e) });
    });
  }
}

type HaikuBackendHandler = (prompt: string, opts: HaikuRouterOptions) => Promise<HaikuResult>;

// resolveBackend() picks the key; this maps the two non-CLI keys to their
// handler — mirroring resolveConnector()'s registry, so adding a backend is
// additive. The CLI is the universal fallback (not a registry entry) and is
// handled separately below.
const NON_CLI_BACKENDS: Record<"anthropic" | "copilot", HaikuBackendHandler> = {
  anthropic: callHaikuDirect,
  copilot: callHaikuViaCopilot,
};

/**
 * Drop-in replacement for `spawnHaiku` that routes through a backend picked
 * by `resolveBackend()`. Falls back to the CLI subprocess on any error.
 */
export async function callHaikuWithFallback(
  prompt: string,
  opts: HaikuRouterOptions,
): Promise<HaikuResult> {
  const backend = resolveBackend(opts);
  const botName = opts.botName ?? "haiku";

  if (backend === "anthropic" && !hasHaikuDirectAuth()) {
    // No auth → skip the attempt entirely rather than failing one call first.
    log.warn("haiku-router anthropic backend requested but no auth, falling back to CLI", { botName });
  } else if (backend !== "cli") {
    try {
      return await NON_CLI_BACKENDS[backend](prompt, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("haiku-router {backend} failed, falling back to CLI: {error}", { botName, backend, error: message });
    }
  }
  return spawnHaiku(prompt, opts);
}
