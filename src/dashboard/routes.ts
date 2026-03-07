import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Scalar } from "@scalar/hono-api-reference";
import type { Config } from "../config.ts";
import { getLog } from "../logging.ts";
import { spec } from "./openapi-spec.ts";
import { activityLog } from "./activity-log.ts";
import { renderDashboardPage } from "./views/page.ts";
import { renderTracesPage } from "./views/traces-page.ts";
import { renderMemsearchPage } from "./views/memsearch-page.ts";
import { renderSearchPage } from "./views/search-page.ts";
import { renderSearchDocumentPage } from "./views/search-document-page.ts";
import { renderYouTubePage } from "./views/youtube-page.ts";
import { renderResearchPage } from "./views/research-page.ts";
import { createJob, getJob, getRecentJobs, subscribe as subscribeYouTubeJob } from "../youtube/state.ts";
import { summarizeVideo } from "../youtube/summarizer.ts";
import { simulatorState } from "../simulator/state.ts";
import { loadChatConfig, addChatUser } from "../simulator/chat-config.ts";
import { setPendingMessage } from "../simulator/pending-messages.ts";
import { renderLogsPage } from "./views/logs-page.ts";
import { renderMcpDebugPage } from "./views/mcp-debug-page.ts";
import { renderSerenaPage } from "./views/serena-page.ts";
import { loadMcpConfig, connectToServer, callTool, disconnectServer } from "./mcp-client.ts";
import { serenaManager } from "../serena/manager.ts";
import { discoverAllBots } from "../bots/config.ts";
import { getRecentMessages } from "../db/messages.ts";
import { getActiveGoals } from "../db/goals.ts";
import { getAllGoals } from "../db/goals.ts";
import { getScheduledTasksForUser } from "../db/scheduled-tasks.ts";
import { getAllScheduledTasks } from "../db/scheduled-tasks.ts";
import { getRecentMemories, getMemoriesByUser, getMemoriesForUser, dashboardSearchMemories, getSearchStats } from "../db/memories.ts";
import { generateEmbedding } from "../ai/embeddings.ts";
import { getDashboardStats, getSlackAnalytics, getUsersSummary, getUserOverview } from "../db/stats.ts";
import { getAllWatchers } from "../db/watchers.ts";
import { getRecentTraces, getTrace, getTraceStats, getTraceFilterOptions } from "../db/traces.ts";
import { getAllThreadsForBot, createThread, deleteThreadById } from "../db/threads.ts";
import { getPromptSnapshot } from "../db/prompt-snapshots.ts";
import { getUserSettings } from "../db/user-settings.ts";
import { agentStatus } from "./agent-status.ts";

const log = getLog("dashboard");

/** Parse a numeric query param with fallback and bounds clamping. */
function parseIntParam(value: string | undefined, defaultVal: number, max: number): number {
  const parsed = parseInt(value ?? String(defaultVal), 10);
  if (isNaN(parsed) || parsed < 1) return defaultVal;
  return Math.min(parsed, max);
}

