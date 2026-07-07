import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import {
  listCandidates,
  getCandidateById,
  setCandidateStatus,
  expireStaleCandidates,
  candidateOutcomeStats,
} from "../../db/summary-candidates.ts";
import {
  getJob,
  getRecentJobs,
  subscribe,
} from "../../anthropic/state.ts";
import { kickCandidateSummarize } from "../../anthropic/summarizer.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { getSummarySource } from "../../summaries/sources.ts";
import { registerSummaryVertical } from "./summary-vertical.ts";
import { isValidUuid } from "./route-utils.ts";

const log = getLog("dashboard");

// Single source of truth for the collection name lives in the registry.
const ANTHROPIC_SOURCE = getSummarySource("anthropic")!;
const ANTHROPIC_COLLECTION = ANTHROPIC_SOURCE.collection;

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
  // Shared summarizer-vertical plumbing (mirrors youtube-routes): SSE stream,
  // jobs, document/similar proxies against `anthropic-summaries`. No bare-path
  // redirect and no CORS preflight — anthropic has no standalone page and its
  // summarize entry is the candidate-scoped POST below, not a public /summarize.
  registerSummaryVertical(app, config, {
    apiBase: ANTHROPIC_SOURCE.apiBase,
    collection: ANTHROPIC_COLLECTION,
    store: { getJob, getRecentJobs, subscribe },
  });

  // The ranked, pre-annotated candidate inbox. Returns the actionable + in-flight +
  // on-the-shelf set so the client can render each row by status: `new` (active
  // Summarize), `summarizing` (in progress, e.g. an auto-promoted ≥0.9 item mid-run),
  // `summarized` (read-only "On the shelf", links to its doc — the client collapses
  // these into an expandable "Done recently" group), and `error` (retryable).
  // `dismissed` rows stay hidden. On each load two housekeeping steps keep the set
  // bounded: non-terminal rows (`new`/`error`/`summarizing`) with no activity for 14
  // days are auto-dismissed, and `summarized` rows are cut to the last 7 days (so old
  // high-scoring shelf rows can't crowd out fresh low-scoring `new` ones under the
  // 200-row score-DESC cap).
  app.get("/api/anthropic/candidates", async (c) => {
    try {
      // Cheap indexed cleanup on load — never fatal to the listing.
      try {
        await expireStaleCandidates(14);
      } catch (err) {
        log.warn("expireStaleCandidates failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Both verticals share this inbox — anthropic releases + captured long-form X
      // posts. (dashboard_url stays source=anthropic for all: that param keys the shelf
      // registry, and both land on the anthropic-summaries shelf — see sources.ts.)
      const candidates = await listCandidates({
        source: ["anthropic", "x"],
        status: ["new", "summarizing", "summarized", "error"],
        summarizedWithinDays: 7,
      });
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
      // Already in flight — a double-click (or the auto-promote path racing the
      // button) must not spawn a second Claude job for the same candidate. The
      // candidate stays `summarizing` for the whole pipeline, so this one check
      // covers the entire in-progress window.
      if (candidate.status === "summarizing") {
        return c.json({ error: "Already summarizing", status: "summarizing" }, 409);
      }

      const summarizerBot = resolveSummarizerBot(discoverAllBots());
      if (!summarizerBot) {
        return c.json({ error: "No bots configured" }, 500);
      }

      // createJob → mark the candidate `summarizing` (leaves the `new` queue so a
      // concurrent inbox refresh stops offering it) → fire the background summarize.
      // Shared with the watcher's auto-promote path (kickCandidateSummarize).
      const jobId = await kickCandidateSummarize(candidate, config, summarizerBot);
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
      // 'manual' distinguishes this human "not worth a summary" judgement from an
      // auto-expired stale row ('expired'), so the calibration acceptance metric
      // counts only real rejections against summarized rows.
      await setCandidateStatus(id, "dismissed", null, "manual");
      return c.json({ ok: true });
    } catch (err) {
      log.error("Dismissing anthropic candidate {id} failed: {error}", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to dismiss candidate" }, 500);
    }
  });

  // Gate-outcome calibration (display-only). Aggregates the labeled candidate dataset
  // — acceptance rates per (source, kind) + per 0.1 score band, plus a suggested
  // per-kind capture floor — for the /summaries "Calibration" tab. Read-only: it
  // NEVER writes watcher config; the operator hand-copies the suggested floors.
  app.get("/api/anthropic/candidates/stats", async (c) => {
    try {
      const stats = await candidateOutcomeStats();
      return c.json(stats);
    } catch (err) {
      log.error("Loading candidate outcome stats failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to load calibration stats" }, 500);
    }
  });

}
