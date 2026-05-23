/**
 * Subset of the claude-hivemind broker protocol that Muninn uses.
 *
 * Mirrored from `~/source/private/claude-hivemind/src/shared/types.ts`.
 * We only include what's needed to register, list peers, and exchange
 * messages — the full set (services, docker, dashboard) is broker-only.
 */

export type PeerId = string;
export type Namespace = string;
export type AgentType = "claude-code" | "opencode" | "copilot";

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  git_branch: string | null;
  tty: string | null;
  summary: string;
  namespace: Namespace;
  agent_type: AgentType;
  registered_at: string;
  last_seen: string;
  connected: number;
}

// --- WebSocket: Client → Broker ---

export type ClientMessage =
  | {
      type: "register";
      pid: number;
      cwd: string;
      git_root: string | null;
      git_branch: string | null;
      tty: string | null;
      summary: string;
      namespace: Namespace;
      agent_type?: AgentType;
    }
  | { type: "set_summary"; summary: string }
  | { type: "send_message"; to: PeerId; text: string; correlation_id?: string }
  | { type: "list_peers"; scope: "namespace" | "machine" }
  | { type: "heartbeat" };

// --- WebSocket: Broker → Client ---

export type BrokerMessage =
  | { type: "registered"; id: PeerId; namespace: Namespace }
  | {
      type: "message";
      from_id: PeerId;
      from_summary: string;
      from_cwd: string;
      text: string;
      sent_at: string;
      /** Opaque correlation token, echoed from the originator's outbound.
       *  Absent until the broker carries it (rollout: broker ships first). */
      correlation_id?: string;
      /** Broker row id — reserved for a future reply-by-id variant. */
      message_id?: number;
    }
  | { type: "peers"; peers: Peer[] }
  | { type: "error"; error: string }
  | { type: "peer_joined"; peer: Peer }
  | { type: "peer_left"; peer_id: PeerId }
  | { type: "peer_updated"; peer: Peer };
