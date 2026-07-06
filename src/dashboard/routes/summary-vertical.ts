import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../../config.ts";
import { knowledgeApiHandler } from "../../ai/knowledge-api-client.ts";
import { isTerminalStatus, type Job, type JobEvent } from "../../summaries/job-store.ts";

/**
 * The in-memory job-store accessors a capture vertical exposes from its
 * `state.ts` — the read + subscribe surface the shared SSE/jobs routes need.
 */
export interface SummaryVerticalStore<S extends string, F> {
  getJob(jobId: string): Job<S, F> | undefined;
  getRecentJobs(limit?: number): Job<S, F>[];
  subscribe(jobId: string, fn: (event: JobEvent<S>) => void): () => void;
}

export interface SummaryVerticalConfig<S extends string, F> {
  /** Client API prefix, e.g. "/api/youtube". */
  apiBase: string;
  /** Huginn collection name for document/similar proxying, e.g. "youtube-summaries". */
  collection: string;
  /** In-memory job store accessors (from the vertical's `state.ts`). */
  store: SummaryVerticalStore<S, F>;
  /**
   * Bare-path → `/summaries?source=…` redirect for old bookmarks / the Chrome
   * extension fallback. `{ path: "/youtube", source: "youtube" }`. Omit for
   * verticals with no standalone bare path (anthropic).
   */
  redirect?: { path: string; source: string };
  /**
   * Register a CORS preflight `OPTIONS <apiBase>/summarize` (Chrome-extension
   * verticals with a public `POST /summarize`). Omit for verticals whose
   * summarize entry isn't extension-facing (anthropic's `/candidates/:id/summarize`).
   */
  corsPreflight?: boolean;
  /**
   * TikTok only: the terminal `complete` *replay* event carries
   * `{ summary: job.summary }` so a live browser can drop replayed frame-reading
   * chatter. The other verticals replay a bare `{}` (matching their runtime
   * `{ type: "complete" }`).
   */
  completeCarriesSummary?: boolean;
}

/**
 * Register the route plumbing shared verbatim by the four capture verticals
 * (youtube, x-article, tiktok, anthropic): the SSE stream, the recent-jobs list,
 * the knowledge-API `document/*` + `similar` proxies, the CORS preflight, and the
 * bare-path redirect. Each vertical's routes module still owns its own
 * `POST <apiBase>/summarize` (different request shapes/validation/dedup) plus any
 * bespoke routes (anthropic's candidate inbox).
 */
export function registerSummaryVertical<S extends string, F>(
  app: Hono,
  config: Config,
  opts: SummaryVerticalConfig<S, F>,
): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;
  const { apiBase, collection, store } = opts;

  // Bare-path redirect into the merged /summaries view, carrying the source tag.
  if (opts.redirect) {
    const { path, source } = opts.redirect;
    app.get(path, (c) => {
      const qs = new URL(c.req.url).searchParams;
      qs.set("source", source);
      // 302 (not 301): the target is computed from transient query params, so we
      // don't want browsers permanently caching the bare-path redirect.
      return c.redirect(`/summaries?${qs.toString()}`, 302);
    });
  }

  // CORS preflight for Chrome extension
  if (opts.corsPreflight) {
    app.options(`${apiBase}/summarize`, () => {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    });
  }

  app.get(`${apiBase}/stream/:jobId`, (c) => {
    const jobId = c.req.param("jobId");
    const job = store.getJob(jobId);

    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      // Replay current state
      await stream.writeSSE({ event: "status", data: JSON.stringify({ status: job.status }) });
      if (job.text) {
        await stream.writeSSE({ event: "text_delta", data: JSON.stringify({ text: job.text }) });
      }
      if (job.category) {
        await stream.writeSSE({ event: "category", data: JSON.stringify({ category: job.category }) });
      }
      if (job.similar) {
        await stream.writeSSE({ event: "similar", data: JSON.stringify({ articles: job.similar }) });
      }

      // If already terminal, send final event and close. For TikTok the complete
      // event carries the parsed summary so the client can drop any replayed chatter.
      if (job.status === "complete") {
        const data = opts.completeCarriesSummary ? JSON.stringify({ summary: job.summary }) : "{}";
        await stream.writeSSE({ event: "complete", data });
        return;
      }
      if (job.status === "error") {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: job.error }) });
        return;
      }

      // Subscribe to live updates
      let alive = true;
      const unsubscribe = store.subscribe(jobId, async (event) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          if (isTerminalStatus(event.type)) {
            alive = false;
          }
        } catch {
          alive = false;
        }
      });

      // Heartbeat every 30s
      const heartbeat = setInterval(async () => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "heartbeat", data: "{}" });
        } catch {
          alive = false;
        }
      }, 30_000);

      stream.onAbort(() => {
        alive = false;
        unsubscribe();
        clearInterval(heartbeat);
      });

      while (alive) {
        await Bun.sleep(1000);
      }
      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  app.get(`${apiBase}/jobs`, (c) => {
    const limit = parseInt(c.req.query("limit") || "20", 10);
    const jobs = store.getRecentJobs(Math.min(Math.max(limit, 1), 100));
    return c.json({ jobs });
  });

  // --- Browse (proxy to knowledge API) ---
  // The merged /summaries view reads /api/summaries/documents for the listing;
  // the /document/* + /similar endpoints stay — the unified client still calls
  // them per-source via SOURCES[].apiBase.

  app.get(`${apiBase}/document/*`, async (c) => {
    // Read the still-encoded path from the raw URL. c.req.path decodes lossily
    // (decodeURI-style: %20→space but reserved chars like %2C, %24 stay
    // encoded), so re-encoding it double-encodes the reserved ones and the
    // upstream 404s (surfaced here as 502). The client already
    // encodeURIComponent'd each segment, so forward that encoding verbatim.
    const encodedDocId = new URL(c.req.url).pathname.replace(`${apiBase}/document/`, "");
    if (!encodedDocId) return c.json({ error: "Missing document ID" }, 400);
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/document/${collection}/${encodedDocId}`);
  });

  app.get(`${apiBase}/similar`, async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "Missing query parameter" }, 400);
    const params = new URLSearchParams({ q, collection, limit: "7" });
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/search?${params}`, 10000);
  });
}
