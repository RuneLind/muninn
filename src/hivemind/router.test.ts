import { test, expect, describe, beforeEach } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { ChatState, type ChatEvent } from "../chat/state.ts";
import { setBotDefaultUser } from "../db/chat-preferences.ts";
import { getDb } from "../db/client.ts";
import { listThreads, getOrCreatePeerThread, setThreadAutoRespondPaused, createThread } from "../db/threads.ts";
import { saveMessage } from "../db/messages.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";
import type { processMessage as ProcessMessageFn } from "../core/message-processor.ts";
import type { HivemindBotClient } from "./client.ts";
import { HivemindRouter, peerNameFor, parsePeerThreadName, peerThreadNameFor, framePeerMessage, type InboundPeerMessage, type AutorespondDeps } from "./router.ts";
import { setPendingPeer } from "./correlation.ts";
import { setCorrelationToken } from "./correlation-tokens.ts";
import { birthDevRun, insertHandoff, listHandoffs, listDevRunEvents, getDevRunById, updateDevRun, MAX_REENGAGE_ATTEMPTS } from "../db/dev-runs.ts";
import { shortRunId } from "./mcp-server.ts";

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

  test("routes inbound to the originating thread when correlation exists", async () => {
    await setBotDefaultUser(CORR_BOT, CORR_OWNER);
    // The "current" thread on this bot (e.g. a Jira research thread).
    const originating = await createThread(CORR_OWNER, CORR_BOT, "jira-research-RUNE-1234");
    // Outbound side recorded this when the bot called send_to_peer(huginn, ...).
    await setPendingPeer(CORR_BOT, "peer-uuid-aaa", originating.id);

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

  test("routes inbound to the originating thread even when it belongs to a non-default user", async () => {
    // Bot's default user is CORR_OWNER, but a *different* user (e.g. Rune-4 in
    // a web chat while vy-tester-1 is the bot default) initiated the outbound to
    // this peer. The reply must land in that user's originating thread, not a
    // fresh peer:<ns>/<name> bucket under the default user.
    await setBotDefaultUser(CORR_BOT, CORR_OWNER);
    const otherThread = await createThread("some-other-user", CORR_BOT, "other-user-thread");
    await setPendingPeer(CORR_BOT, "peer-uuid-aaa", otherThread.id);

    const chat = new ChatState();
    const router = new HivemindRouter(chat);
    const messageId = await router.route(CORR_BOT, makeMsg());
    expect(messageId).toBeTruthy();

    const sql = getDb();
    const [row] = await sql`SELECT thread_id, user_id FROM messages WHERE id = ${messageId!}`;
    // Reply persisted in the originating thread, attributed to its owner.
    expect(row?.thread_id).toBe(otherThread.id);
    expect(row?.user_id).toBe("some-other-user");

    // No fallback peer thread under either user.
    const ownerThreads = await listThreads(CORR_OWNER, CORR_BOT);
    expect(ownerThreads.find((t) => t.name === "peer:private/huginn")).toBeUndefined();
    const otherThreads = await listThreads("some-other-user", CORR_BOT);
    expect(otherThreads.find((t) => t.name === "peer:private/huginn")).toBeUndefined();
  });

  test("correlation token routes to the exact originating thread, beating the (bot,peer) fallback", async () => {
    // The precision win: two outbounds to the SAME peer from two threads. The
    // (bot,peer) table is last-write-wins → points at threadB. But the reply
    // echoes threadA's token, so it must land in threadA, not threadB.
    await setBotDefaultUser(CORR_BOT, CORR_OWNER);
    const threadA = await createThread(CORR_OWNER, CORR_BOT, "research-A");
    const threadB = await createThread(CORR_OWNER, CORR_BOT, "research-B");
    await setCorrelationToken(CORR_BOT, "cid-A", threadA.id);
    await setCorrelationToken(CORR_BOT, "cid-B", threadB.id);
    // Last-write-wins fallback points at B (the later outbound).
    await setPendingPeer(CORR_BOT, "peer-uuid-aaa", threadB.id);

    const chat = new ChatState();
    const router = new HivemindRouter(chat);
    const messageId = await router.route(CORR_BOT, makeMsg({ correlationId: "cid-A" }));
    expect(messageId).toBeTruthy();

    const sql = getDb();
    const [row] = await sql`SELECT thread_id FROM messages WHERE id = ${messageId!}`;
    expect(row?.thread_id).toBe(threadA.id);
  });

  test("falls back to the (bot,peer) table when the echoed token is unknown", async () => {
    await setBotDefaultUser(CORR_BOT, CORR_OWNER);
    const originating = await createThread(CORR_OWNER, CORR_BOT, "fallback-thread");
    await setPendingPeer(CORR_BOT, "peer-uuid-aaa", originating.id);

    const chat = new ChatState();
    const router = new HivemindRouter(chat);
    // Token muninn never minted — misses the token store, falls back.
    const messageId = await router.route(CORR_BOT, makeMsg({ correlationId: "cid-foreign" }));
    expect(messageId).toBeTruthy();

    const sql = getDb();
    const [row] = await sql`SELECT thread_id FROM messages WHERE id = ${messageId!}`;
    expect(row?.thread_id).toBe(originating.id);
  });

  test("falls back when the token's thread was deleted", async () => {
    await setBotDefaultUser(CORR_BOT, CORR_OWNER);
    await setCorrelationToken(CORR_BOT, "cid-stale", "00000000-0000-0000-0000-000000000000");

    const chat = new ChatState();
    const router = new HivemindRouter(chat);
    const messageId = await router.route(CORR_BOT, makeMsg({ correlationId: "cid-stale" }));
    expect(messageId).toBeTruthy();

    // No live token or (bot,peer) row → default peer thread.
    const threads = await listThreads(CORR_OWNER, CORR_BOT);
    expect(threads.find((t) => t.name === "peer:private/huginn")).toBeDefined();
  });

  test("falls back when the correlated thread was deleted", async () => {
    await setBotDefaultUser(CORR_BOT, CORR_OWNER);
    await setPendingPeer(CORR_BOT, "peer-uuid-aaa", "00000000-0000-0000-0000-000000000000");

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
    await setPendingPeer(CORR_BOT, "peer-uuid-aaa", originating.id);

    const chat = new ChatState();
    const router = new HivemindRouter(chat);
    await router.route(CORR_BOT, makeMsg({ text: "first reply" }));
    await router.route(CORR_BOT, makeMsg({ text: "follow-up", fromId: "peer-uuid-aaa" }));

    const sql = getDb();
    const rows = await sql`SELECT content, thread_id FROM messages WHERE thread_id = ${originating.id} AND role = 'peer' ORDER BY created_at`;
    expect(rows.map((r) => r.content)).toEqual(["first reply", "follow-up"]);
  });
});

