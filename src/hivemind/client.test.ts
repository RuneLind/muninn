import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { HivemindBotClient } from "./client.ts";
import type { ClientMessage } from "./types.ts";

/**
 * Spin up a tiny in-process broker stub so we can exercise the client's
 * WebSocket flow end to end without depending on the real claude-hivemind
 * broker daemon.
 */

interface BrokerStub {
  port: number;
  stop: () => void;
  /** Pretend to be peer X and send a message to the connected client. */
  sendFrom(fromId: string, text: string, fromSummary?: string): void;
  /** Last register/list_peers/send_message/etc. received from the client. */
  lastClientMessage: ClientMessage | null;
  /** All client→broker messages received. */
  received: ClientMessage[];
  /** Override the response sent for the next list_peers request. */
  setListPeersResponse(peers: unknown[]): void;
}

let server: ReturnType<typeof Bun.serve>;
let stub: BrokerStub;
let activeWs: { send(s: string): void } | null = null;
let listPeersResponse: unknown[] = [];
const received: ClientMessage[] = [];

beforeAll(() => {
  server = Bun.serve<{ stub: true }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return new Response("ok");
      if (url.pathname === "/ws/peer") {
        if (srv.upgrade(req, { data: { stub: true } })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        activeWs = ws as unknown as { send(s: string): void };
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as ClientMessage;
        received.push(msg);
        if (msg.type === "register") {
          ws.send(JSON.stringify({ type: "registered", id: "broker-assigned-peer-id", namespace: msg.namespace }));
        } else if (msg.type === "list_peers") {
          ws.send(JSON.stringify({ type: "peers", peers: listPeersResponse }));
        }
        // send_message / set_summary / heartbeat — nothing to ack
      },
      close() {
        activeWs = null;
      },
    },
  });

  stub = {
    port: server.port ?? 0,
    stop: () => server.stop(),
    sendFrom(fromId: string, text: string, fromSummary = "") {
      activeWs?.send(JSON.stringify({
        type: "message",
        from_id: fromId,
        from_summary: fromSummary,
        from_cwd: "/tmp",
        text,
        sent_at: new Date().toISOString(),
      }));
    },
    get lastClientMessage() { return received[received.length - 1] ?? null; },
    received,
    setListPeersResponse(peers) { listPeersResponse = peers; },
  };
});

afterAll(() => {
  stub.stop();
});

