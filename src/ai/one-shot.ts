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
import type { BotConfig, ConnectorType } from "../bots/config.ts";
import type { ClaudeExecResult } from "./executor.ts";
import type { StreamProgressCallback } from "./stream-parser.ts";
import { resolveConnector } from "./connector.ts";

export interface OneShotOptions {
  /** System prompt (persona / instructions). Passed through to the connector. */
  systemPrompt?: string;
  /** Response timeout override in ms. Falls back to the bot/global default. */
  timeoutMs?: number;
  /** Streaming progress callback (text deltas, tool events). */
  onProgress?: StreamProgressCallback;
  /**
   * Extra directories the run may read from (Claude CLI `--add-dir`). Used by
   * the TikTok summarizer so the CLI can Read frame JPEGs in a tmp dir. Only
   * connectors whose {@link ConnectorCapabilities.supportsExtraDirs} is true
   * accept these — passing them to any other connector throws.
   */
  extraDirs?: string[];
}

export interface ConnectorCapabilities {
  /**
   * Whether the connector can grant read access to directories outside the bot
   * folder (Claude CLI `--add-dir`). Only `claude-cli` can — the SDK/HTTP
   * connectors have no equivalent knob.
   */
  supportsExtraDirs: boolean;
}

/** Query a bot's connector capabilities without spawning anything. */
export function connectorCapabilities(botConfig: BotConfig): ConnectorCapabilities {
  const connector: ConnectorType = botConfig.connector ?? "claude-cli";
  return {
    supportsExtraDirs: connector === "claude-cli",
  };
}

/**
 * Run a single prompt through the bot's connector and return its result.
 *
 * A thin adapter over {@link resolveConnector}: it folds `timeoutMs` and
 * `extraDirs` into a per-call botConfig clone (the caller's config is never
 * mutated), then dispatches. `extraDirs` on a connector that can't express them
 * throws before the connector runs so callers fail fast with a clear message.
 */
export async function executeOneShot(
  prompt: string,
  config: Config,
  botConfig: BotConfig,
  opts: OneShotOptions = {},
): Promise<ClaudeExecResult> {
  const { systemPrompt, timeoutMs, onProgress, extraDirs } = opts;

  let effective = botConfig;

  if (timeoutMs !== undefined) {
    effective = { ...effective, timeoutMs };
  }

  if (extraDirs && extraDirs.length > 0) {
    if (!connectorCapabilities(botConfig).supportsExtraDirs) {
      const connector = botConfig.connector ?? "claude-cli";
      throw new Error(
        `Connector "${connector}" does not support extraDirs — only claude-cli can grant --add-dir access.`,
      );
    }
    // The CLI connector reads extra --add-dir flags from spawnArgs.
    const addDirArgs = extraDirs.flatMap((dir) => ["--add-dir", dir]);
    effective = {
      ...effective,
      spawnArgs: [...(effective.spawnArgs ?? []), ...addDirArgs],
    };
  }

  const connector = resolveConnector(effective);
  return connector(prompt, config, effective, systemPrompt, onProgress);
}
