import { setupLogging, getLog } from "./logging.ts";
import { loadConfig } from "./config.ts";
import { discoverBots, discoverBotsForSimulator } from "./bots/config.ts";
import { initDb, closeDb, ensureSimulatorDb } from "./db/client.ts";
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
const botConfigs = config.simulatorEnabled
  ? discoverBotsForSimulator()
  : discoverBots();

if (botConfigs.length === 0) {
  log.error("No bots discovered. Ensure bots/<name>/CLAUDE.md exists" +
    (config.simulatorEnabled ? "." : " and at least one platform token is set."));
  process.exit(1);
}

// Module-level references for shutdown handler
let telegramBotMap: Map<string, Bot> | undefined;
let slackAppList: SlackApp[] | undefined;

// Initialize database — simulator mode uses a separate DB
if (config.simulatorEnabled) {
  await ensureSimulatorDb(config.databaseUrl, config.simulatorDatabaseUrl);
  initDb(config, config.simulatorDatabaseUrl);
} else {
  initDb(config);
}

// Configure modules with centralized config
configureKnowledgeSearch(config.knowledgeApiUrl);

// Pre-load embedding model (fire-and-forget)
warmupEmbeddings();

// Load persisted activity events from DB
await activityLog.loadFromDb();

// Build the combined Hono app
const dashboard = createDashboardRoutes(config);
const app = new Hono();
app.route("/", dashboard);

// Lazy-load simulator module only when enabled (avoids importing in production)
type WsData = { unsubscribe: (() => void) | null };
let simulatorWs: import("bun").WebSocketHandler<WsData> | undefined;

if (config.simulatorEnabled) {
  const sim = await import("./simulator/index.ts");
  const simulator = sim.createSimulatorRoutes(botConfigs, config);
  app.route("/simulator", simulator);
  simulatorWs = sim.simulatorWebSocket;
}

// Start server — with WebSocket support for simulator
const noopWs: import("bun").WebSocketHandler<WsData> = { message() {} };

const server = Bun.serve<WsData>({
  port: config.dashboardPort,
  idleTimeout: 255, // max value, needed for SSE connections
  fetch(req, server) {
    // Handle WebSocket upgrade for simulator (only when enabled)
    if (simulatorWs) {
      const url = new URL(req.url);
      if (url.pathname === "/simulator/ws") {
        const upgraded = server.upgrade(req, {
          data: { unsubscribe: null },
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }
    }
    return app.fetch(req);
  },
  websocket: simulatorWs ?? noopWs,
});

activityLog.push("system", `Dashboard running on http://localhost:${server.port}`);

if (config.simulatorEnabled) {
  // Simulator mode — skip real platform startup
  activityLog.push("system", "Simulator mode enabled — real platform bots and scheduler are disabled");
  log.info("Simulator mode — dashboard: http://localhost:{port}, simulator: http://localhost:{port}/simulator", { port: server.port });
} else {
  // Normal mode — start real Telegram/Slack bots + scheduler
  telegramBotMap = new Map<string, Bot>();
  slackAppList = [];

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
          slackAppList?.push(app);
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

      const telegramBot = telegramBotMap?.get(botCfg.name);
      if (telegramBot) {
        startScheduler(telegramBot.api, config, botCfg);
      }
    }
  }, 10_000);
}

// Graceful shutdown
async function shutdown() {
  log.info("Shutting down...");
  stopScheduler();
  await waitForPendingTicks(10_000);

  if (telegramBotMap) {
    for (const bot of telegramBotMap.values()) {
      bot.stop();
    }
  }

  if (slackAppList) {
    for (const app of slackAppList) {
      await app.stop().catch(() => {});
    }
  }

  server.stop();
  await disconnectAllMcp();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
