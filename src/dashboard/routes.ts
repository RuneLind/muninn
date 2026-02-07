import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { activityLog } from "./activity-log.ts";
import { renderDashboardPage } from "./views/page.ts";
import { getRecentMessages } from "../db/messages.ts";

export function createDashboardRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    return c.html(renderDashboardPage());
  });

  app.get("/api/activity", (c) => {
    return c.json({
      events: activityLog.getRecent(50),
      stats: activityLog.stats,
    });
  });

  app.get("/api/messages/:userId", async (c) => {
    const userId = parseInt(c.req.param("userId"), 10);
    if (isNaN(userId)) {
      return c.json({ error: "Invalid userId" }, 400);
    }
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const messages = await getRecentMessages(userId, limit);
    return c.json({ messages });
  });

  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      // Send recent history
      const recent = activityLog.getRecent(50);
      for (const event of recent) {
        await stream.writeSSE({ event: "activity", data: JSON.stringify(event) });
      }

      // Send current stats
      await stream.writeSSE({ event: "stats", data: JSON.stringify(activityLog.stats) });

      // Subscribe to live updates
      let alive = true;
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
        clearInterval(heartbeat);
      });

      // Keep the stream open
      while (alive) {
        await Bun.sleep(1000);
      }

      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  return app;
}
