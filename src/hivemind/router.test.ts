import { test, expect, describe, beforeEach } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { ChatState } from "../chat/state.ts";
import { setBotDefaultUser } from "../db/chat-preferences.ts";
import { getDb } from "../db/client.ts";
import { listThreads, getOrCreatePeerThread, setThreadAutoRespondPaused, createThread } from "../db/threads.ts";
import { saveMessage } from "../db/messages.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";
import type { processMessage as ProcessMessageFn } from "../core/message-processor.ts";
import type { HivemindBotClient } from "./client.ts";
import { HivemindRouter, peerNameFor, parsePeerThreadName, peerThreadNameFor, type InboundPeerMessage, type AutorespondDeps } from "./router.ts";
import { setPendingPeer, _resetPendingPeersForTests } from "./correlation.ts";

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
    namespace: "private",
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

describe("peer thread name (namespace-aware)", () => {
  test("peerThreadNameFor builds peer:<ns>/<basename>", () => {
    expect(peerThreadNameFor({
      namespace: "nav", fromCwd: "/Users/x/source/huginn", fromSummary: "h", fromId: "id",
    })).toBe("peer:nav/huginn");
  });

  test("parsePeerThreadName splits namespace and peer name", () => {
    expect(parsePeerThreadName("peer:nav/huginn")).toEqual({ namespace: "nav", peerName: "huginn" });
    expect(parsePeerThreadName("peer:private/yggdrasil")).toEqual({ namespace: "private", peerName: "yggdrasil" });
  });

  test("parsePeerThreadName returns null for legacy/unmigrated rows or non-peer names", () => {
    expect(parsePeerThreadName("peer:huginn")).toBeNull();
    expect(parsePeerThreadName("main")).toBeNull();
    expect(parsePeerThreadName("peer:nav/")).toBeNull();
    expect(parsePeerThreadName("peer:/huginn")).toBeNull();
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
    const peerThread = threads.find((t) => t.name === "peer:private/huginn");
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
    const peerThreads = threads.filter((t) => t.name === "peer:private/huginn");
    expect(peerThreads).toHaveLength(1);

    const sql = getDb();
    const rows = await sql`SELECT content, from_peer_id FROM messages WHERE thread_id = ${peerThreads[0]!.id} ORDER BY created_at`;
    expect(rows.map((r) => r.content)).toEqual(["first", "second"]);
    // Even when from_peer_id changes (peer reconnected), the thread is reused.
    expect(rows.map((r) => r.from_peer_id)).toEqual(["peer-uuid-aaa", "peer-uuid-bbb"]);
  });

  test("same cwd basename in two namespaces creates two distinct threads", async () => {
    await setBotDefaultUser(BOT, OWNER);
    const chat = new ChatState();
    const router = new HivemindRouter(chat);

    await router.route(BOT, makeMsg({ namespace: "private", text: "from-private" }));
    await router.route(BOT, makeMsg({
      namespace: "nav", text: "from-nav", fromId: "peer-uuid-nav-1",
    }));

    const threads = await listThreads(OWNER, BOT);
    const privateThread = threads.find((t) => t.name === "peer:private/huginn");
    const navThread = threads.find((t) => t.name === "peer:nav/huginn");
    expect(privateThread).toBeDefined();
    expect(navThread).toBeDefined();
    expect(privateThread!.id).not.toBe(navThread!.id);

    const sql = getDb();
    const privateRows = await sql`SELECT content FROM messages WHERE thread_id = ${privateThread!.id}`;
    const navRows = await sql`SELECT content FROM messages WHERE thread_id = ${navThread!.id}`;
    expect(privateRows.map((r) => r.content)).toEqual(["from-private"]);
    expect(navRows.map((r) => r.content)).toEqual(["from-nav"]);
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

describe("HivemindRouter.route — peer correlation", () => {
  const CORR_BOT = "corr-router-bot";
  const CORR_OWNER = "corr-owner";

  beforeEach(() => _resetPendingPeersForTests());

  test("routes inbound to the originating thread when correlation exists", async () => {
    await setBotDefaultUser(CORR_BOT, CORR_OWNER);
    // The "current" thread on this bot (e.g. a Jira research thread).
    const originating = await createThread(CORR_OWNER, CORR_BOT, "jira-research-RUNE-1234");
    // Outbound side recorded this when the bot called send_to_peer(huginn, ...).
    setPendingPeer(CORR_BOT, "peer-uuid-aaa", originating.id);

    const chat = new ChatState();
    const router = new HivemindRouter(chat);
    const messageId = await router.route(CORR_BOT, makeMsg());
    expect(messageId).toBeTruthy();

    const sql = getDb();
    const [row] = await sql`SELECT thread_id FROM messages WHERE id = ${messageId!}`;
    expect(row?.thread_id).toBe(originating.id);

    // No fallback peer:<ns>/<name> thread should have been created.
    const threads = await listThreads(CORR_OWNER, CORR_BOT);
    expect(threads.find((t) => t.name === "peer:private/huginn")).toBeUndefined();
  });

  test("falls back to peer:<ns>/<name> when correlation points at a different user's thread", async () => {
    await setBotDefaultUser(CORR_BOT, CORR_OWNER);
    // Create a thread belonging to a different user — owner mismatch should
    // trigger a warn + fallback to the default peer thread.
    const otherThread = await createThread("some-other-user", CORR_BOT, "other-user-thread");
    setPendingPeer(CORR_BOT, "peer-uuid-aaa", otherThread.id);

    const chat = new ChatState();
    const router = new HivemindRouter(chat);
    const messageId = await router.route(CORR_BOT, makeMsg());
    expect(messageId).toBeTruthy();

    const sql = getDb();
    const [row] = await sql`SELECT thread_id FROM messages WHERE id = ${messageId!}`;
    const threads = await listThreads(CORR_OWNER, CORR_BOT);
    const fallback = threads.find((t) => t.name === "peer:private/huginn");
    expect(fallback).toBeDefined();
    expect(row?.thread_id).toBe(fallback!.id);
  });

  test("falls back when the correlated thread was deleted", async () => {
    await setBotDefaultUser(CORR_BOT, CORR_OWNER);
    setPendingPeer(CORR_BOT, "peer-uuid-aaa", "00000000-0000-0000-0000-000000000000");

    const chat = new ChatState();
    const router = new HivemindRouter(chat);
    const messageId = await router.route(CORR_BOT, makeMsg());
    expect(messageId).toBeTruthy();

    const threads = await listThreads(CORR_OWNER, CORR_BOT);
    expect(threads.find((t) => t.name === "peer:private/huginn")).toBeDefined();
  });

  test("follow-up inbound from the same peer still routes to the originating thread (no consume)", async () => {
    await setBotDefaultUser(CORR_BOT, CORR_OWNER);
    const originating = await createThread(CORR_OWNER, CORR_BOT, "jira-research-followup");
    setPendingPeer(CORR_BOT, "peer-uuid-aaa", originating.id);

    const chat = new ChatState();
    const router = new HivemindRouter(chat);
    await router.route(CORR_BOT, makeMsg({ text: "first reply" }));
    await router.route(CORR_BOT, makeMsg({ text: "follow-up", fromId: "peer-uuid-aaa" }));

    const sql = getDb();
    const rows = await sql`SELECT content, thread_id FROM messages WHERE thread_id = ${originating.id} AND role = 'peer' ORDER BY created_at`;
    expect(rows.map((r) => r.content)).toEqual(["first reply", "follow-up"]);
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
    clientLookups?: { calls: { botName: string; namespace: string }[] };
  }): AutorespondDeps {
    return {
      getBotConfig: () => opts.botConfig,
      getClient: (botName, namespace) => {
        opts.clientLookups?.calls.push({ botName, namespace });
        return makeStubClient(opts.sent);
      },
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
      namespace: "private",
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
    const thread = await getOrCreatePeerThread(AR_OWNER, AR_BOT, "private/huginn");
    await setThreadAutoRespondPaused(thread.id, false);
  });

  test("calls processMessage and relays bot reply when peer is on autoRespondPeers", async () => {
    await setBotDefaultUser(AR_BOT, AR_OWNER);
    await clearAssistantMessagesForThread("private/huginn");
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
    await clearAssistantMessagesForThread("private/yggdrasil");
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
    await clearAssistantMessagesForThread("private/huginn");
    // Pre-seed the thread with 3 assistant turns to trip the cap of 3 on first attempt.
    const thread = await getOrCreatePeerThread(AR_OWNER, AR_BOT, "private/huginn");
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
    const peerThread = threads.find((t) => t.name === "peer:private/huginn");
    expect(peerThread?.autoRespondPaused).toBe(true);
    expect(peerThread?.pauseReason).toBe("3-turn/hour cap");
  });

  test("does not autorespond when thread is already paused", async () => {
    await setBotDefaultUser(AR_BOT, AR_OWNER);
    await clearAssistantMessagesForThread("private/huginn");
    const thread = await getOrCreatePeerThread(AR_OWNER, AR_BOT, "private/huginn");
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

  test("autorespond outbound looks up the client for the inbound namespace", async () => {
    await setBotDefaultUser(AR_BOT, AR_OWNER);
    // Ensure both candidate threads start unpaused.
    const navThread = await getOrCreatePeerThread(AR_OWNER, AR_BOT, "nav/huginn");
    await setThreadAutoRespondPaused(navThread.id, false);
    const sql = getDb();
    await sql`DELETE FROM messages WHERE thread_id = ${navThread.id} AND role = 'assistant'`;

    const chat = new ChatState();
    const sent = { calls: [] as { to: string; text: string }[], result: true };
    const clientLookups = { calls: [] as { botName: string; namespace: string }[] };
    const stubProcess: StubProcessMessage = async (params) => {
      await saveMessage({
        userId: params.userId, botName: params.botConfig.name, role: "assistant",
        content: "ack", platform: "web", threadId: params.threadId,
      });
      return {
        responseText: "ack",
        traceId: "trace-x", durationMs: 1, inputTokens: 1, outputTokens: 1,
        costUsd: 0, model: "stub", numTurns: 1,
      };
    };
    const router = new HivemindRouter(chat, makeDeps({
      botConfig: makeBotConfig({ namespaces: ["private", "nav"], autoRespondPeers: ["huginn"] }),
      sent, process: stubProcess, clientLookups,
    }));

    await router.route(AR_BOT, makeMsg({ namespace: "nav", fromId: "nav-peer-id" }));
    await router.pendingAutorespond;

    expect(clientLookups.calls).toHaveLength(1);
    expect(clientLookups.calls[0]!.namespace).toBe("nav");
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0]!.to).toBe("nav-peer-id");
  });

  test("setThreadAutoRespondPaused round-trips paused + reason", async () => {
    await setBotDefaultUser(AR_BOT, AR_OWNER);
    const thread = await getOrCreatePeerThread(AR_OWNER, AR_BOT, "private/huginn");

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
