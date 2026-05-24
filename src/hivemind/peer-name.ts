import { basename } from "node:path";

/**
 * Stable peer name across reconnects — the broker's `from_id` UUID rotates per
 * session, but the cwd basename does not.
 *
 * Single source of truth shared by both sides of the dev-run handoff join: the
 * inbound router names peer threads (and matches the autorespond allowlist) with
 * this, and `delegate_task` stamps the same value onto the `dev_run_handoff`
 * row. Phase 4 joins a peer reply to its handoff on `(run_id, peer_name)`, so
 * both sides MUST derive the name identically — keep this the only implementation.
 */
export function peerNameFor(msg: { fromCwd: string; fromSummary: string; fromId: string }): string {
  const cwdBase = basename(msg.fromCwd).trim();
  if (cwdBase) return cwdBase;
  const summarySlug = msg.fromSummary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (summarySlug) return summarySlug;
  return `peer-${msg.fromId.slice(0, 8)}`;
}
