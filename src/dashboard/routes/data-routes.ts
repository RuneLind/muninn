import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { spec } from "../openapi-spec.ts";
import { Scalar } from "@scalar/hono-api-reference";
import { activityLog } from "../activity-log.ts";
import { discoverAllBots } from "../../bots/config.ts";
import { loadChatConfig, addChatUser } from "../../chat/chat-config.ts";
import { getRecentMessages } from "../../db/messages.ts";
import { getActiveGoals } from "../../db/goals.ts";
import { getAllGoals } from "../../db/goals.ts";
import { getScheduledTasksForUser } from "../../db/scheduled-tasks.ts";
import { getAllScheduledTasks } from "../../db/scheduled-tasks.ts";
import { getRecentMemories, getMemoriesByUser, getMemoriesForUser } from "../../db/memories.ts";
import { getDashboardStats, getSlackAnalytics, getUsersSummary, getUserOverview } from "../../db/stats.ts";
import { getAllWatchers } from "../../db/watchers.ts";
import { getAllThreadsForBot, deleteThreadById } from "../../db/threads.ts";
import { getUserSettings } from "../../db/user-settings.ts";
import { parseIntParam } from "./route-utils.ts";

const log = getLog("dashboard");

export function registerDataRoutes(app: Hono, _config: Config): void {
  app.get("/api/openapi.json", (c) => c.json(spec));
  app.get("/docs", Scalar({ url: "/api/openapi.json", pageTitle: "Muninn API" }));

  // --- Aggregate endpoints (single-user, no userId needed) ---

  app.get("/api/bots", async (c) => {
    try {
      const sql = (await import("../../db/client.ts")).getDb();
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

  app.get("/api/goals/:userId", async (c) => {
    const userId = c.req.param("userId");
    if (!userId) {
      return c.json({ error: "Invalid userId" }, 400);
    }
    const goals = await getActiveGoals(userId);
    return c.json({ goals });
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

  app.get("/api/scheduled-tasks/:userId", async (c) => {
    const userId = c.req.param("userId");
    if (!userId) {
      return c.json({ error: "Invalid userId" }, 400);
    }
    const tasks = await getScheduledTasksForUser(userId);
    return c.json({ tasks });
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

  app.get("/api/activity", (c) => {
    return c.json({
      events: activityLog.getRecent(50),
      stats: activityLog.stats,
    });
  });
}
