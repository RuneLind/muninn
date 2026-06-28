import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import {
  listCandidates,
  getCandidateById,
  setCandidateStatus,
} from "../../db/summary-candidates.ts";
import {
  createJob,
  getJob,
  getRecentJobs,
  subscribe as subscribeAnthropicJob,
} from "../../anthropic/state.ts";
import { summarizeCandidate } from "../../anthropic/summarizer.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { knowledgeApiHandler } from "../../ai/knowledge-api-client.ts";
import { getSummarySource } from "../../summaries/sources.ts";
import { isValidUuid } from "./route-utils.ts";

const log = getLog("dashboard");

// Single source of truth for the collection name lives in the registry.
const ANTHROPIC_COLLECTION = getSummarySource("anthropic")!.collection;

/**
 * Anthropic vertical — the Curate layer of the Claude Learning Center.
 *
 * Two halves share this module:
 *  - the candidate inbox (Phase D-list): the read-only list + Dismiss action.
 *  - the summarizer vertical (Phase C): `POST /candidates/:id/summarize` kicks a
 *    background job that pulls the candidate's content from Huginn
 *    `anthropic-knowledge`, summarizes it, and ingests into `anthropic-summaries`;
 *    the `/summarize|stream|jobs|document|similar` endpoints mirror
 *    youtube-routes.ts (collection swapped to `anthropic-summaries`) so the
 *    unified /summaries page renders the source automatically.
 */
export function registerAnthropicRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  // The ranked, pre-annotated candidate inbox. Defaults to the unworked queue
  // (status `new`); the watcher captures these on its 2h Highlights cadence.
  app.get("/api/anthropic/candidates", async (c) => {
    try {
      const candidates = await listCandidates({ source: "anthropic", status: "new" });
      return c.json({ candidates });
    } catch (err) {
      log.error("Listing anthropic candidates failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to load candidates" }, 500);
    }
  });

  // Summarize a candidate: resolve content from anthropic-knowledge → summarize →
  // ingest into anthropic-summaries. Sets the candidate `summarizing` and fires
  // the background job; the summarizer flips it to `summarized` (+ doc_id) / `error`.
  app.post("/api/anthropic/candidates/:id/summarize", async (c) => {
    const id = c.req.param("id");
    if (!isValidUuid(id)) {
      return c.json({ error: "Invalid candidate id" }, 400);
    }
    try {
      const candidate = await getCandidateById(id);
      if (!candidate) {
        return c.json({ error: "Candidate not found" }, 404);
      }
      // Already on the shelf — don't re-summarize; point at the existing doc.
      if (candidate.status === "summarized") {
        return c.json({
          duplicate: true,
          doc_id: candidate.docId,
          dashboard_url: candidate.docId
            ? `/summaries?source=anthropic&doc=${encodeURIComponent(candidate.docId)}&duplicate=1`
            : `/summaries?source=anthropic`,
        });
      }

      const summarizerBot = resolveSummarizerBot(discoverAllBots());
      if (!summarizerBot) {
        return c.json({ error: "No bots configured" }, 500);
      }

      const jobId = createJob(candidate.id, candidate.title, candidate.url);
      // Leave the `new` queue immediately so a concurrent inbox refresh stops
      // showing it; the summarizer owns the terminal status from here.
      await setCandidateStatus(candidate.id, "summarizing");

      // Fire and forget — background summarization.
      summarizeCandidate(
        jobId,
        candidate.id,
        candidate.title,
        candidate.url,
        config,
        summarizerBot,
      ).catch((err) => {
        log.error("Anthropic summarization failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      return c.json({ job_id: jobId, dashboard_url: `/summaries?source=anthropic&job=${jobId}` });
    } catch (err) {
      log.error("Summarizing anthropic candidate {id} failed: {error}", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to start summarization" }, 500);
    }
  });

  // Drop a candidate from the inbox. Idempotent-ish: a missing row 404s, an
  // already-dismissed one stays dismissed (setCandidateStatus is an unconditional
  // UPDATE, so re-dismissing is a harmless no-op).
  app.post("/api/anthropic/candidates/:id/dismiss", async (c) => {
    const id = c.req.param("id");
    if (!isValidUuid(id)) {
      return c.json({ error: "Invalid candidate id" }, 400);
    }
    try {
      const candidate = await getCandidateById(id);
      if (!candidate) {
        return c.json({ error: "Candidate not found" }, 404);
      }
      await setCandidateStatus(id, "dismissed");
      return c.json({ ok: true });
    } catch (err) {
      log.error("Dismissing anthropic candidate {id} failed: {error}", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to dismiss candidate" }, 500);
    }
  });

  // --- Summarizer job streaming (mirrors youtube-routes.ts) ---

  app.get("/api/anthropic/stream/:jobId", (c) => {
    const jobId = c.req.param("jobId");
    const job = getJob(jobId);

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

      // If already terminal, send final event and close
      if (job.status === "complete") {
        await stream.writeSSE({ event: "complete", data: "{}" });
        return;
      }
      if (job.status === "error") {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: job.error }) });
        return;
      }

      // Subscribe to live updates
      let alive = true;
      const unsubscribe = subscribeAnthropicJob(jobId, async (event) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          if (event.type === "complete" || event.type === "error") {
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

  app.get("/api/anthropic/jobs", (c) => {
    const limit = parseInt(c.req.query("limit") || "20", 10);
    const jobs = getRecentJobs(Math.min(Math.max(limit, 1), 100));
    return c.json({ jobs });
  });

  // --- Anthropic summaries browse (proxy to knowledge API) ---
  // The merged /summaries view reads /api/summaries/documents for the listing;
  // the /document/* + /similar endpoints back the per-source doc panel that the
  // unified client calls via SOURCES[].apiBase.

  app.get("/api/anthropic/document/*", async (c) => {
    // Read the still-encoded path from the raw URL. c.req.path decodes lossily
    // (decodeURI-style: %20→space but reserved chars like %2C/%24 stay encoded),
    // so re-encoding it double-encodes the reserved ones and the upstream 404s
    // (surfaced here as 502). The client already encodeURIComponent'd each
    // segment, so forward that encoding verbatim.
    const encodedDocId = new URL(c.req.url).pathname.replace("/api/anthropic/document/", "");
    if (!encodedDocId) return c.json({ error: "Missing document ID" }, 400);
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/document/${ANTHROPIC_COLLECTION}/${encodedDocId}`);
  });

  app.get("/api/anthropic/similar", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "Missing query parameter" }, 400);
    const params = new URLSearchParams({ q, collection: ANTHROPIC_COLLECTION, limit: "7" });
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/search?${params}`, 10000);
  });
}
