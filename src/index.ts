import { loadConfig } from "./config.ts";
import { discoverBots } from "./bots/config.ts";
import { initDb, closeDb } from "./db/client.ts";
import { createBot } from "./bot/index.ts";
import { createSlackApp } from "./slack/index.ts";
import { createDashboardRoutes, activityLog } from "./dashboard/index.ts";
import { warmupEmbeddings } from "./ai/embeddings.ts";
import { startScheduler, stopScheduler } from "./scheduler/runner.ts";
import type { Bot } from "grammy";
import type { App as SlackApp } from "@slack/bolt";

const config = loadConfig();
const botConfigs = discoverBots();

if (botConfigs.length === 0) {
  console.error("No bots discovered. Ensure bots/<name>/CLAUDE.md exists and at least one platform token is set.");
  process.exit(1);
}

// Initialize database
initDb(config);

// Pre-load embedding model (fire-and-forget)
warmupEmbeddings();

// Load persisted activity events from DB
await activityLog.loadFromDb();

// Start dashboard
const dashboard = createDashboardRoutes();

const server = Bun.serve({
  port: config.dashboardPort,
  fetch: dashboard.fetch,
  idleTimeout: 255, // max value, needed for SSE connections
});

activityLog.push("system", `Dashboard running on http://localhost:${server.port}`);

// Start all discovered bots
const telegramBotMap = new Map<string, Bot>();
const slackApps: SlackApp[] = [];

for (const botConfig of botConfigs) {
  // Start Telegram if token is available
  if (botConfig.telegramBotToken) {
    const bot = createBot(config, botConfig);
    telegramBotMap.set(botConfig.name, bot);

    activityLog.push("system", `Starting ${botConfig.name} Telegram bot...`);

    bot.start({
      onStart: (botInfo) => {
        activityLog.push("system", `${botConfig.name} Telegram connected as @${botInfo.username}`);
        console.log(`${botConfig.name} Telegram is live — bot: @${botInfo.username}, dashboard: http://localhost:${server.port}`);
      },
    });
  }

  // Start Slack if tokens are available
  if (botConfig.slackBotToken && botConfig.slackAppToken) {
    activityLog.push("system", `Starting ${botConfig.name} Slack app...`);

    createSlackApp(config, botConfig)
      .then((app) => {
        slackApps.push(app);
        activityLog.push("system", `${botConfig.name} Slack app connected`);
      })
      .catch((err) => {
        console.error(`[${botConfig.name}] Failed to start Slack app:`, err);
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
  console.log("\nShutting down...");
  stopScheduler();
  for (const bot of telegramBotMap.values()) {
    bot.stop();
  }
  for (const app of slackApps) {
    await app.stop().catch(() => {});
  }
  server.stop();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
