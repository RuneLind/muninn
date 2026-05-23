/**
 * Precise peer-reply correlation via opaque minted tokens.
 *
 * An *initiating* outbound (`ask_peer` / `send_to_peer` / chat `>`) mints a
 * fresh random `correlation_id`, puts it on the wire, and stores
 * `token → originating thread` here. When the peer's reply echoes the token,
 * `router.ts` resolves it back to the exact thread — so two concurrent outbounds
 * to the same peer no longer collide the way the `(bot, peer)` table
 * (`correlation.ts`) does under last-write-wins.
 *
 * This is the primary, precise path. `peer_thread_correlation` stays as the
 * `(bot, peer)` fallback for replies that arrive without a token (raw peers that
 * didn't echo, or messages that predate the broker carrying `correlation_id`).
 *
 * Unlike the fallback table (one row per peer, updated in place), this grows
 * **one row per outbound**, so `setCorrelationToken` opportunistically sweeps
 * expired rows on each write — cheap with the `expires_at` index, and avoids a
 * standalone background job. TTL matches `PEER_CORRELATION_TTL_MS` so a token
 * never expires before its `(bot, peer)` fallback; an expired token simply
 * misses the lookup and the router falls back cleanly.
 *
 * DB errors degrade gracefully: a failed write means the reply falls back to the
 * `(bot, peer)` path (or the default `peer:<ns>/<name>` thread), same as a miss.
 */

import { getLog } from "../logging.ts";
import { getDb } from "../db/client.ts";
import { PEER_CORRELATION_TTL_MS } from "./config.ts";

const log = getLog("hivemind", "correlation-tokens");

/** Mint a fresh opaque correlation token. Random + unguessable so it stays
 *  meaningless to the broker and to peers — never derive it from a threadId. */
export function mintCorrelationToken(): string {
  return crypto.randomUUID();
}

/**
 * Record that outbound traffic carrying `correlationId` (on `botName`)
 * originated in `threadId`. The peer's echoed reply routes back into this
 * thread until the TTL expires. Sweeps expired rows on the way in.
 */
export async function setCorrelationToken(
  botName: string,
  correlationId: string,
  threadId: string,
  ttlMs: number = PEER_CORRELATION_TTL_MS,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs);
  try {
    const sql = getDb();
    // Opportunistic sweep — keeps the one-row-per-outbound table bounded
    // without a background job. Indexed on expires_at, so it's cheap.
    await sql`DELETE FROM peer_correlation_tokens WHERE expires_at < now()`;
    await sql`
      INSERT INTO peer_correlation_tokens (bot_name, correlation_id, thread_id, expires_at)
      VALUES (${botName}, ${correlationId}, ${threadId}, ${expiresAt})
      ON CONFLICT (bot_name, correlation_id)
      DO UPDATE SET thread_id = EXCLUDED.thread_id, expires_at = EXCLUDED.expires_at
    `;
    log.debug("Recorded correlation token {bot}/{cid} → thread {thread}", {
      botName, bot: botName, cid: correlationId, thread: threadId,
    });
  } catch (err) {
    log.warn("Failed to persist correlation token {bot}/{cid}: {error}", {
      botName, bot: botName, cid: correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Resolve the originating thread for an echoed `correlationId` on `botName`.
 * Returns null if no live (unexpired) token matches. Does NOT consume the row —
 * a peer may send several follow-ups echoing the same token, all of which should
 * land in the originating thread until the TTL elapses.
 */
export async function getThreadByCorrelationToken(
  botName: string,
  correlationId: string,
): Promise<string | null> {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT thread_id
      FROM peer_correlation_tokens
      WHERE bot_name = ${botName} AND correlation_id = ${correlationId} AND expires_at > now()
    `;
    return rows.length > 0 ? (rows[0]!.thread_id as string) : null;
  } catch (err) {
    log.warn("Failed to read correlation token {bot}/{cid}: {error}", {
      botName, bot: botName, cid: correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Drop a token (e.g. its thread was deleted or belongs to another bot). */
export async function clearCorrelationToken(botName: string, correlationId: string): Promise<void> {
  try {
    const sql = getDb();
    await sql`DELETE FROM peer_correlation_tokens WHERE bot_name = ${botName} AND correlation_id = ${correlationId}`;
  } catch (err) {
    log.warn("Failed to clear correlation token {bot}/{cid}: {error}", {
      botName, bot: botName, cid: correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
