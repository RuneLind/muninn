import { loadConfig } from "./config.ts";
import { discoverBots } from "./bots/config.ts";
import { initDb, closeDb } from "./db/client.ts";
import { createBot } from "./bot/index.ts";
import { createDashboardRoutes, activityLog } from "./dashboard/index.ts";
import { warmupEmbeddings } from "./ai/embeddings.ts";
import { startScheduler, stopScheduler } from "./scheduler/runner.ts";
import type { Bot } from "grammy";

const config = loadConfig();
const botConfigs = discoverBots();

if (botConfigs.length === 0) {
  console.error("No bots discovered. Ensure bots/<name>/CLAUDE.md exists and TELEGRAM_BOT_TOKEN_<NAME> is set.");
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
const bots: Bot[] = [];

for (const botConfig of botConfigs) {
  const bot = createBot(config, botConfig);
  bots.push(bot);

  activityLog.push("system", `Starting ${botConfig.name} bot...`);

  bot.start({
    onStart: (botInfo) => {
      activityLog.push("system", `${botConfig.name} connected as @${botInfo.username}`);
      console.log(`${botConfig.name} is live — bot: @${botInfo.username}, dashboard: http://localhost:${server.port}`);
    },
  });
}

// Start per-bot schedulers after bots are connected (10s delay for stability)
setTimeout(() => {
  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i]!;
    const botCfg = botConfigs[i]!;
    startScheduler(bot.api, config, botCfg);
  }
}, 10_000);

// Graceful shutdown
async function shutdown() {
  console.log("\nShutting down...");
  stopScheduler();
  for (const bot of bots) {
    bot.stop();
  }
  server.stop();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
