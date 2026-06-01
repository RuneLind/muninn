import { setupLogging, getLog } from "./logging.ts";
import { loadConfig } from "./config.ts";
import { discoverActiveBots, discoverAllBots } from "./bots/config.ts";
import { initDb, closeDb } from "./db/client.ts";
import { createBot } from "./bot/index.ts";
import { createSlackApp } from "./slack/index.ts";
import { registerSlackApp, getAllSlackApps } from "./slack/registry.ts";
import { createDashboardRoutes } from "./dashboard/index.ts";
import { activityLog } from "./observability/activity-log.ts";
import { warmupEmbeddings } from "./ai/embeddings.ts";
import { startScheduler, stopScheduler, waitForPendingTicks } from "./scheduler/runner.ts";
import { waitForPendingExtractions } from "./ai/extraction-tracker.ts";
import { logResolvedHaikuBackends } from "./ai/haiku-direct.ts";
import { disconnectAll as disconnectAllMcp } from "./ai/mcp-tool-caller.ts";
import { serenaManager } from "./serena/manager.ts";
import { hivemindManager } from "./hivemind/manager.ts";
import { researchMcpServer } from "./research/mcp-server.ts";
import { startStaleHandoffSweep, stopStaleHandoffSweep } from "./chat/stale-sweep.ts";
import { auditMcpAdapters } from "./startup/adapter-audit.ts";
import { Hono } from "hono";
import type { Bot } from "grammy";

const config = loadConfig();
await setupLogging(config.logDir);
const log = getLog("core");

// Backstop for promise rejections that escape a fire-and-forget path (e.g. a
// throw inside an extraction `onResult` callback). Bun would otherwise log and
// continue with the process in an indeterminate state; we log it explicitly at
// error level with a stable category so it is searchable, and keep running —
// a single background failure must never take down the bot.
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection: {reason}", {
    reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  });
});

// Surface any MCP adapter processes that survived `predev: cleanup:kill`. Stale
// adapters captured a different HUGINN_TRACE_* env at module-load and silently
// skip trace marker emission; this audit names them in the log so intermittent
// search-trace failures stop being mysterious.
await auditMcpAdapters();
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

// Surface the effective Haiku backend (+ the precedence rule that chose it) per
// bot, so a mis-resolved backend is visible at boot rather than via the trace.
logResolvedHaikuBackends(allBotConfigs);

// Module-level references for shutdown handler
const telegramBotMap = new Map<string, Bot>();

// Discover Serena instances from bot configs (lazy — doesn't start them)
serenaManager.init();

// Initialize database
initDb(config);

// Pre-load embedding model (fire-and-forget)
warmupEmbeddings();

// Pre-build browser bundles so the first /traces and /chat request doesn't
// pay Bun.build latency. The accessors memoize, so this just primes the cache;
// any build error will resurface on the actual request.
import("./dashboard/views/components/helpers-client.ts").then((m) => m.helpersClientScript()).catch(() => {});
import("./dashboard/views/components/traces-waterfall-client.ts").then((m) => m.tracesWaterfallClientScript()).catch(() => {});
import("./chat/views/components/web-format-client.ts").then((m) => m.webFormatClientScript()).catch(() => {});

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

// Start hivemind manager (peers, MCP server). Best-effort — never blocks boot.
hivemindManager.start(allBotConfigs, config).catch((err) => {
  log.warn("Hivemind manager failed to start: {error}", { error: err instanceof Error ? err.message : String(err) });
});

// Periodic stale-handoff sweep (spec-driven dev loop, Phase 5): nudges open chat
// tabs so a run parked on a dead/silent peer surfaces its re-send affordance.
startStaleHandoffSweep();

// Start research_knowledge MCP server. Bots opt in by adding the server to their
// .mcp.json — bots without it just don't see the tool.
try {
  researchMcpServer.start();
  for (const bot of allBotConfigs) {
    researchMcpServer.registerBot({
      botName: bot.name,
      botDir: bot.dir,
      knowledgeApiUrl: config.knowledgeApiUrl,
      defaultCollections: bot.defaultKnowledgeCollections,
      connector: bot.connector,
      haikuBackend: bot.haikuBackend,
    });
  }
} catch (err) {
  log.warn("Research MCP server failed to start: {error}", { error: err instanceof Error ? err.message : String(err) });
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
  // Bind loopback-only by default — the dashboard + chat expose MCP tools, logs,
  // traces and full CRUD with no auth, so they must not be reachable from the LAN.
  // Set DASHBOARD_HOST=0.0.0.0 to deliberately expose it (e.g. trusted home net).
  // `||` (not `??`) so a blank `DASHBOARD_HOST=` in .env or docker-compose
  // shorthand also falls through to the safe loopback default — empty-string
  // hostname is undocumented in Bun and a future release could treat it as
  // "bind everywhere", silently re-opening the very hole this default closes.
  hostname: process.env.DASHBOARD_HOST || "127.0.0.1",
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
        registerSlackApp(botConfig.name, app);
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
  stopStaleHandoffSweep();
  await waitForPendingTicks(10_000);
  // Let in-flight memory/goal/schedule extractions finish their DB writes
  // before the pool closes below — otherwise their writes race closeDb().
  await waitForPendingExtractions(10_000);

  for (const bot of telegramBotMap.values()) {
    bot.stop();
  }

  for (const app of getAllSlackApps()) {
    await app.stop().catch(() => {});
  }

  server.stop();
  await hivemindManager.stop();
  await researchMcpServer.stop();
  await serenaManager.stopAll();
  await disconnectAllMcp();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
