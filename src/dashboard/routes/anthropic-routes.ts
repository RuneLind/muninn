import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import {
  listCandidates,
  getCandidateById,
  setCandidateStatus,
  expireStaleCandidates,
  candidateOutcomeStats,
  candidateRecentStats,
  RECENT_WINDOW_DEFAULT_DAYS,
  RECENT_WINDOW_MIN_DAYS,
  RECENT_WINDOW_MAX_DAYS,
  type CandidateOutcomeStats,
  type CandidateRecentStats,
} from "../../db/summary-candidates.ts";
import { pruneXLinkAmplifiers } from "../../db/x-link-amplifiers.ts";
import {
  getJob,
  getRecentJobs,
  subscribe,
} from "../../anthropic/state.ts";
import { kickCandidateSummarize } from "../../anthropic/summarizer.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { getSummarySource } from "../../summaries/sources.ts";
import { registerSummaryVertical } from "./summary-vertical.ts";
import { isValidUuid, clampIntQuery } from "./route-utils.ts";

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
/**
 * The two calibration aggregations, injectable so the route's own contract (the `?days=`
 * clamp, and the degrade rule below) is testable without a Postgres container.
 */
export interface AnthropicStatsDeps {
  outcomeStats?: () => Promise<CandidateOutcomeStats>;
  recentStats?: (windowDays: number) => Promise<CandidateRecentStats>;
}

export function registerAnthropicRoutes(
  app: Hono,
  config: Config,
  statsDeps: AnthropicStatsDeps = {},
): void {
  const outcomeStats = statsDeps.outcomeStats ?? candidateOutcomeStats;
  const recentStats = statsDeps.recentStats ?? candidateRecentStats;
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
      // Same shape, same call site: the step-2b amplifier votes age out at 30 days (a
      // wave that never reached its threshold in a month is not a wave). Cleanup
      // therefore depends on dashboard visits — accepted; the miss is unbounded growth
      // of a tiny table, never incorrectness.
      try {
        await pruneXLinkAmplifiers(30);
      } catch (err) {
        log.warn("pruneXLinkAmplifiers failed: {error}", {
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
  //
  // `?days=` (integer, clamped 1–90, default 7) adds a `recent` block: per-source
  // capture/triage/acceptance over that `created_at` window, with untriaged rows
  // counted SEPARATELY from rejections and the acceptance target stated in the payload.
  // Extended in place rather than split into a second endpoint so the Calibration tab
  // stays one fetch and the windowed block can never disagree with the all-time tables
  // about the target (both read `recent.target`). The all-time fields are unchanged, so
  // an old client that ignores `recent` is unaffected.
  app.get("/api/anthropic/candidates/stats", async (c) => {
    try {
      const days = clampIntQuery(c.req.query("days"), {
        min: RECENT_WINDOW_MIN_DAYS,
        max: RECENT_WINDOW_MAX_DAYS,
        fallback: RECENT_WINDOW_DEFAULT_DAYS,
      });
      // The windowed block is a FOURTH view that happens to ride the same fetch, not a
      // part of the other three. Under one `Promise.all` any failure in it 500'd the
      // whole Calibration tab — so it degrades on its own: `recent: null`, one warn, and
      // the all-time tables still render (the client hides the block on a null).
      // `allSettled` is what buys BOTH: the two independent queries still run
      // CONCURRENTLY (two sequential awaits made the tab as slow as their sum), while a
      // rejection of either is delivered as a value rather than unwinding the other.
      const [allTime, windowed] = await Promise.allSettled([outcomeStats(), recentStats(days)]);
      // The all-time half is the route's contract: its failure is still a 500, so it is
      // rethrown into the outer catch rather than reported as a partial payload.
      if (allTime.status === "rejected") throw allTime.reason;
      let recent: CandidateRecentStats | null = null;
      if (windowed.status === "fulfilled") recent = windowed.value;
      else {
        const err = windowed.reason;
        log.warn("Windowed candidate stats failed (days={days}): {error}", {
          days,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return c.json({ ...allTime.value, recent });
    } catch (err) {
      log.error("Loading candidate outcome stats failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to load calibration stats" }, 500);
    }
  });

}