describe("HivemindRouter handoff interpret (Phase 4)", () => {
  const HI_BOT = "phase4-handoff-bot";
  const HI_OWNER = "phase4-handoff-owner";

  test("a handoff reply routed to the run's thread rolls up the handoff off the delivery path", async () => {
    await setBotDefaultUser(HI_BOT, HI_OWNER);
    // The research thread + its dev_run (born at research-thread creation).
    const thread = await createThread(HI_OWNER, HI_BOT, "research-handoff-1");
    const run = await birthDevRun({ botName: HI_BOT, userId: HI_OWNER, issueKey: "research-aaaa1111", threadId: thread.id });
    // delegate_task recorded a build handoff under the peer's cwd-basename name.
    await insertHandoff({ runId: run.id, peerName: "huginn", role: "build" });
    // The reply routes back to the originating thread via the (bot,peer) binding.
    await setPendingPeer(HI_BOT, "peer-uuid-aaa", thread.id);

    const chat = new ChatState();
    const router = new HivemindRouter(chat);
    const messageId = await router.route(HI_BOT, makeMsg({
      text: `built it\n<!-- status: done run:${shortRunId(run.id)} -->`,
    }));
    expect(messageId).toBeTruthy();
    await router.pendingHandoffInterpret;

    const handoff = (await listHandoffs(run.id)).find((h) => h.peerName === "huginn")!;
    expect(handoff.status).toBe("done");
    // build-only run with the role done → computeRunStatus "building" persisted
    // (no test role yet); the point is the roll-up ran and updated dev_run.
    expect((await getDevRunById(run.id))!.status).toBe("building");
  });

  test("a non-marker reply leaves dev_run handoffs untouched", async () => {
    await setBotDefaultUser(HI_BOT, HI_OWNER);
    const thread = await createThread(HI_OWNER, HI_BOT, "research-handoff-2");
    const run = await birthDevRun({ botName: HI_BOT, userId: HI_OWNER, issueKey: "research-bbbb2222", threadId: thread.id });
    await insertHandoff({ runId: run.id, peerName: "huginn", role: "build" });
    await setPendingPeer(HI_BOT, "peer-uuid-aaa", thread.id);

    const chat = new ChatState();
    const router = new HivemindRouter(chat);
    await router.route(HI_BOT, makeMsg({ text: "just chatting, no marker here" }));
    await router.pendingHandoffInterpret;

    expect((await listHandoffs(run.id))[0]!.status).toBe("sent");
  });

  test("a non-terminal note records an event, bumps the handoff working, and broadcasts dev_run_event (Phase B)", async () => {
    await setBotDefaultUser(HI_BOT, HI_OWNER);
    const thread = await createThread(HI_OWNER, HI_BOT, "research-handoff-note");
    const run = await birthDevRun({ botName: HI_BOT, userId: HI_OWNER, issueKey: "research-cccc3333", threadId: thread.id });
    await updateDevRun(run.id, { status: "building" });
    await insertHandoff({ runId: run.id, peerName: "huginn", role: "build" });
    await setPendingPeer(HI_BOT, "peer-uuid-aaa", thread.id);

    const chat = new ChatState();
    const events: ChatEvent[] = [];
    chat.subscribe((e) => events.push(e));
    const router = new HivemindRouter(chat);
    await router.route(HI_BOT, makeMsg({
      text: `field already on the DTO\n<!-- note: discovery run:${shortRunId(run.id)} -->`,
    }));
    await router.pendingHandoffInterpret;

    // Handoff bumped sent → working; run status unchanged (a note never recomputes).
    expect((await listHandoffs(run.id))[0]!.status).toBe("working");
    expect((await getDevRunById(run.id))!.status).toBe("building");
    // Event persisted + broadcast as a dev_run_event carrying the run's thread.
    const dbEvents = await listDevRunEvents(run.id);
    expect(dbEvents).toHaveLength(1);
    expect(dbEvents[0]!.kind).toBe("discovery");
    const ev = events.find((e) => e.type === "dev_run_event") as Extract<ChatEvent, { type: "dev_run_event" }>;
    expect(ev).toBeDefined();
    expect(ev.runId).toBe(run.id);
    expect(ev.threadId).toBe(thread.id);
    expect(ev.event.text).toBe("field already on the DTO");
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

  function makeStubClient(sentRef: { calls: { to: string; text: string; correlationId?: string }[]; result: boolean }) {
    return {
      sendMessage: (to: string, text: string, correlationId?: string) => {
        sentRef.calls.push({ to, text, correlationId });
        return sentRef.result;
      },
    } as unknown as HivemindBotClient;
  }

  type StubProcessMessage = typeof ProcessMessageFn;

  function makeDeps(opts: {
    botConfig: BotConfig | undefined;
    sent: { calls: { to: string; text: string; correlationId?: string }[]; result: boolean };
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

  test("wraps the peer message in trust framing for the bot turn", async () => {
    // The allowlist check is the trust decision — without framing, the model
    // sees a bare message claiming to be another agent and refuses it as
    // prompt injection. The persisted role='peer' message must stay raw.
    await setBotDefaultUser(AR_BOT, AR_OWNER);
    await clearAssistantMessagesForThread("private/huginn");
    const chat = new ChatState();
    const sent = { calls: [] as { to: string; text: string }[], result: true };
    let seenText: string | undefined;
    const stubProcess: StubProcessMessage = async (params) => {
      seenText = params.text;
      await saveMessage({
        userId: params.userId, botName: params.botConfig.name, role: "assistant",
        content: "titles: a, b, c", platform: "web", threadId: params.threadId,
      });
      return {
        responseText: "titles: a, b, c",
        traceId: "t", durationMs: 1, inputTokens: 1, outputTokens: 1,
        costUsd: 0, model: "stub", numTurns: 1,
      };
    };
    const router = new HivemindRouter(chat, makeDeps({
      botConfig: makeBotConfig(), sent, process: stubProcess,
    }));

    await router.route(AR_BOT, makeMsg({ text: "run one knowledge_search please" }));
    await router.pendingAutorespond;

    expect(seenText).toBe(framePeerMessage("huginn", "run one knowledge_search please"));
    expect(seenText).toContain("run one knowledge_search please");
    expect(seenText).toContain("allowlisted for auto-respond");

    // The stored copy of the trigger is the raw peer message, not the framed one.
    const sql = getDb();
    const thread = await getOrCreatePeerThread(AR_OWNER, AR_BOT, "private/huginn");
    const rows = await sql`
      SELECT content FROM messages
      WHERE thread_id = ${thread.id} AND role = 'peer'
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(rows[0]!.content).toBe("run one knowledge_search please");

    await clearAssistantMessagesForThread("private/huginn");
  });

  test("autorespond echoes the inbound correlation token on its reply", async () => {
    // Replying → echo the inbound token verbatim (set-vs-echo discipline), so
    // the initiating peer can resolve our reply against its own token store.
    await setBotDefaultUser(AR_BOT, AR_OWNER);
    await clearAssistantMessagesForThread("private/huginn");
    const chat = new ChatState();
    const sent = { calls: [] as { to: string; text: string; correlationId?: string }[], result: true };
    const stubProcess: StubProcessMessage = async (params) => {
      await saveMessage({
        userId: params.userId, botName: params.botConfig.name, role: "assistant",
        content: "echoed reply", platform: "web", threadId: params.threadId,
      });
      return {
        responseText: "echoed reply",
        traceId: "t", durationMs: 1, inputTokens: 1, outputTokens: 1,
        costUsd: 0, model: "stub", numTurns: 1,
      };
    };
    const router = new HivemindRouter(chat, makeDeps({
      botConfig: makeBotConfig(), sent, process: stubProcess,
    }));

    await router.route(AR_BOT, makeMsg({ correlationId: "inbound-cid" }));
    await router.pendingAutorespond;

    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0]!.correlationId).toBe("inbound-cid");

    await clearAssistantMessagesForThread("private/huginn");
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

describe("HivemindRouter auto-advance (Phase 6a — auto-fire orchestrate)", () => {
  const P6_BOT = "phase6a-bot";
  const P6_OWNER = "phase6a-owner";

  function makeBotConfig(devLoop?: { autoOrchestrate?: boolean }): BotConfig {
    return {
      name: P6_BOT,
      dir: `/tmp/bots/${P6_BOT}`,
      persona: "Test bot persona",
      telegramAllowedUserIds: [],
      slackAllowedUserIds: [],
      hivemind: { enabled: true, namespaces: ["private"], devLoop },
    } as BotConfig;
  }

  function makeDeps(botConfig: BotConfig | undefined, process: typeof ProcessMessageFn): AutorespondDeps {
    return {
      getBotConfig: () => botConfig,
      getClient: () => null, // auto-orchestrate uses delegate_task inside the turn, not a relay
      config: {} as Config,
      processMessage: process,
    };
  }

  /** A processMessage stub that records its calls (the real bot would call
   *  delegate_task here; we just assert the turn was fired with the right prompt). */
  function makeStubProcess() {
    const calls: Array<{ text: string; threadId?: string; skipUserSave?: boolean }> = [];
    const fn: typeof ProcessMessageFn = async (params) => {
      calls.push({ text: params.text, threadId: params.threadId, skipUserSave: params.skipUserSave });
      return {
        responseText: "delegated orchestrate to the e2e agent",
        traceId: "t", durationMs: 1, inputTokens: 1, outputTokens: 1,
        costUsd: 0, model: "stub", numTurns: 1,
      };
    };
    return { calls, fn };
  }

  /** Seed a run whose build is done + test is pending, so the test-peer's done
   *  marker tips it to ready_to_verify. Returns the run + research thread. */
  async function seedReadyMinusTest(issueKey: string) {
    await setBotDefaultUser(P6_BOT, P6_OWNER);
    const thread = await createThread(P6_OWNER, P6_BOT, `research-${issueKey}`);
    const run = await birthDevRun({ botName: P6_BOT, userId: P6_OWNER, issueKey, threadId: thread.id });
    // The approved spec's stored path (the auto prompt + verified-flip use this).
    await updateDevRun(run.id, { specPath: `specs/${P6_OWNER}/${issueKey}.md` });
    await insertHandoff({ runId: run.id, peerName: "buildpeer", role: "build", status: "done" });
    await insertHandoff({ runId: run.id, peerName: "testpeer", role: "test", status: "sent" });
    return { run, thread };
  }

  /** The test peer's done marker (peerNameFor(cwd)=="testpeer"). */
  function testPeerDone(runId: string): InboundPeerMessage {
    return makeMsg({
      fromId: "testpeer-uuid",
      fromCwd: "/Users/test/source/nav/testpeer",
      text: `done\n<!-- status: done run:${shortRunId(runId)} -->`,
    });
  }

  test("auto-fires the orchestrate turn when opted in and the run reaches ready_to_verify", async () => {
    const { run, thread } = await seedReadyMinusTest("research-6a000001");
    const chat = new ChatState();
    const stub = makeStubProcess();
    const router = new HivemindRouter(chat, makeDeps(makeBotConfig({ autoOrchestrate: true }), stub.fn));

    await router.route(P6_BOT, testPeerDone(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.threadId).toBe(thread.id);
    expect(stub.calls[0]!.text).toContain("delegate_task");
    expect(stub.calls[0]!.text.toLowerCase()).toContain("orchestrate");
    expect(stub.calls[0]!.skipUserSave).toBe(true);
    // The CAS claim moved the run past the gate.
    expect((await getDevRunById(run.id))!.status).toBe("verifying");
  });

  test("does NOT auto-fire when the bot has not opted in (v1 park-and-confirm)", async () => {
    const { run } = await seedReadyMinusTest("research-6a000002");
    const chat = new ChatState();
    const stub = makeStubProcess();
    const router = new HivemindRouter(chat, makeDeps(makeBotConfig(/* no devLoop */), stub.fn));

    await router.route(P6_BOT, testPeerDone(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;

    expect(stub.calls).toHaveLength(0);
    // Parked at the gate for the user's confirm — exactly v1.
    expect((await getDevRunById(run.id))!.status).toBe("ready_to_verify");
  });

  test("a duplicate build|test marker does NOT re-fire orchestrate (no-downgrade guard)", async () => {
    const { run } = await seedReadyMinusTest("research-6a000003");
    const chat = new ChatState();
    const stub = makeStubProcess();
    const router = new HivemindRouter(chat, makeDeps(makeBotConfig({ autoOrchestrate: true }), stub.fn));

    // First marker tips the run, claims verifying, fires once.
    await router.route(P6_BOT, testPeerDone(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;
    expect(stub.calls).toHaveLength(1);

    // A duplicate done marker recomputes ready_to_verify, but persistRunStatus
    // keeps the run `verifying` → the auto-advance seam sees verifying and no-ops.
    await router.route(P6_BOT, testPeerDone(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;

    expect(stub.calls).toHaveLength(1); // not 2 — no double orchestrate
    expect((await getDevRunById(run.id))!.status).toBe("verifying");
  });

  test("a thrown orchestrate turn reverts the run off 'verifying' (no wedge)", async () => {
    const { run } = await seedReadyMinusTest("research-6a000004");
    const chat = new ChatState();
    const calls: number[] = [];
    const throwingProcess: typeof ProcessMessageFn = async () => {
      calls.push(1);
      throw new Error("connector boom");
    };
    const router = new HivemindRouter(chat, makeDeps(makeBotConfig({ autoOrchestrate: true }), throwingProcess));

    await router.route(P6_BOT, testPeerDone(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun.catch(() => {}); // the turn throws + rethrows — swallow

    expect(calls).toHaveLength(1); // it did fire
    // No orchestrate handoff was inserted (the stub threw), so the compensating
    // revert recomputes ready_to_verify — the run is recoverable, not wedged.
    expect((await getDevRunById(run.id))!.status).toBe("ready_to_verify");
    expect((await listHandoffs(run.id)).some((h) => h.role === "orchestrate")).toBe(false);
  });
});

describe("HivemindRouter auto-re-engage (Phase 6b — re-engage build on red)", () => {
  const P6_BOT = "phase6b-bot";
  const P6_OWNER = "phase6b-owner";
  const CI_URL = "https://github.com/navikt/melosys-e2e-tests/actions/runs/26280001";

  function makeBotConfig(over?: {
    autoReengageOnRed?: boolean;
    autoOrchestrate?: boolean;
    reengageClassifier?: boolean;
    maxAutoTurnsPerHour?: number;
  }): BotConfig {
    const hasDevLoop =
      over &&
      (over.autoReengageOnRed !== undefined ||
        over.autoOrchestrate !== undefined ||
        over.reengageClassifier !== undefined);
    return {
      name: P6_BOT,
      dir: `/tmp/bots/${P6_BOT}`,
      persona: "Test bot persona",
      telegramAllowedUserIds: [],
      slackAllowedUserIds: [],
      hivemind: {
        enabled: true,
        namespaces: ["private"],
        maxAutoTurnsPerHour: over?.maxAutoTurnsPerHour,
        devLoop: hasDevLoop
          ? {
              autoReengageOnRed: over!.autoReengageOnRed,
              autoOrchestrate: over!.autoOrchestrate,
              reengageClassifier: over!.reengageClassifier,
            }
          : undefined,
      },
    } as BotConfig;
  }

  function makeDeps(
    botConfig: BotConfig | undefined,
    process: typeof ProcessMessageFn,
    classify?: AutorespondDeps["classifyReengageRole"],
  ): AutorespondDeps {
    return {
      getBotConfig: () => botConfig,
      getClient: () => null,
      config: {} as Config,
      processMessage: process,
      classifyReengageRole: classify,
    };
  }

  /** A processMessage stub that records its calls (the real bot would call
   *  delegate_task(role:"build") here). */
  function makeStubProcess() {
    const calls: Array<{ text: string; threadId?: string; skipUserSave?: boolean; traceId?: string }> = [];
    const fn: typeof ProcessMessageFn = async (params) => {
      calls.push({
        text: params.text, threadId: params.threadId, skipUserSave: params.skipUserSave,
        traceId: params.tracer?.traceId,
      });
      return {
        responseText: "re-engaged the build agent",
        traceId: "t", durationMs: 1, inputTokens: 1, outputTokens: 1,
        costUsd: 0, model: "stub", numTurns: 1,
      };
    };
    return { calls, fn };
  }

  /** Seed a run mid-verify: build done, test done, orchestrate sent — the
   *  orchestrate peer's `e2e: red` marker tips it red. Returns the run + thread. */
  async function seedVerifyingRun(issueKey: string) {
    await setBotDefaultUser(P6_BOT, P6_OWNER);
    const thread = await createThread(P6_OWNER, P6_BOT, `research-${issueKey}`);
    const run = await birthDevRun({ botName: P6_BOT, userId: P6_OWNER, issueKey, threadId: thread.id });
    await updateDevRun(run.id, { specPath: `specs/${P6_OWNER}/${issueKey}.md`, status: "verifying" });
    await insertHandoff({ runId: run.id, peerName: "buildpeer", role: "build", status: "done" });
    await insertHandoff({ runId: run.id, peerName: "testpeer", role: "test", status: "done" });
    await insertHandoff({ runId: run.id, peerName: "orchpeer", role: "orchestrate", status: "sent" });
    return { run, thread };
  }

  /** The orchestrate peer's red marker (peerNameFor(cwd)=="orchpeer"), carrying
   *  the failed CI URL the re-engage context extracts. */
  function orchPeerRed(runId: string): InboundPeerMessage {
    return makeMsg({
      fromId: "orchpeer-uuid",
      fromCwd: "/Users/test/source/nav/orchpeer",
      text: `e2e failed — see ${CI_URL}\n<!-- e2e: red run:${shortRunId(runId)} -->`,
    });
  }

  test("re-engages the build agent when opted in and the run goes red", async () => {
    const { run, thread } = await seedVerifyingRun("research-6b000001");
    const chat = new ChatState();
    const stub = makeStubProcess();
    const router = new HivemindRouter(chat, makeDeps(makeBotConfig({ autoReengageOnRed: true }), stub.fn));

    await router.route(P6_BOT, orchPeerRed(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.threadId).toBe(thread.id);
    expect(stub.calls[0]!.text).toContain("delegate_task");
    expect(stub.calls[0]!.text.toLowerCase()).toContain("build");
    expect(stub.calls[0]!.text).toContain(CI_URL); // failure context fed in
    expect(stub.calls[0]!.text).toContain("buildpeer"); // re-engage the same peer
    expect(stub.calls[0]!.skipUserSave).toBe(true);

    const after = (await getDevRunById(run.id))!;
    expect(after.status).toBe("building"); // re-opened off red
    expect(after.reengageCount).toBe(1);
    // The failed e2e was abandoned so the re-fixed build can re-verify.
    expect((await listHandoffs(run.id)).some((h) => h.role === "orchestrate")).toBe(false);
  });

  test("does NOT re-engage when the bot has not opted in (v1 parks at red)", async () => {
    const { run } = await seedVerifyingRun("research-6b000002");
    const chat = new ChatState();
    const stub = makeStubProcess();
    const router = new HivemindRouter(chat, makeDeps(makeBotConfig(/* no devLoop */), stub.fn));

    await router.route(P6_BOT, orchPeerRed(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;

    expect(stub.calls).toHaveLength(0);
    const after = (await getDevRunById(run.id))!;
    expect(after.status).toBe("red"); // parked for the user
    expect(after.reengageCount).toBe(0);
  });

  test("does NOT re-engage a build-phase red (no failed e2e) — parks for the user", async () => {
    // A build peer fails before any e2e runs: build failed, test done, NO
    // orchestrate handoff. Re-engaging build here can't safely roll the run up
    // (the failed build row would survive a cross-peer fix), so it must park.
    await setBotDefaultUser(P6_BOT, P6_OWNER);
    const thread = await createThread(P6_OWNER, P6_BOT, "research-6b000007");
    const run = await birthDevRun({ botName: P6_BOT, userId: P6_OWNER, issueKey: "research-6b000007", threadId: thread.id });
    await insertHandoff({ runId: run.id, peerName: "buildpeer", role: "build", status: "sent" });
    await insertHandoff({ runId: run.id, peerName: "testpeer", role: "test", status: "done" });
    const chat = new ChatState();
    const stub = makeStubProcess();
    const router = new HivemindRouter(chat, makeDeps(makeBotConfig({ autoReengageOnRed: true }), stub.fn));

    // The build peer reports failed (peerNameFor(cwd)=="buildpeer").
    const buildRed = makeMsg({
      fromId: "buildpeer-uuid",
      fromCwd: "/Users/test/source/nav/buildpeer",
      text: `build failed\n<!-- status: failed run:${shortRunId(run.id)} -->`,
    });
    await router.route(P6_BOT, buildRed);
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;

    expect(stub.calls).toHaveLength(0); // no re-engage — build/test red parks
    const after = (await getDevRunById(run.id))!;
    expect(after.status).toBe("red");
    expect(after.reengageCount).toBe(0); // cap untouched
  });

  test("stops at the per-run cap — a red run already at MAX doesn't re-fire", async () => {
    const { run } = await seedVerifyingRun("research-6b000003");
    // Pretend both attempts are spent and the run went red again on a failed e2e.
    const sql = getDb();
    await sql`UPDATE dev_runs SET status = 'red', reengage_count = ${MAX_REENGAGE_ATTEMPTS} WHERE id = ${run.id}`;
    await sql`UPDATE dev_run_handoffs SET status = 'failed' WHERE run_id = ${run.id} AND role = 'orchestrate'`;
    const chat = new ChatState();
    const stub = makeStubProcess();
    const router = new HivemindRouter(chat, makeDeps(makeBotConfig({ autoReengageOnRed: true }), stub.fn));

    await router.route(P6_BOT, orchPeerRed(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;

    expect(stub.calls).toHaveLength(0); // exhausted — surfaced to the user, not re-fired
    const after = (await getDevRunById(run.id))!;
    expect(after.status).toBe("red");
    expect(after.reengageCount).toBe(MAX_REENGAGE_ATTEMPTS); // not bumped past the cap
  });

  test("a flapping red marker doesn't re-fire (orchestrate handoff already cleared)", async () => {
    const { run } = await seedVerifyingRun("research-6b000004");
    const chat = new ChatState();
    const stub = makeStubProcess();
    const router = new HivemindRouter(chat, makeDeps(makeBotConfig({ autoReengageOnRed: true }), stub.fn));

    // First red tips + re-engages once (run re-opened, orchestrate handoff cleared).
    await router.route(P6_BOT, orchPeerRed(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;
    expect(stub.calls).toHaveLength(1);

    // A re-sent red marker now misses the (run, peer_name) join (orchestrate row is
    // gone) → no red verdict re-computed → no second re-engage.
    await router.route(P6_BOT, orchPeerRed(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;
    expect(stub.calls).toHaveLength(1); // not 2
    expect((await getDevRunById(run.id))!.reengageCount).toBe(1);
  });

  test("the hourly backstop blocks re-engage on a busy thread", async () => {
    const { run, thread } = await seedVerifyingRun("research-6b000005");
    // One prior assistant turn trips a maxAutoTurnsPerHour of 1.
    await saveMessage({
      userId: P6_OWNER, botName: P6_BOT, role: "assistant",
      content: "earlier turn", platform: "web", threadId: thread.id,
    });
    const chat = new ChatState();
    const stub = makeStubProcess();
    const router = new HivemindRouter(
      chat,
      makeDeps(makeBotConfig({ autoReengageOnRed: true, maxAutoTurnsPerHour: 1 }), stub.fn),
    );

    await router.route(P6_BOT, orchPeerRed(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;

    expect(stub.calls).toHaveLength(0); // backstopped
    const after = (await getDevRunById(run.id))!;
    expect(after.status).toBe("red"); // left red, not claimed/re-opened
    expect(after.reengageCount).toBe(0);
  });

  test("a thrown re-engage turn recomputes the run (no wedge at building)", async () => {
    const { run } = await seedVerifyingRun("research-6b000006");
    const chat = new ChatState();
    const calls: number[] = [];
    const throwingProcess: typeof ProcessMessageFn = async () => {
      calls.push(1);
      throw new Error("connector boom");
    };
    const router = new HivemindRouter(chat, makeDeps(makeBotConfig({ autoReengageOnRed: true }), throwingProcess));

    await router.route(P6_BOT, orchPeerRed(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun.catch(() => {}); // the turn throws + rethrows

    expect(calls).toHaveLength(1); // it did fire
    // The claim re-opened to building + cleared orchestrate; the compensating
    // recompute (build∧test still done, no orchestrate) lands ready_to_verify, so
    // the user can re-run e2e — recoverable, not stranded at a turn-less building.
    expect((await getDevRunById(run.id))!.status).toBe("ready_to_verify");
    expect((await getDevRunById(run.id))!.reengageCount).toBe(1); // the attempt stands
  });

  test("routes to the TEST agent when the classifier (opted in) judges spec/test drift", async () => {
    const { run } = await seedVerifyingRun("research-6b000008");
    const chat = new ChatState();
    const stub = makeStubProcess();
    const classifyCalls: Array<{ ctxHasCi: boolean }> = [];
    const classify: AutorespondDeps["classifyReengageRole"] = async (ctx) => {
      classifyCalls.push({ ctxHasCi: !!ctx.ciUrl });
      return "test";
    };
    const router = new HivemindRouter(
      chat,
      makeDeps(makeBotConfig({ autoReengageOnRed: true, reengageClassifier: true }), stub.fn, classify),
    );

    await router.route(P6_BOT, orchPeerRed(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;

    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]!.ctxHasCi).toBe(true); // got the failure context (CI URL)
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.text).toContain('role: "test"'); // routed to the test agent
    expect(stub.calls[0]!.text).toContain("testpeer"); // re-delegate to the test peer
    expect(stub.calls[0]!.text).not.toContain('role: "build"');
    const after = (await getDevRunById(run.id))!;
    expect(after.status).toBe("building");
    expect(after.reengageCount).toBe(1);
  });

  test("constructs the devloop_autostep tracer BEFORE classification and threads it into the classify call", async () => {
    const { run } = await seedVerifyingRun("research-6b00000b");
    const chat = new ChatState();
    const stub = makeStubProcess();
    const seenTraceIds: Array<string | undefined> = [];
    const classify: AutorespondDeps["classifyReengageRole"] = async (_ctx, opts) => {
      // The tracer must already exist when the classifier runs — this is the
      // whole point of the hoist (its haiku_usage row ties to the turn trace).
      seenTraceIds.push(opts.tracer?.traceId);
      return "build";
    };
    const router = new HivemindRouter(
      chat,
      makeDeps(makeBotConfig({ autoReengageOnRed: true, reengageClassifier: true }), stub.fn, classify),
    );

    await router.route(P6_BOT, orchPeerRed(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;

    expect(seenTraceIds).toHaveLength(1);
    expect(seenTraceIds[0]).toBeTruthy(); // classifier got a live tracer, not undefined
    // ...and it is the SAME tracer the turn runs under (single construction,
    // settled exactly once by the turn's try/catch — no leak on any path).
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.traceId).toBe(seenTraceIds[0]);
  });

  test("routes to the BUILD agent when the classifier judges a feature bug", async () => {
    const { run } = await seedVerifyingRun("research-6b000009");
    const chat = new ChatState();
    const stub = makeStubProcess();
    const classify: AutorespondDeps["classifyReengageRole"] = async () => "build";
    const router = new HivemindRouter(
      chat,
      makeDeps(makeBotConfig({ autoReengageOnRed: true, reengageClassifier: true }), stub.fn, classify),
    );

    await router.route(P6_BOT, orchPeerRed(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.text).toContain('role: "build"');
    expect(stub.calls[0]!.text).toContain("buildpeer");
    expect(stub.calls[0]!.text).not.toContain('role: "test"');
  });

  test("does NOT consult the classifier when reengageClassifier is off (always build)", async () => {
    const { run } = await seedVerifyingRun("research-6b00000a");
    const chat = new ChatState();
    const stub = makeStubProcess();
    let classifyCount = 0;
    const classify: AutorespondDeps["classifyReengageRole"] = async () => {
      classifyCount++;
      return "test";
    };
    const router = new HivemindRouter(
      chat,
      // autoReengageOnRed on, reengageClassifier OFF — the verified always-build path.
      makeDeps(makeBotConfig({ autoReengageOnRed: true }), stub.fn, classify),
    );

    await router.route(P6_BOT, orchPeerRed(run.id));
    await router.pendingHandoffInterpret;
    await router.pendingAdvanceRun;

    expect(classifyCount).toBe(0); // classifier not consulted
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.text).toContain('role: "build"'); // default route stands
  });
});
