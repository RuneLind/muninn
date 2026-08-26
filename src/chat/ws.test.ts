import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import type { ServerWebSocket } from "bun";
import { chatWebSocket, eventVisibleTo, wsDataFor, WS_CLOSE_EXPIRED, type ChatWsData } from "./ws.ts";
import { chatState, type ChatEvent, type ChatConversation } from "./state.ts";

/**
 * Acceptance 8's CHANNEL half: with B sending a turn, a socket owned by A
 * carries **zero** references to B — no message text, no `username`, no
 * conversation id.
 *
 * This is a `bun test` rather than an e2e spec for a reason worth stating.
 * `MUNINN_AUTH=local` pins exactly ONE identity per process, so a live server
 * cannot be made to produce B's turn: every loopback request on it is A. The
 * events B's turn publishes are `chatState` events, and driving them here is
 * what makes the assertion real rather than vacuous. The handshake half —
 * 401/403/101 against a real `Bun.serve` — is `src/auth/ws-upgrade.test.ts`, and
 * the snapshot half is asserted against a live server in `e2e/ws-scope.spec.ts`.
 */

const A = "user-a";
const B = "user-b";

/** A `ServerWebSocket` stand-in that records what was sent. Bun's own type is
 *  huge and none of it is exercised by `open`/`close` beyond `send`/`close`. */
function fakeSocket(data: Partial<ChatWsData> = {}) {
  const sent: string[] = [];
  const closes: { code: number; reason: string }[] = [];
  const ws = {
    data: {
      unsubscribe: null,
      userId: null,
      role: null,
      expiresAt: null,
      expiryTimer: null,
      ...data,
    } as ChatWsData,
    send(payload: string) {
      sent.push(payload);
      return payload.length;
    },
    close(code: number, reason: string) {
      closes.push({ code, reason });
    },
  };
  return { ws: ws as unknown as ServerWebSocket<ChatWsData>, sent, closes, raw: ws };
}

function conv(id: string, userId: string): ChatConversation {
  return { id, type: "web", botName: "bot", userId, username: `${userId}-name`, messages: [] };
}

const OWNERS: Record<string, string> = { "conv-a": A, "conv-b": B };
const ownerOf = (id: string) => OWNERS[id];

const MESSAGE_FROM_B: ChatEvent = {
  type: "message",
  conversationId: "conv-b",
  message: { id: "m1", timestamp: 0, sender: "user", text: "B's private text" },
};

describe("wsDataFor — the upgrade → socket wiring", () => {
  // The three-field literal this replaced typechecked with `userId: null`, which
  // upgrades fine and delivers an UNFILTERED socket. `e2e/ws-scope.spec.ts` pins
  // that `src/index.ts` calls the authorizer; this pins what it does with the
  // answer.
  test("a resolved identity becomes the socket's viewer, role and expiry", () => {
    expect(wsDataFor({
      identity: { userId: "user-a", expiresAt: 1234 },
      role: "user",
    })).toEqual({ unsubscribe: null, userId: "user-a", role: "user", expiresAt: 1234, expiryTimer: null });
  });

  test("auth off carries no viewer and no cap", () => {
    expect(wsDataFor({ identity: null, role: null })).toEqual({
      unsubscribe: null, userId: null, role: null, expiresAt: null, expiryTimer: null,
    });
  });

  test("a credential with no expiry — the raw shared secret — caps nothing", () => {
    expect(wsDataFor({ identity: { userId: "user-a", expiresAt: null }, role: "user" }).expiresAt)
      .toBeNull();
  });
});

