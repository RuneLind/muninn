import { Hono } from "hono";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { simulatorState, type ConversationType } from "./state.ts";
import { processSimulatorMessage } from "./processor.ts";
import { renderSimulatorPage } from "./views/page.ts";

/**
 * Creates the simulator Hono sub-router.
 * Mounted at /simulator on the main dashboard server.
 */
export function createSimulatorRoutes(botConfigs: BotConfig[], config: Config): Hono {
  const app = new Hono();

  // Serve the simulator UI page
  app.get("/", (c) => {
    return c.html(renderSimulatorPage());
  });

  // List available bots
  app.get("/bots", (c) => {
    const bots = botConfigs.map((b) => ({
      name: b.name,
      hasTelegram: !!b.telegramBotToken,
      hasSlack: !!b.slackBotToken,
      model: b.model,
    }));
    return c.json({ bots });
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

    const validTypes: ConversationType[] = ["telegram_dm", "slack_dm", "slack_channel", "slack_assistant"];
    if (!validTypes.includes(body.type)) {
      return c.json({ error: `Invalid type. Must be one of: ${validTypes.join(", ")}` }, 400);
    }

    if (body.type === "slack_channel" && !body.channelName) {
      return c.json({ error: "channelName is required for slack_channel type" }, 400);
    }

    const conversation = simulatorState.createConversation({
      type: body.type,
      botName: body.botName,
      userId: body.userId ?? "sim-user-1",
      username: body.username ?? "simulator",
      channelName: body.channelName,
    });

    return c.json({ conversation }, 201);
  });

  // List all conversations
  app.get("/conversations", (c) => {
    const conversations = simulatorState.getConversations().map((conv) => ({
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
    const conversation = simulatorState.getConversation(id);
    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    return c.json({ conversation });
  });

  // Delete a specific conversation
  app.delete("/conversations/:id", (c) => {
    const id = c.req.param("id");
    const deleted = simulatorState.deleteConversation(id);
    if (!deleted) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    return c.json({ ok: true });
  });

  // Send a message in a conversation (triggers Claude processing)
  app.post("/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    const conversation = simulatorState.getConversation(id);
    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const body = await c.req.json<{ text: string }>();
    if (!body.text) {
      return c.json({ error: "text is required" }, 400);
    }

    const bot = botConfigs.find((b) => b.name === conversation.botName);
    if (!bot) {
      return c.json({ error: `Bot "${conversation.botName}" not found` }, 404);
    }

    // Process asynchronously — response comes via WebSocket
    processSimulatorMessage(id, body.text, bot, config).catch((err) => {
      console.error(`[simulator] Error processing message:`, err);
      // Add error message to conversation
      simulatorState.addMessage(id, {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        sender: "bot",
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
      simulatorState.setStatus(id, "");
    });

    return c.json({ status: "processing" }, 202);
  });

  // Reset all simulator state (and optionally truncate simulator DB tables)
  app.delete("/reset", async (c) => {
    simulatorState.clear();
    try {
      const { getDb } = await import("../db/client.ts");
      const sql = getDb();
      // Safety: only truncate if connected to a simulator database
      const rows = await sql`SELECT current_database()`;
      const current_database = rows[0]?.current_database as string | undefined;
      if (!current_database?.includes("simulator")) {
        return c.json({ error: "Refusing to truncate non-simulator database" }, 403);
      }
      await sql`TRUNCATE messages, activity_log, memories, goals, scheduled_tasks, watchers, haiku_usage, user_settings, traces, prompt_snapshots CASCADE`;
    } catch {
      // DB truncate is best-effort — state is always cleared
    }
    return c.json({ ok: true });
  });

  return app;
}
