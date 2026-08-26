import { Hono } from "hono";
import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { chatState, roleToSender, type ConversationType } from "./state.ts";
import { processChatMessage } from "./processor.ts";
import { renderChatPage } from "./views/page.ts";
import { listThreads, createThread, deleteThreadById, getThreadById, updateThreadConnector, setThreadAutoRespondPaused } from "../db/threads.ts";
import { listConnectors, getConnector } from "../db/connectors.ts";
import { getChatPreferences, setPreferredConnector, getBotDefaultUser, setBotDefaultUser } from "../db/chat-preferences.ts";
import { getSimMessages, getLastResponseMeta, getMostRecentPeerIdForThread, saveMessage, getMessageById } from "../db/messages.ts";
import { upsertFeedback, deleteFeedback } from "../db/message-feedback.ts";
import { hivemindManager } from "../hivemind/manager.ts";
import { parsePeerThreadName } from "../hivemind/router.ts";
import { setPendingPeer } from "../hivemind/correlation.ts";
import { mintCorrelationToken, setCorrelationToken } from "../hivemind/correlation-tokens.ts";
import { getToolUsageStats } from "../db/traces.ts";
import { linkSpecToDevRun, setResearchStageByThread, getDevRunByThreadId, listHandoffs, listDevRunEvents } from "../db/dev-runs.ts";
import { getMcpStatus, invalidateMcpStatus, getCachedMcpStatus, onMcpStatusChange } from "../ai/mcp-status.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { consumePendingMessage } from "./pending-messages.ts";
import { isValidUuid } from "../dashboard/routes/route-utils.ts";
import { resolveJiraBotLive } from "../jira/bot.ts";
import { getLog } from "../logging.ts";
import { requireOwnUser, forbiddenHead, sessionIdentity, sessionRole, extractionsForcedOff } from "../auth/guard.ts";
import { requireOwnedResource, filterToOwner, decideResourceAccess } from "../auth/resource-guard.ts";
import { pinnedLocalUserId } from "../auth/policy.ts";
import { streamSSE } from "hono/streaming";
import { agentStatus } from "../observability/agent-status.ts";
import { applyCors, corsHeaders } from "../auth/cors.ts";

const log = getLog("chat");

/**
 * Map an analysis-phase research prompt marker to the dev_run `research_stage` it
 * advances to (Phase 5). The chat drives which research affordances to show off
 * run state instead of a positional reply counter, so the Investigate / Deep
 * buttons (which prefix their text with these markers) advance the stage here.
 * Returns null for any other message. Exported for testing.
 */
export function researchStageForPrompt(text: string): "investigation" | "deep" | null {
  if (text.startsWith("<!-- prompt:investigate -->")) return "investigation";
  if (text.startsWith("<!-- prompt:deepAnalysis -->")) return "deep";
  return null;
}

/**
 * Drop the SHARE presets from the `prompts` blob `GET /bots` ships.
 *
 * The four research-flow bodies stay — the chat client types them into the
 * composer verbatim, so they are load-bearing on that page. `share`/`shareVariants`
 * are read by nothing here: the share dialog fetches its own merged list (which
 * includes the shipped defaults this payload never carried). Returned as a fresh
 * object, never a mutation of the discovered config.
 */
function stripSharePrompts(prompts: BotConfig["prompts"]): BotConfig["prompts"] {
  if (!prompts) return prompts;
  const { share: _share, shareVariants: _shareVariants, ...rest } = prompts;
  return rest;
}

/**
 * Creates the chat Hono sub-router.
 * Mounted at /chat on the main dashboard server.
 */