export function createDashboardRoutes(config: Config): Hono {
  const app = new Hono();

  app.get("/api/openapi.json", (c) => c.json(spec));
  app.get("/docs", Scalar({ url: "/api/openapi.json", pageTitle: "Javrvis API" }));

  app.get("/", (c) => {
    return c.html(renderDashboardPage());
  });

  // --- Aggregate endpoints (single-user, no userId needed) ---

  app.get("/api/bots", async (c) => {
    try {
      const sql = (await import("../db/client.ts")).getDb();
      const rows = await sql`SELECT DISTINCT bot_name FROM messages WHERE bot_name IS NOT NULL ORDER BY bot_name`;
      return c.json({ bots: rows.map((r: Record<string, unknown>) => r.bot_name as string) });
    } catch (err) {
      log.error("Failed to fetch bots: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch bots" }, 500);
    }
  });

  app.get("/api/stats", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const stats = await getDashboardStats(botName);
      return c.json(stats);
    } catch (err) {
      log.error("Failed to fetch dashboard stats: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch stats" }, 500);
    }
  });

  app.get("/api/memories", async (c) => {
    try {
      const limit = parseIntParam(c.req.query("limit"), 20, 100);
      const botName = c.req.query("bot") || undefined;
      const memories = await getRecentMemories(limit, botName);
      return c.json({ memories });
    } catch (err) {
      log.error("Failed to fetch memories: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch memories" }, 500);
    }
  });

  app.get("/api/goals", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const goals = await getAllGoals(botName);
      return c.json({ goals });
    } catch (err) {
      log.error("Failed to fetch goals: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch goals" }, 500);
    }
  });

  app.get("/api/tasks", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const tasks = await getAllScheduledTasks(botName);
      return c.json({ tasks });
    } catch (err) {
      log.error("Failed to fetch tasks: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch tasks" }, 500);
    }
  });

  app.get("/api/slack-analytics", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const analytics = await getSlackAnalytics(botName);
      return c.json(analytics);
    } catch (err) {
      log.error("Failed to fetch Slack analytics: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch Slack analytics" }, 500);
    }
  });

  app.get("/api/watchers", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const watchers = await getAllWatchers(botName);
      return c.json({ watchers });
    } catch (err) {
      log.error("Failed to fetch watchers: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch watchers" }, 500);
    }
  });

  app.get("/api/threads", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const threads = await getAllThreadsForBot(botName);
      return c.json({ threads });
    } catch (err) {
      log.error("Failed to fetch threads: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch threads" }, 500);
    }
  });

  app.delete("/api/threads/:id", async (c) => {
    try {
      const id = c.req.param("id");
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

  app.get("/api/users", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const users = await getUsersSummary(botName);
      return c.json({ users });
    } catch (err) {
      log.error("Failed to fetch users: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch users" }, 500);
    }
  });

  app.post("/api/users", async (c) => {
    try {
      const body = await c.req.json<{ userId: string; username: string; botName: string }>();
      if (!body.userId || !body.username || !body.botName) {
        return c.json({ error: "userId, username, and botName are required" }, 400);
      }
      const allBots = discoverAllBots();
      if (!allBots.some((b) => b.name === body.botName)) {
        return c.json({ error: `Bot "${body.botName}" not found` }, 400);
      }
      // Create user in DB + ensure default thread
      await addChatUser({ id: body.userId, name: body.username, bot: body.botName });
      log.info("Created user {userId} ({username}) for bot {botName}", {
        userId: body.userId, username: body.username, botName: body.botName,
      });
      return c.json({ ok: true, user: { userId: body.userId, username: body.username, botName: body.botName } }, 201);
    } catch (err) {
      log.error("Failed to create user: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to create user" }, 500);
    }
  });

  app.get("/api/users/:userId/overview", async (c) => {
    try {
      const userId = c.req.param("userId");
      if (!userId) return c.json({ error: "Invalid userId" }, 400);
      const botName = c.req.query("bot") || undefined;
      const overview = await getUserOverview(userId, botName);
      return c.json(overview);
    } catch (err) {
      log.error("Failed to fetch user overview: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch user overview" }, 500);
    }
  });

  app.get("/api/memories/by-user", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const users = await getMemoriesByUser(botName);
      return c.json({ users });
    } catch (err) {
      log.error("Failed to fetch memories by user: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch memories by user" }, 500);
    }
  });

  app.get("/api/memories/user/:userId", async (c) => {
    try {
      const userId = c.req.param("userId");
      if (!userId) {
        return c.json({ error: "Invalid userId" }, 400);
      }
      const limit = parseIntParam(c.req.query("limit"), 20, 100);
      const botName = c.req.query("bot") || undefined;
      const memories = await getMemoriesForUser(userId, limit, botName);
      return c.json({ memories });
    } catch (err) {
      log.error("Failed to fetch memories for user: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch memories for user" }, 500);
    }
  });

  app.get("/api/user-settings/:userId", async (c) => {
    try {
      const userId = c.req.param("userId");
      if (!userId) {
        return c.json({ error: "Invalid userId" }, 400);
      }
      const settings = await getUserSettings(userId);
      return c.json({ settings });
    } catch (err) {
      log.error("Failed to fetch user settings: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch user settings" }, 500);
    }
  });

  // --- Traces page ---

  app.get("/traces", (c) => {
    return c.html(renderTracesPage());
  });

  app.get("/api/traces", async (c) => {
    try {
      const limit = parseIntParam(c.req.query("limit"), 50, 200);
      const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
      const botName = c.req.query("bot") || undefined;
      const name = c.req.query("name") || undefined;
      const traces = await getRecentTraces(limit, offset, botName, name);
      return c.json({ traces });
    } catch (err) {
      log.error("Failed to fetch traces: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch traces" }, 500);
    }
  });

  app.get("/api/traces/:traceId", async (c) => {
    try {
      const traceId = c.req.param("traceId");
      const spans = await getTrace(traceId);
      return c.json({ spans });
    } catch (err) {
      log.error("Failed to fetch trace: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch trace" }, 500);
    }
  });

  app.get("/api/prompts/:traceId", async (c) => {
    try {
      const traceId = c.req.param("traceId");
      const snapshot = await getPromptSnapshot(traceId);
      if (!snapshot) {
        return c.json({ error: "Prompt snapshot not found" }, 404);
      }
      return c.json(snapshot);
    } catch (err) {
      log.error("Failed to fetch prompt snapshot: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch prompt snapshot" }, 500);
    }
  });

  app.get("/api/trace-stats", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const stats = await getTraceStats(botName);
      return c.json(stats);
    } catch (err) {
      log.error("Failed to fetch trace stats: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch trace stats" }, 500);
    }
  });

  app.get("/api/trace-filters", async (c) => {
    try {
      const options = await getTraceFilterOptions();
      return c.json(options);
    } catch (err) {
      log.error("Failed to fetch trace filter options: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch filter options" }, 500);
    }
  });

  // --- MemSearch page ---

  app.get("/memsearch", (c) => {
    return c.html(renderMemsearchPage());
  });

  app.get("/api/memsearch", async (c) => {
    try {
      const query = c.req.query("q");
      if (!query || query.trim().length === 0) {
        return c.json({ results: [] });
      }

      const mode = (c.req.query("mode") || "hybrid") as "hybrid" | "semantic" | "text";
      const limit = parseIntParam(c.req.query("limit"), 25, 100);
      const botName = c.req.query("bot") || undefined;
      const scope = (c.req.query("scope") || undefined) as "personal" | "shared" | undefined;

      // Generate embedding for semantic/hybrid modes
      let embedding: number[] | null = null;
      if (mode !== "text") {
        embedding = await generateEmbedding(query);
      }

      const results = await dashboardSearchMemories({
        query,
        embedding,
        mode,
        limit,
        botName,
        scope,
      });

      return c.json({ results });
    } catch (err) {
      log.error("Search failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Search failed" }, 500);
    }
  });

  app.get("/api/memsearch-stats", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const stats = await getSearchStats(botName);
      return c.json(stats);
    } catch (err) {
      log.error("Failed to fetch search stats: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch search stats" }, 500);
    }
  });

  // --- Logs page ---

  const LOG_DIR = config.logDir;

  app.get("/logs", (c) => {
    return c.html(renderLogsPage());
  });

  app.get("/api/logs/dates", async (c) => {
    try {
      const glob = new Bun.Glob("*.log");
      const dates: string[] = [];
      for await (const file of glob.scan(LOG_DIR)) {
        const match = file.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
        if (match && match[1]) dates.push(match[1]);
      }
      dates.sort((a, b) => b.localeCompare(a)); // newest first
      return c.json({ dates });
    } catch (err) {
      log.error("Failed to scan log dates: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ dates: [] });
    }
  });

  /** Read and parse a JSONL log file, returning parsed entries. */
  async function readLogEntries(date: string): Promise<Record<string, unknown>[]> {
    const filePath = `${LOG_DIR}/${date}.log`;
    const file = Bun.file(filePath);
    if (!(await file.exists())) return [];
    const text = await file.text();
    return text.trim().split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  app.get("/api/logs", async (c) => {
    try {
      const date = c.req.query("date");
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return c.json({ error: "Invalid date format" }, 400);
      }
      const entries = await readLogEntries(date);
      return c.json({ entries });
    } catch (err) {
      log.error("Failed to read log file: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to read logs" }, 500);
    }
  });

  app.get("/api/logs/tail", async (c) => {
    try {
      const date = c.req.query("date");
      const after = c.req.query("after");
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return c.json({ error: "Invalid date format" }, 400);
      }
      if (!after) {
        return c.json({ error: "Missing 'after' parameter" }, 400);
      }
      const entries = (await readLogEntries(date))
        .filter((e) => (e as { ts: string }).ts > after);
      return c.json({ entries });
    } catch (err) {
      log.error("Failed to tail log file: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to tail logs" }, 500);
    }
  });

  // --- Search page (proxy to Knowledge API) ---

  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  app.get("/search", (c) => {
    return c.html(renderSearchPage());
  });

  app.get("/search/document/:collection/*", (c) => {
    const collection = c.req.param("collection");
    const docId = c.req.path.split(`/search/document/${collection}/`)[1] || "";
    return c.html(renderSearchDocumentPage(collection, decodeURIComponent(docId)));
  });

  app.get("/api/search/health", async (c) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      const data = await res.json();
      return c.json(data);
    } catch (err) {
      log.warn("Knowledge API unreachable: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  app.get("/api/search/collections", async (c) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/collections`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      const data = await res.json();
      return c.json(data);
    } catch (err) {
      log.warn("Knowledge API unreachable: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  app.get("/api/search/search", async (c) => {
    try {
      const query = c.req.query("q");
      if (!query || query.trim().length === 0) {
        return c.json({ results: [] });
      }
      const params = new URLSearchParams({ q: query });
      const limit = c.req.query("limit");
      if (limit) params.set("limit", limit);
      const collections = c.req.queries("collection");
      if (collections) {
        for (const col of collections) params.append("collection", col);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/search?${params}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      const data = await res.json();
      return c.json(data);
    } catch (err) {
      log.warn("Knowledge search failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  app.get("/api/search/collection/:name/documents", async (c) => {
    try {
      const name = c.req.param("name");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/collection/${encodeURIComponent(name)}/documents`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      const data = await res.json();
      return c.json(data);
    } catch (err) {
      log.warn("Knowledge collection documents fetch failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  app.get("/api/search/document/:collection/*", async (c) => {
    try {
      const collection = c.req.param("collection");
      const docId = c.req.path.split(`/api/search/document/${collection}/`)[1] || "";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      // docId is already URL-encoded from the client request path — pass through as-is
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/document/${encodeURIComponent(collection)}/${docId}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      const data = await res.json();
      return c.json(data);
    } catch (err) {
      log.warn("Knowledge document fetch failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  // --- Research page ---

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

    const body = await c.req.json<{ bot?: string; title?: string; text: string; userId?: string }>();
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

    // Resolve userId/username from users table for this bot
    // If userId is provided, use that specific user; otherwise use the last user for the bot
    const chatConfig = await loadChatConfig(botConfig.name);
    const botUsers = chatConfig?.users ?? [];
    const chatUser = body.userId
      ? botUsers.find((u) => u.id === body.userId) ?? botUsers[botUsers.length - 1]
      : botUsers[botUsers.length - 1];
    if (!chatUser) {
      return c.json({ error: `No user found for bot "${botConfig.name}"` }, 400);
    }

    // Find or create conversation in simulator state
    let conversation = simulatorState.getConversations().find(
      (conv) => conv.userId === chatUser.id && conv.botName === botConfig.name && conv.type === "web",
    );
    if (!conversation) {
      conversation = simulatorState.createConversation({
        type: "web",
        botName: botConfig.name,
        userId: chatUser.id,
        username: chatUser.name,
      });
    }

    // Create a dedicated thread for this research
    const thread = await createThread(chatUser.id, botConfig.name, title);

    // Build research prompt with machine-parseable marker for research card rendering
    const prompt = `<!-- research:jira -->
Analyser denne Jira-oppgaven. Bruk verktøyene dine til å søke i kunnskapsbasen etter relevant dokumentasjon og relaterte Jira-saker.

Gi en oppsummering av:
- Hva oppgaven handler om
- Relevant dokumentasjon du finner i kunnskapsbasen
- Relaterte Jira-saker (epic, linked issues, lignende oppgaver)
- Koblinger til eksisterende arbeid
- Eventuelle mangler eller uklarheter

---

${body.text}`;

    log.info("Research chat created: {title} | bot={bot} | thread={threadId}", {
      title,
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

  // --- MCP Debug page ---

  const getBotConfigs = () => {
    try {
      // MCP debug doesn't need platform tokens — always discover all bots
      return discoverAllBots();
    } catch {
      return [];
    }
  };

  app.get("/mcp-debug", (c) => {
    return c.html(renderMcpDebugPage());
  });

  app.get("/api/mcp/bots", (c) => {
    const bots = getBotConfigs().map((b) => b.name);
    return c.json({ bots });
  });

  app.get("/api/mcp/config", async (c) => {
    const botName = c.req.query("bot");
    if (!botName) return c.json({ error: "Missing bot parameter" }, 400);

    const bot = getBotConfigs().find((b) => b.name === botName);
    if (!bot) return c.json({ error: "Bot not found" }, 404);

    const mcpConfig = await loadMcpConfig(bot.dir);
    if (!mcpConfig) return c.json({ error: "No .mcp.json found" }, 404);

    return c.json(mcpConfig);
  });

  app.post("/api/mcp/connect", async (c) => {
    try {
      const { bot: botName, server: serverName } = await c.req.json();
      if (!botName || !serverName) return c.json({ error: "Missing bot or server" }, 400);

      const bot = getBotConfigs().find((b) => b.name === botName);
      if (!bot) return c.json({ error: "Bot not found" }, 404);

      const mcpConfig = await loadMcpConfig(bot.dir);
      if (!mcpConfig?.mcpServers?.[serverName]) {
        return c.json({ error: "Server not found in config" }, 404);
      }

      const result = await connectToServer(botName, serverName, mcpConfig.mcpServers[serverName]);
      return c.json(result);
    } catch (err) {
      log.error("MCP connect failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: err instanceof Error ? err.message : "Connection failed" }, 500);
    }
  });

  app.post("/api/mcp/call", async (c) => {
    try {
      const body = await c.req.json();
      const { bot: botName, server: serverName, tool: toolName } = body;
      const args = body.arguments || {};
      if (!botName || !serverName || !toolName) {
        return c.json({ error: "Missing bot, server, or tool" }, 400);
      }

      const result = await callTool(botName, serverName, toolName, args);
      return c.json(result);
    } catch (err) {
      log.error("MCP call failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: err instanceof Error ? err.message : "Call failed" }, 500);
    }
  });

  app.post("/api/mcp/disconnect", async (c) => {
    try {
      const { bot: botName, server: serverName } = await c.req.json();
      if (!botName || !serverName) return c.json({ error: "Missing bot or server" }, 400);

      await disconnectServer(botName, serverName);
      return c.json({ ok: true });
    } catch (err) {
      log.error("MCP disconnect failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: err instanceof Error ? err.message : "Disconnect failed" }, 500);
    }
  });

  // --- Serena MCP Proxy ---

  app.get("/serena", (c) => {
    return c.html(renderSerenaPage());
  });

  app.get("/api/serena/instances", (c) => {
    const instances = serenaManager.getInstances().map((inst) => ({
      name: inst.config.name,
      displayName: inst.config.displayName,
      projectPath: inst.config.projectPath,
      port: inst.config.port,
      botName: inst.botName,
      status: inst.status,
      error: inst.error,
      startedAt: inst.startedAt,
      mcpUrl: inst.mcpUrl,
      dashboardUrl: inst.dashboardUrl,
    }));
    return c.json(instances);
  });

  app.post("/api/serena/:name/start", async (c) => {
    const name = c.req.param("name");
    if (!serenaManager.getInstance(name)) return c.json({ error: `Unknown Serena instance: ${name}` }, 404);
    try {
      await serenaManager.start(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/serena/:name/stop", async (c) => {
    const name = c.req.param("name");
    if (!serenaManager.getInstance(name)) return c.json({ error: `Unknown Serena instance: ${name}` }, 404);
    try {
      await serenaManager.stop(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/serena/:name/index", async (c) => {
    const name = c.req.param("name");
    const instance = serenaManager.getInstance(name);
    if (!instance) return c.json({ error: `Unknown Serena instance: ${name}` }, 404);
    if (instance.status === "running" || instance.status === "starting") return c.json({ error: `Stop ${name} before re-indexing` }, 400);
    // Fire and forget — indexing runs in the background, errors logged inside
    serenaManager.index(name).catch(() => {});
    return c.json({ ok: true });
  });

  // --- Per-user endpoints (backward compat) ---

  app.get("/api/activity", (c) => {
    return c.json({
      events: activityLog.getRecent(50),
      stats: activityLog.stats,
    });
  });

  app.get("/api/messages/:userId", async (c) => {
    const userId = c.req.param("userId");
    if (!userId) {
      return c.json({ error: "Invalid userId" }, 400);
    }
    const limit = parseIntParam(c.req.query("limit"), 50, 200);
    const botName = c.req.query("bot") || undefined;
    const threadId = c.req.query("thread") || undefined;
    const messages = await getRecentMessages(userId, limit, botName, threadId);
    return c.json({ messages });
  });

  app.get("/api/goals/:userId", async (c) => {
    const userId = c.req.param("userId");
    if (!userId) {
      return c.json({ error: "Invalid userId" }, 400);
    }
    const goals = await getActiveGoals(userId);
    return c.json({ goals });
  });

  app.get("/api/scheduled-tasks/:userId", async (c) => {
    const userId = c.req.param("userId");
    if (!userId) {
      return c.json({ error: "Invalid userId" }, 400);
    }
    const tasks = await getScheduledTasksForUser(userId);
    return c.json({ tasks });
  });

  // --- YouTube Summarizer ---

  app.get("/youtube", (c) => {
    return c.html(renderYouTubePage());
  });

  // CORS preflight for Chrome extension
  app.options("/api/youtube/summarize", () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  });

  app.post("/api/youtube/summarize", async (c) => {
    c.header("Access-Control-Allow-Origin", "*");

    const body = await c.req.json<{ title?: string; url?: string; video_id?: string }>();
    const { title, url, video_id } = body;

    if (!video_id || !url) {
      return c.json({ error: "Missing required fields: url, video_id" }, 400);
    }

    const jobId = createJob(video_id, title || url, url);

    const bots = getBotConfigs();
    if (bots.length === 0) {
      return c.json({ error: "No bots configured" }, 500);
    }

    // Fire and forget — background summarization
    summarizeVideo(jobId, video_id, title || url, url, config, bots[0]!).catch((err) => {
      log.error("YouTube summarization failed: {error}", { error: err instanceof Error ? err.message : String(err) });
    });

    return c.json({ job_id: jobId, dashboard_url: `/youtube?job=${jobId}` });
  });

  app.get("/api/youtube/stream/:jobId", (c) => {
    const jobId = c.req.param("jobId");
    const job = getJob(jobId);

    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      // Replay current state
      await stream.writeSSE({ event: "status", data: JSON.stringify({ status: job.status }) });
      if (job.text) {
        await stream.writeSSE({ event: "text_delta", data: JSON.stringify({ text: job.text }) });
      }
      if (job.category) {
        await stream.writeSSE({ event: "category", data: JSON.stringify({ category: job.category }) });
      }
      if (job.similar) {
        await stream.writeSSE({ event: "similar", data: JSON.stringify({ articles: job.similar }) });
      }

      // If already terminal, send final event and close
      if (job.status === "complete") {
        await stream.writeSSE({ event: "complete", data: "{}" });
        return;
      }
      if (job.status === "error") {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: job.error }) });
        return;
      }

      // Subscribe to live updates
      let alive = true;
      const unsubscribe = subscribeYouTubeJob(jobId, async (event) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          if (event.type === "complete" || event.type === "error") {
            alive = false;
          }
        } catch {
          alive = false;
        }
      });

      // Heartbeat every 30s
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
        unsubscribe();
        clearInterval(heartbeat);
      });

      while (alive) {
        await Bun.sleep(1000);
      }
      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  app.get("/api/youtube/jobs", (c) => {
    const limit = parseInt(c.req.query("limit") || "20", 10);
    const jobs = getRecentJobs(Math.min(Math.max(limit, 1), 100));
    return c.json({ jobs });
  });

  // --- YouTube browse (proxy to knowledge API) ---

  const YT_COLLECTION = "youtube-summaries";

  app.get("/api/youtube/categories", async (c) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/youtube/categories`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      return c.json(await res.json());
    } catch (err) {
      log.warn("YouTube categories API failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  app.get("/api/youtube/documents", async (c) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/collection/${YT_COLLECTION}/documents`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      return c.json(await res.json());
    } catch (err) {
      log.warn("YouTube documents API failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  app.get("/api/youtube/document/*", async (c) => {
    const docId = c.req.path.replace("/api/youtube/document/", "");
    if (!docId) return c.json({ error: "Missing document ID" }, 400);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const encodedDocId = docId.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/document/${YT_COLLECTION}/${encodedDocId}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      return c.json(await res.json());
    } catch (err) {
      log.warn("YouTube document fetch failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  app.get("/api/youtube/similar", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "Missing query parameter" }, 400);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const params = new URLSearchParams({ q, collection: YT_COLLECTION, limit: "7" });
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/search?${params}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      return c.json(await res.json());
    } catch (err) {
      log.warn("YouTube similar search failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  // --- SSE stream ---

  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      // Send recent history
      const recent = activityLog.getRecent(50);
      for (const event of recent) {
        await stream.writeSSE({ event: "activity", data: JSON.stringify(event) });
      }

      // Send current stats and agent status
      await stream.writeSSE({ event: "stats", data: JSON.stringify(activityLog.stats) });
      await stream.writeSSE({ event: "agent_status", data: JSON.stringify(agentStatus.get()) });
      await stream.writeSSE({ event: "request_progress", data: JSON.stringify(agentStatus.getProgress()) });

      // Subscribe to live updates
      let alive = true;
      const unsubscribeProgress = agentStatus.subscribeProgress(async (progress) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "request_progress", data: JSON.stringify(progress) });
        } catch {
          alive = false;
        }
      });
      const unsubscribeStatus = agentStatus.subscribe(async (status) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "agent_status", data: JSON.stringify(status) });
        } catch {
          alive = false;
        }
      });
      const unsubscribe = activityLog.subscribe(async (event) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "activity", data: JSON.stringify(event) });
          await stream.writeSSE({ event: "stats", data: JSON.stringify(activityLog.stats) });
        } catch {
          alive = false;
        }
      });

      // Heartbeat every 30s
      const heartbeat = setInterval(async () => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "heartbeat", data: "{}" });
        } catch {
          alive = false;
        }
      }, 30_000);

      // Wait until the stream is aborted
      stream.onAbort(() => {
        alive = false;
        unsubscribe();
        unsubscribeStatus();
        unsubscribeProgress();
        clearInterval(heartbeat);
      });

      // Keep the stream open (cleanup handled in onAbort)
      while (alive) {
        await Bun.sleep(1000);
      }
    });
  });

  return app;
}
