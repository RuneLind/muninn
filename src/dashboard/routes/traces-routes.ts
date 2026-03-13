import type { Hono } from "hono";
import { getLog } from "../../logging.ts";
import { renderTracesPage } from "../views/traces-page.ts";
import { getRecentTraces, getTrace, getTraceStats, getTraceFilterOptions } from "../../db/traces.ts";
import { getPromptSnapshot } from "../../db/prompt-snapshots.ts";
import { parseIntParam } from "./route-utils.ts";

const log = getLog("dashboard");

export function registerTracesRoutes(app: Hono): void {
  app.get("/traces", (c) => {
    return c.html(renderTracesPage());
  });

  app.get("/api/traces", async (c) => {
    try {
      const limit = parseIntParam(c.req.query("limit"), 50, 200);
      const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
      const botName = c.req.query("bot") || undefined;
      const name = c.req.query("name") || undefined;
      const traces = await getRecentTraces(limit, offset, botName, name);
      return c.json({ traces });
    } catch (err) {
      log.error("Failed to fetch traces: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch traces" }, 500);
    }
  });

  app.get("/api/traces/:traceId", async (c) => {
    try {
      const traceId = c.req.param("traceId");
      const spans = await getTrace(traceId);
      return c.json({ spans });
    } catch (err) {
      log.error("Failed to fetch trace: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch trace" }, 500);
    }
  });

  app.get("/api/prompts/:traceId", async (c) => {
    try {
      const traceId = c.req.param("traceId");
      const snapshot = await getPromptSnapshot(traceId);
      if (!snapshot) {
        return c.json({ error: "Prompt snapshot not found" }, 404);
      }
      return c.json(snapshot);
    } catch (err) {
      log.error("Failed to fetch prompt snapshot: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch prompt snapshot" }, 500);
    }
  });

  app.get("/api/trace-stats", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const stats = await getTraceStats(botName);
      return c.json(stats);
    } catch (err) {
      log.error("Failed to fetch trace stats: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch trace stats" }, 500);
    }
  });

  app.get("/api/trace-filters", async (c) => {
    try {
      const options = await getTraceFilterOptions();
      return c.json(options);
    } catch (err) {
      log.error("Failed to fetch trace filter options: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch filter options" }, 500);
    }
  });
}
