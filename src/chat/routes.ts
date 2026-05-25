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
import { getSimMessages, getLastResponseMeta, getMostRecentPeerIdForThread, saveMessage } from "../db/messages.ts";
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
import { getLog } from "../logging.ts";

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
      prompts: b.prompts,
      hivemindNamespaceCount: b.hivemind?.enabled ? b.hivemind.namespaces.length : 0,
    }));
    let connectors: Awaited<ReturnType<typeof listConnectors>> = [];
    try { connectors = await listConnectors(); } catch (err) {
      log.warn("Failed to load connectors: {error}", { error: err instanceof Error ? err.message : String(err) });
    }
    return c.json({ bots, connectors });
  });

  // Get chat preferences for a user+bot (connector, persisted in DB)
  app.get("/preferences/:userId/:botName", async (c) => {
    try {
      const userId = c.req.param("userId");
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
    try {
      const userId = c.req.param("userId");
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
    c.header("Access-Control-Allow-Origin", "*");
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
    c.header("Access-Control-Allow-Origin", "*");
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
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, PUT",
        "Access-Control-Allow-Headers": "Content-Type",
      },
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

    const conversation = chatState.createConversation({
      type: body.type,
      botName: body.botName,
      userId: body.userId ?? "sim-user-1",
      username: body.username ?? "chat-user",
      channelName: body.channelName,
    });

    return c.json({ conversation }, 201);
  });

  // List all conversations
  app.get("/conversations", (c) => {
    const conversations = chatState.getConversations().map((conv) => ({
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
  app.get("/conversations/:id", (c) => {
    const id = c.req.param("id");
    const conversation = chatState.getConversation(id);
    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    return c.json({ conversation });
  });

  // Delete a specific conversation
  app.delete("/conversations/:id", (c) => {
    const id = c.req.param("id");
    const deleted = chatState.deleteConversation(id);
    if (!deleted) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    return c.json({ ok: true });
  });

  // Create a new thread for a user+bot
  app.post("/threads", async (c) => {
    const body = await c.req.json<{ userId: string; botName: string; name: string; description?: string; connectorId?: string }>();
    if (!body.userId || !body.botName || !body.name) {
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
      const thread = await createThread(body.userId, body.botName, body.name, body.description, body.connectorId);
      return c.json({ thread }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // List threads for a user+bot (excludes slack: threads)
  app.get("/threads/:userId/:botName", async (c) => {
    const userId = c.req.param("userId");
    const botName = c.req.param("botName");
    const allThreads = await listThreads(userId, botName);
    const threads = allThreads.filter((t) => !t.name.startsWith("slack:"));
    return c.json({ threads });
  });

  // Update a thread's connector
  app.patch("/threads/:id/connector", async (c) => {
    const id = c.req.param("id");
    if (!isValidUuid(id)) return c.json({ error: "Invalid thread ID" }, 400);
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
    const conversation = chatState.getConversation(id);
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

  // Consume a pending research message (one-time use)
  app.get("/pending/:threadId", (c) => {
    const threadId = c.req.param("threadId");
    const pending = consumePendingMessage(threadId);
    if (!pending) return c.json({ text: null });
    return c.json({ text: pending.text, jiraContent: pending.jiraContent, title: pending.title });
  });

  // Send a message in a conversation (triggers Claude processing)
  app.post("/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    const conversation = chatState.getConversation(id);
    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const body = await c.req.json<{ text: string; threadId?: string; connector?: string; skipExtractions?: boolean }>();
    if (!body.text) {
      return c.json({ error: "text is required" }, 400);
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
    processChatMessage(id, body.text, bot, config, body.threadId, connectorOverride, threadConnector ?? undefined, body.skipExtractions).catch((err) => {
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
    const userId = c.req.param("userId");
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
    const userId = c.req.param("userId");
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

  // MCP server status for a bot (uses cache if fresh, probes otherwise)
  app.get("/mcp-status/:botName", async (c) => {
    const botName = c.req.param("botName");
    const bot = botConfigs.find((b) => b.name === botName);
    if (!bot) return c.json({ error: `Bot "${botName}" not found` }, 404);
    try {
      const cached = getCachedMcpStatus(botName);
      const servers = cached ?? (await getMcpStatus(bot));
      return c.json({ servers, cached: cached !== null });
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
  const VALID_USER_ID = /^[a-zA-Z0-9_-]+$/;
  // dev_run statuses a spec save may set: draft on Save Spec, approved at the fagperson gate.
  const VALID_SPEC_STATUS = new Set(["spec_draft", "spec_approved"]);

  // Save a research report file to bots/<botName>/reports/<userId>/<issueKey>.md
  app.post("/reports/:botName/:userId/:issueKey", async (c) => {
    const botName = c.req.param("botName");
    const userId = c.req.param("userId");
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
    const userId = c.req.param("userId");
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
    const userId = c.req.param("userId");
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
    const userId = c.req.param("userId");
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
    const userId = c.req.param("userId");
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
    const userId = c.req.param("userId");
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
