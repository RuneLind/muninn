import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import {
  fetchKnowledgeApi,
  knowledgeApiHandler,
} from "./knowledge-api-client.ts";
import { renderGraphPage } from "../views/graph-page.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "graph-routes");

/** Collections that support wikilink edge extraction. */
const WIKILINK_COLLECTIONS = ["wiki", "nav-wiki", "capra-wiki"];

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface WikilinkEdge {
  source: string;
  target: string;
  similarity: number;
  type: "wikilink";
}

const wikilinkCache = new Map<
  string,
  { edges: WikilinkEdge[]; ts: number }
>();

/**
 * Fetch all wiki documents from Huginn and extract [[wikilink]] references
 * as directed edges. Results are cached for 5 minutes since wiki content
 * rarely changes and slider adjustments only affect similarity edges.
 */
async function extractWikilinkEdges(
  baseUrl: string,
  collection: string,
  nodes: Array<{ id: string; title: string }>,
): Promise<WikilinkEdge[]> {
  const cached = wikilinkCache.get(collection);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.edges;
  }

  const titleToId = new Map<string, string>();
  for (const node of nodes) {
    titleToId.set(node.title.toLowerCase(), node.id);
    const stem = node.id.replace(/^.*\//, "").replace(/\.md$/i, "");
    if (stem) titleToId.set(stem.toLowerCase(), node.id);
  }

  const docList = await fetchKnowledgeApi(
    baseUrl,
    `/api/collection/${encodeURIComponent(collection)}/documents`,
    { timeoutMs: 10000 },
  );
  const docIds: string[] = (docList.documents || []).map(
    (d: { id: string }) => d.id,
  );

  const results = await Promise.allSettled(
    docIds.map((docId) =>
      fetchKnowledgeApi(
        baseUrl,
        `/api/document/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`,
        { timeoutMs: 10000 },
      ),
    ),
  );

  const edges: WikilinkEdge[] = [];
  const seen = new Set<string>();

  for (let j = 0; j < results.length; j++) {
    const result = results[j]!;
    if (result.status !== "fulfilled") continue;

    const doc = (result as PromiseFulfilledResult<any>).value;
    const sourceId = docIds[j]!;
    const content: string = doc.content || doc.text || "";

    for (const match of content.matchAll(WIKILINK_RE)) {
      const linkTitle = match[1]!.trim().toLowerCase();
      const targetId = titleToId.get(linkTitle);
      if (!targetId || targetId === sourceId) continue;

      const key = `${sourceId}->${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({ source: sourceId, target: targetId, similarity: 1.0, type: "wikilink" });
    }
  }

  wikilinkCache.set(collection, { edges, ts: Date.now() });
  log.info("Extracted {count} wikilink edges from {docs} documents", {
    count: edges.length,
    docs: docIds.length,
  });
  return edges;
}

export function registerGraphRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  app.get("/graph", async (c) => {
    return c.html(await renderGraphPage());
  });

  // Proxy to Huginn collections list
  app.get("/api/graph/collections", async (c) => {
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, "/api/collections");
  });

  // Proxy to Huginn similarity-graph endpoint, enriched with wikilink edges for wiki collections
  app.get("/api/graph/similarity", async (c) => {
    const collection = c.req.query("collection") || "youtube-summaries";
    const topK = c.req.query("top_k") || "5";
    const minSim = c.req.query("min_similarity") || "0.65";
    const params = new URLSearchParams({
      top_k: topK,
      min_similarity: minSim,
    });

    // For non-wiki collections, simple proxy
    if (!WIKILINK_COLLECTIONS.includes(collection)) {
      return knowledgeApiHandler(
        c,
        KNOWLEDGE_API_URL,
        `/api/collection/${encodeURIComponent(collection)}/similarity-graph?${params}`,
        15000,
      );
    }

    // For wiki collections: fetch graph + extract wikilink edges
    try {
      const graphData = await fetchKnowledgeApi(
        KNOWLEDGE_API_URL,
        `/api/collection/${encodeURIComponent(collection)}/similarity-graph?${params}`,
        { timeoutMs: 15000 },
      );

      for (const edge of graphData.edges) {
        edge.type = "similarity";
      }

      try {
        const wikilinkEdges = await extractWikilinkEdges(
          KNOWLEDGE_API_URL,
          collection,
          graphData.nodes,
        );
        graphData.edges.push(...wikilinkEdges);
      } catch (err) {
        log.warn("Failed to extract wikilink edges: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue with similarity-only graph
      }

      return c.json(graphData);
    } catch (err) {
      log.warn("Knowledge API error: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  // Proxy to Huginn author-graph endpoint
  app.get("/api/graph/author", async (c) => {
    const collection = c.req.query("collection") || "x-feed";
    const minScore = c.req.query("min_score") || "0.0";
    const minInteractions = c.req.query("min_interactions") || "1";
    const params = new URLSearchParams({
      min_score: minScore,
      min_interactions: minInteractions,
    });
    return knowledgeApiHandler(
      c,
      KNOWLEDGE_API_URL,
      `/api/collection/${encodeURIComponent(collection)}/author-graph?${params}`,
      30000,
    );
  });
}
