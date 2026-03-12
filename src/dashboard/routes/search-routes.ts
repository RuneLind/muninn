import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { renderSearchPage } from "../views/search-page.ts";
import { renderSearchDocumentPage } from "../views/search-document-page.ts";

const log = getLog("dashboard");

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

  app.get("/api/search/health", async (c) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      const data = await res.json();
      return c.json(data);
    } catch (err) {
      log.warn("Knowledge API unreachable: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  app.get("/api/search/collections", async (c) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/collections`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      const data = await res.json();
      return c.json(data);
    } catch (err) {
      log.warn("Knowledge API unreachable: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  app.get("/api/search/search", async (c) => {
    try {
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

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/search?${params}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      const data = await res.json();
      return c.json(data);
    } catch (err) {
      log.warn("Knowledge search failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  app.get("/api/search/collection/:name/documents", async (c) => {
    try {
      const name = c.req.param("name");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/collection/${encodeURIComponent(name)}/documents`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      const data = await res.json();
      return c.json(data);
    } catch (err) {
      log.warn("Knowledge collection documents fetch failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  app.get("/api/search/document/:collection/*", async (c) => {
    try {
      const collection = c.req.param("collection");
      const docId = c.req.path.split(`/api/search/document/${collection}/`)[1] || "";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      // docId is already URL-encoded from the client request path — pass through as-is
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/document/${encodeURIComponent(collection)}/${docId}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      const data = await res.json();
      return c.json(data);
    } catch (err) {
      log.warn("Knowledge document fetch failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });
}
