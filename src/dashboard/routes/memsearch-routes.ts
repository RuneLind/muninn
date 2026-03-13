import type { Hono } from "hono";
import { getLog } from "../../logging.ts";
import { dashboardSearchMemories, getSearchStats } from "../../db/memories.ts";
import { generateEmbedding } from "../../ai/embeddings.ts";
import { parseIntParam } from "./route-utils.ts";

const log = getLog("dashboard");

export function registerMemsearchRoutes(app: Hono): void {
  // Redirect standalone page to dashboard tab
  app.get("/memsearch", (c) => {
    return c.redirect("/#memsearch", 302);
  });

  app.get("/api/memsearch", async (c) => {
    try {
      const query = c.req.query("q");
      if (!query || query.trim().length === 0) {
        return c.json({ results: [] });
      }

      const mode = (c.req.query("mode") || "hybrid") as "hybrid" | "semantic" | "text";
      const limit = parseIntParam(c.req.query("limit"), 25, 100);
      const botName = c.req.query("bot") || undefined;
      const scope = (c.req.query("scope") || undefined) as "personal" | "shared" | undefined;

      // Generate embedding for semantic/hybrid modes
      let embedding: number[] | null = null;
      if (mode !== "text") {
        embedding = await generateEmbedding(query);
      }

      const results = await dashboardSearchMemories({
        query,
        embedding,
        mode,
        limit,
        botName,
        scope,
      });

      return c.json({ results });
    } catch (err) {
      log.error("Search failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Search failed" }, 500);
    }
  });

  app.get("/api/memsearch-stats", async (c) => {
    try {
      const botName = c.req.query("bot") || undefined;
      const stats = await getSearchStats(botName);
      return c.json(stats);
    } catch (err) {
      log.error("Failed to fetch search stats: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to fetch search stats" }, 500);
    }
  });
}