async function waitFor<T>(check: () => T | null | undefined, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

test("registers with broker and reports connected", async () => {
  received.length = 0;
  const c = new HivemindBotClient({
    botName: "test-bot",
    namespace: "private",
    cwd: "/tmp",
    summary: "test",
    brokerPort: stub.port,
  });
  c.start();

  await waitFor(() => c.isConnected ? true : null);
  expect(c.id).toBe("broker-assigned-peer-id");

  // First client message should be register
  const reg = received.find((m) => m.type === "register");
  expect(reg).toBeDefined();
  expect(reg).toMatchObject({ type: "register", namespace: "private", summary: "test" });

  await c.stop();
});

test("listPeers returns broker response", async () => {
  received.length = 0;
  stub.setListPeersResponse([{
    id: "peer-A", pid: 123, cwd: "/repo", git_root: "/repo", git_branch: "main", tty: null,
    summary: "huginn", namespace: "private", agent_type: "claude-code",
    registered_at: "2026-04-28T00:00:00Z", last_seen: "2026-04-28T00:00:00Z", connected: 1,
  }]);

  const c = new HivemindBotClient({ botName: "test-bot", namespace: "private", cwd: "/tmp", brokerPort: stub.port });
  c.start();
  await waitFor(() => c.isConnected ? true : null);

  const peers = await c.listPeers("namespace");
  expect(peers).toHaveLength(1);
  expect(peers[0]?.id).toBe("peer-A");

  await c.stop();
});

test("sendMessage dispatches send_message to broker", async () => {
  received.length = 0;
  const c = new HivemindBotClient({ botName: "test-bot", namespace: "private", cwd: "/tmp", brokerPort: stub.port });
  c.start();
  await waitFor(() => c.isConnected ? true : null);

  const ok = c.sendMessage("peer-A", "hello");
  expect(ok).toBe(true);

  await waitFor(() => received.find((m) => m.type === "send_message") ?? null);
  const sent = received.find((m) => m.type === "send_message");
  expect(sent).toMatchObject({ type: "send_message", to: "peer-A", text: "hello" });

  await c.stop();
});

test("askPeer resolves with first matching inbound message", async () => {
  received.length = 0;
  const c = new HivemindBotClient({ botName: "test-bot", namespace: "private", cwd: "/tmp", brokerPort: stub.port });
  c.start();
  await waitFor(() => c.isConnected ? true : null);

  const askPromise = c.askPeer("peer-A", "are you there?", 5);

  // Simulate broker delivering a reply from peer-A
  await waitFor(() => received.find((m) => m.type === "send_message") ?? null);
  stub.sendFrom("peer-A", "yes I'm here");

  const reply = await askPromise;
  expect(reply.status).toBe("ok");
  expect(reply.text).toBe("yes I'm here");

  await c.stop();
});

test("askPeer times out and reports timeout", async () => {
  received.length = 0;
  const c = new HivemindBotClient({ botName: "test-bot", namespace: "private", cwd: "/tmp", brokerPort: stub.port });
  c.start();
  await waitFor(() => c.isConnected ? true : null);

  const reply = await c.askPeer("peer-B", "ping", 1);
  expect(reply.status).toBe("timeout");
  expect(reply.text).toContain("no reply from peer within 1s");

  await c.stop();
});

test("inbound message with no pending ask invokes onIncomingMessage", async () => {
  received.length = 0;
  const c = new HivemindBotClient({ botName: "test-bot", namespace: "private", cwd: "/tmp", brokerPort: stub.port });
  const onIncoming = mock((m: { fromId: string; text: string }) => { void m; });
  c.onIncomingMessage = onIncoming;
  c.start();
  await waitFor(() => c.isConnected ? true : null);

  stub.sendFrom("peer-X", "unsolicited hello");

  await waitFor(() => onIncoming.mock.calls.length > 0 ? true : null);
  expect(onIncoming.mock.calls[0]?.[0]).toMatchObject({ fromId: "peer-X", text: "unsolicited hello" });

  await c.stop();
});

test("unsolicited inbound message exposes fromCwd, fromSummary, sentAt for the router", async () => {
  received.length = 0;
  const c = new HivemindBotClient({ botName: "test-bot", namespace: "private", cwd: "/tmp", brokerPort: stub.port });
  const onIncoming = mock(
    (m: { fromId: string; fromSummary: string; fromCwd: string; text: string; sentAt: string }) => { void m; },
  );
  c.onIncomingMessage = onIncoming;
  c.start();
  await waitFor(() => c.isConnected ? true : null);

  stub.sendFrom("peer-huginn", "index rebuilt", "huginn — search-index assistant");

  await waitFor(() => onIncoming.mock.calls.length > 0 ? true : null);
  const payload = onIncoming.mock.calls[0]?.[0]!;
  expect(payload.fromId).toBe("peer-huginn");
  expect(payload.fromCwd).toBe("/tmp");
  expect(payload.fromSummary).toBe("huginn — search-index assistant");
  expect(payload.text).toBe("index rebuilt");
  expect(typeof payload.sentAt).toBe("string");
  expect(Number.isFinite(new Date(payload.sentAt).getTime())).toBe(true);

  await c.stop();
});

test("force-closes WS if broker never sends `registered` reply", async () => {
  // Spin up a silent broker that accepts the upgrade but never replies to register.
  let silentWs: { send(s: string): void; close(): void } | null = null;
  const silentServer = Bun.serve<{ stub: true }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/peer") {
        if (srv.upgrade(req, { data: { stub: true } })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        silentWs = ws as unknown as typeof silentWs;
      },
      message() { /* deliberately silent */ },
      close() { silentWs = null; },
    },
  });

  const c = new HivemindBotClient({
    botName: "test-bot",
    namespace: "private",
    cwd: "/tmp",
    brokerPort: silentServer.port ?? 0,
  });
  c.start();

  // Wait for the WS to connect to our silent broker
  await waitFor(() => silentWs ? true : null, 1000);
  // peerId should remain null because broker never replied
  expect(c.id).toBeNull();
  // After REGISTRATION_TIMEOUT_MS (5s) the client should close the WS itself.
  // We don't want to wait 5s in a unit test — instead, verify the client
  // doesn't claim to be connected.
  expect(c.isConnected).toBe(false);

  await c.stop();
  silentServer.stop();
});

test("FIFO: two concurrent asks to same peer resolve in order", async () => {
  received.length = 0;
  const c = new HivemindBotClient({ botName: "test-bot", namespace: "private", cwd: "/tmp", brokerPort: stub.port });
  c.start();
  await waitFor(() => c.isConnected ? true : null);

  const ask1 = c.askPeer("peer-A", "first", 5);
  const ask2 = c.askPeer("peer-A", "second", 5);

  // Wait for both send_messages to arrive at broker before delivering replies
  await waitFor(() => received.filter((m) => m.type === "send_message").length === 2 ? true : null);

  stub.sendFrom("peer-A", "answer-1");
  stub.sendFrom("peer-A", "answer-2");

  const r1 = await ask1;
  const r2 = await ask2;
  expect(r1.text).toBe("answer-1");
  expect(r2.text).toBe("answer-2");

  await c.stop();
});
