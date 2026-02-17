import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getLog } from "../logging.ts";
import { activityLog } from "./activity-log.ts";
import { renderDashboardPage } from "./views/page.ts";
import { renderTracesPage } from "./views/traces-page.ts";
import { renderSearchPage } from "./views/search-page.ts";
import { renderKnowledgePage } from "./views/knowledge-page.ts";
import { getRecentMessages } from "../db/messages.ts";
import { getActiveGoals } from "../db/goals.ts";
import { getAllGoals } from "../db/goals.ts";
import { getScheduledTasksForUser } from "../db/scheduled-tasks.ts";
import { getAllScheduledTasks } from "../db/scheduled-tasks.ts";
import { getRecentMemories, getMemoriesByUser, getMemoriesForUser, dashboardSearchMemories, getSearchStats } from "../db/memories.ts";
import { generateEmbedding } from "../ai/embeddings.ts";
import { getDashboardStats, getSlackAnalytics, getUsersSummary } from "../db/stats.ts";
import { getAllWatchers } from "../db/watchers.ts";
import { getRecentTraces, getTrace, getTraceStats, getTraceFilterOptions } from "../db/traces.ts";
import { getAllThreadsForBot } from "../db/threads.ts";
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

export function createDashboardRoutes(): Hono {
  const app = new Hono();

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

  // --- Search page ---

  app.get("/search", (c) => {
    return c.html(renderSearchPage());
  });

  app.get("/api/search", async (c) => {
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

  app.get("/api/search-stats", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const stats = await getSearchStats(botName);
      return c.json(stats);
    } catch (err) {
      log.error("Failed to fetch search stats: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch search stats" }, 500);
    }
  });

  // --- Knowledge page (proxy to Knowledge API) ---

  const KNOWLEDGE_API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";

  app.get("/knowledge", (c) => {
    return c.html(renderKnowledgePage());
  });

  app.get("/api/knowledge/health", async (c) => {
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

  app.get("/api/knowledge/collections", async (c) => {
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

  app.get("/api/knowledge/search", async (c) => {
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

  app.get("/api/knowledge/document/:collection/:docId", async (c) => {
    try {
      const collection = c.req.param("collection");
      const docId = c.req.param("docId");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/document/${collection}/${docId}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      const data = await res.json();
      return c.json(data);
    } catch (err) {
      log.warn("Knowledge document fetch failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
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

      // Subscribe to live updates
      let alive = true;
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
        clearInterval(heartbeat);
      });

      // Keep the stream open
      while (alive) {
        await Bun.sleep(1000);
      }

      unsubscribe();
      unsubscribeStatus();
      clearInterval(heartbeat);
    });
  });

  return app;
}
