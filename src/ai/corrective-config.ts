import type { BotConfig } from "../bots/config.ts";

/**
 * Resolved per-bot corrective-retrieval settings (Path C — prompt-level
 * guidance). Precedence:
 *   1. `CORRECTIVE_RETRIEVAL_DISABLED=1` (hard kill-switch) → always off.
 *   2. The bot's `config.json` `correctiveRetrieval.enabled`.
 *   3. The global env default (`CORRECTIVE_RETRIEVAL_ENABLED=true`).
 *
 * When enabled, `prompt-builder.ts` appends a block telling the model to
 * re-call `search_knowledge` with the `broaderQuery` / `narrowerQuery` hints
 * Huginn emits in its `*Weak match*` / `*No confident match*` footers. The
 * loop is then driven by the model itself — no SDK hook, no proxy.
 *
 * History: an earlier shape carried `retryBudget` + `grader` for a hook-based
 * orchestrator (PR #113). That architecture was retired after the Copilot SDK
 * was shown to silently drop `onPostToolUse` `modifiedResult` / `additionalContext`
 * — see mimir/plans/muninn-corrective-rag-rework.md.
 *
 * Reads `process.env` directly (rather than going through `loadConfig()`) so
 * it has no hard `DATABASE_URL` dependency and behaves the same in tests.
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
