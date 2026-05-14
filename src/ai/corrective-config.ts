import type { BotConfig } from "../bots/config.ts";

/**
 * Resolved per-bot corrective-retrieval settings (Path C). Precedence:
 *   1. `CORRECTIVE_RETRIEVAL_DISABLED=1` kill-switch → always off.
 *   2. The bot's `config.json` `correctiveRetrieval.enabled`.
 *   3. Global env default (`CORRECTIVE_RETRIEVAL_ENABLED=true`).
 *
 * Reads `process.env` directly rather than via `loadConfig()` so it has no
 * hard `DATABASE_URL` dependency and behaves the same in tests.
 */
export interface ResolvedCorrectiveConfig {
  enabled: boolean;
}

export function resolveCorrectiveConfig(
  botConfig: Pick<BotConfig, "correctiveRetrieval">,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCorrectiveConfig {
  if (env.CORRECTIVE_RETRIEVAL_DISABLED === "1") {
    return { enabled: false };
  }

  const bot = botConfig.correctiveRetrieval;
  const globalEnabled = env.CORRECTIVE_RETRIEVAL_ENABLED === "true";
  const enabled = bot?.enabled ?? globalEnabled;

  return { enabled };
}
