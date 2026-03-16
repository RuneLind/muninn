import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { renderSearchPage } from "../views/search-page.ts";
import { renderSearchDocumentPage } from "../views/search-document-page.ts";
import { knowledgeApiHandler } from "./knowledge-api-client.ts";

export function registerSearchRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  app.get("/search", (c) => {
    return c.html(renderSearchPage());
  });

  app.get("/search/document/:collection/*", (c) => {
    const collection = c.req.param("collection");
    const docId = c.req.path.split(`/search/document/${collection}/`)[1] || "";
    return c.html(renderSearchDocumentPage(collection, decodeURIComponent(docId)));
  });

  app.get("/api/search/health", (c) => {
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, "/health", 3000);
  });

  app.get("/api/search/collections", (c) => {
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, "/api/collections");
  });

  app.get("/api/search/search", async (c) => {
    const query = c.req.query("q");
    if (!query || query.trim().length === 0) {
      return c.json({ results: [] });
    }
    const params = new URLSearchParams({ q: query });
    const limit = c.req.query("limit");
    if (limit) params.set("limit", limit);
    const collections = c.req.queries("collection");
    if (collections) {
      for (const col of collections) params.append("collection", col);
    }

    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/search?${params}`, 10000);
  });

  app.get("/api/search/collection/:name/documents", (c) => {
    const name = c.req.param("name");
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/collection/${encodeURIComponent(name)}/documents`, 10000);
  });

  app.get("/api/search/document/:collection/*", (c) => {
    const collection = c.req.param("collection");
    const docId = c.req.path.split(`/api/search/document/${collection}/`)[1] || "";
    // docId is already URL-encoded from the client request path — pass through as-is
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/document/${encodeURIComponent(collection)}/${docId}`);
  });
}