describe("eventVisibleTo", () => {
  test("auth off hears everything — off is off", () => {
    expect(eventVisibleTo(MESSAGE_FROM_B, null, null, ownerOf)).toBe(true);
  });

  test("A does not hear an event addressed to B's conversation", () => {
    expect(eventVisibleTo(MESSAGE_FROM_B, A, "user", ownerOf)).toBe(false);
  });

  test("A hears an event addressed to A's own conversation", () => {
    expect(eventVisibleTo({ ...MESSAGE_FROM_B, conversationId: "conv-a" }, A, "user", ownerOf)).toBe(true);
  });

  test("admin hears everything — the dashboard consumes this socket too", () => {
    expect(eventVisibleTo(MESSAGE_FROM_B, "operator", "admin", ownerOf)).toBe(true);
  });

  test("an event for an unknown conversation is DROPPED, not delivered", () => {
    // Fail closed. Unreachable in practice since PR A stopped evicting shells,
    // which is exactly why it needs a test rather than a comment.
    expect(eventVisibleTo({ ...MESSAGE_FROM_B, conversationId: "gone" }, A, "user", ownerOf)).toBe(false);
  });

  test("mcp_status is delivered to everyone — it carries no conversationId and no user data", () => {
    // §6 names this explicitly: it is the one unaddressed event the page
    // consumes, and silently dropping it blanks the inspector's MCP panel — the
    // "passes every security test while breaking the product" failure.
    const event: ChatEvent = { type: "mcp_status", botName: "bot", servers: [] };
    expect(eventVisibleTo(event, A, "user", ownerOf)).toBe(true);
  });

  test("conversation_created is judged from its PAYLOAD, not by id lookup", () => {
    // It is the one event that can arrive before the shell is readable by id
    // from another async context — and it carries the whole conversation, so
    // the owner is right there.
    const mine: ChatEvent = { type: "conversation_created", conversation: conv("fresh-a", A) };
    const theirs: ChatEvent = { type: "conversation_created", conversation: conv("fresh-b", B) };
    expect(eventVisibleTo(mine, A, "user", ownerOf)).toBe(true);
    expect(eventVisibleTo(theirs, A, "user", ownerOf)).toBe(false);
  });

  test("EVERY addressed event type is filtered, not just `message`", () => {
    // A filter written for one event type is how a leak survives: `text_delta`
    // carries the reply as it is generated, and `response_meta` carries the
    // model, the cost and the message id.
    const addressed: ChatEvent[] = [
      { type: "status", conversationId: "conv-b", status: "thinking" },
      { type: "text_delta", conversationId: "conv-b", delta: "B's answer" },
      { type: "stream_clear", conversationId: "conv-b" },
      { type: "intent", conversationId: "conv-b", text: "…" },
      { type: "tool_status", conversationId: "conv-b", text: "…" },
      { type: "tool_end", conversationId: "conv-b", name: "x", displayName: "X" },
      { type: "usage_progress", conversationId: "conv-b", inputTokens: 1, outputTokens: 1 },
      {
        type: "response_meta", conversationId: "conv-b", inputTokens: 1, outputTokens: 1,
        durationMs: 1, costUsd: 0, model: "m", numTurns: 1,
      },
    ];
    for (const event of addressed) {
      expect(eventVisibleTo(event, A, "user", ownerOf), `${event.type} leaked to A`).toBe(false);
    }
  });
});

