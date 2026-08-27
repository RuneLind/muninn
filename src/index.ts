import { setupLogging, getLog } from "./logging.ts";
import { loadConfig } from "./config.ts";
import { discoverActiveBots, discoverAllBots } from "./bots/config.ts";
import { initDb, closeDb } from "./db/client.ts";
import { createBot } from "./bot/index.ts";
import { createSlackApp } from "./slack/index.ts";
import { registerSlackApp, getAllSlackApps } from "./slack/registry.ts";
import { createDashboardRoutes } from "./dashboard/index.ts";
import { NAIS_DROPPED_ROUTE_GROUPS } from "./dashboard/route-groups.ts";
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
import { isWikiReadonly, WIKI_READONLY_ENV } from "./wiki/readonly.ts";
import { AuthConfigError, resolveAuthConfig, isAuthenticatingMode, type AuthConfig } from "./auth/mode.ts";
import { createAuthMiddleware } from "./auth/middleware.ts";
import { createIntrospector } from "./auth/introspect.ts";
import { createOriginMiddleware } from "./auth/origin.ts";
import { createZoneMiddleware } from "./auth/zone-middleware.ts";
import { setAuthPolicy } from "./auth/policy.ts";
import { createWsUpgradeAuthorizer } from "./auth/ws-upgrade.ts";
import { Hono } from "hono";
import type { Bot } from "grammy";

// `loadConfig()` throws on every fail-closed config condition — a missing
// DATABASE_URL, an unrecognised MUNINN_PROFILE, a `global` Vertex region. It has
// to run before `setupLogging`, which needs `logDir` from it, so there is no
// logger yet and an uncaught throw prints a Bun stack trace. In a nais pod that
// reaches the shared aggregator as an unhandled exception rather than as the one
// legible line the message already is. Same shape as the auth refusal below,
// minus the logger it cannot have yet.
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Refusing to start: ${(err as Error).message}`);
  process.exit(1);
}
await setupLogging(config.logDir);
const log = getLog("core");

// The auth contract, resolved before anything is STARTED — no DB pool, no bot
// processes, no MCP children — so a fail-closed refusal costs nothing. (Not
// before `loadConfig()` above, which is what demands `DATABASE_URL`: an instance
// missing that reports it first. Logging is already configured, so the refusal
// is never lost.) `resolveAuthConfig` throws on every fail-closed condition
// (nais without an authenticating mode, `entra` before the zone model lands, an
// authenticating mode missing its own config); the message is the whole
// diagnosis, so it is printed without a stack.
let auth: AuthConfig;
try {
  auth = resolveAuthConfig();
} catch (err) {
  if (err instanceof AuthConfigError) {
    log.error("Refusing to start: {message}", { message: err.message });
    process.exit(1);
  }
  throw err;
}
// Published to the two readers that live outside the request path and so cannot
// read the identity off a Hono context: `src/db/memories.ts`'s `scope='shared'`
// branch, the CORS sites across seven route files, and `getBotDefaultUser`'s
// pinned-identity fallback. Immediately
// after `resolveAuthConfig()` and before anything is started, because the
// default is `off` and a later call would leave a window in which a wildcard
// CORS header and a cross-user shared-memory read are both still live.
// `src/auth/wiring.test.ts` pins this call site.
setAuthPolicy(auth);

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

// Prime the role-override snapshot so the sync resolvers see DB overrides.
try {
  const { loadRoleOverrides } = await import("./db/role-overrides.ts");
  await loadRoleOverrides();
} catch (err) {
  log.warn("Failed to load role overrides: {error}", { error: err instanceof Error ? err.message : String(err) });
}

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
// Registered BEFORE any route: Hono matches handlers in registration order, so
// a `use` added after `route` would never run for those routes. Mounted only in
// an authenticating mode — with auth off there is no middleware to run.
// ONE introspector per process, shared by the HTTP middleware and the WebSocket
// upgrade below. Not a tidiness choice: in `entra` mode it holds the Texas
// introspection cache AND is the DB-provisioning path, so a second instance
// means the chat page's socket upgrade misses the cache its own HTTP request
// just filled (the pair the cache exists for, milliseconds apart) and two
// provisioning transactions race on a colleague's first login. Null with auth
// off, where neither consumer is mounted.
const introspector = createIntrospector(auth);
if (isAuthenticatingMode(auth.mode)) {
  app.use("*", createAuthMiddleware(auth, introspector));
  // AFTER the auth middleware, so a request with no credential is answered 401
  // by identity rather than 403 by origin — a scripted client must be able to
  // tell "you are not logged in" from "your origin is refused". Not mounted
  // with auth off: there is no ambient session to ride there, so the refusal
  // would change today's muninn to close nothing.
  app.use("*", createOriginMiddleware(auth.allowedOrigins, config.dashboardPort));
  // LAST of the three, and on the TOP-LEVEL app: it decides ROLE, so it must
  // run after identity exists (or every request is 403 before it can be 401)
  // and after the origin check (or a cross-origin side effect is judged by role
  // rather than refused). Mounting it inside `createDashboardRoutes` would
  // leave the `/chat` sub-app — the second `app.route` below — uncovered.
  app.use("*", createZoneMiddleware(auth));
}
app.route("/", dashboard);

// Always mount chat routes — uses ALL bots (not just those with platform tokens)
const chat = await import("./chat/index.ts");
const chatRoutes = chat.createChatRoutes(allBotConfigs, config);
app.route("/chat", chatRoutes);
// Redirect old /simulator paths for bookmarks/compat
app.all("/simulator/*", (c) => c.redirect(c.req.path.replace("/simulator", "/chat"), 301));
app.all("/simulator", (c) => c.redirect("/chat", 301));

// Start server — with WebSocket support for chat
// Built once at boot, like the two Hono middlewares: with auth off it is a
// constant "allow", so the wiring is exercised on every instance rather than
// only on the one that authenticates.
const authorizeWsUpgrade = createWsUpgradeAuthorizer(auth, config.dashboardPort, introspector);

const server = Bun.serve<import("./chat/index.ts").ChatWsData>({
  port: config.dashboardPort,
  // Bind loopback-only by default — with MUNINN_AUTH=off (the default) the
  // dashboard + chat expose MCP tools, logs, traces and full CRUD with no auth,
  // so they must not be reachable from the LAN.
  // Set DASHBOARD_HOST=0.0.0.0 to deliberately expose it (e.g. trusted home net).
  // `||` (not `??`) so a blank `DASHBOARD_HOST=` in .env or docker-compose
  // shorthand also falls through to the safe loopback default — empty-string
  // hostname is undocumented in Bun and a future release could treat it as
  // "bind everywhere", silently re-opening the very hole this default closes.
  hostname: process.env.DASHBOARD_HOST || "127.0.0.1",
  idleTimeout: 255, // max value, needed for SSE connections
  // `async` for the upgrade branch below, which must await introspection before
  // deciding. Measured on Bun 1.3.14 (`src/auth/ws-upgrade.test.ts`, acceptance
  // 13): `server.upgrade` still returns `true` after an `await` inside `fetch`,
  // and the socket delivers frames — the bundled Bun docs and types show only
  // the synchronous form and say nothing either way, and this plan does not
  // build on "very likely".
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/chat/ws" || url.pathname === "/simulator/ws") {
      // The one surface no Hono middleware can see: this runs before
      // `app.fetch`. Identity AND origin are decided here, by the same two
      // functions the HTTP path uses.
      const decision = await authorizeWsUpgrade(req, server.requestIP(req)?.address);
      if (!decision.ok) return decision.response;
      // `wsDataFor` rather than a literal: see its doc comment — a slip there is
      // an unfiltered socket that typechecks.
      const upgraded = server.upgrade(req, { data: chat.wsDataFor(decision) });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    // `server` is passed as Hono's env so `hono/bun`'s getConnInfo can read the
    // peer address — which is what the auth middleware's loopback bypass turns
    // on. Without it that bypass is inert and a wrong secret is a lockout.
    return app.fetch(req, server);
  },
  websocket: chat.chatWebSocket,
});

log.info("Dashboard: http://localhost:{port}", { port: server.port });
activityLog.push("system", `Dashboard running on http://localhost:${server.port}`);

