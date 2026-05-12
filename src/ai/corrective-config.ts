import type { BotConfig } from "../bots/config.ts";

/**
 * Resolved per-bot corrective-retrieval settings. Precedence:
 *   1. `CORRECTIVE_RETRIEVAL_DISABLED=1` (hard kill-switch) → always off.
 *   2. The bot's `config.json` `correctiveRetrieval` block.
 *   3. The global env defaults (`CORRECTIVE_RETRIEVAL_ENABLED` /
 *      `CORRECTIVE_RETRIEVAL_BUDGET`).
 * `retryBudget` is clamped to 1–2 regardless of source.
 *
 * Reads `process.env` directly (rather than going through `loadConfig()`) so it
 * has no hard `DATABASE_URL` dependency and behaves the same in tests.
 */
export interface ResolvedCorrectiveConfig {
  enabled: boolean;
  /** Max corrective re-queries per knowledge search (1 or 2). */
  retryBudget: number;
}

export function resolveCorrectiveConfig(
  botConfig: Pick<BotConfig, "correctiveRetrieval">,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCorrectiveConfig {
  if (env.CORRECTIVE_RETRIEVAL_DISABLED === "1") {
    return { enabled: false, retryBudget: 1 };
  }

  const bot = botConfig.correctiveRetrieval;
  const globalEnabled = env.CORRECTIVE_RETRIEVAL_ENABLED === "true";
  const enabled = bot?.enabled ?? globalEnabled;

  const globalBudget = parseBudgetEnv(env.CORRECTIVE_RETRIEVAL_BUDGET);
  const rawBudget = bot?.retryBudget ?? globalBudget ?? 1;
  return { enabled, retryBudget: clampBudget(rawBudget) };
}

export function clampBudget(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(2, Math.floor(n)));
}

function parseBudgetEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}
