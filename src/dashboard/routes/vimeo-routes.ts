import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { createJob, getJob, getRecentJobs, subscribe } from "../../vimeo/state.ts";
import { summarizeVimeo, VIMEO_MAX_DURATION_SEC } from "../../vimeo/summarizer.ts";
import { canonicalVimeoUrl, resolveVimeoRef } from "../../vimeo/url.ts";
import { fetchVimeoOembed, isNotPublic } from "../../vimeo/oembed.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { getSummarySource } from "../../summaries/sources.ts";
import { registerSummaryVertical } from "./summary-vertical.ts";

const log = getLog("dashboard");

// The registry owns the collection name; `src/vimeo/summarizer.ts` derives its
// `VIMEO_COLLECTION` from the same entry, so the collection this route dedups
// against and the one the job ingests into cannot drift apart.
const VIMEO_SOURCE = getSummarySource("vimeo")!;
const VIMEO_COLLECTION = VIMEO_SOURCE.collection;

interface VimeoDocumentMeta { id: string; url?: string }

/**
 * Look for an already-captured document of this VIDEO.
 *
 * Each listed row's url is resolved to its video id and compared with the
 * capture's, the way the youtube sibling does — not compared as a whole string.
 * "Every writer posts `canonicalVimeoUrl(id)`" is true of this route and false
 * of the collection: the live one already holds rows this route never wrote
 * (including a bare `https://vimeo.com/`), and a row spelled
 * `vimeo.com/<id>/<hash>` or `player.vimeo.com/video/<id>` is the same video.
 * A row whose url resolves to no id (or has none) matches nothing.
 *
 * A failed listing degrades to "not a duplicate" — the same call the other
 * verticals make, since the cost is a rare re-capture and the alternative is
 * refusing to capture while huginn is down.
 */
