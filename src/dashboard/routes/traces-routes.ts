import type { Hono } from "hono";
import { getLog } from "../../logging.ts";
import { renderTracesPage } from "../views/traces-page.ts";
import { getRecentTraces, getTrace, getTraceStats, getTraceFilterOptions } from "../../db/traces.ts";
import { getPromptSnapshot } from "../../db/prompt-snapshots.ts";
import { parseIntParam } from "./route-utils.ts";
import { requireOwnedResource } from "../../auth/resource-guard.ts";

const log = getLog("dashboard");

export function registerTracesRoutes(app: Hono): void {
  app.get("/traces", async (c) => {
    return c.html(await renderTracesPage());
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
      // §4: the owner is the trace's own `user_id`, and this route carries no
      // `:userId`, so PR C's claimed-id guard could not reach it. It is also NOT
      // an admin-zone route — the chat page's waterfall fetches it for the
      // viewer's own turns — so a filter, not a zone entry, is the answer.
      //
      // ⚠️ A NULL owner (a watcher or gardener trace) is admin-only by §4 and
      // relaxed in `local` mode, where there is one human. The consequence an
      // operator will meet: a `local` identity is role `user`, so a trace owned
      // by ANOTHER `users.id` — a Telegram bot's user row, say — answers with an
      // empty span list on this instance's own /traces page.
      const owned = await requireOwnedResource(c, "trace", traceId);
      // `{ spans: [] }` is what this route already answers for a traceId it does
      // not know, so the denial and the miss are one answer.
      if (!owned.ok) return c.json({ spans: [] });
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
      // Guarded on the SAME kind and the same id as `/api/traces/:traceId`
      // above. §4 assigns this route to the deferred admin zone rather than to
      // PR D's resource list, and the review round is what changed the reading:
      // guarding the spans while leaving the PROMPT open closes the smaller
      // disclosure and leaves the larger one — the fully assembled prompt, with
      // that user's conversation history and extracted memories verbatim —
      // reachable with the identical id. Its only in-repo consumer is the
      // operator's own /traces modal, so the guard costs the chat page nothing.
      const owned = await requireOwnedResource(c, "trace", traceId);
      // The route's own miss, so a denial cannot be told from an absent snapshot.
      if (!owned.ok) return c.json({ error: "Prompt snapshot not found" }, 404);
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