export function createChatRoutes(botConfigs: BotConfig[], config: Config): Hono {
  const app = new Hono();

  // Bridge MCP status changes from the ai/ layer into the chat WebSocket.
  // Wired here (not in ai/mcp-status.ts) to keep ai/ free of chat-state imports.
  onMcpStatusChange((botName, servers) => {
    chatState.publishMcpStatus(botName, servers);
  });

  // Serve the chat UI page
  app.get("/", async (c) => {
    return c.html(await renderChatPage());
  });

  // Knowledge viewable collections config for index document links
  app.get("/knowledge-config", (c) => {
    return c.json({ viewableCollections: config.knowledgeViewableCollections });
  });

  // List available bots + connectors
  app.get("/bots", async (c) => {
    const bots = botConfigs.map((b) => ({
      name: b.name,
      dir: b.dir,
      hasTelegram: !!b.telegramBotToken,
      hasSlack: !!b.slackBotToken,
      connector: b.connector ?? "claude-cli",
      model: b.model ?? null,
      baseUrl: b.baseUrl ?? null,
      showWaterfall: b.showWaterfall !== false,
      contextWindow: b.contextWindow ?? null,
      // The research-flow prompt BODIES ride along because the chat client types
      // them into the composer (`research-card.ts` inserts `investigateCode` /
      // `deepAnalysis` / `specGeneration` / `specDomain` verbatim). The SHARE
      // presets are stripped: nothing on this page reads them, they are the
      // longest prompts a bot carries, and the share dialog has its own route
      // (`GET /api/wiki/share/presets`) which resolves the shipped defaults too —
      // this payload never could have served it.
      prompts: stripSharePrompts(b.prompts),
      hivemindNamespaceCount: b.hivemind?.enabled ? b.hivemind.namespaces.length : 0,
    }));
    let connectors: Awaited<ReturnType<typeof listConnectors>> = [];
    try { connectors = await listConnectors(); } catch (err) {
      log.warn("Failed to load connectors: {error}", { error: err instanceof Error ? err.message : String(err) });
    }
    // Which of these bots the Jira composer drafts on — the ONE thing the page
    // needs in order to decide whether a bot message gets a «Lag Jira-sak»
    // control. Resolved SERVER-side (`JIRA_BOT`, no fallback) rather than
    // hardcoded in the client: a second copy of that name is exactly the drift
    // that makes the button appear on a bot whose thread the route then 400s.
    // `null` when the pinned name matches no discovered bot — the same install
    // state in which every `/api/jira/*` route 503s, so the control stays away.
    //
    // **`resolveJiraBotLive`, not `resolveJiraBot(botConfigs)`.** `botConfigs` is
    // the TOKEN-GATED list captured at process start; every `/api/jira/*` route
    // resolves over the live `discoverAllBots()`. Two lookups for one answer is
    // the same class of drift this field exists to remove one layer up.
    const jiraBot = resolveJiraBotLive()?.name ?? null;
    return c.json({ bots, connectors, jiraBot });
  });

  /**
   * Who the caller is, and whether the page may still offer a user PICKER.
   *
   * `mode: "local"` means "no server-side identity — pick a user", which is
   * today's muninn and what keeps the dropdown, `sim-user-1` and
   * `bot_default_user` working unchanged. `mode: "session"` means the server
   * decides, and the client must then NOT call `loadUsersForBot` at all: that
   * function issues `GET /api/users?bot=` AND
   * `GET /chat/bot-preferences/:botName/default-user` in one `allSettled` —
   * both admin-zone under §4 — and it is also what assigns `selectedUserId`
   * and `selectedUsername`, which every downstream fetch depends on. Skipping
   * only the first fetch would leave the authenticated client calling an admin
   * route with no id of its own.
   */
  app.get("/me", (c) => {
    const identity = sessionIdentity(c);
    if (!identity) return c.json({ mode: "local", userId: null, displayName: null, role: null });
    return c.json({
      mode: "session",
      userId: identity.userId,
      displayName: identity.displayName,
      navIdent: identity.navIdent,
      // The client branches on this for `bot_default_user`: a SINGLE pinned
      // local identity may keep writing that bot-global field (six readers
      // degrade silently without it), a multi-user provider may not.
      provider: identity.provider,
      role: sessionRole(c),
    });
  });

  /**
   * The chat page's OWN event stream — PR D's replacement for `GET /api/events`.
   *
   * Two channels, and deliberately only two: `agent_status` (the phase pill) and
   * `request_progress` (the single-pane waterfall). Those are the ones the chat
   * page renders as ITS OWN, and both were already viewer-scopeable
   * (`src/observability/agent-status.ts`).
   *
   * The other two channels on `/api/events` are why this route exists rather
   * than a `?viewer=` on that one: `activity` replays 50 events carrying the
   * full message text of every turn on the instance, and `agent_runs` is
   * `snapshotAll()` — every run process-wide, with `username`, `traceId` and
   * tool inputs. `EventSource` delivers every event over the wire regardless of
   * which ones the page reads, so "the page only registers two handlers" was
   * never a fix. **Nothing here may re-add `agent_runs`.**
   *
   * `?viewer=` goes through `requireOwnUser` exactly as it did on the old route:
   * the claim verbatim with auth off (the page picks its own user there), the
   * session id in any authenticating mode. The page still fails CLOSED and does
   * not connect at all without a resolved viewer — see `connectSSE` in
   * `views/page.ts`.
   */
  app.get("/events", (c) => {
    const own = requireOwnUser(c, c.req.query("viewer"));
    if (!own.ok) return own.response;
    const viewer = own.userId || undefined;
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "agent_status", data: JSON.stringify(agentStatus.get(viewer)) });
      await stream.writeSSE({ event: "request_progress", data: JSON.stringify(agentStatus.getProgress(viewer)) });

      let alive = true;
      const unsubscribeProgress = agentStatus.subscribeProgress(async (progress) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "request_progress", data: JSON.stringify(progress) });
        } catch {
          alive = false;
        }
      }, viewer);
      const unsubscribeStatus = agentStatus.subscribe(async (status) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "agent_status", data: JSON.stringify(status) });
        } catch {
          alive = false;
        }
      }, viewer);

      // Same 30s heartbeat as the operator stream: `Bun.serve`'s `idleTimeout`
      // is 255s, so a quiet chat page would otherwise be dropped and reconnect.
      const heartbeat = setInterval(async () => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "heartbeat", data: "{}" });
        } catch {
          alive = false;
        }
      }, 30_000);

      stream.onAbort(() => {
        alive = false;
        unsubscribeStatus();
        unsubscribeProgress();
        clearInterval(heartbeat);
      });

      while (alive) {
        await Bun.sleep(1000);
      }
    });
  });

  // Get chat preferences for a user+bot (connector, persisted in DB)
  app.get("/preferences/:userId/:botName", async (c) => {
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return own.response;
    try {
      const userId = own.userId!;
      const botName = c.req.param("botName");
      const prefs = await getChatPreferences(userId, botName);
      return c.json({ connectorId: prefs.preferredConnectorId });
    } catch (err) {
      log.error("Failed to fetch chat preferences: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ connectorId: null });
    }
  });

  // Set preferred connector for a user+bot (persisted in DB)
  app.put("/preferences/:userId/:botName/connector", async (c) => {
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return own.response;
    try {
      const userId = own.userId!;
      const botName = c.req.param("botName");
      const body = await c.req.json<{ connectorId: string | null }>();
      const connectorId = body.connectorId || null;
      if (connectorId && !isValidUuid(connectorId)) {
        return c.json({ error: "Invalid connectorId" }, 400);
      }
      await setPreferredConnector(userId, botName, connectorId);
      return c.json({ ok: true });
    } catch (err) {
      log.error("Failed to save chat preferences: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to save preferences" }, 500);
    }
  });

  // Get default user for a bot (single source of truth for plugin + chat page)
  app.get("/bot-preferences/:botName/default-user", async (c) => {
    applyCors(c);
    try {
      const botName = c.req.param("botName");
      const userId = await getBotDefaultUser(botName);
      return c.json({ userId });
    } catch (err) {
      log.error("Failed to fetch bot default user: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ userId: null });
    }
  });

  // Set default user for a bot
  app.put("/bot-preferences/:botName/default-user", async (c) => {
    applyCors(c);
    try {
      const botName = c.req.param("botName");
      const body = await c.req.json<{ userId: string }>();
      if (!body.userId) {
        return c.json({ error: "userId is required" }, 400);
      }
      await setBotDefaultUser(botName, body.userId);
      return c.json({ ok: true });
    } catch (err) {
      log.error("Failed to save bot default user: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to save default user" }, 500);
    }
  });

  // CORS preflight for bot-preferences (Chrome extension)
  app.options("/bot-preferences/:botName/default-user", (c) => {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(c, {
        "Access-Control-Allow-Methods": "GET, PUT",
        "Access-Control-Allow-Headers": "Content-Type",
      }),
    });
  });

  // Create a new conversation
  app.post("/conversations", async (c) => {
    const body = await c.req.json<{
      type: ConversationType;
      botName: string;
      userId?: string;
      username?: string;
      channelName?: string;
    }>();

    const own = requireOwnUser(c, body.userId, body.username);
    if (!own.ok) return own.response;

    if (!body.type || !body.botName) {
      return c.json({ error: "type and botName are required" }, 400);
    }

    const bot = botConfigs.find((b) => b.name === body.botName);
    if (!bot) {
      return c.json({ error: `Bot "${body.botName}" not found` }, 404);
    }

    const validTypes: ConversationType[] = ["telegram_dm", "slack_dm", "slack_channel", "slack_assistant", "web"];
    if (!validTypes.includes(body.type)) {
      return c.json({ error: `Invalid type. Must be one of: ${validTypes.join(", ")}` }, 400);
    }

    if (body.type === "slack_channel" && !body.channelName) {
      return c.json({ error: "channelName is required for slack_channel type" }, 400);
    }

    // The claimed pair. In an authenticating mode BOTH come from the session:
    // `username` is a second client-supplied identity, and while it never
    // clobbers `users.username` (the web path passes `lockUsername`), it does
    // reach the prompt's speaker label, `traces.username`, the `activity_log`
    // row and `AgentRun.username`. `"sim-user-1"` is unreachable there for the
    // same reason — `own.userId` is always a string once an identity exists.
    const userId = own.userId ?? "sim-user-1";
    const username = own.username ?? body.username ?? "chat-user";

    // A web conversation gets the DETERMINISTIC id — the one hydrateFromDb
    // rebuilds it under and every off-band broadcaster computes. Minting a
    // random UUID here (what this route used to do, and the path the chat page
    // takes on a user's very first turn with a bot) produced a shell nothing
    // could ever address again: unreachable after a restart, and unreachable
    // from a dev_run or Jira roll-up in the same process.
    const conversation = body.type === "web"
      ? await chatState.findOrCreateBotConversation({ botName: body.botName, userId, username })
      : chatState.createConversation({
        type: body.type,
        botName: body.botName,
        userId,
        username,
        channelName: body.channelName,
      });

    return c.json({ conversation }, 201);
  });

  // List all conversations
  app.get("/conversations", (c) => {
    // The FILTER shape (§4's third annotation). This route has neither a claimed
    // id nor a single resource, so it cannot be gated — it must return less. It
    // publishes `id`, `userId` and `username` for every conversation in memory,
    // i.e. exactly the derivable id set every `requireOwnedResource` route below
    // is protecting; guarding those while leaving this index open would close
    // nothing.
    const conversations = filterToOwner(c, chatState.getConversations(), (conv) => conv.userId).map((conv) => ({
      id: conv.id,
      type: conv.type,
      botName: conv.botName,
      userId: conv.userId,
      username: conv.username,
      channelName: conv.channelName,
      messageCount: conv.messages.length,
      status: conv.status,
    }));
    return c.json({ conversations });
  });

  // Get a specific conversation with messages
  app.get("/conversations/:id", async (c) => {
    const id = c.req.param("id");
    const owned = await requireOwnedResource(c, "conversation", id);
    const conversation = owned.ok ? chatState.getConversation(id) : undefined;
    if (!conversation) {
      // The denial and the genuine miss are the SAME expression, deliberately: a
      // web conversation id is derivable, so a 403 (or a differently-worded 404)
      // would confirm "this id exists and is someone else's".
      return c.json({ error: "Conversation not found" }, 404);
    }
    return c.json({ conversation });
  });

  // Delete a specific conversation
  app.delete("/conversations/:id", async (c) => {
    const id = c.req.param("id");
    const owned = await requireOwnedResource(c, "conversation", id);
    // BEFORE the delete, not after: the effect is the thing being guarded.
    if (!owned.ok || !chatState.deleteConversation(id)) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    return c.json({ ok: true });
  });

  // Create a new thread for a user+bot
  app.post("/threads", async (c) => {
    const body = await c.req.json<{ userId: string; botName: string; name: string; description?: string; connectorId?: string }>();
    const own = requireOwnUser(c, body.userId);
    if (!own.ok) return own.response;
    if (!own.userId || !body.botName || !body.name) {
      return c.json({ error: "userId, botName, and name are required" }, 400);
    }
    const bot = botConfigs.find((b) => b.name === body.botName);
    if (!bot) {
      return c.json({ error: `Bot "${body.botName}" not found` }, 404);
    }
    if (body.connectorId && !isValidUuid(body.connectorId)) {
      return c.json({ error: "Invalid connectorId" }, 400);
    }
    try {
      const thread = await createThread(own.userId, body.botName, body.name, body.description, body.connectorId);
      return c.json({ thread }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // List threads for a user+bot (excludes slack: threads)
  app.get("/threads/:userId/:botName", async (c) => {
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return own.response;
    const userId = own.userId!;
    const botName = c.req.param("botName");
    const allThreads = await listThreads(userId, botName);
    const threads = allThreads.filter((t) => !t.name.startsWith("slack:"));
    return c.json({ threads });
  });

  // Update a thread's connector
  app.patch("/threads/:id/connector", async (c) => {
    const id = c.req.param("id");
    if (!isValidUuid(id)) return c.json({ error: "Invalid thread ID" }, 400);
    const owned = await requireOwnedResource(c, "thread", id);
    if (!owned.ok) return c.json({ error: "Thread not found" }, 404);
    const body = await c.req.json<{ connectorId: string | null }>();
    if (body.connectorId && !isValidUuid(body.connectorId)) {
      return c.json({ error: "Invalid connectorId" }, 400);
    }
    try {
      const updated = await updateThreadConnector(id, body.connectorId ?? null);
      if (!updated) return c.json({ error: "Thread not found" }, 404);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Toggle hivemind autorespond pause for a peer thread
  app.patch("/threads/:id/auto-respond", async (c) => {
    const id = c.req.param("id");
    if (!isValidUuid(id)) return c.json({ error: "Invalid thread ID" }, 400);
    const owned = await requireOwnedResource(c, "thread", id);
    if (!owned.ok) return c.json({ error: "Thread not found" }, 404);
    const body = await c.req.json<{ paused: boolean; reason?: string }>();
    if (typeof body.paused !== "boolean") {
      return c.json({ error: "paused (boolean) is required" }, 400);
    }
    try {
      const updated = await setThreadAutoRespondPaused(id, body.paused, body.paused ? body.reason ?? "manual" : null);
      if (!updated) return c.json({ error: "Thread not found" }, 404);
      const thread = await getThreadById(id);
      return c.json({ ok: true, thread });
    } catch (err) {
      log.error("Failed to toggle auto-respond: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to update thread" }, 500);
    }
  });

  // Delete a thread by ID (including messages and associated memories)
  app.delete("/threads/:id", async (c) => {
    const id = c.req.param("id");
    try {
      // INSIDE the try, and behind the uuid check: `threads.id` is a uuid column,
      // so a non-uuid is a postgres cast error, and a guard placed above the
      // existing `try` put that error outside the catch that used to absorb it.
      if (!isValidUuid(id)) return c.json({ error: "Thread not found or is the main thread" }, 404);
      const owned = await requireOwnedResource(c, "thread", id);
      // Same wording as the route's own miss below: "not yours" and "not there"
      // must be one answer.
      if (!owned.ok) return c.json({ error: "Thread not found or is the main thread" }, 404);
      const deleted = await deleteThreadById(id);
      if (!deleted) {
        return c.json({ error: "Thread not found or is the main thread" }, 404);
      }
      log.info("Deleted thread {threadId} ({threadName}) for user {userId}", {
        threadId: deleted.id, threadName: deleted.name, userId: deleted.userId,
      });
      return c.json({ ok: true, thread: deleted });
    } catch (err) {
      log.error("Failed to delete thread: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to delete thread" }, 500);
    }
  });

  // Get messages for a conversation, optionally filtered by thread
  app.get("/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    const owned = await requireOwnedResource(c, "conversation", id);
    const conversation = owned.ok ? chatState.getConversation(id) : undefined;
    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const threadId = c.req.query("thread");
    const raw = c.req.query("raw") === "true";
    const platform = conversationTypeToPlatform(conversation.type);
    const isWeb = conversation.type === "web";
    const msgs = await getSimMessages(
      conversation.userId,
      conversation.botName,
      platform,
      200,
      threadId || undefined,
      true,
    );
    return c.json({
      messages: msgs.map((m) => ({
        id: m.id,
        sender: roleToSender(m.role),
        text: raw ? m.content : (isWeb && m.role === "assistant" ? formatWebHtml(m.content) : m.content),
        timestamp: m.createdAt,
        threadId: m.threadId,
        traceId: m.traceId,
        fromPeerId: m.fromPeerId,
        model: m.model,
      })),
    });
  });

  // Response-quality feedback: a lightweight 👍/👎 on an assistant message.
  // value 1 / -1 upserts; value null clears. user/bot/platform are derived from
  // the message row (not trusted from the client). Capture-only — nothing
  // consumes this yet; the point is to accumulate a labeled dataset.
  app.post("/feedback", async (c) => {
    const body = await c.req.json<{ messageId?: string; value?: number | null }>();
    const messageId = body.messageId;
    if (!messageId || !isValidUuid(messageId)) {
      return c.json({ error: "valid messageId is required" }, 400);
    }
    if (body.value !== 1 && body.value !== -1 && body.value !== null) {
      return c.json({ error: "value must be 1, -1, or null" }, 400);
    }

    const owner = await getMessageById(messageId);
    // The resource guard runs on the SAME row the route already reads, so the
    // lookup is not repeated: `requireOwnedResource` would re-read `messages`
    // for an answer that is in hand. The verdict is the shared one.
    if (
      !owner ||
      !decideResourceAccess({
        sessionUserId: sessionIdentity(c)?.userId ?? null,
        role: sessionRole(c),
        owner: { found: true, userId: owner.userId },
        nullOwnerAllowed: pinnedLocalUserId() !== null,
      }).ok
    ) {
      return c.json({ error: "Message not found" }, 404);
    }

    if (body.value === null) {
      await deleteFeedback(messageId, owner.userId, "web");
      return c.json({ ok: true, value: null });
    }

    await upsertFeedback({
      messageId,
      userId: owner.userId,
      botName: owner.botName,
      platform: owner.platform,
      source: "web",
      value: body.value,
    });
    return c.json({ ok: true, value: body.value });
  });

  // Consume a pending research message (one-time use)
  app.get("/pending/:threadId", async (c) => {
    const threadId = c.req.param("threadId");
    // BEFORE the consume. This route DESTROYS what it reads, which is why it is
    // also on `SIDE_EFFECTING_GETS`: a guard placed after it would answer 404
    // having already thrown away the owner's pending message. The denial is the
    // route's own "nothing pending" answer — `{ text: null }` — because that is
    // what it says for a threadId it does not know.
    //
    // The uuid pre-check is the guard's, not the route's: `threads.id` is a uuid
    // COLUMN, so an unparseable value reaches postgres as a cast ERROR rather
    // than an empty result, and this handler has no `try`. Without it the guard
    // turned `GET /chat/pending/garbage` from `{text:null}` into a 500 — the
    // `unknownDraft` rule the Jira routes already live by.
    if (!isValidUuid(threadId)) return c.json({ text: null });
    const owned = await requireOwnedResource(c, "thread", threadId);
    if (!owned.ok) return c.json({ text: null });
    const pending = consumePendingMessage(threadId);
    if (!pending) return c.json({ text: null });
    return c.json({ text: pending.text, jiraContent: pending.jiraContent, title: pending.title });
  });

  // Send a message in a conversation (triggers Claude processing)
  app.post("/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    // The route this whole PR exists for: it spends a model turn AS the
    // conversation's owner and writes into their thread. PR C could not reach
    // it — it names no `userId` at all.
    const owned = await requireOwnedResource(c, "conversation", id);
    const conversation = owned.ok ? chatState.getConversation(id) : undefined;
    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const body = await c.req.json<{ text: string; threadId?: string; connector?: string; skipExtractions?: boolean }>();
    if (!body.text) {
      return c.json({ error: "text is required" }, 400);
    }

    // ⚠️ This route addresses TWO resources, and guarding only `:id` was the
    // review round's highest finding. `body.threadId` reaches, below and
    // downstream: `handlePeerOutbound` (which `saveMessage`s under the THREAD
    // owner's `user_id` and sends out on their hivemind peer),
    // `setResearchStageByThread` (an unconditional cross-user UPDATE), the
    // thread's connector, and `processChatMessage`, which persists the turn
    // against that thread — the same key `seedThreadCitations` and
    // `GET /api/jira/drafts?thread=` read. Owning the conversation says nothing
    // about owning the thread. Same 404 as the conversation's, so a thread id
    // cannot be probed through this route either.
    if (body.threadId) {
      if (!isValidUuid(body.threadId)) return c.json({ error: "Conversation not found" }, 404);
      const ownsThread = await requireOwnedResource(c, "thread", body.threadId);
      if (!ownsThread.ok) return c.json({ error: "Conversation not found" }, 404);
    }

    const bot = botConfigs.find((b) => b.name === conversation.botName);
    if (!bot) {
      return c.json({ error: `Bot "${conversation.botName}" not found` }, 404);
    }

    if (body.threadId && body.text.startsWith(">")) {
      const peerThread = await getThreadById(body.threadId);
      if (peerThread?.name.startsWith("peer:")) {
        const result = await handlePeerOutbound(id, peerThread, conversation.username, body.text);
        return c.json(result.body, result.status);
      }
    }

    const connectorOverride = body.connector === "copilot-sdk" || body.connector === "claude-cli"
      ? body.connector as "copilot-sdk" | "claude-cli"
      : undefined;

    // Look up thread's connector override (if any)
    let threadConnector: Awaited<ReturnType<typeof getConnector>> = null;
    if (body.threadId) {
      try {
        const thread = await getThreadById(body.threadId);
        if (thread?.connectorId) {
          threadConnector = await getConnector(thread.connectorId);
        }
      } catch (err) {
        log.warn("Failed to resolve thread connector: {error}", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Phase 5: advance the dev_run's research_stage from the analysis-phase
    // prompt markers so the chat can drive affordance visibility off run state
    // (not a positional reply counter). Awaited (it's a single fast UPDATE) so the
    // stage is committed BEFORE the bot turn even starts — the client re-reads it
    // after the reply, so the write must win that race. A runless thread is a
    // no-op; any error is swallowed so it never blocks the turn.
    if (body.threadId) {
      const stage = researchStageForPrompt(body.text);
      if (stage) {
        try {
          await setResearchStageByThread(body.threadId, stage);
        } catch (err) {
          log.warn("Failed to set research_stage: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Process asynchronously — response comes via WebSocket
    // Server-side FORCE, not a default: `skipExtractions` is a checkbox in the
    // inspector panel, so a rule that only read the body could be cleared by
    // the client. §8's ROS decision is that memory/goal/schedule extraction is
    // off for `platform = 'entra'` accounts — a turn a colleague types must not
    // write distilled facts about them as a side effect of ordinary use. Inert
    // for a `local` identity and with auth off.
    const skipExtractions = body.skipExtractions || extractionsForcedOff(c);
    processChatMessage(id, body.text, bot, config, body.threadId, connectorOverride, threadConnector ?? undefined, skipExtractions).catch((err) => {
      log.error("Error processing message: {error}", { error: err instanceof Error ? err.message : String(err) });
      // Add error message to conversation
      chatState.addMessage(id, {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        sender: "bot",
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
      chatState.setStatus(id, "");
    });

    return c.json({ status: "processing" }, 202);
  });

  // Last response context usage for a user+bot (survives page refresh)
  app.get("/context-usage/:userId/:botName", async (c) => {
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return own.response;
    const userId = own.userId!;
    const botName = c.req.param("botName");
    const threadId = c.req.query("thread");
    const bot = botConfigs.find((b) => b.name === botName);
    try {
      const meta = await getLastResponseMeta(userId, botName, threadId);
      if (!meta) return c.json({ inputTokens: 0, outputTokens: 0, contextWindow: bot?.contextWindow ?? null });
      return c.json({ ...meta, contextWindow: bot?.contextWindow ?? null });
    } catch (err) {
      log.warn("Failed to load context usage: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ inputTokens: 0, outputTokens: 0, contextWindow: null });
    }
  });

  // Aggregate tool usage stats from traces for a user+bot
  app.get("/tool-usage/:userId/:botName", async (c) => {
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return own.response;
    const userId = own.userId!;
    const botName = c.req.param("botName");
    const threadId = c.req.query("thread");
    try {
      const tools = await getToolUsageStats(userId, botName, threadId);
      return c.json({ tools });
    } catch (err) {
      log.warn("Failed to load tool usage: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ tools: [] });
    }
  });

  // MCP server status for a bot. Serves the cached snapshot immediately when
  // one exists and revalidates in the background — getMcpStatus() is a cheap
  // cache hit while the TTL is fresh, and once expired it re-probes and pushes
  // the result to the panel via the onMcpStatusChange → WebSocket bridge
  // (stale-while-revalidate). Only blocks on a probe when nothing is cached.
  app.get("/mcp-status/:botName", async (c) => {
    const botName = c.req.param("botName");
    const bot = botConfigs.find((b) => b.name === botName);
    if (!bot) return c.json({ error: `Bot "${botName}" not found` }, 404);
    try {
      const cached = getCachedMcpStatus(botName);
      if (cached) {
        getMcpStatus(bot).catch((err) => {
          log.warn("Background MCP re-probe failed for {bot}: {error}", { bot: botName, error: err instanceof Error ? err.message : String(err) });
        });
        return c.json({ servers: cached, cached: true });
      }
      const servers = await getMcpStatus(bot);
      return c.json({ servers, cached: false });
    } catch (err) {
      log.warn("Failed to load MCP status for {bot}: {error}", { bot: botName, error: err instanceof Error ? err.message : String(err) });
      return c.json({ servers: [], cached: false });
    }
  });

  // Force re-probe MCP status — invalidates cache and probes
  app.post("/mcp-status/:botName/refresh", async (c) => {
    const botName = c.req.param("botName");
    const bot = botConfigs.find((b) => b.name === botName);
    if (!bot) return c.json({ error: `Bot "${botName}" not found` }, 404);
    invalidateMcpStatus(botName);
    try {
      const servers = await getMcpStatus(bot, { force: true });
      return c.json({ servers });
    } catch (err) {
      log.warn("Failed to refresh MCP status for {bot}: {error}", { bot: botName, error: err instanceof Error ? err.message : String(err) });
      return c.json({ servers: [] }, 500);
    }
  });

  // Validate issueKey to prevent path traversal (Jira keys or research-<uuid> fallback)
  const VALID_ISSUE_KEY = /^[A-Z]+-\d+$|^research-[a-f0-9]{8}$/;
  /**
   * The charset a `userId` may have when it becomes a PATH SEGMENT.
   *
   * `/chat/reports/*` and `/chat/specs/*` address a file
   * (`resolve(bot.dir, "reports", userId, …)`), so under PR C this is checked
   * AFTER `requireOwnUser` has substituted the session id — never before.
   * Guarding the claim and then writing an unchecked session id would move the
   * traversal surface from the request onto `MUNINN_LOCAL_USER`.
   *
   * The converse is a config trap, so `resolveAuthConfig` warns at boot: a
   * pinned id containing `.`, `@` or `:` is a perfectly good `users.id`
   * everywhere else and makes only these six routes 400.
   */
  const VALID_USER_ID = /^[a-zA-Z0-9_-]+$/;
  // dev_run statuses a spec save may set: draft on Save Spec, approved at the fagperson gate.
  const VALID_SPEC_STATUS = new Set(["spec_draft", "spec_approved"]);

  // Save a research report file to bots/<botName>/reports/<userId>/<issueKey>.md
  app.post("/reports/:botName/:userId/:issueKey", async (c) => {
    const botName = c.req.param("botName");
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return own.response;
    // Validated AFTER the substitution, never before: these routes address a
    // FILE (`resolve(bot.dir, "reports", userId, …)`), so the value that lands
    // in the path is the one that has to be checked. Guarding the claim and
    // then writing the session id would move the traversal surface onto
    // `MUNINN_LOCAL_USER`.
    const userId = own.userId!;
    const issueKey = c.req.param("issueKey");
    if (!VALID_USER_ID.test(userId)) return c.json({ error: "Invalid user ID" }, 400);
    if (!VALID_ISSUE_KEY.test(issueKey)) return c.json({ error: "Invalid issue key" }, 400);
    const bot = botConfigs.find((b) => b.name === botName);
    if (!bot) return c.json({ error: `Bot "${botName}" not found` }, 404);

    const body = await c.req.json<{ content: string }>();
    if (!body.content) return c.json({ error: "content is required" }, 400);

    // Best-effort: stamp analysis_trace_id into the frontmatter (shared helper).
    const enrichedContent = await enrichWithAnalysisTraceId(body.content, userId, botName, "report");

    const reportPath = resolve(bot.dir, "reports", userId, `${issueKey}.md`);
    await mkdir(dirname(reportPath), { recursive: true });
    await Bun.write(reportPath, enrichedContent);
    log.info("Saved research report {path}", { botName, userId, path: reportPath });
    return c.json({ ok: true, path: `reports/${userId}/${issueKey}.md` }, 201);
  });

  // Get a research report
  app.get("/reports/:botName/:userId/:issueKey", async (c) => {
    const botName = c.req.param("botName");
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return own.response;
    // See VALID_USER_ID: checked AFTER the substitution, deliberately.
    const userId = own.userId!;
    const issueKey = c.req.param("issueKey");
    if (!VALID_USER_ID.test(userId)) return c.json({ error: "Invalid user ID" }, 400);
    if (!VALID_ISSUE_KEY.test(issueKey)) return c.json({ error: "Invalid issue key" }, 400);
    const bot = botConfigs.find((b) => b.name === botName);
    if (!bot) return c.json({ error: `Bot "${botName}" not found` }, 404);

    const file = Bun.file(resolve(bot.dir, "reports", userId, `${issueKey}.md`));
    if (!(await file.exists())) return c.json({ error: "Report not found" }, 404);
    const content = await file.text();
    return c.json({ content });
  });

  // Check if a research report exists (lightweight)
  app.on("HEAD", "/reports/:botName/:userId/:issueKey", async (c) => {
    const botName = c.req.param("botName");
    // Bodyless 403: an unguarded HEAD here is a 200/404 ORACLE over whether a
    // colleague has a saved report or spec for a given Jira key, and the chat
    // client probes exactly this endpoint.
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return forbiddenHead(c);
    const userId = own.userId!;
    const issueKey = c.req.param("issueKey");
    if (!VALID_USER_ID.test(userId)) return c.body(null, 400);
    if (!VALID_ISSUE_KEY.test(issueKey)) return c.body(null, 400);
    const bot = botConfigs.find((b) => b.name === botName);
    if (!bot) return c.body(null, 404);

    const file = Bun.file(resolve(bot.dir, "reports", userId, `${issueKey}.md`));
    return c.body(null, (await file.exists()) ? 200 : 404);
  });

  // --- Domain test-specs (Phase 0) ---------------------------------------
  // Persist the domain layer of a spec as a first-class artifact, mirroring
  // the report endpoints. This is the staging/review copy (gitignored,
  // per-developer); the canonical version-controlled spec lives in the
  // e2e-tests repo where the test agent lands the full file with binding.

  // Save a domain spec to bots/<botName>/specs/<userId>/<issueKey>.md
  app.post("/specs/:botName/:userId/:issueKey", async (c) => {
    const botName = c.req.param("botName");
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return own.response;
    // See VALID_USER_ID: checked AFTER the substitution, deliberately.
    const userId = own.userId!;
    const issueKey = c.req.param("issueKey");
    if (!VALID_USER_ID.test(userId)) return c.json({ error: "Invalid user ID" }, 400);
    if (!VALID_ISSUE_KEY.test(issueKey)) return c.json({ error: "Invalid issue key" }, 400);
    const bot = botConfigs.find((b) => b.name === botName);
    if (!bot) return c.json({ error: `Bot "${botName}" not found` }, 404);

    const body = await c.req.json<{ content: string; status?: string }>();
    if (!body.content) return c.json({ error: "content is required" }, 400);
    // Optional dev_run status flip: spec_draft on save, spec_approved at the
    // fagperson gate. Validated up front so a bad status never writes the file.
    if (body.status !== undefined && !VALID_SPEC_STATUS.has(body.status)) {
      return c.json({ error: "Invalid status" }, 400);
    }

    const enrichedContent = await enrichWithAnalysisTraceId(body.content, userId, botName, "spec");
    const relPath = `specs/${userId}/${issueKey}.md`;
    const specPath = resolve(bot.dir, "specs", userId, `${issueKey}.md`);
    await mkdir(dirname(specPath), { recursive: true });
    await Bun.write(specPath, enrichedContent);
    log.info("Saved domain spec {path}", { botName, userId, path: specPath });

    // Best-effort: link the spec to its dev_run (born at research-thread
    // creation, keyed by the same bot/user/issueKey). A DB hiccup or a missing
    // run must never fail the save — the file is the artifact that matters.
    if (body.status) {
      try {
        const linked = await linkSpecToDevRun({ botName, userId, issueKey, specPath: relPath, status: body.status });
        if (!linked) log.warn("Saved spec but no dev_run to link {issueKey}", { botName, userId, issueKey });
      } catch (err) {
        log.warn("Failed to link spec to dev_run: {error}", {
          botName,
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return c.json({ ok: true, path: relPath }, 201);
  });

  // Get a domain spec
  app.get("/specs/:botName/:userId/:issueKey", async (c) => {
    const botName = c.req.param("botName");
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return own.response;
    // See VALID_USER_ID: checked AFTER the substitution, deliberately.
    const userId = own.userId!;
    const issueKey = c.req.param("issueKey");
    if (!VALID_USER_ID.test(userId)) return c.json({ error: "Invalid user ID" }, 400);
    if (!VALID_ISSUE_KEY.test(issueKey)) return c.json({ error: "Invalid issue key" }, 400);
    const bot = botConfigs.find((b) => b.name === botName);
    if (!bot) return c.json({ error: `Bot "${botName}" not found` }, 404);

    const file = Bun.file(resolve(bot.dir, "specs", userId, `${issueKey}.md`));
    if (!(await file.exists())) return c.json({ error: "Spec not found" }, 404);
    const content = await file.text();
    return c.json({ content });
  });

  // Check if a domain spec exists (lightweight — gates downstream buttons)
  app.on("HEAD", "/specs/:botName/:userId/:issueKey", async (c) => {
    const botName = c.req.param("botName");
    // Bodyless 403 — the 200/404 oracle; see the first HEAD route above.
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return forbiddenHead(c);
    const userId = own.userId!;
    const issueKey = c.req.param("issueKey");
    if (!VALID_USER_ID.test(userId)) return c.body(null, 400);
    if (!VALID_ISSUE_KEY.test(issueKey)) return c.body(null, 400);
    const bot = botConfigs.find((b) => b.name === botName);
    if (!bot) return c.body(null, 404);

    const file = Bun.file(resolve(bot.dir, "specs", userId, `${issueKey}.md`));
    return c.body(null, (await file.exists()) ? 200 : 404);
  });

  // Live dev_run state for a research thread (Phase 5). The chat fetches this on
  // entering a research thread and after each bot reply to render the live run
  // card + per-handoff rows and to drive affordance visibility off run state.
  // 404 when the thread has no run (older / non-research threads) — the client
  // then falls back to the default analysis affordances.
  app.get("/dev-run/by-thread/:threadId", async (c) => {
    const threadId = c.req.param("threadId");
    if (!isValidUuid(threadId)) return c.json({ error: "Invalid thread ID" }, 400);
    const owned = await requireOwnedResource(c, "thread", threadId);
    if (!owned.ok) return c.json({ error: "No dev_run for thread" }, 404);
    const run = await getDevRunByThreadId(threadId);
    if (!run) return c.json({ error: "No dev_run for thread" }, 404);
    const handoffs = await listHandoffs(run.id);
    // events (Phase B) hydrate the inspector Agents tab's discoveries timeline on a
    // reload / thread-open; live appends arrive via the dev_run_event WS broadcast.
    // Best-effort: the additive timeline must never take down the load-bearing
    // run + handoffs payload (e.g. on a DB that runs this code without migration 043).
    const events = await listDevRunEvents(run.id).catch((err) => {
      log.warn("Failed to load dev_run_events for {run}: {error}", {
        run: run.id, error: err instanceof Error ? err.message : String(err),
      });
      return [];
    });
    return c.json({ run, handoffs, events });
  });

  return app;
}

/**
 * Best-effort: stamp `analysis_trace_id` into a research artifact's YAML
 * frontmatter so the saved file can later be linked back to the muninn
 * analysis trace (e.g. for the benchmark judge). Pulls the most recent
 * assistant message with a trace for this user+bot. Returns the content
 * unchanged if there's no recent trace or no leading frontmatter block.
 * Shared by the /reports and /specs save endpoints.
 */
async function enrichWithAnalysisTraceId(
  content: string,
  userId: string,
  botName: string,
  kind: "report" | "spec",
): Promise<string> {
  try {
    const recentMessages = await getSimMessages(userId, botName, "web", 20, undefined, true);
    // getSimMessages returns oldest-first, so reverse to get newest-first
    const newestFirst = [...recentMessages].reverse();
    const mostRecentBotTrace = newestFirst.find((m) => m.role === "assistant" && m.traceId)?.traceId;
    if (mostRecentBotTrace && /^---\n[\s\S]*?\n---/.test(content)) {
      log.info("Enriched {kind} with analysis_trace_id {traceId}", { botName, userId, kind, traceId: mostRecentBotTrace });
      return content.replace(/^---\n([\s\S]*?)\n---/, `---\n$1\nanalysis_trace_id: ${mostRecentBotTrace}\n---`);
    }
  } catch (err) {
    log.warn("Failed to enrich {kind} with analysis_trace_id: {error}", {
      botName,
      userId,
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return content;
}

/** Map ConversationType to the platform string used in the DB */
function conversationTypeToPlatform(type: ConversationType): string {
  switch (type) {
    case "telegram_dm": return "telegram";
    case "web": return "web";
    default: return type; // slack_dm, slack_channel, slack_assistant match directly
  }
}

async function handlePeerOutbound(
  conversationId: string,
  thread: { id: string; userId: string; botName: string; name: string },
  username: string,
  rawText: string,
): Promise<{ status: 202 | 400 | 503; body: { status?: string; error?: string } }> {
  // Token after `>` is advisory; recipient is always the thread's most-recent peer.
  const stripped = rawText.replace(/^>\s*\S*\s*/, "").trim();
  if (!stripped) {
    return { status: 400, body: { error: "Empty message after stripping `>` prefix" } };
  }

  // Outbound goes through the same WS the inbound came in on; namespace is
  // encoded in the thread name. `getAnyClient` is the fallback for legacy
  // unmigrated `peer:<name>` rows (pre-Phase-4 format).
  const parsed = parsePeerThreadName(thread.name);
  const client = parsed
    ? hivemindManager.getClient(thread.botName, parsed.namespace)
    : hivemindManager.getAnyClient(thread.botName);
  if (!client) {
    return { status: 503, body: { error: "Hivemind is not enabled for this bot in that namespace" } };
  }
  if (!client.isConnected) {
    return { status: 503, body: { error: "Hivemind broker is not connected" } };
  }

  const targetPeerId = await getMostRecentPeerIdForThread(thread.id);
  if (!targetPeerId) {
    return { status: 400, body: { error: "No prior peer message in this thread to reply to" } };
  }

  // Record so an unsolicited reply from this peer routes back to this thread
  // instead of falling into the default peer:<ns>/<name> thread for the bot.
  // Mint a token for the precise path; keep the (bot, peer) row as the
  // un-echoed fallback for peers that don't echo it.
  const correlationId = mintCorrelationToken();
  await Promise.all([
    setCorrelationToken(thread.botName, correlationId, thread.id),
    setPendingPeer(thread.botName, targetPeerId, thread.id),
  ]);
  const sent = client.sendMessage(targetPeerId, stripped, correlationId);
  if (!sent) {
    return { status: 503, body: { error: "Failed to send to peer (WebSocket write failed)" } };
  }

  const messageId = await saveMessage({
    userId: thread.userId,
    botName: thread.botName,
    username,
    role: "user",
    content: stripped,
    platform: "web",
    threadId: thread.id,
  });
  chatState.addMessage(conversationId, {
    id: messageId,
    timestamp: Date.now(),
    sender: "user",
    text: stripped,
    threadId: thread.id,
  });

  return { status: 202, body: { status: "sent" } };
}
