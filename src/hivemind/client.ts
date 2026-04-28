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

/** A pending ask_peer call waiting for a reply from a specific peer. */
interface PendingAsk {
  fromId: PeerId;
  resolve: (reply: { text: string; sentAt: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One Muninn bot ↔ one hivemind peer (WebSocket connection).
 *
 * Phase 1 = single namespace per bot. The constructor takes one namespace;
 * multi-namespace support arrives in Phase 4 by instantiating one client per
 * namespace and routing tool calls based on the target peer's namespace.
 *
 * Connection lifecycle:
 *  1. `start()` opens the WebSocket and sends `register`.
 *  2. On `registered` → set summary, mark ready.
 *  3. On disconnect → exponential backoff reconnect.
 *  4. Inbound `message` → either resolve a pending ask_peer or dispatch to onIncoming.
 *  5. Inbound `peers` → resolve a pending list_peers request.
 */
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
  private stopped = false;

  /** FIFO queue of pending ask_peer calls per fromId. First message resolves first ask. */
  private pendingAsks = new Map<PeerId, PendingAsk[]>();
  /** Pending list_peers promise. Only one concurrent at a time. */
  private pendingListPeers: { resolve: (peers: Peer[]) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  /** Optional callback for inbound messages with no pending ask. Phase 2 wires this to thread injection. */
  onIncomingMessage: ((msg: { fromId: PeerId; fromSummary: string; fromCwd: string; text: string; sentAt: string }) => void) | null = null;

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

  /** Start the connection. Idempotent. */
  start(): void {
    if (this.ws) return;
    this.stopped = false;
    this.connect();
  }

  /** Stop the connection. Drops pending requests. */
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
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.peerId = null;
    // Reject all pending asks
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

  /** Fire-and-forget message to a peer. Returns true if the WS write succeeded. */
  sendMessage(toPeerId: PeerId, text: string): boolean {
    return this.send({ type: "send_message", to: toPeerId, text });
  }

  /**
   * Send a message and wait up to `timeoutSec` for a reply from the same peer.
   * Resolves with the first inbound message from `toPeerId` after this call.
   *
   * If multiple ask_peer calls target the same peer, replies match in FIFO order.
   */
  askPeer(toPeerId: PeerId, text: string, timeoutSec: number): Promise<{ text: string; sentAt: string; timedOut: boolean }> {
    if (!this.isConnected) {
      return Promise.resolve({ text: "not connected to broker — message not sent", sentAt: new Date().toISOString(), timedOut: false });
    }

    return new Promise((resolve) => {
      const ask: PendingAsk = {
        fromId: toPeerId,
        resolve: (reply) => resolve({ text: reply.text, sentAt: reply.sentAt, timedOut: false }),
        timer: setTimeout(() => {
          this.dequeueAsk(toPeerId, ask);
          resolve({ text: `no reply from peer within ${timeoutSec}s — try send_to_peer for fire-and-forget`, sentAt: new Date().toISOString(), timedOut: true });
        }, timeoutSec * 1000),
      };

      const queue = this.pendingAsks.get(toPeerId) ?? [];
      queue.push(ask);
      this.pendingAsks.set(toPeerId, queue);

      const sent = this.send({ type: "send_message", to: toPeerId, text });
      if (!sent) {
        clearTimeout(ask.timer);
        this.dequeueAsk(toPeerId, ask);
        resolve({ text: "WebSocket write failed — message not sent", sentAt: new Date().toISOString(), timedOut: false });
      }
    });
  }

  /** Request the peer list scoped to namespace or machine. */
  listPeers(scope: "namespace" | "machine"): Promise<Peer[]> {
    if (!this.isConnected) {
      return Promise.reject(new Error("not connected to broker"));
    }
    if (this.pendingListPeers) {
      return Promise.reject(new Error("a list_peers request is already in flight"));
    }
    return new Promise((resolve, reject) => {
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
    });
  }

  // ── internals ────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;

    const url = `ws://127.0.0.1:${this.brokerPort}/ws/peer?namespace=${encodeURIComponent(this.namespace)}`;
    log.info("Connecting bot {botName} to broker {url}", { botName: this.botName, url });

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      log.warn("Bot {botName}: WebSocket constructor failed: {error}", { botName: this.botName, error: e instanceof Error ? e.message : String(e) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      log.info("Bot {botName}: WS connected, sending register", { botName: this.botName });
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
            "Bot {botName}: no `registered` reply within {ms}ms — closing WS to force reconnect",
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
        log.warn("Bot {botName}: invalid broker message: {error}", { botName: this.botName, error: String(e) });
      }
    });

    ws.addEventListener("close", () => {
      log.info("Bot {botName}: WS closed", { botName: this.botName });
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
    log.info("Bot {botName}: reconnecting in {delay}ms (attempt {n})", { botName: this.botName, delay, n: this.reconnectAttempts });
    setTimeout(() => this.connect(), delay);
  }

  private handleBrokerMessage(msg: BrokerMessage): void {
    switch (msg.type) {
      case "registered":
        this.peerId = msg.id;
        log.info("Bot {botName}: registered as peer {peerId} in namespace {ns}", { botName: this.botName, peerId: msg.id, ns: msg.namespace });
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
        log.warn("Bot {botName}: broker error: {error}", { botName: this.botName, error: msg.error });
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
      const ask = queue.shift()!;
      if (queue.length === 0) this.pendingAsks.delete(msg.from_id);
      clearTimeout(ask.timer);
      ask.resolve({ text: msg.text, sentAt: msg.sent_at });
      log.info("Bot {botName}: resolved pending ask_peer from {fromId}", { botName: this.botName, fromId: msg.from_id });
      return;
    }
    log.info("Bot {botName}: inbound message from {fromId} (no pending ask)", { botName: this.botName, fromId: msg.from_id });
    this.onIncomingMessage?.({
      fromId: msg.from_id,
      fromSummary: msg.from_summary,
      fromCwd: msg.from_cwd,
      text: msg.text,
      sentAt: msg.sent_at,
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
      log.warn("Bot {botName}: send failed: {error}", { botName: this.botName, error: String(e) });
      return false;
    }
  }
}
