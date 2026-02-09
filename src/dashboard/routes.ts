import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { activityLog } from "./activity-log.ts";
import { renderDashboardPage } from "./views/page.ts";
import { getRecentMessages } from "../db/messages.ts";
import { getActiveGoals } from "../db/goals.ts";
import { getAllGoals } from "../db/goals.ts";
import { getScheduledTasksForUser } from "../db/scheduled-tasks.ts";
import { getAllScheduledTasks } from "../db/scheduled-tasks.ts";
import { getRecentMemories } from "../db/memories.ts";
import { getDashboardStats } from "../db/stats.ts";
import { getAllWatchers } from "../db/watchers.ts";
import { agentStatus } from "./agent-status.ts";

export function createDashboardRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    return c.html(renderDashboardPage());
  });

  // --- Aggregate endpoints (single-user, no userId needed) ---

  app.get("/api/stats", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const stats = await getDashboardStats(botName);
      return c.json(stats);
    } catch (err) {
      console.error("Failed to fetch dashboard stats:", err);
      return c.json({ error: "Failed to fetch stats" }, 500);
    }
  });

  app.get("/api/memories", async (c) => {
    try {
      const limit = parseInt(c.req.query("limit") ?? "20", 10);
      const botName = c.req.query("bot") || undefined;
      const memories = await getRecentMemories(limit, botName);
      return c.json({ memories });
    } catch (err) {
      console.error("Failed to fetch memories:", err);
      return c.json({ error: "Failed to fetch memories" }, 500);
    }
  });

  app.get("/api/goals", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const goals = await getAllGoals(botName);
      return c.json({ goals });
    } catch (err) {
      console.error("Failed to fetch goals:", err);
      return c.json({ error: "Failed to fetch goals" }, 500);
    }
  });

  app.get("/api/tasks", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const tasks = await getAllScheduledTasks(botName);
      return c.json({ tasks });
    } catch (err) {
      console.error("Failed to fetch tasks:", err);
      return c.json({ error: "Failed to fetch tasks" }, 500);
    }
  });

  app.get("/api/watchers", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const watchers = await getAllWatchers(botName);
      return c.json({ watchers });
    } catch (err) {
      console.error("Failed to fetch watchers:", err);
      return c.json({ error: "Failed to fetch watchers" }, 500);
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
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const messages = await getRecentMessages(userId, limit);
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
