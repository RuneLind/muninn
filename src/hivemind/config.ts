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
/**
 * Spec-driven dev loop autonomy (v2 / Phase 6). Default off ⇒ v1 behaviour
 * (the run parks at `ready_to_verify` and waits for the user's orchestrate
 * confirm). Lives under `hivemind.devLoop` because the dispatch trips in the
 * inbound hivemind router (off the handoff interpreter), which already has the
 * bot's hivemind config in hand.
 */
export interface DevLoopConfig {
  /** Auto-fire the orchestrate (cross-repo e2e) turn when build ∧ test land done,
   *  instead of parking at `ready_to_verify` for the user's confirm (PR 6a). */
  autoOrchestrate?: boolean;
  /** On a red e2e, auto-re-engage the build agent (re-open the run + hand it the
   *  failure context) up to MAX_REENGAGE_ATTEMPTS, then park at `red` for the user
   *  (PR 6b). Independent of autoOrchestrate, though they compose: a re-engaged
   *  build that lands done rolls the run back to `ready_to_verify`, where
   *  autoOrchestrate (if on) re-fires the e2e. */
  autoReengageOnRed?: boolean;
  /** When re-engaging on a red e2e (PR 6b), use a Haiku classifier to route the
   *  fix to the BUILD agent (feature-code bug) vs the TEST agent (spec/test
   *  drift — stale selector, outdated assertion, test data). Default off ⇒ the
   *  verified always-build first cut. Only consulted when autoReengageOnRed is on;
   *  any classifier miss/error falls back to build. */
  reengageClassifier?: boolean;
}

export interface HivemindBotConfig {
  enabled: boolean;
  /** Namespaces to register a peer in. Phase 1 supports the first only; multi-namespace lands in Phase 4. */
  namespaces: Namespace[];
  /** Initial set_summary value. Visible to peers via list_peers. */
  summary?: string;
  /** Allowlist of peer names (matching `peerNameFor()` output) that may trigger autonomous bot replies. */
  autoRespondPeers?: string[];
  /** Hourly cap on autorespond turns per peer thread. Hitting it auto-pauses until manual unmute. Default 20. */
  maxAutoTurnsPerHour?: number;
  /** Default ask_peer wait timeout in seconds (default 120). */
  askPeerDefaultTimeoutSec?: number;
  /** Whether to expose the hivemind tools to the bot's Claude (default true if enabled). */
  exposeToTools?: boolean;
  /** Spec-driven dev loop autonomy (v2). Absent/empty ⇒ v1 park-and-confirm. */
  devLoop?: DevLoopConfig;
}

export const DEFAULT_ASK_PEER_TIMEOUT_SEC = 120;
export const DEFAULT_MAX_AUTO_TURNS_PER_HOUR = 20;
/**
 * How long a peer-correlation entry stays valid after an outbound — see
 * correlation.ts. Now that correlation is persisted (survives restarts), this
 * is a generous ceiling that covers long-running peer tasks (a coding agent
 * may take hours on a big handoff). Every new outbound to the peer resets it,
 * so the TTL only bounds how long an *unsolicited* late reply still routes home.
 */
export const PEER_CORRELATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
    maxAutoTurnsPerHour:
      typeof r.maxAutoTurnsPerHour === "number" && r.maxAutoTurnsPerHour > 0
        ? Math.floor(r.maxAutoTurnsPerHour)
        : undefined,
    askPeerDefaultTimeoutSec:
      typeof r.askPeerDefaultTimeoutSec === "number" && r.askPeerDefaultTimeoutSec > 0
        ? r.askPeerDefaultTimeoutSec
        : undefined,
    exposeToTools: typeof r.exposeToTools === "boolean" ? r.exposeToTools : true,
    devLoop: parseDevLoopConfig(r.devLoop),
  };
}

/** Validate the optional `hivemind.devLoop` autonomy sub-block. Returns
 *  undefined when absent or empty so an unset block reads identically to v1. */
function parseDevLoopConfig(raw: unknown): DevLoopConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const cfg: DevLoopConfig = {};
  if (typeof r.autoOrchestrate === "boolean") cfg.autoOrchestrate = r.autoOrchestrate;
  if (typeof r.autoReengageOnRed === "boolean") cfg.autoReengageOnRed = r.autoReengageOnRed;
  if (typeof r.reengageClassifier === "boolean") cfg.reengageClassifier = r.reengageClassifier;
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}
