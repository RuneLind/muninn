import { setupLogging, getLog } from "./logging.ts";
import { loadConfig } from "./config.ts";
import { discoverActiveBots, discoverAllBots } from "./bots/config.ts";
import { initDb, closeDb } from "./db/client.ts";
import { createBot } from "./bot/index.ts";
import { createSlackApp } from "./slack/index.ts";
import { createDashboardRoutes, activityLog } from "./dashboard/index.ts";
import { warmupEmbeddings } from "./ai/embeddings.ts";
import { startScheduler, stopScheduler, waitForPendingTicks } from "./scheduler/runner.ts";
import { disconnectAll as disconnectAllMcp } from "./dashboard/mcp-client.ts";
import { serenaManager } from "./serena/manager.ts";
import { Hono } from "hono";
import type { Bot } from "grammy";
import type { App as SlackApp } from "@slack/bolt";

const config = loadConfig();
await setupLogging(config.logDir);
const log = getLog("core");
// Discover all bots with CLAUDE.md (dashboard/chat page needs all bots)
const allBotConfigs = discoverAllBots();
// For platform startup: only bots with Telegram/Slack tokens
const botConfigs = discoverActiveBots();

if (allBotConfigs.length === 0) {
  log.error("No bots discovered. Ensure bots/<name>/CLAUDE.md exists.");
  process.exit(1);
}
if (botConfigs.length === 0) {
  log.warn("No bots have platform tokens — only dashboard + /chat will be available. Set TELEGRAM_BOT_TOKEN_<NAME> or SLACK_BOT_TOKEN_<NAME> + SLACK_APP_TOKEN_<NAME> for live bots.");
}

// Module-level references for shutdown handler
const telegramBotMap = new Map<string, Bot>();
const slackAppList: SlackApp[] = [];

// Discover Serena instances from bot configs (lazy — doesn't start them)
serenaManager.init();

// Initialize database
initDb(config);

// Pre-load embedding model (fire-and-forget)
warmupEmbeddings();

// Seed connector entries from bot configs (first run only)
try {
  const { seedConnectorsFromBotConfigs } = await import("./db/connectors.ts");
  const seeded = await seedConnectorsFromBotConfigs(allBotConfigs);
  if (seeded > 0) {
    log.info("Seeded {count} connectors from bot configs", { count: seeded });
  }
} catch (err) {
  log.warn("Failed to seed connectors: {error}", { error: err instanceof Error ? err.message : String(err) });
}

// Load persisted activity events from DB
await activityLog.loadFromDb();

// Migrate chat.config.json to DB (one-time, best-effort)
try {
  const { migrateChatConfigFile } = await import("./chat/chat-config.ts");
  const migrated = await migrateChatConfigFile();
  if (migrated > 0) {
    log.info("Migrated {count} users from chat.config.json to DB", { count: migrated });
  }
} catch (err) {
  log.warn("Failed to migrate chat config: {error}", { error: err instanceof Error ? err.message : String(err) });
}

// Hydrate chat conversations from DB (best-effort — don't block startup)
try {
  const { chatState } = await import("./chat/state.ts");
  const hydratedCount = await chatState.hydrateFromDb();
  if (hydratedCount > 0) {
    log.info("Hydrated {count} conversations from DB", { count: hydratedCount });
  }
} catch (err) {
  log.warn("Failed to hydrate chat conversations: {error}", { error: err instanceof Error ? err.message : String(err) });
}

// Build the combined Hono app
const dashboard = createDashboardRoutes(config);
const app = new Hono();
app.route("/", dashboard);

// Always mount chat routes — uses ALL bots (not just those with platform tokens)
const chat = await import("./chat/index.ts");
const chatRoutes = chat.createChatRoutes(allBotConfigs, config);
app.route("/chat", chatRoutes);
// Redirect old /simulator paths for bookmarks/compat
app.all("/simulator/*", (c) => c.redirect(c.req.path.replace("/simulator", "/chat"), 301));
app.all("/simulator", (c) => c.redirect("/chat", 301));

// Start server — with WebSocket support for chat
const server = Bun.serve<import("./chat/index.ts").ChatWsData>({
  port: config.dashboardPort,
  idleTimeout: 255, // max value, needed for SSE connections
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/chat/ws" || url.pathname === "/simulator/ws") {
      const upgraded = server.upgrade(req, {
        data: { unsubscribe: null },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return app.fetch(req);
  },
  websocket: chat.chatWebSocket,
});

log.info("Dashboard: http://localhost:{port}", { port: server.port });
activityLog.push("system", `Dashboard running on http://localhost:${server.port}`);

// Start real Telegram/Slack bots + scheduler
for (const botConfig of botConfigs) {
  // Start Telegram if token is available
  if (botConfig.telegramBotToken) {
    const bot = createBot(config, botConfig);
    telegramBotMap.set(botConfig.name, bot);

    activityLog.push("system", `Starting ${botConfig.name} Telegram bot...`);

    bot.start({
      onStart: (botInfo) => {
        activityLog.push("system", `${botConfig.name} Telegram connected as @${botInfo.username}`);
        log.info("{botName} Telegram is live — bot: @{botUsername}, dashboard: http://localhost:{port}", { botName: botConfig.name, botUsername: botInfo.username, port: server.port });
      },
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("{botName} Telegram failed to start: {error} — check TELEGRAM_BOT_TOKEN_{env}", { botName: botConfig.name, error: msg, env: botConfig.name.toUpperCase() });
      activityLog.push("error", `${botConfig.name} Telegram failed: ${msg} — is the bot token valid?`);
      telegramBotMap.delete(botConfig.name);
    });
  }

  // Start Slack if tokens are available
  if (botConfig.slackBotToken && botConfig.slackAppToken) {
    activityLog.push("system", `Starting ${botConfig.name} Slack app...`);

    createSlackApp(config, botConfig)
      .then((app) => {
        slackAppList.push(app);
        activityLog.push("system", `${botConfig.name} Slack app connected`);
      })
      .catch((err) => {
        log.error("Failed to start Slack app: {error}", { botName: botConfig.name, error: err.message });
        activityLog.push("error", `${botConfig.name} Slack app failed: ${err.message}`);
      });
  }
}

// Start per-bot schedulers after bots are connected (10s delay for stability)
// Scheduler uses Telegram API — only start for bots with Telegram tokens
setTimeout(() => {
  for (const botCfg of botConfigs) {
    if (!botCfg.telegramBotToken) continue;

    const telegramBot = telegramBotMap.get(botCfg.name);
    if (telegramBot) {
      startScheduler(telegramBot.api, config, botCfg);
    }
  }
}, 10_000);

// Graceful shutdown
async function shutdown() {
  log.info("Shutting down...");
  stopScheduler();
  await waitForPendingTicks(10_000);

  for (const bot of telegramBotMap.values()) {
    bot.stop();
  }

  for (const app of slackAppList) {
    await app.stop().catch(() => {});
  }

  server.stop();
  await serenaManager.stopAll();
  await disconnectAllMcp();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
