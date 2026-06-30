import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { renderResearchPage } from "../views/research-page.ts";
import { discoverAllBots, resolveResearchBot, canSynthesizeResearch, DEFAULT_VARIANT_ID, DEFAULT_VARIANT_LABEL } from "../../bots/config.ts";
import { streamResearchAnswer } from "../../research/ask.ts";
import { MAX_HISTORY_TURNS, type ResearchTurn } from "../../research/answer.ts";
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

// Loose upper bounds for the replayed `history` param — these only cap untrusted
// input size, they are NOT the synthesis budget (that is the binding cap in
// renderHistoryBlock, answer.ts). Kept generous (≥ that budget) so bumping the
// answer.ts budget actually takes effect rather than silently clamping here.
const HISTORY_PARAM_MAX_CHARS = 20_000; // whole param; rejected before JSON.parse
const HISTORY_QUESTION_CHARS = 1_000;
const HISTORY_ANSWER_CHARS = 4_000;

/**
 * Parse the compact `history` query param the Research page replays on a
 * follow-up: a JSON array of `{ q, a }` prior turns (oldest→newest). The corpus
 * Q&A is stateless on the server, so the running conversation lives entirely in
 * this param. Malformed/oversized input degrades to single-shot (empty history)
 * rather than erroring — a follow-up that loses context still answers standalone.
 */
function parseResearchHistory(raw: string | undefined): ResearchTurn[] {
  if (!raw || raw.length > HISTORY_PARAM_MAX_CHARS) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is { q: string; a: string } =>
          !!t && typeof t.q === "string" && typeof t.a === "string" && t.q.trim().length > 0,
      )
      .slice(-MAX_HISTORY_TURNS)
      .map((t) => ({
        question: t.q.slice(0, HISTORY_QUESTION_CHARS),
        answer: t.a.slice(0, HISTORY_ANSWER_CHARS),
      }));
  } catch {
    return [];
  }
}

export function registerResearchRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  app.get("/research", async (c) => {
    return c.html(await renderResearchPage());
  });

  // Research: list available bots
  app.get("/api/research/bots", (c) => {
    // Only bots that can synthesize on the CLI path — copilot-sdk/openai-compat
    // bots carry model ids the CLI rejects (see canSynthesizeResearch), so they
    // must not appear as a pickable Research engine.
    const bots = discoverAllBots()
      .filter(canSynthesizeResearch)
      .map((b) => ({ name: b.name }));
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

    const allBots = discoverAllBots();
    // Honor an explicit ?bot= only if it can actually synthesize on the CLI path.
    // A copilot-sdk/openai-compat bot (e.g. melosys, model "claude-sonnet-4.6")
    // would crash the spawn with an invalid --model, so fall back to the fast
    // CLI research bot instead — the corpus is fixed, so the synthesis engine is
    // an implementation detail the reader doesn't pick. (A stale shared bot
    // selection from another page can still arrive here despite the filtered
    // /api/research/bots list.)
    const requested = botName ? allBots.find((b) => b.name === botName) : undefined;
    const requestedUsable = !!requested && canSynthesizeResearch(requested);
    if (requested && !requestedUsable) {
      log.warn("Research: requested bot={bot} can't synthesize on the CLI path — falling back", {
        bot: requested.name,
      });
    }
    const botConfig = (requestedUsable ? requested : undefined) ?? resolveResearchBot(allBots);
    if (!botConfig) return c.json({ error: "No bots configured" }, 500);

    log.info("Research ask: bot={bot} turn={turn} q={q}", {
      bot: botConfig.name,
      turn: history.length + 1,
      q: question.slice(0, 120),
    });

    return streamSSE(c, async (stream) => {
      // Retrieval (≤30s) and a slow first synthesis token can leave a long gap
      // with no events; a heartbeat keeps the connection alive through any proxy
      // with a shorter idle window than the dashboard's own 255s (matches the
      // youtube/anthropic SSE streams). The client has no 'heartbeat' listener,
      // so these are silently ignored.
      let alive = true;
      const heartbeat = setInterval(() => {
        if (!alive) return;
        stream.writeSSE({ event: "heartbeat", data: "{}" }).catch(() => { alive = false; });
      }, 30_000);
      stream.onAbort(() => { alive = false; clearInterval(heartbeat); });
      try {
        await streamResearchAnswer({ question, config, botConfig, history }, async (event) => {
          // EventSource reserves the "error" event for connection-level failures
          // (it also fires onerror), so a same-named app event gets masked as
          // "Connection lost" on the client. Emit app errors under a distinct
          // name; the payload still carries {type:"error", message}.
          const wireEvent = event.type === "error" ? "app_error" : event.type;
          await stream.writeSSE({ event: wireEvent, data: JSON.stringify(event) });
        });
        // Final sentinel so the client can close the EventSource deterministically.
        await stream.writeSSE({ event: "end", data: "{}" });
      } finally {
        alive = false;
        clearInterval(heartbeat);
      }
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
