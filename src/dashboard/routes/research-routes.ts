import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { renderResearchPage } from "../views/research-page.ts";
import { discoverAllBots, resolveResearchBot, DEFAULT_VARIANT_ID, DEFAULT_VARIANT_LABEL } from "../../bots/config.ts";
import { streamResearchSSE } from "./research-sse.ts";
import { resolveProfile } from "../../research/corpus.ts";
import { parseResearchHistory } from "../../research/history-param.ts";
import { enrichCitationsWithPages } from "../../wiki/citation-links.ts";
import { renderResearchAnswerHtml } from "../../wiki/ask-render.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { loadMcpConfig } from "../../ai/mcp-tool-caller.ts";
import { chatState } from "../../chat/state.ts";
import { loadChatConfig } from "../../chat/chat-config.ts";
import { setPendingMessage } from "../../chat/pending-messages.ts";
import { createThread, findThreadByName } from "../../db/threads.ts";
import { birthDevRun } from "../../db/dev-runs.ts";
import { isValidUuid } from "../routes/route-utils.ts";
import { knowledgeApiHandler, fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { parseMcpConfig } from "../../ai/connectors/copilot-mcp.ts";
import { checkMcpServerHealth } from "../../ai/connectors/mcp-health.ts";

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

  app.get("/research", async (c) => {
    return c.html(await renderResearchPage());
  });

  // Research: list available bots. Every connector can synthesize now (synthesis
  // routes through executeOneShot), so all discovered bots are pickable.
  app.get("/api/research/bots", (c) => {
    const bots = discoverAllBots().map((b) => ({ name: b.name }));
    return c.json({ bots });
  });

  // Research Q&A (Claude Learning Center, Research layer): retrieve across the
  // shelf corpus via researchKnowledge, then synthesize one cited answer.
  // SSE over GET so the browser drives it with a plain EventSource; the question
  // rides in the `q` query param and the synthesizing bot in `bot` (defaults to
  // a fast Research bot — see resolveResearchBot; pass an explicit bot to pin one).
  app.get("/api/research/ask", (c) => {
    const question = (c.req.query("q") ?? "").trim();
    const botName = c.req.query("bot")?.trim();
    if (!question) return c.json({ error: "Missing query parameter: q" }, 400);

    const history = parseResearchHistory(c.req.query("history"));

    // Corpus profile scopes retrieval to a domain (ai | life). Stateless like
    // history: the page sends profile= on every ask (including follow-ups), so
    // reading it here keeps the whole conversation in-domain. Unknown/missing
    // resolves to the default `ai` profile.
    const profile = resolveProfile(c.req.query("profile"));

    const allBots = discoverAllBots();
    // Honor an explicit ?bot= when it names a real bot; any connector can
    // synthesize (routed through executeOneShot), so no CLI-native filter here.
    // The corpus is fixed, so the synthesis engine is an implementation detail
    // the reader doesn't pick — an unknown name falls back to the fast default.
    const requested = botName ? allBots.find((b) => b.name === botName) : undefined;
    const botConfig = requested ?? resolveResearchBot(allBots);
    if (!botConfig) return c.json({ error: "No bots configured" }, 500);

    log.info("Research ask: bot={bot} profile={profile} turn={turn} q={q}", {
      bot: botConfig.name,
      profile: profile.label,
      turn: history.length + 1,
      q: question.slice(0, 120),
    });

    return streamResearchSSE(c, {
      question,
      config,
      botConfig,
      history,
      collections: profile.collections,
      // Enrich citations whose collection maps to a registered wiki with the
      // matched page name, so the research page can link them into the /wiki
      // reader. Non-wiki collections pass through unchanged.
      enrich: (citations) => enrichCitationsWithPages(citations, getWikiRegistry()),
      // Render the final answer through the shared component-aware markdown
      // pipeline and ship it as a trailing `answer_html` event. The research page
      // swaps its streamed plain text for this (and re-linkifies `[n]` markers
      // client-side). See renderResearchAnswerHtml for why it's not the Ask renderer.
      renderAnswerHtml: (answer) => renderResearchAnswerHtml(answer),
    });
  });

  // Research: list jiraAnalysis prompt variants for a bot (Chrome extension dropdown)
  app.get("/api/research/variants", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    const botName = c.req.query("bot");
    if (!botName) return c.json({ error: "Missing bot parameter" }, 400);
    const bot = discoverAllBots().find((b) => b.name === botName);
    if (!bot) return c.json({ error: `Bot "${botName}" not found` }, 404);

    const variants: Array<{ id: string; label: string }> = [
      { id: DEFAULT_VARIANT_ID, label: DEFAULT_VARIANT_LABEL },
    ];
    for (const v of bot.prompts?.jiraAnalysisVariants ?? []) {
      variants.push({ id: v.id, label: v.label });
    }
    return c.json({ variants });
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
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/tags?collection=${encodeURIComponent(collection)}`);
  });

  // Research browse: documents in a collection
  app.get("/api/research/documents", async (c) => {
    const collection = c.req.query("collection");
    if (!collection) return c.json({ error: "Missing collection parameter" }, 400);
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/collection/${encodeURIComponent(collection)}/documents`, 10000);
  });

  // Research browse: single document
  app.get("/api/research/document/:collection/*", (c) => {
    const collection = c.req.param("collection");
    const docId = c.req.path.split(`/api/research/document/${collection}/`)[1] || "";
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/document/${encodeURIComponent(collection)}/${docId}`);
  });

  // Research browse: similar search
  app.get("/api/research/similar", async (c) => {
    const q = c.req.query("q");
    const collection = c.req.query("collection");
    if (!q) return c.json({ error: "Missing query parameter" }, 400);
    const params = new URLSearchParams({ q, limit: "6" });
    if (collection) params.set("collection", collection);
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/search?${params}`, 10000);
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
      connectorId?: string; promptVariant?: string;
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

    // Health-check critical MCP servers before starting analysis
    const mcpServers = parseMcpConfig(botConfig.dir);
    const healthErrors = await checkMcpServerHealth(mcpServers, ["yggdrasil"], botConfig.name);
    if (healthErrors.length > 0) {
      const names = healthErrors.map((e) => e.name).join(", ");
      log.warn("Research blocked — MCP servers not reachable: {names}", { botName: botConfig.name, names });
      return c.json({
        error: `Kan ikke starte analyse — følgende MCP-servere er ikke tilgjengelige: ${names}. Start dem fra dashboardet (Serena-siden) før du kjører en analyse.`,
        unreachableServers: healthErrors,
      }, 503);
    }

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

    // Validate connectorId if provided (chat page stamps connector on thread select)
    const connectorId = body.connectorId && isValidUuid(body.connectorId) ? body.connectorId : undefined;

    // Create a dedicated thread for this research
    const thread = await createThread(chatUser.id, botConfig.name, threadTitle, body.description, connectorId);

    // Birth the dev_run that spans the whole research → build → verify arc
    // (spec-driven dev loop, Phase 0). issue_key = the Jira key (from the title)
    // or the synthetic research-<threadId8> the report/spec paths also use —
    // never NULL, server-authoritative. Best-effort: a failure here must never
    // block starting the research.
    try {
      const issueKey = rawTitle.match(/^([A-Z]+-\d+)/)?.[1] ?? `research-${thread.id.slice(0, 8)}`;
      await birthDevRun({ botName: botConfig.name, userId: chatUser.id, issueKey, threadId: thread.id });
    } catch (err) {
      log.warn("Failed to birth dev_run for research thread {threadId}: {error}", {
        threadId: thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Resolve which Jira analysis prompt to use (default vs named variant)
    const variantId = body.promptVariant && body.promptVariant !== DEFAULT_VARIANT_ID ? body.promptVariant : null;
    let jiraPrompt: string;
    if (variantId) {
      const variant = botConfig.prompts?.jiraAnalysisVariants?.find((v) => v.id === variantId);
      if (!variant) {
        return c.json({
          error: `Unknown promptVariant "${variantId}" for bot "${botConfig.name}"`,
        }, 400);
      }
      jiraPrompt = variant.content;
    } else {
      jiraPrompt = botConfig.prompts?.jiraAnalysis ?? DEFAULT_JIRA_ANALYSIS_PROMPT;
    }
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
      fetchKnowledgeApi(config.knowledgeApiUrl, "/api/jira/ingest", {
        timeoutMs: 15_000,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueKey: issueKeyMatch[1],
          title: rawTitle,
          description: body.text,
        }),
      }).then(() => {
        log.info("Jira indexed: {issueKey}", { issueKey: issueKeyMatch[1] });
      }).catch((err) => {
        log.warn("Jira ingest failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      });
    }

    return c.json({
      threadId: thread.id,
      conversationId: conversation.id,
      chatUrl: `/chat?bot=${encodeURIComponent(botConfig.name)}&thread=${encodeURIComponent(thread.id)}&user=${encodeURIComponent(chatUser.id)}`,
    });
  });
}