describe("the open handler", () => {
  // These need the real `chatState`, since `open` reads the singleton. Files run
  // to completion sequentially in one `bun test` process, so clearing here
  // cannot strand another file's setup.
  beforeEach(() => chatState.clear());
  afterAll(() => chatState.clear());

  function seed() {
    chatState.findOrCreateChannel("bot", "#a", A, "A");
    const mine = chatState.createConversation({ type: "web", botName: "bot", userId: A, username: "A" });
    const theirs = chatState.createConversation({ type: "web", botName: "bot", userId: B, username: "B" });
    return { mine, theirs };
  }

  function snapshotOf(sent: string[]): { id: string; userId: string }[] {
    const frame = sent.map((s) => JSON.parse(s)).find((f) => f.type === "snapshot");
    return frame?.conversations ?? [];
  }

  test("the snapshot carries only the viewer's conversations", () => {
    // The largest single disclosure on this socket: `id`, `userId` and
    // `username` for every conversation in memory. Filtering the live fan-out
    // while shipping an unfiltered snapshot would close nothing.
    seed();
    const { ws, sent } = fakeSocket({ userId: A, role: "user" });
    chatWebSocket.open(ws);
    const rows = snapshotOf(sent);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.userId === A)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(B);
    chatWebSocket.close(ws);
  });

  test("with auth off the snapshot is unfiltered, exactly as today", () => {
    seed();
    const { ws, sent } = fakeSocket({ userId: null, role: null });
    chatWebSocket.open(ws);
    expect(snapshotOf(sent)).toHaveLength(chatState.getConversations().length);
    chatWebSocket.close(ws);
  });

  test("an admin socket sees every conversation", () => {
    seed();
    const { ws, sent } = fakeSocket({ userId: "operator", role: "admin" });
    chatWebSocket.open(ws);
    expect(snapshotOf(sent)).toHaveLength(chatState.getConversations().length);
    chatWebSocket.close(ws);
  });

  test("a live turn in B's conversation reaches ZERO frames on A's socket", () => {
    // Acceptance 8, end to end through the real subscribe path.
    const { theirs } = seed();
    const { ws, sent } = fakeSocket({ userId: A, role: "user" });
    chatWebSocket.open(ws);
    const before = sent.length;

    chatState.addMessage(theirs.id, { id: "m", timestamp: 1, sender: "user", text: "B's private text" });
    chatState.setStatus(theirs.id, "thinking");

    expect(sent.slice(before)).toEqual([]);
    chatWebSocket.close(ws);
  });

  test("A's own turn still reaches A's socket", () => {
    // The other half, and the one that catches a filter that simply drops
    // everything — which would pass every cross-user assertion above.
    const { mine } = seed();
    const { ws, sent } = fakeSocket({ userId: A, role: "user" });
    chatWebSocket.open(ws);
    const before = sent.length;

    chatState.addMessage(mine.id, { id: "m", timestamp: 1, sender: "user", text: "A's text" });

    expect(sent.slice(before).length).toBeGreaterThan(0);
    expect(sent.slice(before).join("")).toContain("A's text");
    chatWebSocket.close(ws);
  });

  test("close unsubscribes, so a closed socket hears nothing more", () => {
    const { mine } = seed();
    const { ws, sent } = fakeSocket({ userId: A, role: "user" });
    chatWebSocket.open(ws);
    chatWebSocket.close(ws);
    const before = sent.length;
    chatState.addMessage(mine.id, { id: "m", timestamp: 1, sender: "user", text: "after close" });
    expect(sent.slice(before)).toEqual([]);
  });
});

describe("socket lifetime", () => {
  beforeEach(() => chatState.clear());
  afterAll(() => chatState.clear());

  test("an already-expired credential closes the socket immediately", () => {
    // The upgrade authenticates ONCE, so without a cap a disabled account keeps
    // receiving live events until the tab closes.
    const { ws, closes } = fakeSocket({ userId: A, role: "user", expiresAt: Date.now() - 1 });
    chatWebSocket.open(ws);
    expect(closes).toEqual([{ code: WS_CLOSE_EXPIRED, reason: "session expired" }]);
  });

  test("a credential that expires later arms a timer, and close clears it", async () => {
    const { ws, closes, raw } = fakeSocket({ userId: A, role: "user", expiresAt: Date.now() + 40 });
    chatWebSocket.open(ws);
    expect(closes).toEqual([]);
    expect(raw.data.expiryTimer).not.toBeNull();
    await Bun.sleep(80);
    expect(closes).toEqual([{ code: WS_CLOSE_EXPIRED, reason: "session expired" }]);
    chatWebSocket.close(ws);
    expect(raw.data.expiryTimer).toBeNull();
  });

  test("an expiry beyond the 32-bit timer range does NOT fire immediately", async () => {
    // `setTimeout` clamps a delay over 2**31-1 ms to 1 — with a
    // TimeoutOverflowWarning on stderr — so a far-future `expiresAt` (a token
    // whose `exp` is years out, or a clock skew) closed the socket at once with
    // 4401, which the client reads as "your session expired" and reloads. The
    // loop that produces is a reload per socket, immediately, forever.
    const { ws, closes, raw } = fakeSocket({
      userId: A,
      role: "user",
      expiresAt: Date.now() + 2 ** 31 + 60_000,
    });
    chatWebSocket.open(ws);
    await Bun.sleep(30);
    expect(closes).toEqual([]);
    expect(raw.data.expiryTimer).not.toBeNull();
    chatWebSocket.close(ws);
  });

  test("a NULL expiry — the raw shared secret, and auth off — arms nothing", () => {
    const { ws, raw } = fakeSocket({ userId: A, role: "user", expiresAt: null });
    chatWebSocket.open(ws);
    expect(raw.data.expiryTimer).toBeNull();
    chatWebSocket.close(ws);
  });

  test("close on a socket whose timer never armed does not throw", () => {
    const { ws } = fakeSocket({ userId: null, role: null });
    chatWebSocket.open(ws);
    expect(() => chatWebSocket.close(ws)).not.toThrow();
  });
});
