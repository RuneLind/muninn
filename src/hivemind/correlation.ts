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
 * Persisted in the `peer_thread_correlation` table so it survives muninn
 * restarts (frequent under `--watch`) and peers that take longer than the TTL
 * to reply. DB errors degrade gracefully: a failed write just means the reply
 * falls back to the default `peer:<ns>/<name>` thread, same as a cache miss.
 */

import { getLog } from "../logging.ts";
import { getDb } from "../db/client.ts";
import { PEER_CORRELATION_TTL_MS } from "./config.ts";

const log = getLog("hivemind", "correlation");

/**
 * Record that outbound traffic from `threadId` (on `botName`) has gone to
 * `peerId`. Inbound replies from that peer will route back into this thread
 * until the TTL expires or another thread overwrites the mapping.
 */
export async function setPendingPeer(
  botName: string,
  peerId: string,
  threadId: string,
  ttlMs: number = PEER_CORRELATION_TTL_MS,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs);
  try {
    const sql = getDb();
    await sql`
      INSERT INTO peer_thread_correlation (bot_name, peer_id, thread_id, expires_at, updated_at)
      VALUES (${botName}, ${peerId}, ${threadId}, ${expiresAt}, now())
      ON CONFLICT (bot_name, peer_id)
      DO UPDATE SET thread_id = EXCLUDED.thread_id, expires_at = EXCLUDED.expires_at, updated_at = now()
    `;
    log.debug("Recorded peer correlation {bot}/{peer} → thread {thread}", {
      botName, bot: botName, peer: peerId, thread: threadId,
    });
  } catch (err) {
    log.warn("Failed to persist peer correlation {bot}/{peer}: {error}", {
      botName, bot: botName, peer: peerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Look up the originating thread for an inbound message from `peerId` to
 * `botName`. Returns null if no entry exists or it has expired. Does NOT
 * consume the entry — follow-up replies from the same peer still route to
 * the originating thread until the TTL elapses.
 */
export async function getPendingPeer(botName: string, peerId: string): Promise<string | null> {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT thread_id
      FROM peer_thread_correlation
      WHERE bot_name = ${botName} AND peer_id = ${peerId} AND expires_at > now()
    `;
    return rows.length > 0 ? (rows[0]!.thread_id as string) : null;
  } catch (err) {
    log.warn("Failed to read peer correlation {bot}/{peer}: {error}", {
      botName, bot: botName, peer: peerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Drop a specific correlation entry (e.g. its thread was deleted). */
export async function clearPendingPeer(botName: string, peerId: string): Promise<void> {
  try {
    const sql = getDb();
    await sql`DELETE FROM peer_thread_correlation WHERE bot_name = ${botName} AND peer_id = ${peerId}`;
  } catch (err) {
    log.warn("Failed to clear peer correlation {bot}/{peer}: {error}", {
      botName, bot: botName, peer: peerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
