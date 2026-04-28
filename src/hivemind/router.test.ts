import { test, expect, describe, beforeEach } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { ChatState } from "../chat/state.ts";
import { setBotDefaultUser } from "../db/chat-preferences.ts";
import { getDb } from "../db/client.ts";
import { listThreads, getOrCreatePeerThread, setThreadAutoRespondPaused } from "../db/threads.ts";
import { saveMessage } from "../db/messages.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";
import type { processMessage as ProcessMessageFn } from "../core/message-processor.ts";
import type { HivemindBotClient } from "./client.ts";
import { HivemindRouter, peerNameFor, type InboundPeerMessage, type AutorespondDeps } from "./router.ts";

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

describe("HivemindRouter autorespond (Phase 3)", () => {
  const AR_BOT = "phase3-autorespond-bot";
  const AR_OWNER = "phase3-autorespond-owner";

  function makeBotConfig(overrides: Partial<NonNullable<BotConfig["hivemind"]>> = {}): BotConfig {
    return {
      name: AR_BOT,
      dir: `/tmp/bots/${AR_BOT}`,
      persona: "Test bot persona",
      telegramAllowedUserIds: [],
      slackAllowedUserIds: [],
      hivemind: {
        enabled: true,
        namespaces: ["private"],
        autoRespondPeers: ["huginn"],
        ...overrides,
      },
    } as BotConfig;
  }

  function makeStubClient(sentRef: { calls: { to: string; text: string }[]; result: boolean }) {
    return {
      sendMessage: (to: string, text: string) => {
        sentRef.calls.push({ to, text });
        return sentRef.result;
      },
    } as unknown as HivemindBotClient;
  }

  type StubProcessMessage = typeof ProcessMessageFn;

  function makeDeps(opts: {
    botConfig: BotConfig | undefined;
    sent: { calls: { to: string; text: string }[]; result: boolean };
    process: StubProcessMessage;
  }): AutorespondDeps {
    return {
      getBotConfig: () => opts.botConfig,
      getClient: () => makeStubClient(opts.sent),
      config: {} as Config,
      processMessage: opts.process,
    };
  }

  function makeMsg(overrides: Partial<InboundPeerMessage> = {}): InboundPeerMessage {
    return {
      fromId: "auto-peer-1",
      fromSummary: "huginn",
      fromCwd: "/Users/test/source/private/huginn",
      text: "please re-index",
      sentAt: new Date().toISOString(),
      ...overrides,
    };
  }

  async function clearAssistantMessagesForThread(peerName: string): Promise<void> {
    const thread = await getOrCreatePeerThread(AR_OWNER, AR_BOT, peerName);
    const sql = getDb();
    await sql`DELETE FROM messages WHERE thread_id = ${thread.id} AND role = 'assistant'`;
  }

  beforeEach(async () => {
    await setBotDefaultUser(AR_BOT, AR_OWNER);
    const thread = await getOrCreatePeerThread(AR_OWNER, AR_BOT, "huginn");
    await setThreadAutoRespondPaused(thread.id, false);
  });

  test("calls processMessage and relays bot reply when peer is on autoRespondPeers", async () => {
    await setBotDefaultUser(AR_BOT, AR_OWNER);
    await clearAssistantMessagesForThread("huginn");
    const chat = new ChatState();
    const sent = { calls: [] as { to: string; text: string }[], result: true };
    let processCalls = 0;
    const stubProcess: StubProcessMessage = async (params) => {
      processCalls++;
      // Simulate processMessage saving the assistant turn so the loop guard
      // sees it on subsequent runs.
      await saveMessage({
        userId: params.userId, botName: params.botConfig.name, role: "assistant",
        content: "ack: index rebuild started", platform: "web", threadId: params.threadId,
      });
      return {
        responseText: "ack: index rebuild started",
        traceId: "trace-x", durationMs: 12, inputTokens: 10, outputTokens: 8,
        costUsd: 0, model: "stub", numTurns: 1,
      };
    };
    const router = new HivemindRouter(chat, makeDeps({
      botConfig: makeBotConfig(), sent, process: stubProcess,
    }));

    await router.route(AR_BOT, makeMsg());
    await router.pendingAutorespond;

    expect(processCalls).toBe(1);
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0]!.to).toBe("auto-peer-1");
    expect(sent.calls[0]!.text).toBe("ack: index rebuild started");
  });

  test("does not autorespond when peer is not on the allowlist", async () => {
    await setBotDefaultUser(AR_BOT, AR_OWNER);
    await clearAssistantMessagesForThread("yggdrasil");
    const chat = new ChatState();
    const sent = { calls: [] as { to: string; text: string }[], result: true };
    let processCalls = 0;
    const stubProcess: StubProcessMessage = async () => {
      processCalls++;
      return {
        responseText: "should not be called",
        traceId: "x", durationMs: 0, inputTokens: 0, outputTokens: 0,
        costUsd: 0, model: "stub", numTurns: 1,
      };
    };
    const router = new HivemindRouter(chat, makeDeps({
      botConfig: makeBotConfig({ autoRespondPeers: ["huginn"] }), sent, process: stubProcess,
    }));

    await router.route(AR_BOT, makeMsg({
      fromCwd: "/Users/test/source/private/yggdrasil",
      fromSummary: "yggdrasil",
    }));
    await router.pendingAutorespond;

    expect(processCalls).toBe(0);
    expect(sent.calls).toHaveLength(0);
  });

  test("does not autorespond when bot has no hivemind config", async () => {
    const NO_HIVE_BOT = "phase3-no-hivemind-bot";
    await setBotDefaultUser(NO_HIVE_BOT, AR_OWNER);
    const chat = new ChatState();
    const sent = { calls: [] as { to: string; text: string }[], result: true };
    let processCalls = 0;
    const stubProcess: StubProcessMessage = async () => {
      processCalls++;
      return {
        responseText: "x", traceId: "x", durationMs: 0,
        inputTokens: 0, outputTokens: 0, costUsd: 0, model: "stub", numTurns: 1,
      };
    };
    const noHive: BotConfig = {
      name: NO_HIVE_BOT, dir: `/tmp/bots/${NO_HIVE_BOT}`, persona: "p",
      telegramAllowedUserIds: [], slackAllowedUserIds: [],
    } as BotConfig;
    const router = new HivemindRouter(chat, makeDeps({
      botConfig: noHive, sent, process: stubProcess,
    }));

    await router.route(NO_HIVE_BOT, makeMsg());
    await router.pendingAutorespond;

    expect(processCalls).toBe(0);
    expect(sent.calls).toHaveLength(0);
  });

  test("auto-pauses the thread when hourly turn cap is hit and skips processMessage", async () => {
    await setBotDefaultUser(AR_BOT, AR_OWNER);
    await clearAssistantMessagesForThread("huginn");
    // Pre-seed the thread with 3 assistant turns to trip the cap of 3 on first attempt.
    const thread = await getOrCreatePeerThread(AR_OWNER, AR_BOT, "huginn");
    for (let i = 0; i < 3; i++) {
      await saveMessage({
        userId: AR_OWNER, botName: AR_BOT, role: "assistant", content: `prior ${i}`,
        platform: "web", threadId: thread.id,
      });
    }
    const chat = new ChatState();
    const sent = { calls: [] as { to: string; text: string }[], result: true };
    let processCalls = 0;
    const stubProcess: StubProcessMessage = async () => {
      processCalls++;
      return {
        responseText: "x", traceId: "x", durationMs: 0,
        inputTokens: 0, outputTokens: 0, costUsd: 0, model: "stub", numTurns: 1,
      };
    };
    const router = new HivemindRouter(chat, makeDeps({
      botConfig: makeBotConfig({ maxAutoTurnsPerHour: 3 }), sent, process: stubProcess,
    }));

    await router.route(AR_BOT, makeMsg());
    await router.pendingAutorespond;

    expect(processCalls).toBe(0);
    expect(sent.calls).toHaveLength(0);
    const threads = await listThreads(AR_OWNER, AR_BOT);
    const peerThread = threads.find((t) => t.name === "peer:huginn");
    expect(peerThread?.autoRespondPaused).toBe(true);
    expect(peerThread?.pauseReason).toBe("3-turn/hour cap");
  });

  test("does not autorespond when thread is already paused", async () => {
    await setBotDefaultUser(AR_BOT, AR_OWNER);
    await clearAssistantMessagesForThread("huginn");
    const thread = await getOrCreatePeerThread(AR_OWNER, AR_BOT, "huginn");
    await setThreadAutoRespondPaused(thread.id, true, "manual");
    const chat = new ChatState();
    const sent = { calls: [] as { to: string; text: string }[], result: true };
    let processCalls = 0;
    const stubProcess: StubProcessMessage = async () => {
      processCalls++;
      return {
        responseText: "x", traceId: "x", durationMs: 0,
        inputTokens: 0, outputTokens: 0, costUsd: 0, model: "stub", numTurns: 1,
      };
    };
    const router = new HivemindRouter(chat, makeDeps({
      botConfig: makeBotConfig(), sent, process: stubProcess,
    }));

    await router.route(AR_BOT, makeMsg());
    await router.pendingAutorespond;

    expect(processCalls).toBe(0);
    expect(sent.calls).toHaveLength(0);
  });

  test("setThreadAutoRespondPaused round-trips paused + reason", async () => {
    await setBotDefaultUser(AR_BOT, AR_OWNER);
    const thread = await getOrCreatePeerThread(AR_OWNER, AR_BOT, "huginn");

    expect(await setThreadAutoRespondPaused(thread.id, true, "manual")).toBe(true);
    let threads = await listThreads(AR_OWNER, AR_BOT);
    let row = threads.find((t) => t.id === thread.id);
    expect(row?.autoRespondPaused).toBe(true);
    expect(row?.pauseReason).toBe("manual");

    expect(await setThreadAutoRespondPaused(thread.id, false)).toBe(true);
    threads = await listThreads(AR_OWNER, AR_BOT);
    row = threads.find((t) => t.id === thread.id);
    expect(row?.autoRespondPaused).toBe(false);
    expect(row?.pauseReason).toBeUndefined();
  });
});