// An authenticating mode is invisible from the outside until a request is
// refused, and its two LIMITS are invisible entirely — so both are said once, at
// boot, rather than left for the mode's presence to imply a boundary it does not
// have yet.
if (isAuthenticatingMode(auth.mode)) {
  log.info(
    "MUNINN_AUTH={mode} — HTTP requests and the /chat/ws upgrade require a credential. Resource guards, " +
    "the socket's owner filter and the ZONE model are all in place: role `user` reaches /chat and the " +
    "routes that page calls, and every other route — /traces, /models, /plans, /agents, /logs, " +
    "/api/prompts/:traceId, the unfiltered collection reads — answers 403. GET / redirects a `user` to " +
    "/chat. Only /api/live and /api/ready are reachable with no credential.",
    { mode: auth.mode },
  );
  // ⚠️ The next two lines are about the PINNED identity and the LOOPBACK
  // BYPASS, and both are `local`-mode mechanisms. In `entra` there is no pinned
  // identity for the bypass to hand out (`config.local` is null, so
  // `resolveRequestIdentity` cannot take that branch at all) and
  // MUNINN_LOCAL_ROLE is not even parsed — so printing them there described a
  // mechanism the running process does not have, at the one moment an operator
  // reads the log to learn what it does.
  if (auth.local) {
    log.info(
      "MUNINN_AUTH={mode}, MUNINN_LOCAL_ROLE={localRole} — a `local` identity resolves to that role ONLY " +
      "when its identity came from a credential channel. A DIRECT-LOOPBACK request with no credential is " +
      "always role `user`, and a BROWSER running on this host stays `user` even with MUNINN_LOCAL_ROLE=admin: " +
      "the login redirect strips the token, so the browser's cookie-only request takes the loopback bypass " +
      "(the identity is filled before the cookie is read) and never reaches the cookie branch. So a browser " +
      "on the host cannot reach the operator surface at all. Two ways in: front muninn with an HTTP proxy that " +
      "stamps x-forwarded-* (removing the bypass, so the session cookie is honoured and the browser gets " +
      "admin), or use `curl -H \"x-muninn-token: <secret>\"` from the host.",
      { mode: auth.mode, localRole: auth.localRole },
    );
    log.info(
      "MUNINN_AUTH={mode} — the loopback bypass trusts the PEER ADDRESS, so it is only sound behind an HTTP " +
      "proxy that stamps forwarding headers (e.g. `tailscale serve` in HTTP mode). An L4 forward — " +
      "`tailscale serve --tcp`, an nginx `stream` block, `ssh -L`, `socat`, `kubectl port-forward` — or a bare " +
      "`proxy_pass` with no `proxy_set_header` adds no headers, and every client through one is granted the " +
      "pinned identity with NO credential — at role `user`, which is why the bypass is not promotable. " +
      "See src/auth/CLAUDE.md.",
      { mode: auth.mode },
    );
  }
  if (auth.entra) {
    log.info(
      "MUNINN_AUTH=entra — every credential is an Entra access token on `Authorization: Bearer`, " +
      "introspected against {endpoint} (tenant {tenant}). There is NO loopback bypass and no pinned " +
      "identity: a request without a valid Bearer token is 401 wherever it comes from, this host " +
      "included. muninn mints no session cookie — wonderwall owns the session — and MUNINN_LOCAL_ROLE is " +
      "not read: role comes from MUNINN_ADMIN_IDENTS, matched against each token's own NAVident/oid. " +
      "A credential muninn cannot INTROSPECT (Texas unreachable, non-200, unparseable body) is answered " +
      "503, not 401, so clients retry instead of reloading through the sidecar.",
      { endpoint: auth.entra.introspectionEndpoint, tenant: auth.entra.tenant },
    );
  }
  activityLog.push(
    "system",
    auth.local ? `Auth mode: ${auth.mode} (local role: ${auth.localRole})` : `Auth mode: ${auth.mode}`,
  );
}

