import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { renderResearchPage } from "../views/research-page.ts";
import { discoverAllBots } from "../../bots/config.ts";
import { loadMcpConfig } from "../mcp-client.ts";
import { chatState } from "../../chat/state.ts";
import { loadChatConfig } from "../../chat/chat-config.ts";
import { setPendingMessage } from "../../chat/pending-messages.ts";
import { createThread, findThreadByName } from "../../db/threads.ts";

const log = getLog("dashboard");

const DEFAULT_JIRA_ANALYSIS_PROMPT = `Analyser denne Jira-oppgaven. Bruk verktøyene dine til å søke i kunnskapsbasen etter relevant dokumentasjon og relaterte Jira-saker.

Gi en oppsummering av:
- Hva oppgaven handler om
- Relevant dokumentasjon du finner i kunnskapsbasen
- Relaterte Jira-saker (epic, linked issues, lignende oppgaver)
- Koblinger til eksisterende arbeid
- Eventuelle mangler eller uklarheter`;

export function registerResearchRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  app.get("/research", (c) => {
    return c.html(renderResearchPage());
  });

  // Research: list available bots
  app.get("/api/research/bots", (c) => {
    const bots = discoverAllBots().map((b) => ({ name: b.name }));
    return c.json({ bots });
  });

  // Research: get KNOWLEDGE_COLLECTIONS for a bot from its .mcp.json
  app.get("/api/research/bot-collections", async (c) => {
    const botName = c.req.query("bot");
    if (!botName) return c.json({ collections: [] });

    const bot = discoverAllBots().find((b) => b.name === botName);
    if (!bot) return c.json({ collections: [] });

    const mcpConfig = await loadMcpConfig(bot.dir);
    if (!mcpConfig?.mcpServers) return c.json({ collections: [] });

    // Look for KNOWLEDGE_COLLECTIONS in any server's env
    for (const server of Object.values(mcpConfig.mcpServers) as Array<{ env?: Record<string, string> }>) {
      const knowledgeCollections = server?.env?.KNOWLEDGE_COLLECTIONS;
      if (knowledgeCollections) {
        const names = knowledgeCollections.split(",").map((s: string) => s.trim()).filter(Boolean);
        return c.json({ collections: names });
      }
    }
    return c.json({ collections: [] });
  });

  // Research browse: tags for a collection
  app.get("/api/research/tags", async (c) => {
    const collection = c.req.query("collection");
    if (!collection) return c.json({ error: "Missing collection parameter" }, 400);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/tags?collection=${encodeURIComponent(collection)}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      return c.json(await res.json());
    } catch (err) {
      log.warn("Research tags API failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  // Research browse: documents in a collection
  app.get("/api/research/documents", async (c) => {
    const collection = c.req.query("collection");
    if (!collection) return c.json({ error: "Missing collection parameter" }, 400);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/collection/${encodeURIComponent(collection)}/documents`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      return c.json(await res.json());
    } catch (err) {
      log.warn("Research documents API failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  // Research browse: single document
  app.get("/api/research/document/:collection/*", async (c) => {
    try {
      const collection = c.req.param("collection");
      const docId = c.req.path.split(`/api/research/document/${collection}/`)[1] || "";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/document/${encodeURIComponent(collection)}/${docId}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      return c.json(await res.json());
    } catch (err) {
      log.warn("Research document fetch failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  // Research browse: similar search
  app.get("/api/research/similar", async (c) => {
    const q = c.req.query("q");
    const collection = c.req.query("collection");
    if (!q) return c.json({ error: "Missing query parameter" }, 400);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const params = new URLSearchParams({ q, limit: "6" });
      if (collection) params.set("collection", collection);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/search?${params}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      return c.json(await res.json());
    } catch (err) {
      log.warn("Research similar search failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  // Research chat: CORS preflight for Chrome extension
  app.options("/api/research/chat", (c) => {
    log.info("CORS preflight for /api/research/chat from {origin}", { origin: c.req.header("origin") || "unknown" });
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  });

  // Research chat: create thread + send first message via bot chat
  app.post("/api/research/chat", async (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    const origin = c.req.header("origin") || c.req.header("referer") || "unknown";
    log.info("POST /api/research/chat from {origin}", { origin });

    const body = await c.req.json<{
      bot?: string; title?: string; text: string;
      userId?: string; forceNew?: boolean; description?: string;
      connectorId?: string;
    }>();
    if (!body.text) {
      return c.json({ error: "Missing required field: text" }, 400);
    }

    const rawTitle = body.title || body.text.slice(0, 80) + (body.text.length > 80 ? "..." : "");
    // Thread names max 50 chars — truncate with ellipsis
    const title = rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;

    // Find the requested bot
    const allBots = discoverAllBots();
    if (allBots.length === 0) {
      return c.json({ error: "No bots configured" }, 500);
    }
    const botConfig = (body.bot && allBots.find((b) => b.name === body.bot)) || allBots[0]!;

    // Resolve userId — require explicit userId when multiple users exist
    const chatConfig = await loadChatConfig(botConfig.name);
    const botUsers = chatConfig?.users ?? [];
    if (body.userId && !botUsers.find((u) => u.id === body.userId)) {
      return c.json({
        error: `User "${body.userId}" not found for bot "${botConfig.name}"`,
        needsUser: true,
        users: botUsers.map((u) => ({ id: u.id, name: u.name })),
      }, 400);
    }
    if (!body.userId && botUsers.length > 1) {
      return c.json({
        error: "Multiple users available — please specify userId",
        needsUser: true,
        users: botUsers.map((u) => ({ id: u.id, name: u.name })),
      }, 400);
    }
    const chatUser = body.userId
      ? botUsers.find((u) => u.id === body.userId)!
      : botUsers[0];
    if (!chatUser) {
      return c.json({ error: `No user found for bot "${botConfig.name}"` }, 400);
    }

    // Check if thread with this name already exists (unless forceNew requested)
    const normalizedTitle = title.toLowerCase().trim();
    const existingThread = await findThreadByName(chatUser.id, botConfig.name, normalizedTitle);
    if (existingThread && !body.forceNew) {
      return c.json({
        threadExists: true,
        existingThreadId: existingThread.id,
        existingThreadName: existingThread.name,
        userId: chatUser.id,
        botName: botConfig.name,
      }, 409);
    }

    // If forceNew and thread exists, append timestamp to make name unique
    let threadTitle = title;
    if (existingThread && body.forceNew) {
      const now = new Date();
      const suffix = `-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
      threadTitle = title.length + suffix.length > 50
        ? title.slice(0, 50 - suffix.length) + suffix
        : title + suffix;
    }

    // Find or create conversation in chat state
    let conversation = chatState.getConversations().find(
      (conv) => conv.userId === chatUser.id && conv.botName === botConfig.name && conv.type === "web",
    );
    if (!conversation) {
      conversation = chatState.createConversation({
        type: "web",
        botName: botConfig.name,
        userId: chatUser.id,
        username: chatUser.name,
      });
    }

    // Create a dedicated thread for this research
    const thread = await createThread(chatUser.id, botConfig.name, threadTitle, body.description, body.connectorId);

    // Build research prompt with machine-parseable marker for research card rendering
    const jiraPrompt = botConfig.prompts?.jiraAnalysis ?? DEFAULT_JIRA_ANALYSIS_PROMPT;
    const prompt = `<!-- research:jira -->\n${jiraPrompt}\n\n---\n\n${body.text}`;

    log.info("Research chat created: {title} | bot={bot} | thread={threadId}", {
      title: threadTitle,
      bot: botConfig.name,
      threadId: thread.id,
    });

    // Store pending message — chat page will pick it up and send via normal pipeline
    setPendingMessage(thread.id, prompt, { jiraContent: body.text, title: rawTitle });

    // Index Jira content in knowledge base (fire-and-forget)
    const issueKeyMatch = rawTitle.match(/^([A-Z]+-\d+)/);
    if (issueKeyMatch) {
      const ingestJira = async () => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15_000);
          const res = await fetch(`${config.knowledgeApiUrl}/api/jira/ingest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              issueKey: issueKeyMatch[1],
              title: rawTitle,
              description: body.text,
            }),
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (res.ok) {
            log.info("Jira indexed: {issueKey}", { issueKey: issueKeyMatch[1] });
          } else {
            log.warn("Jira ingest returned {status}", { status: res.status });
          }
        } catch (err) {
          log.warn("Jira ingest failed: {error}", { error: err instanceof Error ? err.message : String(err) });
        }
      };
      ingestJira();
    }

    return c.json({
      threadId: thread.id,
      conversationId: conversation.id,
      chatUrl: `/chat?bot=${encodeURIComponent(botConfig.name)}&thread=${encodeURIComponent(thread.id)}&user=${encodeURIComponent(chatUser.id)}`,
    });
  });
}
