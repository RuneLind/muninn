import type { BotConfig, ConnectorType } from "../bots/config.ts";
import type { Connector } from "../db/connectors.ts";

/**
 * A thread's named connector over the bot's config.json: each field the
 * connector sets wins, each it leaves unset falls back to the bot.
 */
export function applyThreadConnector(botConfig: BotConfig, threadConnector: Connector): BotConfig {
  return {
    ...botConfig,
    connector: threadConnector.connectorType as ConnectorType,
    model: threadConnector.model ?? botConfig.model,
    baseUrl: threadConnector.baseUrl ?? botConfig.baseUrl,
    thinkingMaxTokens: threadConnector.thinkingMaxTokens ?? botConfig.thinkingMaxTokens,
    effort: threadConnector.effort ?? botConfig.effort,
    timeoutMs: threadConnector.timeoutMs ?? botConfig.timeoutMs,
  };
}
