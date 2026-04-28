import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { ChatState } from "../chat/state.ts";
import { setBotDefaultUser } from "../db/chat-preferences.ts";
import { getDb } from "../db/client.ts";
import { listThreads } from "../db/threads.ts";
import { HivemindRouter, peerNameFor, type InboundPeerMessage } from "./router.ts";

setupTestDb();

const BOT = "test-router-bot";
const OWNER = "owner-of-bot";

function makeMsg(overrides: Partial<InboundPeerMessage> = {}): InboundPeerMessage {
  return {
    fromId: "peer-uuid-aaa",
    fromSummary: "huginn — search-index assistant",
    fromCwd: "/Users/test/source/private/huginn",
    text: "index rebuilt, +12% recall",
    sentAt: new Date("2026-04-28T10:00:00Z").toISOString(),
    ...overrides,
  };
}

describe("peerNameFor", () => {
  test("uses cwd basename when available", () => {
    expect(peerNameFor({ fromCwd: "/Users/x/source/huginn", fromSummary: "Huginn", fromId: "id" })).toBe("huginn");
    expect(peerNameFor({ fromCwd: "/Users/x/source/huginn/", fromSummary: "Huginn", fromId: "id" })).toBe("huginn");
  });

  test("falls back to summary slug when cwd is empty", () => {
    expect(peerNameFor({ fromCwd: "", fromSummary: "NAV Review Bot", fromId: "id" })).toBe("nav-review-bot");
  });

  test("falls back to id prefix when both cwd and summary are blank", () => {
    expect(peerNameFor({ fromCwd: "", fromSummary: "", fromId: "abcdef1234567890" })).toBe("peer-abcdef12");
  });
});

describe("HivemindRouter.route", () => {
  test("creates peer:<cwd-basename> thread and persists message under bot owner", async () => {
    await setBotDefaultUser(BOT, OWNER);
    const chat = new ChatState();
    const router = new HivemindRouter(chat);

    const messageId = await router.route(BOT, makeMsg());
    expect(messageId).toBeTruthy();

    const threads = await listThreads(OWNER, BOT);
    const peerThread = threads.find((t) => t.name === "peer:huginn");
    expect(peerThread).toBeDefined();
    expect(peerThread!.isActive).toBe(false);

    const sql = getDb();
    const [row] = await sql`SELECT role, content, from_peer_id, thread_id, platform FROM messages WHERE id = ${messageId!}`;
    expect(row?.role).toBe("peer");
    expect(row?.content).toBe("index rebuilt, +12% recall");
    expect(row?.from_peer_id).toBe("peer-uuid-aaa");
    expect(row?.thread_id).toBe(peerThread!.id);
    expect(row?.platform).toBe("web");
  });

  test("broadcasts a message event on the bot owner's web conversation", async () => {
    await setBotDefaultUser(BOT, OWNER);
    const chat = new ChatState();
    const router = new HivemindRouter(chat);

    const events: Array<{ conversationId: string; sender: string; text: string; threadId?: string | null }> = [];
    chat.subscribe((ev) => {
      if (ev.type === "message") {
        events.push({
          conversationId: ev.conversationId,
          sender: ev.message.sender,
          text: ev.message.text,
          threadId: ev.message.threadId,
        });
      }
    });

    await router.route(BOT, makeMsg());

    const peerEvent = events.find((e) => e.sender === "peer");
    expect(peerEvent).toBeDefined();
    expect(peerEvent!.text).toBe("index rebuilt, +12% recall");
    expect(peerEvent!.threadId).toBeTruthy();

    // The conversation should be created and accessible via getConversations
    const convs = chat.getConversations();
    expect(convs).toHaveLength(1);
    expect(convs[0]!.botName).toBe(BOT);
    expect(convs[0]!.userId).toBe(OWNER);
    expect(convs[0]!.type).toBe("web");
  });

  test("reuses the same peer thread for repeat inbound messages", async () => {
    await setBotDefaultUser(BOT, OWNER);
    const chat = new ChatState();
    const router = new HivemindRouter(chat);

    await router.route(BOT, makeMsg({ text: "first" }));
    await router.route(BOT, makeMsg({ text: "second", fromId: "peer-uuid-bbb" }));

    const threads = await listThreads(OWNER, BOT);
    const peerThreads = threads.filter((t) => t.name === "peer:huginn");
    expect(peerThreads).toHaveLength(1);

    const sql = getDb();
    const rows = await sql`SELECT content, from_peer_id FROM messages WHERE thread_id = ${peerThreads[0]!.id} ORDER BY created_at`;
    expect(rows.map((r) => r.content)).toEqual(["first", "second"]);
    // Even when from_peer_id changes (peer reconnected), the thread is reused.
    expect(rows.map((r) => r.from_peer_id)).toEqual(["peer-uuid-aaa", "peer-uuid-bbb"]);
  });

  test("returns null and does not persist when the bot has no default user", async () => {
    // No setBotDefaultUser call — owner is unset.
    const chat = new ChatState();
    const router = new HivemindRouter(chat);

    const id = await router.route("bot-without-owner", makeMsg());
    expect(id).toBeNull();

    const sql = getDb();
    const [row] = await sql`SELECT COUNT(*)::int AS count FROM messages WHERE bot_name = ${"bot-without-owner"}`;
    expect(Number(row?.count ?? -1)).toBe(0);
  });
});
