import type { Config } from "../config.ts";
import type { BotConfig, ConnectorType } from "../bots/config.ts";
import type { ClaudeExecResult } from "./executor.ts";
import type { StreamProgressCallback } from "./stream-parser.ts";

/**
 * A connector executes a prompt against an AI backend and returns a result.
 * All connectors must conform to this signature.
 */
export type AiConnector = (
  prompt: string,
  config: Config,
  botConfig: BotConfig,
  systemPrompt?: string,
  onProgress?: StreamProgressCallback,
) => Promise<ClaudeExecResult>;

import { executePrompt as claudeCli } from "./connectors/claude-cli.ts";

// Lazy-loaded connectors (avoid loading heavy deps like copilot-sdk at startup for all bots)
const lazyConnectors: Partial<Record<ConnectorType, AiConnector>> = {};

const connectorLoaders: Record<ConnectorType, () => Promise<AiConnector>> = {
  "claude-cli": async () => claudeCli,
  "copilot-sdk": async () => {
    const mod = await import("./connectors/copilot-sdk.ts");
    return mod.executePrompt;
  },
};

/** Resolve the AI connector function for a given bot config. */
export function resolveConnector(botConfig: BotConfig): AiConnector {
  const type = botConfig.connector ?? "claude-cli";
  // Return cached connector if already loaded
  if (type === "claude-cli") return claudeCli;
  const cached = lazyConnectors[type];
  if (cached) return cached;

  // Return a wrapper that lazy-loads on first call
  const loader = connectorLoaders[type];
  if (!loader) throw new Error(`Unknown connector type: ${type}`);

  const lazyWrapper: AiConnector = async (...args) => {
    const connector = await loader();
    lazyConnectors[type] = connector;
    return connector(...args);
  };
  lazyConnectors[type] = lazyWrapper;
  return lazyWrapper;
}
