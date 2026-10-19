/**
 * One-shot execution seam — runs a single prompt→text turn through a bot's
 * configured AI connector (claude-cli / copilot-sdk / openai-compat / claude-sdk).
 *
 * Batch/background jobs (the summarizers, research synthesis) used to call
 * `executeClaudePrompt` directly, which always spawns the Claude CLI and passes
 * `botConfig.model` straight to `--model`. That silently excluded copilot-sdk /
 * openai-compat bots (their model ids aren't valid CLI `--model` values) and
 * forced connector knowledge into bot-selection guards. Routing through
 * `resolveConnector` instead means every job honors the bot's connector exactly
 * like a chat turn does.
 */

import type { Config } from "../config.ts";
import type { BotConfig, ConnectorType, EffortLevel } from "../bots/config.ts";
import type { ClaudeExecResult } from "./executor.ts";
import type { StreamProgressCallback } from "./stream-parser.ts";
import { resolveConnector } from "./connector.ts";
import { isReadSurface, type ToolSurface } from "./tool-surface.ts";
import { getLog } from "../logging.ts";
import { isAbsolute, resolve } from "node:path";

const log = getLog("ai", "one-shot");

/**
 * Callers build one-shot prompts with template strings over dynamic values
 * (paths, dates, retrieved content). When one of those values is missing, the
 * bug surfaces as a literal "undefined" baked into the prompt and a connector
 * run is wasted on garbage — a real dispatch once asked a bot to read
 * "undefined/secret.txt". An empty prompt is unambiguously a caller bug and
 * throws; the marker strings can legitimately occur inside interpolated
 * content (an email quoting JS errors, a code transcript), so they only log
 * loudly instead of rejecting the run.
 */
const UNRESOLVED_TEMPLATE_MARKERS = ["undefined/", "/undefined", "[object Object]", "NaN/"];

export function checkPromptResolved(prompt: string): void {
  if (!prompt.trim()) {
    throw new Error("executeOneShot: empty prompt — a template variable likely didn't resolve.");
  }
  const marker = UNRESOLVED_TEMPLATE_MARKERS.find((m) => prompt.includes(m));
  if (marker) {
    log.warn(
      'One-shot prompt contains "{marker}" — possible unresolved template variable. Prompt head: {head}',
      { marker, head: prompt.slice(0, 160) },
    );
  }
}

export interface OneShotOptions {
  /** System prompt (persona / instructions). Passed through to the connector. */
  systemPrompt?: string;
  /** Response timeout override in ms. Falls back to the bot/global default. */
  timeoutMs?: number;
  /**
   * Thinking-budget override for this call. Falls back to the bot's
   * `thinkingMaxTokens`. Claude Code applies a budget only on models that take
   * one (Haiku 4.5 and older); on adaptive-thinking models pass `effort` too.
   *
   * A one-shot job inherits the bot's CHAT thinking budget, which is tuned for
   * open-ended conversation — jarvis carries 40k. On a batch transform (the
   * capture summarizers) that budget is spent as silent dead-air before the
   * first token: measured on a real 2.3k-word transcript, 40k thinking took
   * 9.5s to first token / 23.8s total, versus 2.5s / 17.2s at an 8k cap, with
   * no loss of summary quality. Callers whose work genuinely benefits from
   * deep reasoning simply omit this and keep the bot's budget.
   */
  thinkingMaxTokens?: number;
  /**
   * Effort override for this call; falls back to the bot's `effort`. The
   * thinking control on adaptive-thinking models (Opus/Sonnet 4.6+, the 5.5
   * models included), where `thinkingMaxTokens` is ignored.
   */
  effort?: EffortLevel;
  /** Streaming progress callback (text deltas, tool events). */
  onProgress?: StreamProgressCallback;
  /**
   * Extra directories the run may read from (Claude CLI `--add-dir`). Used by
   * the TikTok summarizer so the CLI can Read frame JPEGs in a tmp dir. Only
   * connectors whose {@link ConnectorCapabilities.supportsExtraDirs} is true
   * accept these — passing them to any other connector throws. Only with
   * `toolSurface: "bot"`: on `{ read }` the dirs come from the surface.
   */
  extraDirs?: string[];
  /**
   * The tools this run may reach. Required, so typecheck fails on a caller
   * that does not state it. See `src/ai/tool-surface.ts`.
   */
  toolSurface: ToolSurface;
}