async function findExistingByVideoId(
  baseUrl: string,
  videoId: string,
): Promise<VimeoDocumentMeta | null> {
  try {
    const data = await fetchKnowledgeApi(
      baseUrl,
      `/api/collection/${VIMEO_COLLECTION}/documents`,
      { timeoutMs: 10000 },
    );
    const docs = (data?.documents ?? []) as VimeoDocumentMeta[];
    return docs.find((d) => d.url !== undefined && resolveVimeoRef(d.url)?.id === videoId) ?? null;
  } catch (err) {
    log.warn("Vimeo duplicate check failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The captures this process has started and not yet settled, keyed on the VIDEO
 * id — the in-flight half of the duplicate check.
 *
 * The huginn lookup is an await, so the stored-document check is check-then-act:
 * two POSTs of the same url on either side of it both found nothing and both
 * captured, and huginn suffixes `(2)` rather than overwriting, so the corpus
 * kept a shadow copy of the same talk. The claim is taken SYNCHRONOUSLY, before
 * that lookup, and `jobId` is filled in once the job exists — a second POST
 * arriving in the window between the two waits for the first to decide (one
 * huginn call, ≤10 s) rather than being answered with a job id that does not
 * exist yet.
 */
interface VimeoFlight {
  jobId: string | null;
  /** Resolves when the claim is either filled in or released. */
  decided: Promise<void>;
  settle: () => void;
}
const inFlight = new Map<string, VimeoFlight>();

function claimVideo(videoId: string): VimeoFlight {
  let settle!: () => void;
  const decided = new Promise<void>((resolve) => { settle = resolve; });
  const flight: VimeoFlight = { jobId: null, decided, settle };
  inFlight.set(videoId, flight);
  return flight;
}

function releaseVideo(videoId: string, flight: VimeoFlight): void {
  if (inFlight.get(videoId) === flight) inFlight.delete(videoId);
  flight.settle();
}

export function registerVimeoRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  // Shared plumbing: bare-path redirect, SSE stream, jobs, document/similar
  // proxies. NO CORS preflight and no `applyCors` on the POST below: there is no
  // Chrome extension for this vertical (PR 3 adds a URL field on /summaries,
  // which is same-origin), and a cross-origin summarize entry is a way for any
  // page to spend the operator's model budget.
  registerSummaryVertical(app, config, {
    apiBase: VIMEO_SOURCE.apiBase,
    collection: VIMEO_COLLECTION,
    store: { getJob, getRecentJobs, subscribe },
    redirect: { path: "/vimeo", source: "vimeo" },
    corsPreflight: false,
  });

  app.post("/api/vimeo/summarize", async (c) => {
    const body = await c.req.json<{ url?: string }>().catch(() => ({} as { url?: string }));
    const url = body.url;

    if (!url) {
      return c.json({ error: "Missing required field: url" }, 400);
    }

    const ref = resolveVimeoRef(url);
    if (!ref) {
      return c.json({ error: `Not a Vimeo video URL: ${url}` }, 400);
    }

    // oEmbed FIRST, and everything that can refuse the capture happens on its
    // answer — before a job exists. A job created above an early return is never
    // settled and lingers for the whole in-flight grace at the top of
    // /summaries with a "running" /agents card (the ordering
    // capture-route-job-ordering.test.ts pins for the other verticals).
    let meta;
    try {
      meta = await fetchVimeoOembed(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("Vimeo oEmbed failed for {url}: {error}", { url, error: message });
      return c.json({ error: "oembed_failed", detail: message }, 502);
    }

    if (isNotPublic(meta)) {
      return c.json({ error: "not_public", status: meta.status }, 422);
    }

    // `toDurationSec` degrades a missing, non-numeric or negative `duration` to
    // 0 — "the endpoint did not say" — and 0 passes the cap below unconditionally.
    // The duration is the ONLY length bound this vertical has (there is no
    // download to time out and no frame budget), so a metadata answer that never
    // said how long the video is refuses rather than starting an unbounded
    // capture. Below the not-public branch, which carries no duration at all.
    if (meta.durationSec === 0) {
      return c.json({ error: "duration_unknown" }, 422);
    }

    if (meta.durationSec > VIMEO_MAX_DURATION_SEC) {
      return c.json(
        { error: "too_long", durationSec: meta.durationSec, maxSec: VIMEO_MAX_DURATION_SEC },
        413,
      );
    }

    // A capture of this video already running in this process is the other half
    // of the duplicate check — the stored-document half cannot see it, because
    // nothing is stored until the job finishes.
    let running = inFlight.get(ref.id);
    while (running) {
      await running.decided;
      if (running.jobId) {
        return c.json({
          in_flight: true,
          job_id: running.jobId,
          dashboard_url: `/summaries?source=vimeo&job=${running.jobId}`,
        });
      }
      // That POST refused (duplicate, no bot, …) and released its claim without
      // starting anything, so this one decides for itself. Re-read rather than
      // fall straight through: another waiter may have claimed it meanwhile.
      const next = inFlight.get(ref.id);
      // A claim that settled without a job id and is STILL mapped has nothing
      // left to wait for, and awaiting its resolved promise again is an infinite
      // loop that hangs the request — measured, by mutating the release away.
      // `releaseVideo` deletes and settles together, so this cannot happen
      // today; the guard is what keeps a future bug a wrong answer rather than a
      // wedged handler.
      if (next === running) break;
      running = next;
    }

    const canonicalUrl = canonicalVimeoUrl(ref.id);
    // oEmbed can answer 200 with no title (`toMetadata` degrades every field to
    // ""), and huginn derives the document's FILENAME from the title — an empty
    // one would collide with every other title-less capture (huginn suffixes
    // `(2)`, so the corpus would carry near-identical rows nothing can tell
    // apart). The url is a usable, unique stand-in.
    const title = meta.title || canonicalUrl;

    const flight = claimVideo(ref.id);
    let started = false;
    try {
      const existing = await findExistingByVideoId(KNOWLEDGE_API_URL, ref.id);
      if (existing) {
        log.info("Vimeo duplicate detected for {videoId}: {docId}", {
          videoId: ref.id,
          docId: existing.id,
        });
        return c.json({
          duplicate: true,
          document_id: existing.id,
          existing_url: existing.url,
          dashboard_url: `/summaries?source=vimeo&doc=${encodeURIComponent(existing.id)}&duplicate=1`,
        });
      }

      const summarizerBot = resolveSummarizerBot(discoverAllBots());
      if (!summarizerBot) {
        return c.json({ error: "No bots configured" }, 500);
      }

      const jobId = createJob(ref.id, title, canonicalUrl);
      flight.jobId = jobId;
      started = true;

      // Fire and forget — background capture. `summarizeVimeo` settles exactly
      // when the job does (it never rethrows; both terminal paths are inside
      // it), so this is where the claim is given back — on `completeJob` and on
      // `failJob` alike, and on a throw the catch below would report.
      summarizeVimeo(
        jobId,
        {
          videoId: ref.id,
          ...(ref.hash ? { hash: ref.hash } : {}),
          url: canonicalUrl,
          title,
          durationSec: meta.durationSec,
          uploadDate: meta.uploadDate,
        },
        config,
        summarizerBot,
      )
        .catch((err) => {
          log.error("Vimeo summarization failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => releaseVideo(ref.id, flight));

      return c.json({ job_id: jobId, dashboard_url: `/summaries?source=vimeo&job=${jobId}` });
    } finally {
      // Every early return under the claim gives it back here; a started capture
      // keeps it until the job settles. Without this one 500 would lock that
      // video out for the life of the process.
      if (!started) releaseVideo(ref.id, flight);
      else flight.settle();
    }
  });
}
