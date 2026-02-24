import { setupLogging, getLog } from "./logging.ts";
import { loadConfig } from "./config.ts";
import { discoverActiveBots, discoverAllBots } from "./bots/config.ts";
import { initDb, closeDb } from "./db/client.ts";
import { createBot } from "./bot/index.ts";
import { createSlackApp } from "./slack/index.ts";
import { createDashboardRoutes, activityLog } from "./dashboard/index.ts";
import { warmupEmbeddings } from "./ai/embeddings.ts";
import { configureKnowledgeSearch } from "./ai/knowledge-search.ts";
import { startScheduler, stopScheduler, waitForPendingTicks } from "./scheduler/runner.ts";
import { disconnectAll as disconnectAllMcp } from "./dashboard/mcp-client.ts";
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

// Initialize database
initDb(config);

// Configure modules with centralized config
configureKnowledgeSearch(config.knowledgeApiUrl);

// Pre-load embedding model (fire-and-forget)
warmupEmbeddings();

// Load persisted activity events from DB
await activityLog.loadFromDb();

// Hydrate chat conversations — config-first, DB fallback (best-effort — don't block startup)
try {
  const { simulatorState } = await import("./simulator/state.ts");
  const { loadChatConfig } = await import("./simulator/chat-config.ts");
  const chatConfig = await loadChatConfig();
  if (chatConfig) {
    const hydratedCount = await simulatorState.hydrateFromConfig(chatConfig.users);
    if (hydratedCount > 0) {
      log.info("Hydrated {count} conversations from chat config", { count: hydratedCount });
    }
  } else {
    const hydratedCount = await simulatorState.hydrateFromDb();
    if (hydratedCount > 0) {
      log.info("Hydrated {count} conversations from DB", { count: hydratedCount });
    }
  }
} catch (err) {
  log.warn("Failed to hydrate chat conversations: {error}", { error: err instanceof Error ? err.message : String(err) });
}

// Build the combined Hono app
const dashboard = createDashboardRoutes(config);
const app = new Hono();
app.route("/", dashboard);

// Always mount chat routes — uses ALL bots (not just those with platform tokens)
const sim = await import("./simulator/index.ts");
const simulator = sim.createSimulatorRoutes(allBotConfigs, config);
app.route("/chat", simulator);
// Redirect old /simulator paths for bookmarks/compat
app.all("/simulator/*", (c) => c.redirect(c.req.path.replace("/simulator", "/chat"), 301));
app.all("/simulator", (c) => c.redirect("/chat", 301));

// Start server — with WebSocket support for chat
const server = Bun.serve<import("./simulator/index.ts").SimulatorWsData>({
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
  websocket: sim.simulatorWebSocket,
});

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
  await disconnectAllMcp();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
