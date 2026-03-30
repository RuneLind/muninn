import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { knowledgeApiHandler } from "./knowledge-api-client.ts";
import { renderGraphPage } from "../views/graph-page.ts";

export function registerGraphRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  app.get("/graph", (c) => {
    return c.html(renderGraphPage());
  });

  // Proxy to Huginn collections list
  app.get("/api/graph/collections", async (c) => {
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, "/api/collections");
  });

  // Proxy to Huginn similarity-graph endpoint
  app.get("/api/graph/similarity", async (c) => {
    const collection = c.req.query("collection") || "youtube-summaries";
    const topK = c.req.query("top_k") || "5";
    const minSim = c.req.query("min_similarity") || "0.65";
    const params = new URLSearchParams({
      top_k: topK,
      min_similarity: minSim,
    });
    return knowledgeApiHandler(
      c,
      KNOWLEDGE_API_URL,
      `/api/collection/${encodeURIComponent(collection)}/similarity-graph?${params}`,
      15000,
    );
  });
}