/**
 * Apply a declared tool surface to a per-call `BotConfig` clone. The single
 * place a surface turns into connector fields: `"none"` sets `toolsDisabled`,
 * the fenced shapes ride on `toolSurface` for the connector to map, and a
 * connector that cannot express a fenced shape is refused before it runs.
 */
export function applyToolSurface(
  botConfig: BotConfig,
  surface: ToolSurface,
  extraDirs: string[] | undefined,
): BotConfig {
  const connector: ConnectorType = botConfig.connector ?? "claude-cli";
  if (surface !== "bot" && extraDirs && extraDirs.length > 0) {
    throw new Error(
      `executeOneShot: extraDirs is only allowed with toolSurface "bot" — a { read } surface names its own dirs.`,
    );
  }
  if (surface === "bot") return { ...botConfig, toolSurface: "bot" };
  if (surface === "none") return { ...botConfig, toolSurface: "none", toolsDisabled: true };

  const caps = connectorCapabilities(botConfig);
  if (isReadSurface(surface)) {
    if (!caps.supportsExtraDirs) {
      throw new Error(`Connector "${connector}" cannot run a { read } tool surface — only claude-cli and claude-sdk can.`);
    }
    if (surface.read.length === 0 || surface.read.some((d) => !isAbsolute(d))) {
      throw new Error("executeOneShot: a { read } tool surface needs at least one directory, every one absolute.");
    }
    return { ...botConfig, toolSurface: { read: surface.read.map((d) => resolve(d)) } };
  }
  if (!caps.supportsWebTools) {
    throw new Error(`Connector "${connector}" cannot run a { web } tool surface — only claude-cli and claude-sdk can.`);
  }
  return { ...botConfig, toolSurface: { web: true } };
}

/**
 * The connector-capability table lives in the dependency-free
 * `connector-capabilities.ts` leaf (the capture-kind resolver narrows the kinds
 * a bot offers by it and must stay IO-free). Import the table's own names from
 * THERE; this module keeps only the bot-config convenience below, which is
 * what a caller holding a `BotConfig` wants.
 */
import type { ConnectorCapabilities } from "./connector-capabilities.ts";
import { capabilitiesForConnectorType } from "./connector-capabilities.ts";

/** Query a bot's connector capabilities without spawning anything. */
export function connectorCapabilities(botConfig: BotConfig): ConnectorCapabilities {
  return capabilitiesForConnectorType(botConfig.connector ?? "claude-cli");
}

/**
 * Run a single prompt through the bot's connector and return its result.
 *
 * A thin adapter over {@link resolveConnector}: it folds the tool surface
 * ({@link applyToolSurface}), `timeoutMs` and `extraDirs` into a per-call
 * botConfig clone (the caller's config is never mutated), then dispatches. `extraDirs` on a connector that can't express them
 * throws before the connector runs so callers fail fast with a clear message.
 */
export async function executeOneShot(
  prompt: string,
  config: Config,
  botConfig: BotConfig,
  opts: OneShotOptions,
): Promise<ClaudeExecResult> {
  const { systemPrompt, timeoutMs, thinkingMaxTokens, effort, onProgress, extraDirs, toolSurface } = opts;

  checkPromptResolved(prompt);

  let effective = applyToolSurface(botConfig, toolSurface, extraDirs);

  if (timeoutMs !== undefined) {
    effective = { ...effective, timeoutMs };
  }

  if (thinkingMaxTokens !== undefined) {
    effective = { ...effective, thinkingMaxTokens };
  }

  if (effort !== undefined) {
    effective = { ...effective, effort };
  }

  if (extraDirs && extraDirs.length > 0) {
    const connector: ConnectorType = botConfig.connector ?? "claude-cli";
    if (!connectorCapabilities(botConfig).supportsExtraDirs) {
      throw new Error(
        `Connector "${connector}" does not support extraDirs — only claude-cli (--add-dir) ` +
          `and claude-sdk (additionalDirectories) can grant read access outside the bot folder.`,
      );
    }
    if (connector === "claude-sdk") {
      // The SDK connector reads absolute dirs from botConfig.extraDirs and maps
      // them to Options.additionalDirectories.
      effective = { ...effective, extraDirs };
    } else {
      // The CLI connector reads extra --add-dir flags from spawnArgs.
      const addDirArgs = extraDirs.flatMap((dir) => ["--add-dir", dir]);
      effective = {
        ...effective,
        spawnArgs: [...(effective.spawnArgs ?? []), ...addDirArgs],
      };
    }
  }

  const connector = resolveConnector(effective);
  return connector(prompt, config, effective, systemPrompt, onProgress);
}
