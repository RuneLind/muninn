import { loadConfig } from "./config.ts";
import { initDb, closeDb } from "./db/client.ts";
import { createBot } from "./bot/index.ts";
import { createDashboardRoutes, activityLog } from "./dashboard/index.ts";
import { warmupEmbeddings } from "./ai/embeddings.ts";
import { startScheduler, stopScheduler } from "./scheduler/runner.ts";

const config = loadConfig();

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

// Start Telegram bot
const bot = createBot(config);

activityLog.push("system", "Starting Telegram bot...");

bot.start({
  onStart: (botInfo) => {
    activityLog.push("system", `Telegram bot connected as @${botInfo.username}`);
    console.log(`Jarvis is live — bot: @${botInfo.username}, dashboard: http://localhost:${server.port}`);

    // Start unified scheduler after bot is connected (10s delay for stability)
    setTimeout(() => {
      startScheduler(bot.api, config);
    }, 10_000);
  },
});

// Graceful shutdown
async function shutdown() {
  console.log("\nShutting down...");
  stopScheduler();
  bot.stop();
  server.stop();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
