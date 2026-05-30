import { getLog } from "../logging.ts";
import type {
  BrokerMessage,
  ClientMessage,
  Namespace,
  Peer,
  PeerId,
} from "./types.ts";

const log = getLog("hivemind", "client");

const DEFAULT_BROKER_PORT = 7899;
const MAX_RECONNECT_DELAY_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const LIST_PEERS_TIMEOUT_MS = 5_000;
/**
 * Max time to wait for the broker's `registered` reply after WS open.
 * If we don't hear back, force a reconnect — the WS is effectively dead.
 * Observed in practice when Bun's --watch hot-reload races with the broker's
 * cleanup of the previous WS.
 */
const REGISTRATION_TIMEOUT_MS = 5_000;

interface PendingAsk {
  fromId: PeerId;
  /** Opaque token minted for this ask, if any. A reply that echoes it resolves
   *  this exact ask — disambiguating concurrent ask_peer calls to one peer. */
  correlationId?: string;
  resolve: (reply: { text: string; sentAt: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type AskPeerResult =
  | { status: "ok"; text: string; sentAt: string }
  | { status: "timeout"; text: string; sentAt: string }
  | { status: "not_connected"; text: string; sentAt: string }
  | { status: "send_failed"; text: string; sentAt: string };

export class HivemindBotClient {
  readonly botName: string;
  readonly namespace: Namespace;
  readonly cwd: string;
  private summary: string;
  private ws: WebSocket | null = null;
  private peerId: PeerId | null = null;
  private brokerPort: number;
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private registrationTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  // FIFO queue per fromId: the first inbound message from peer X resolves the
  // oldest pending ask_peer(X) call. Hivemind has no correlation IDs.
  private pendingAsks = new Map<PeerId, PendingAsk[]>();
  private pendingListPeers: { resolve: (peers: Peer[]) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  // Concurrent list_peers calls (e.g. delegate_task warming the cwd cache while a
  // separate flow lists peers) are COALESCED per scope onto one in-flight request
  // — the broker's `peers` reply isn't scope-tagged and there's a single response
  // slot, so a second caller shares the first's promise instead of being rejected
  // ("a list_peers request is already in flight") or clobbering the slot.
  private inFlightListPeers = new Map<"namespace" | "machine", Promise<Peer[]>>();

  /**
   * Inbound peer message that didn't match a pending ask_peer call. The
   * `namespace` is filled in from the client's own registration so the router
   * can scope the thread name and pick the right outbound WS.
   */
  onIncomingMessage:
    | ((msg: {
        fromId: PeerId;
        fromSummary: string;
        fromCwd: string;
        text: string;
        sentAt: string;
        namespace: Namespace;
        /** Opaque token the reply echoed, if any — the router resolves it
         *  against the minted-token store to find the originating thread. */
        correlationId?: string;
      }) => void)
    | null = null;

  constructor(opts: {
    botName: string;
    namespace: Namespace;
    cwd: string;
    summary?: string;
    brokerPort?: number;
  }) {
    this.botName = opts.botName;
    this.namespace = opts.namespace;
    this.cwd = opts.cwd;
    this.summary = opts.summary ?? `${opts.botName} (Muninn)`;
    this.brokerPort = opts.brokerPort ?? DEFAULT_BROKER_PORT;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.peerId !== null;
  }

  get id(): PeerId | null {
    return this.peerId;
  }

  start(): void {
    if (this.ws) return;
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.registrationTimer) {
      clearTimeout(this.registrationTimer);
      this.registrationTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.peerId = null;
    for (const queue of this.pendingAsks.values()) {
      for (const ask of queue) {
        clearTimeout(ask.timer);
        ask.resolve({ text: "client stopped before reply arrived", sentAt: new Date().toISOString() });
      }
    }
    this.pendingAsks.clear();
    if (this.pendingListPeers) {
      clearTimeout(this.pendingListPeers.timer);
      this.pendingListPeers.reject(new Error("client stopped"));
      this.pendingListPeers = null;
    }
  }

  /** Update the peer's summary visible to other peers. */
  setSummary(summary: string): boolean {
    this.summary = summary;
    return this.send({ type: "set_summary", summary });
  }

  /** Fire-and-forget message to a peer. Returns true if the WS write succeeded.
   *  `correlationId`, when present, is either the token muninn minted for the
   *  originating thread (initiating outbound) or the inbound token being echoed
   *  back verbatim (reply outbound) — see correlation-tokens.ts / router.ts. */
  sendMessage(toPeerId: PeerId, text: string, correlationId?: string): boolean {
    return this.send({ type: "send_message", to: toPeerId, text, correlation_id: correlationId });
  }

  /**
   * Send a message and wait up to `timeoutSec` for a reply from the same peer.
   * Resolves with the first inbound message from `toPeerId` after this call.
   *
   * If multiple ask_peer calls target the same peer, replies match in FIFO order.
   */
  askPeer(toPeerId: PeerId, text: string, timeoutSec: number, correlationId?: string): Promise<AskPeerResult> {
    if (!this.isConnected) {
      return Promise.resolve({ status: "not_connected", text: "not connected to broker — message not sent", sentAt: new Date().toISOString() });
    }

    return new Promise((resolve) => {
      const ask: PendingAsk = {
        fromId: toPeerId,
        correlationId,
        resolve: (reply) => resolve({ status: "ok", text: reply.text, sentAt: reply.sentAt }),
        timer: setTimeout(() => {
          this.dequeueAsk(toPeerId, ask);
          resolve({ status: "timeout", text: `no reply from peer within ${timeoutSec}s — try send_to_peer for fire-and-forget`, sentAt: new Date().toISOString() });
        }, timeoutSec * 1000),
      };

      const queue = this.pendingAsks.get(toPeerId) ?? [];
      queue.push(ask);
      this.pendingAsks.set(toPeerId, queue);

      const sent = this.send({ type: "send_message", to: toPeerId, text, correlation_id: correlationId });
      if (!sent) {
        clearTimeout(ask.timer);
        this.dequeueAsk(toPeerId, ask);
        resolve({ status: "send_failed", text: "WebSocket write failed — message not sent", sentAt: new Date().toISOString() });
      }
    });
  }

  /** Request the peer list scoped to namespace or machine. Concurrent calls for
   *  the same scope share one in-flight request (coalesced) rather than being
   *  rejected — see `inFlightListPeers`. */
  listPeers(scope: "namespace" | "machine"): Promise<Peer[]> {
    if (!this.isConnected) {
      return Promise.reject(new Error("not connected to broker"));
    }
    const existing = this.inFlightListPeers.get(scope);
    if (existing) return existing;
    // The broker has a single (untagged) response slot, so a different-scope
    // request already in flight can't be coalesced — keep the original reject so
    // its slot isn't clobbered. Same-scope concurrency is the case worth sharing.
    if (this.pendingListPeers) {
      return Promise.reject(new Error("a list_peers request is already in flight"));
    }

    const p = new Promise<Peer[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingListPeers = null;
        reject(new Error("list_peers timed out"));
      }, LIST_PEERS_TIMEOUT_MS);
      this.pendingListPeers = { resolve, reject, timer };
      const sent = this.send({ type: "list_peers", scope });
      if (!sent) {
        clearTimeout(timer);
        this.pendingListPeers = null;
        reject(new Error("WebSocket write failed"));
      }
    }).finally(() => {
      this.inFlightListPeers.delete(scope);
    });
    this.inFlightListPeers.set(scope, p);
    return p;
  }

  // ── internals ────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;

    const url = `ws://127.0.0.1:${this.brokerPort}/ws/peer?namespace=${encodeURIComponent(this.namespace)}`;
    log.info("Connecting to broker {url}", { botName: this.botName, url });

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      log.warn("WebSocket constructor failed: {error}", { botName: this.botName, error: e instanceof Error ? e.message : String(e) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      log.info("WS connected, sending register", { botName: this.botName });
      this.reconnectAttempts = 0;
      const reg: ClientMessage = {
        type: "register",
        pid: process.pid,
        cwd: this.cwd,
        git_root: null,
        git_branch: null,
        tty: null,
        summary: this.summary,
        namespace: this.namespace,
        agent_type: "claude-code",
      };
      ws.send(JSON.stringify(reg));
      // Defensive: if the broker never replies with `registered`, the WS is
      // effectively dead — force-close so the reconnect logic kicks in.
      this.registrationTimer = setTimeout(() => {
        if (this.peerId === null && this.ws === ws) {
          log.warn(
            "No `registered` reply within {ms}ms — closing WS to force reconnect",
            { botName: this.botName, ms: REGISTRATION_TIMEOUT_MS },
          );
          ws.close();
        }
      }, REGISTRATION_TIMEOUT_MS);
    });

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as BrokerMessage;
        this.handleBrokerMessage(msg);
      } catch (e) {
        log.warn("Invalid broker message: {error}", { botName: this.botName, error: String(e) });
      }
    });

    ws.addEventListener("close", () => {
      log.info("WS closed", { botName: this.botName });
      this.peerId = null;
      this.ws = null;
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.registrationTimer) {
        clearTimeout(this.registrationTimer);
        this.registrationTimer = null;
      }
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // 'close' will fire next; reconnect logic lives there.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempts++;
    log.info("Reconnecting in {delay}ms (attempt {n})", { botName: this.botName, delay, n: this.reconnectAttempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleBrokerMessage(msg: BrokerMessage): void {
    switch (msg.type) {
      case "registered":
        this.peerId = msg.id;
        log.info("Registered as peer {peerId} in namespace {ns}", { botName: this.botName, peerId: msg.id, ns: msg.namespace });
        if (this.registrationTimer) {
          clearTimeout(this.registrationTimer);
          this.registrationTimer = null;
        }
        // Push initial summary now that we have a peer ID
        this.send({ type: "set_summary", summary: this.summary });
        // Heartbeat keeps the broker from marking us dead
        this.heartbeatTimer = setInterval(() => {
          this.send({ type: "heartbeat" });
        }, HEARTBEAT_INTERVAL_MS);
        break;

      case "message":
        this.dispatchInboundMessage(msg);
        break;

      case "peers":
        if (this.pendingListPeers) {
          clearTimeout(this.pendingListPeers.timer);
          this.pendingListPeers.resolve(msg.peers);
          this.pendingListPeers = null;
        }
        break;

      case "error":
        log.warn("Broker error: {error}", { botName: this.botName, error: msg.error });
        if (this.pendingListPeers) {
          clearTimeout(this.pendingListPeers.timer);
          this.pendingListPeers.reject(new Error(msg.error));
          this.pendingListPeers = null;
        }
        break;

      case "peer_joined":
      case "peer_left":
      case "peer_updated":
        // Phase 1 ignores these — they're for dashboard liveness only.
        break;
    }
  }

  private dispatchInboundMessage(msg: Extract<BrokerMessage, { type: "message" }>): void {
    const queue = this.pendingAsks.get(msg.from_id);
    if (queue && queue.length > 0) {
      // Prefer the pending ask whose minted token this reply echoes; that
      // disambiguates concurrent ask_peer calls to the same peer (pitfall #5).
      // With no token (raw peer, or pre-broker-rollout) fall back to FIFO —
      // oldest ask, same as before. A token-bearing reply that matches no
      // pending ask is an unsolicited/late reply: fall through to the router so
      // it can route by token instead of wrongly consuming an unrelated ask.
      let idx = -1;
      if (msg.correlation_id) {
        idx = queue.findIndex((a) => a.correlationId === msg.correlation_id);
      } else {
        idx = 0;
      }
      if (idx >= 0) {
        const ask = queue[idx]!;
        queue.splice(idx, 1);
        if (queue.length === 0) this.pendingAsks.delete(msg.from_id);
        clearTimeout(ask.timer);
        ask.resolve({ text: msg.text, sentAt: msg.sent_at });
        log.debug("Resolved pending ask_peer from {fromId}", { botName: this.botName, fromId: msg.from_id });
        return;
      }
    }
    log.debug("Inbound message from {fromId} (no pending ask)", { botName: this.botName, fromId: msg.from_id });
    this.onIncomingMessage?.({
      fromId: msg.from_id,
      fromSummary: msg.from_summary,
      fromCwd: msg.from_cwd,
      text: msg.text,
      sentAt: msg.sent_at,
      namespace: this.namespace,
      correlationId: msg.correlation_id,
    });
  }

  private dequeueAsk(fromId: PeerId, ask: PendingAsk): void {
    const queue = this.pendingAsks.get(fromId);
    if (!queue) return;
    const idx = queue.indexOf(ask);
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) this.pendingAsks.delete(fromId);
  }

  private send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      log.warn("Send failed: {error}", { botName: this.botName, error: String(e) });
      return false;
    }
  }
}