// The SERVING profile, same rule as the wiki-readonly line below: env-only,
// invisible from the outside, and every symptom it causes (a 404 on /wiki, a
// missing nav link, a typed Haiku refusal) reads as a bug until you know which
// profile is running. Announced only when it is not `default`.
if (config.profile === "nais") {
  log.info(
    "MUNINN_PROFILE=nais — serving profile: {dropped} route groups are NOT REGISTERED ({groups}), so they answer 404 " +
    "with no handler; the nav omits their links; the inbound-message preview log line drops to debug; and the HAIKU " +
    "spawns (spawnHaiku — the Haiku router's CLI fallback, plus the watchers, which call it directly) refuse with " +
    "HaikuCliUnavailableError (the image is built WITH_CLI=false). NOT covered: the claude-cli CHAT connector and the " +
    "executeOneShot family, which spawn the CLI on their own path — every bot on this deployment must be pinned to a " +
    "non-CLI connector. /chat, the DB/huginn-bound operator routes and both health paths are unchanged.",
    { dropped: NAIS_DROPPED_ROUTE_GROUPS.length, groups: NAIS_DROPPED_ROUTE_GROUPS.join(", ") },
  );
}

// The instance profile is env-only and otherwise invisible until two instances
// write one wiki, so the non-owner says so at boot. Announced only when ON: a
// line on every start of the write owner is noise, and the whole question here is
// "which machine am I looking at?".
if (isWikiReadonly()) {
  log.info(
    "{env}=1 — this instance is NOT the wiki write owner: programmatic wiki page writes are refused (git commits are still allowed). Profile is visible on /models.",
    { env: WIKI_READONLY_ENV },
  );
  activityLog.push("system", `Wiki-readonly instance (${WIKI_READONLY_ENV}=1) — no wiki page writes`);
}

// Start real Telegram/Slack bots + scheduler
for (const botConfig of botConfigs) {
  // Start Telegram if token is available
  if (botConfig.telegramBotToken) {
    const bot = createBot(config, botConfig);
    telegramBotMap.set(botConfig.name, bot);

    activityLog.push("system", `Starting ${botConfig.name} Telegram bot...`);

    bot.start({
      // grammy omits message_reaction from the default allowed_updates, so it must
      // be listed explicitly for reaction-based feedback to be delivered. Listing
      // allowed_updates opts out of the default, so "message" (commands + text +
      // voice) is enumerated too.
      allowed_updates: ["message", "message_reaction"],
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
