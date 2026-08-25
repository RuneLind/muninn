import type { Hono } from "hono";
import { existsSync } from "node:fs";
import { getLog } from "../../logging.ts";
import { spec } from "../openapi-spec.ts";
import { Scalar } from "@scalar/hono-api-reference";
import { activityLog } from "../../observability/activity-log.ts";
import { discoverAllBots } from "../../bots/config.ts";
import { addChatUser } from "../../chat/chat-config.ts";
import { getRecentMessages } from "../../db/messages.ts";
import { getActiveGoals } from "../../db/goals.ts";
import { getAllGoals } from "../../db/goals.ts";
import { getScheduledTasksForUser } from "../../db/scheduled-tasks.ts";
import { getAllScheduledTasks } from "../../db/scheduled-tasks.ts";
import { getRecentMemories, getMemoriesByUser, getMemoriesForUser } from "../../db/memories.ts";
import { getDashboardStats, getSlackAnalytics, getUsersSummary, getUserOverview } from "../../db/stats.ts";
import {
  getAllWatchers,
  updateWatcher,
  getWatcherById,
  forceRunWatcher,
  getWatcherSnapshot,
} from "../../db/watchers.ts";
import { SOURCE_HEALTH_KEY } from "../../watchers/source-health.ts";
import { RUN_HEALTH_KEY, mergeHealthChips } from "../../watchers/run-health.ts";
import { getScheduledTaskById } from "../../db/scheduled-tasks.ts";
import { updateScheduledTask } from "../../db/scheduled-tasks.ts";
import { getActivityForJob } from "../../db/activity.ts";
import { runScheduledTasksFromList } from "../../scheduler/task-executor.ts";
import { getSchedulerContext } from "../../scheduler/runner.ts";
import { getAllThreadsForBot, deleteThreadById } from "../../db/threads.ts";
import { getUserSettings } from "../../db/user-settings.ts";
import { listConnectors, createConnector, updateConnector, deleteConnector } from "../../db/connectors.ts";
import type { ConnectorType } from "../../bots/config.ts";
import { parseIntParam, isValidUuid } from "./route-utils.ts";
import {
  isReadonlyWikiRoot,
  isWikiReadonly,
  wikiReadonlyRootReason,
  WIKI_READONLY_REASON,
} from "../../wiki/readonly.ts";
import { findWiki } from "../../wiki/registry.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
// Shared with the SCHEDULED path (`runChecker` in src/watchers/runner.ts) so the
// manual trigger and the weekly run can never disagree about which watcher types
// draft into a wiki.
import {
  shouldSkipWikiDraftingRun,
  wikiDraftingTarget,
  type WikiDraftingTarget,
} from "../../watchers/wiki-drafting.ts";
import type { WatcherType } from "../../types.ts";
import { requireOwnUser } from "../../auth/guard.ts";

const log = getLog("dashboard");

/**
 * The per-wiki read-only decision for a watcher, bound to the real seams. The
 * rules (which types draft, which root each one drafts into, and why an
 * unresolvable drafting type fails CLOSED) live beside the shared type set in
 * `src/watchers/wiki-drafting.ts`, so this entry point cannot disagree with the
 * scheduled one about any of them.
 */
function watcherWikiDecision(watcher: {
  type: WatcherType;
  botName: string;
  config?: Record<string, unknown> | null;
}): WikiDraftingTarget {
  return wikiDraftingTarget(watcher, {
    botWikiDir: (bot) => discoverAllBots().find((b) => b.name === bot)?.wikiDir,
    wikiRootByName: (name) => findWiki(getWikiRegistry(), name)?.root,
    isReadonlyRoot: isReadonlyWikiRoot,
  });
}

