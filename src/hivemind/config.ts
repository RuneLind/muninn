import type { Namespace } from "./types.ts";

/**
 * Per-bot hivemind configuration. Lives under `hivemind` in `bots/<name>/config.json`.
 *
 * Example:
 * ```json
 * {
 *   "hivemind": {
 *     "enabled": true,
 *     "namespaces": ["private"],
 *     "summary": "Melosys — Jira analysis, asks peers for help",
 *     "autoRespondPeers": []
 *   }
 * }
 * ```
 */
export interface HivemindBotConfig {
  enabled: boolean;
  /** Namespaces to register a peer in. Phase 1 supports the first only; multi-namespace lands in Phase 4. */
  namespaces: Namespace[];
  /** Initial set_summary value. Visible to peers via list_peers. */
  summary?: string;
  /** Allowlist of peer names that may trigger autonomous bot replies. Phase 3+ feature. */
  autoRespondPeers?: string[];
  /** Default ask_peer wait timeout in seconds (default 120). */
  askPeerDefaultTimeoutSec?: number;
  /** Whether to expose the hivemind tools to the bot's Claude (default true if enabled). */
  exposeToTools?: boolean;
}

export const DEFAULT_ASK_PEER_TIMEOUT_SEC = 120;

/** Validate and normalize a hivemind block from a bot's config.json. */
export function parseHivemindConfig(raw: unknown): HivemindBotConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  if (r.enabled !== true) return null;

  const namespacesRaw = r.namespaces;
  if (!Array.isArray(namespacesRaw) || namespacesRaw.length === 0) return null;
  const namespaces = namespacesRaw.filter((n): n is string => typeof n === "string" && n.length > 0);
  if (namespaces.length === 0) return null;

  return {
    enabled: true,
    namespaces,
    summary: typeof r.summary === "string" ? r.summary : undefined,
    autoRespondPeers: Array.isArray(r.autoRespondPeers)
      ? r.autoRespondPeers.filter((p): p is string => typeof p === "string")
      : undefined,
    askPeerDefaultTimeoutSec:
      typeof r.askPeerDefaultTimeoutSec === "number" && r.askPeerDefaultTimeoutSec > 0
        ? r.askPeerDefaultTimeoutSec
        : undefined,
    exposeToTools: typeof r.exposeToTools === "boolean" ? r.exposeToTools : true,
  };
}
