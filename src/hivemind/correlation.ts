/**
 * Tracks which thread originated an outbound message to a hivemind peer, so
 * the inbound reply can be routed back to that thread instead of the default
 * `peer:<ns>/<name>` fallback (`router.ts`).
 *
 * Keyed by `(botName, peerId)`. Set on every outbound — MCP tool calls
 * (`mcp-server.ts` → ask_peer / send_to_peer), chat `>` outbound
 * (`chat/routes.ts` → handlePeerOutbound), and autorespond replies
 * (`router.ts` → maybeAutorespond). Last-write-wins per peer.
 *
 * In-memory only — muninn restart drops the correlation and replies fall
 * back to `peer:<ns>/<name>`. Acceptable for the first cut; promote to a
 * DB-backed table if restart loss becomes a real problem.
 */

import { getLog } from "../logging.ts";

const log = getLog("hivemind", "correlation");

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

interface PendingCorrelation {
  threadId: string;
  expiresAt: number;
}

const pending = new Map<string, PendingCorrelation>();

function makeKey(botName: string, peerId: string): string {
  return `${botName}\x00${peerId}`;
}

/**
 * Record that outbound traffic from `threadId` (on `botName`) has gone to
 * `peerId`. Inbound replies from that peer will route back into this thread
 * until the TTL expires or another thread overwrites the mapping.
 */
export function setPendingPeer(
  botName: string,
  peerId: string,
  threadId: string,
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  pending.set(makeKey(botName, peerId), {
    threadId,
    expiresAt: Date.now() + ttlMs,
  });
  log.debug("Recorded peer correlation {bot}/{peer} → thread {thread}", {
    botName, bot: botName, peer: peerId, thread: threadId,
  });
}

/**
 * Look up the originating thread for an inbound message from `peerId` to
 * `botName`. Returns null if no entry exists or it has expired. Does NOT
 * consume the entry — follow-up replies from the same peer still route to
 * the originating thread until the TTL elapses.
 */
export function getPendingPeer(botName: string, peerId: string): string | null {
  const key = makeKey(botName, peerId);
  const entry = pending.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    pending.delete(key);
    return null;
  }
  return entry.threadId;
}

/** Drop a specific correlation entry. */
export function clearPendingPeer(botName: string, peerId: string): void {
  pending.delete(makeKey(botName, peerId));
}

/** Test-only — reset all correlations between tests. */
export function _resetPendingPeersForTests(): void {
  pending.clear();
}
