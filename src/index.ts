import { loadConfig } from "./config.ts";
import { createBot } from "./bot/index.ts";
import { createDashboardRoutes, activityLog } from "./dashboard/index.ts";

const config = loadConfig();

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
  },
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  bot.stop();
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bot.stop();
  server.stop();
  process.exit(0);
});