export function registerDataRoutes(app: Hono): void {
  app.get("/api/openapi.json", (c) => c.json(spec));
  app.get("/docs", Scalar({ url: "/api/openapi.json", pageTitle: "Muninn API" }));

  // --- Aggregate endpoints (single-user, no userId needed) ---

  app.get("/api/bots", async (c) => {
    try {
      const sql = (await import("../../db/client.ts")).getDb();
      const rows = await sql`SELECT DISTINCT bot_name FROM messages WHERE bot_name IS NOT NULL ORDER BY bot_name`;
      return c.json({ bots: rows.map((r: Record<string, unknown>) => r.bot_name as string) });
    } catch (err) {
      log.error("Failed to fetch bots: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch bots" }, 500);
    }
  });

  app.get("/api/bots/config", (c) => {
    const bots = discoverAllBots().map((b) => ({
      name: b.name,
      connector: b.connector ?? "claude-cli",
      model: b.model ?? null,
      baseUrl: b.baseUrl ?? null,
      timeoutMs: b.timeoutMs ?? null,
      thinkingMaxTokens: b.thinkingMaxTokens ?? null,
      hasMcp: existsSync(`${b.dir}/.mcp.json`),
      platforms: [
        ...(b.telegramBotToken ? ["telegram"] : []),
        ...(b.slackBotToken ? ["slack"] : []),
      ],
    }));
    return c.json({ bots });
  });

  app.get("/api/stats", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const stats = await getDashboardStats(botName);
      return c.json(stats);
    } catch (err) {
      log.error("Failed to fetch dashboard stats: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch stats" }, 500);
    }
  });

  app.get("/api/memories", async (c) => {
    try {
      const limit = parseIntParam(c.req.query("limit"), 20, 100);
      const botName = c.req.query("bot") || undefined;
      const memories = await getRecentMemories(limit, botName);
      return c.json({ memories });
    } catch (err) {
      log.error("Failed to fetch memories: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch memories" }, 500);
    }
  });

  app.get("/api/memories/by-user", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const users = await getMemoriesByUser(botName);
      return c.json({ users });
    } catch (err) {
      log.error("Failed to fetch memories by user: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch memories by user" }, 500);
    }
  });

  app.get("/api/memories/user/:userId", async (c) => {
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return own.response;
    try {
      const userId = own.userId;
      if (!userId) {
        return c.json({ error: "Invalid userId" }, 400);
      }
      const limit = parseIntParam(c.req.query("limit"), 20, 100);
      const botName = c.req.query("bot") || undefined;
      const memories = await getMemoriesForUser(userId, limit, botName);
      return c.json({ memories });
    } catch (err) {
      log.error("Failed to fetch memories for user: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch memories for user" }, 500);
    }
  });

  app.get("/api/goals", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const goals = await getAllGoals(botName);
      return c.json({ goals });
    } catch (err) {
      log.error("Failed to fetch goals: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch goals" }, 500);
    }
  });

  app.get("/api/goals/:userId", async (c) => {
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return own.response;
    try {
      const userId = own.userId;
      if (!userId) {
        return c.json({ error: "Invalid userId" }, 400);
      }
      // `?bot=` must be honoured: both the chat inspector and the dashboard's
      // detail panel send it, and a user's goals are per-bot rows. Dropping it
      // listed every bot's goals under whichever bot was selected — and
      // disagreed with the tab badge, which `getUsersSummary` already scopes.
      const botName = c.req.query("bot") || undefined;
      const goals = await getActiveGoals(userId, botName);
      return c.json({ goals });
    } catch (err) {
      log.error("Failed to fetch goals for user: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch goals for user" }, 500);
    }
  });

  app.get("/api/tasks", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const tasks = await getAllScheduledTasks(botName);
      return c.json({ tasks });
    } catch (err) {
      log.error("Failed to fetch tasks: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch tasks" }, 500);
    }
  });

  app.get("/api/scheduled-tasks/:userId", async (c) => {
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return own.response;
    try {
      const userId = own.userId;
      if (!userId) {
        return c.json({ error: "Invalid userId" }, 400);
      }
      // Same as /api/goals/:userId above — the sent `?bot=` was being dropped.
      const botName = c.req.query("bot") || undefined;
      const tasks = await getScheduledTasksForUser(userId, botName);
      return c.json({ tasks });
    } catch (err) {
      log.error("Failed to fetch scheduled tasks for user: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch scheduled tasks for user" }, 500);
    }
  });

  app.get("/api/threads", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const threads = await getAllThreadsForBot(botName);
      return c.json({ threads });
    } catch (err) {
      log.error("Failed to fetch threads: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch threads" }, 500);
    }
  });

  app.delete("/api/threads/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const deleted = await deleteThreadById(id);
      if (!deleted) {
        return c.json({ error: "Thread not found or is the main thread" }, 404);
      }
      log.info("Deleted thread {threadId} ({threadName}) for user {userId}", {
        threadId: deleted.id, threadName: deleted.name, userId: deleted.userId,
      });
      return c.json({ ok: true, thread: deleted });
    } catch (err) {
      log.error("Failed to delete thread: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to delete thread" }, 500);
    }
  });

  app.get("/api/users", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const users = await getUsersSummary(botName);
      return c.json({ users });
    } catch (err) {
      log.error("Failed to fetch users: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch users" }, 500);
    }
  });

  app.post("/api/users", async (c) => {
    try {
      const body = await c.req.json<{ userId: string; username: string; botName: string }>();
      if (!body.userId || !body.username || !body.botName) {
        return c.json({ error: "userId, username, and botName are required" }, 400);
      }
      const allBots = discoverAllBots();
      if (!allBots.some((b) => b.name === body.botName)) {
        return c.json({ error: `Bot "${body.botName}" not found` }, 400);
      }
      // Create user in DB + ensure default thread
      await addChatUser({ id: body.userId, name: body.username, bot: body.botName });
      log.info("Created user {userId} ({username}) for bot {botName}", {
        userId: body.userId, username: body.username, botName: body.botName,
      });
      return c.json({ ok: true, user: { userId: body.userId, username: body.username, botName: body.botName } }, 201);
    } catch (err) {
      log.error("Failed to create user: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to create user" }, 500);
    }
  });

  app.get("/api/users/:userId/overview", async (c) => {
    try {
      const userId = c.req.param("userId");
      if (!userId) return c.json({ error: "Invalid userId" }, 400);
      const botName = c.req.query("bot") || undefined;
      const overview = await getUserOverview(userId, botName);
      return c.json(overview);
    } catch (err) {
      log.error("Failed to fetch user overview: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch user overview" }, 500);
    }
  });

  app.get("/api/user-settings/:userId", async (c) => {
    const own = requireOwnUser(c, c.req.param("userId"));
    if (!own.ok) return own.response;
    try {
      const userId = own.userId;
      if (!userId) {
        return c.json({ error: "Invalid userId" }, 400);
      }
      const settings = await getUserSettings(userId);
      return c.json({ settings });
    } catch (err) {
      log.error("Failed to fetch user settings: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch user settings" }, 500);
    }
  });

  app.get("/api/messages/:userId", async (c) => {
    const userId = c.req.param("userId");
    if (!userId) {
      return c.json({ error: "Invalid userId" }, 400);
    }
    const limit = parseIntParam(c.req.query("limit"), 50, 200);
    const botName = c.req.query("bot") || undefined;
    const threadId = c.req.query("thread") || undefined;
    // getRecentMessages requires a bot when a thread is given (a NULL bot_name
    // filter would silently cross threads). Surface a clean 400 here rather than
    // letting the guard throw out of this un-try/catch'd handler as a bare 500.
    if (threadId && !botName) {
      return c.json({ error: "bot is required when thread is provided" }, 400);
    }
    const messages = await getRecentMessages(userId, limit, botName, threadId);
    return c.json({ messages });
  });

  app.get("/api/slack-analytics", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const analytics = await getSlackAnalytics(botName);
      return c.json(analytics);
    } catch (err) {
      log.error("Failed to fetch Slack analytics: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch Slack analytics" }, 500);
    }
  });

  app.get("/api/watchers", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const watchers = await getAllWatchers(botName);
      // Per-source health (see src/watchers/source-health.ts). Attached here rather than
      // stored on the watcher row because it is per-SUB-SOURCE state: `last_run_at` being
      // fresh says the watcher ran, not that any given source produced anything — the
      // exact gap that let the anthropic llms.txt leg sit dead for six days while every
      // indicator on this page read healthy. Best-effort per watcher: a health read must
      // never take down the watchers list.
      const withHealth = await Promise.all(
        watchers.map(async (w) => {
          try {
            // Two snapshot keys, one chip list — see `mergeHealthChips`, which owns
            // the merge, the cadence and the ordering because this route is only
            // reachable with a live DB and every decision in it was otherwise
            // pinned by nothing.
            const [sourceSnap, runSnap] = await Promise.all([
              getWatcherSnapshot(w.id, SOURCE_HEALTH_KEY),
              getWatcherSnapshot(w.id, RUN_HEALTH_KEY),
            ]);
            const sourceHealth = mergeHealthChips(runSnap, sourceSnap, w, Date.now());
            if (sourceHealth.length === 0) return w;
            return { ...w, sourceHealth };
          } catch {
            return w;
          }
        }),
      );
      return c.json({ watchers: withHealth });
    } catch (err) {
      log.error("Failed to fetch watchers: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch watchers" }, 500);
    }
  });

  app.put("/api/watchers/:id", async (c) => {
    try {
      const id = c.req.param("id");
      if (!isValidUuid(id)) return c.json({ error: "Invalid watcher ID" }, 400);
      const body = await c.req.json<{
        name?: string;
        intervalMs?: number;
        enabled?: boolean;
        config?: Record<string, unknown>;
      }>();
      if (body.intervalMs !== undefined && (typeof body.intervalMs !== "number" || body.intervalMs <= 0)) {
        return c.json({ error: "intervalMs must be a positive number" }, 400);
      }
      const watcher = await updateWatcher(id, body);
      if (!watcher) return c.json({ error: "Watcher not found" }, 404);
      return c.json({ watcher });
    } catch (err) {
      log.error("Failed to update watcher: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to update watcher" }, 500);
    }
  });

  app.put("/api/tasks/:id", async (c) => {
    try {
      const id = c.req.param("id");
      if (!isValidUuid(id)) return c.json({ error: "Invalid task ID" }, 400);
      const body = await c.req.json<{
        title?: string;
        scheduleHour?: number;
        scheduleMinute?: number;
        scheduleDays?: number[] | null;
        scheduleIntervalMs?: number | null;
        enabled?: boolean;
        prompt?: string | null;
      }>();
      if (body.scheduleHour !== undefined && (!Number.isFinite(body.scheduleHour) || body.scheduleHour < 0 || body.scheduleHour > 23)) {
        return c.json({ error: "scheduleHour must be 0-23" }, 400);
      }
      if (body.scheduleMinute !== undefined && (!Number.isFinite(body.scheduleMinute) || body.scheduleMinute < 0 || body.scheduleMinute > 59)) {
        return c.json({ error: "scheduleMinute must be 0-59" }, 400);
      }
      if (body.scheduleIntervalMs !== undefined && body.scheduleIntervalMs !== null && (typeof body.scheduleIntervalMs !== "number" || body.scheduleIntervalMs <= 0)) {
        return c.json({ error: "scheduleIntervalMs must be a positive number" }, 400);
      }
      const task = await updateScheduledTask(id, body);
      if (!task) return c.json({ error: "Task not found" }, 404);
      return c.json({ task });
    } catch (err) {
      log.error("Failed to update task: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to update task" }, 500);
    }
  });

  app.post("/api/watchers/:id/trigger", async (c) => {
    try {
      const id = c.req.param("id");
      if (!isValidUuid(id)) return c.json({ error: "Invalid watcher ID" }, 400);
      const watcher = await getWatcherById(id);
      if (!watcher) return c.json({ error: "Watcher not found" }, 404);
      // Wiki-readonly instance: refuse the WIKI-DRAFTING watchers only. Both mint
      // wiki proposals (and the gardener run also persists the offered snapshot
      // the write owner's drain reads back), so force-running one here is the
      // same spend-and-corrupt the guarded drafting routes refuse. Everything
      // else — email, x, anthropic, the linter (report-only) and the committer
      // (git, which the flag deliberately leaves open) — stays triggerable.
      if (shouldSkipWikiDraftingRun(watcher.type, isWikiReadonly())) {
        log.info("Watcher trigger refused for {id} ({type}) — instance is wiki-readonly", {
          id,
          type: watcher.type,
        });
        return c.json({ error: WIKI_READONLY_REASON, readonly: true }, 403);
      }
      // …and the per-wiki mechanism. Both drafting checkers already skip a
      // read-only root on the SCHEDULED path, so without this the click would
      // "succeed", queue a forced run, and the run would quietly do nothing —
      // an honest 403 says why at the moment of the click instead.
      const decision = watcherWikiDecision(watcher);
      if (decision.kind === "readonly-root") {
        log.info("Watcher trigger refused for {id} ({type}) — wiki root is registered read-only", {
          id,
          type: watcher.type,
        });
        return c.json({ error: wikiReadonlyRootReason(decision.root), readonly: true }, 403);
      }
      if (decision.kind === "unhandled") {
        // A drafting type the per-wiki resolver has no branch for. Refusing is
        // the only safe answer — allowing it force-runs a drafting watcher whose
        // target root nothing checked — and the warn is what turns a silent gap
        // into a one-line fix when a third drafting type is added.
        log.warn(
          "Watcher trigger refused for {id}: {type} is a wiki-drafting type with no read-only resolver",
          { id, type: watcher.type },
        );
        return c.json(
          {
            error: `"${watcher.type}" drafts into a wiki but muninn cannot tell which one — refusing the manual trigger`,
            readonly: true,
          },
          403,
        );
      }
      await forceRunWatcher(id);
      return c.json({ ok: true, queued: true });
    } catch (err) {
      log.error("Failed to trigger watcher: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to trigger watcher" }, 500);
    }
  });

  app.post("/api/tasks/:id/trigger", async (c) => {
    try {
      const id = c.req.param("id");
      if (!isValidUuid(id)) return c.json({ error: "Invalid task ID" }, 400);
      const task = await getScheduledTaskById(id);
      if (!task) return c.json({ error: "Task not found" }, 404);
      const ctx = getSchedulerContext(task.botName);
      if (!ctx) return c.json({ error: "No scheduler context for bot " + task.botName }, 500);
      await runScheduledTasksFromList(ctx.api, ctx.config, ctx.botConfig, [task]);
      return c.json({ ok: true });
    } catch (err) {
      log.error("Failed to trigger task: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to trigger task" }, 500);
    }
  });

  app.get("/api/activity", (c) => {
    return c.json({
      events: activityLog.getRecent(50),
      stats: activityLog.stats,
    });
  });

  app.get("/api/activity/job/:id", async (c) => {
    try {
      const id = c.req.param("id");
      if (!isValidUuid(id)) return c.json({ error: "Invalid job ID" }, 400);
      const name = c.req.query("name") || id;
      const limit = parseIntParam(c.req.query("limit"), 30, 100);
      const events = await getActivityForJob(id, name, limit);
      return c.json({ events });
    } catch (err) {
      log.error("Failed to fetch job activity: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch job activity" }, 500);
    }
  });

  // --- Connector CRUD ---

  app.get("/api/connectors", async (c) => {
    try {
      const connectors = await listConnectors();
      return c.json({ connectors });
    } catch (err) {
      log.error("Failed to fetch connectors: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch connectors" }, 500);
    }
  });

  app.post("/api/connectors", async (c) => {
    try {
      const body = await c.req.json<{
        name: string;
        description?: string;
        connectorType: string;
        model?: string;
        baseUrl?: string;
        thinkingMaxTokens?: number;
        timeoutMs?: number;
      }>();
      if (!body.name || !body.connectorType) {
        return c.json({ error: "name and connectorType are required" }, 400);
      }
      const validTypes: ConnectorType[] = ["claude-cli", "copilot-sdk", "openai-compat", "claude-sdk"];
      if (!validTypes.includes(body.connectorType as ConnectorType)) {
        return c.json({ error: `Invalid connectorType. Must be one of: ${validTypes.join(", ")}` }, 400);
      }
      const connector = await createConnector({
        name: body.name,
        description: body.description,
        connectorType: body.connectorType as ConnectorType,
        model: body.model,
        baseUrl: body.baseUrl,
        thinkingMaxTokens: body.thinkingMaxTokens,
        timeoutMs: body.timeoutMs,
      });
      return c.json({ connector }, 201);
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
        return c.json({ error: "A connector with this type, model, and base URL already exists" }, 409);
      }
      log.error("Failed to create connector: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to create connector" }, 500);
    }
  });

  app.put("/api/connectors/:id", async (c) => {
    try {
      const id = c.req.param("id");
      if (!isValidUuid(id)) return c.json({ error: "Invalid connector ID" }, 400);
      const body = await c.req.json<{
        name?: string;
        description?: string | null;
        connectorType?: string;
        model?: string | null;
        baseUrl?: string | null;
        thinkingMaxTokens?: number | null;
        timeoutMs?: number | null;
      }>();
      if (body.connectorType) {
        const validTypes: ConnectorType[] = ["claude-cli", "copilot-sdk", "openai-compat", "claude-sdk"];
        if (!validTypes.includes(body.connectorType as ConnectorType)) {
          return c.json({ error: `Invalid connectorType. Must be one of: ${validTypes.join(", ")}` }, 400);
        }
      }
      const connector = await updateConnector(id, {
        name: body.name,
        description: body.description,
        connectorType: body.connectorType as ConnectorType | undefined,
        model: body.model,
        baseUrl: body.baseUrl,
        thinkingMaxTokens: body.thinkingMaxTokens,
        timeoutMs: body.timeoutMs,
      });
      if (!connector) {
        return c.json({ error: "Connector not found" }, 404);
      }
      return c.json({ connector });
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
        return c.json({ error: "A connector with this type, model, and base URL already exists" }, 409);
      }
      log.error("Failed to update connector: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to update connector" }, 500);
    }
  });

  app.delete("/api/connectors/:id", async (c) => {
    try {
      const id = c.req.param("id");
      if (!isValidUuid(id)) return c.json({ error: "Invalid connector ID" }, 400);
      const deleted = await deleteConnector(id);
      if (!deleted) {
        return c.json({ error: "Connector not found" }, 404);
      }
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("referenced by")) {
        return c.json({ error: msg }, 409);
      }
      log.error("Failed to delete connector: {error}", { error: msg });
      return c.json({ error: "Failed to delete connector" }, 500);
    }
  });
}
