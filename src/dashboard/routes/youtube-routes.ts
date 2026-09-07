import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { createJob, getJob, getRecentJobs, subscribe } from "../../youtube/state.ts";
import { summarizeVideo } from "../../youtube/summarizer.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { connectorCapabilities } from "../../ai/one-shot.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { getSummarySource } from "../../summaries/sources.ts";
import { registerSummaryVertical } from "./summary-vertical.ts";
import {
  DEFAULT_CAPTURE_KIND,
  capturePresetOptions,
  findCapturePreset,
} from "../../summaries/presets.ts";
import { applyCors } from "../../auth/cors.ts";
import { YOUTUBE_FRAME_SOURCE, isFrameId, removeKeptFramesForDocument } from "../../summaries/frames.ts";
import { youtubeWatchUrl } from "../../youtube/frames.ts";
import { youtubeCaptureKinds } from "../../youtube/kinds.ts";
import { onSummaryDocumentDeleted } from "../../summaries/document-deleted.ts";

const log = getLog("dashboard");

// Single source of truth for the collection name lives in the registry.
const YT_SOURCE = getSummarySource("youtube")!;
const YT_COLLECTION = YT_SOURCE.collection;

interface YtDocumentMeta { id: string; url?: string }

/**
 * How long a just-ingested video is answered from memory rather than from
 * huginn's listing — the Vimeo constant, and the same number for the same
 * reason: this covers huginn's REINDEX lag (seconds to a minute or two on this
 * corpus), so 30 minutes is generous slack rather than a fitted value.
 *
 * Declared here rather than imported from `vimeo-routes.ts`: nothing about the
 * value is Vimeo's, and a route module importing a sibling vertical's route
 * module for a constant is a dependency neither wants.
 */
export const YOUTUBE_RECENT_INGEST_TTL_MS = 30 * 60 * 1000;

/** How many videos the recently-ingested map remembers — the Vimeo bound, same rationale. */
export const YOUTUBE_RECENT_INGEST_MAX = 200;

/**
 * A video this process ingested but has not yet seen in huginn's listing.
 *
 * `documentId` is huginn's own `file_path` — the same string its `/documents`
 * listing reports as `id` — so the `duplicate` body this produces is
 * indistinguishable from the listing's.
 */
interface YouTubeRecentIngest {
  documentId: string;
  existingUrl: string;
  /** When the ingest landed, read from the injected clock. */
  at: number;
}

/** Options a caller may inject; production passes none. */
export interface YouTubeRouteOptions {
  /** The clock the recently-ingested TTL is measured on. */
  now?: () => number;
  /**
   * Where this vertical's kept frames live, for the DELETE listener below;
   * default `framesRootDir()`. The serving route is registered elsewhere
   * (`frames-routes.ts`), but a test registering these routes still needs a
   * temp root: the listener set is module-level and never unsubscribed, so a
   * registration with no root removes frames under the developer's real home
   * on the next test that fires the signal.
   */
  framesRoot?: string;
}

/**
 * The video id in a YouTube URL, or null.
 *
 * Exported for the delete listener, which resolves the video behind a deleted
 * DOCUMENT out of the listing row huginn still serves — the same rule this
 * route's own dedup applies, so the two can never disagree about which video a
 * row is.
 */
export function extractYouTubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    // Exact host or a real SUBDOMAIN of it, never a suffix match: `endsWith`
    // also accepts `evilyoutube.com`, so one document ingested from such a url
    // answered `duplicate` for the real video — and, through the delete
    // listener, named the video whose kept frames get removed.
    const host = u.hostname.toLowerCase();
    if (host === "youtu.be") return u.pathname.slice(1) || null;
    if (host === "youtube.com" || host.endsWith(".youtube.com")) return u.searchParams.get("v");
    return null;
  } catch {
    return null;
  }
}

/**
 * The longest title this route stores.
 *
 * It is third-party text (the extension reads the page's own `<title>`) and it
 * reaches the job card, the `/agents` run name, the system prompt and huginn's
 * FILE NAME. 300 characters is far past any real video title and well under
 * anything that would matter in a prompt.
 */
export const YOUTUBE_TITLE_MAX = 300;

/** `title`, capped — with the ellipsis inside the bound, never appended past it. */
export function capYouTubeTitle(title: string): string {
  return title.length <= YOUTUBE_TITLE_MAX ? title : `${title.slice(0, YOUTUBE_TITLE_MAX - 1)}…`;
}

/**
 * Look for an already-captured document of this VIDEO.
 *
 * A failed listing degrades to "not a duplicate" — the same call the other
 * verticals make, since the cost is a rare re-capture and the alternative is
 * refusing to capture while huginn is down.
 */
async function findExistingByVideoId(
  baseUrl: string,
  videoId: string,
  /** Rows to pass over — a document a `/summaries` Delete just removed, which
   *  huginn keeps listing until its reindex lands. Applied per ROW, not to the
   *  first match: two rows can resolve to one video (a `youtu.be` short link and
   *  a `watch?v=` one; a title collision suffixed `(2)`), and skipping only the
   *  first would hide a live document behind a deleted one. */
  isGone: (documentId: string) => boolean = () => false,
): Promise<YtDocumentMeta | null> {
  try {
    const data = await fetchKnowledgeApi(
      baseUrl,
      `/api/collection/${YT_COLLECTION}/documents`,
      { timeoutMs: 10000 },
    );
    const docs = (data?.documents ?? []) as YtDocumentMeta[];
    return (
      docs.find(
        (d) => d.url != null && extractYouTubeVideoId(d.url) === videoId && !isGone(d.id),
      ) ?? null
    );
  } catch (err) {
    log.warn("YouTube duplicate check failed: {error}", {
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
 * two POSTs of the same video on either side of it both found nothing and both
 * captured. The claim is taken SYNCHRONOUSLY, before that lookup, and `jobId` is
 * filled in once the job exists — a second POST arriving in the window between
 * the two waits for the first to decide rather than being answered with a job id
 * that does not exist yet.
 */
interface YouTubeFlight {
  jobId: string | null;
  /** Resolves when the claim is either filled in or released. */
  decided: Promise<void>;
  settle: () => void;
}

export function registerYouTubeRoutes(
  app: Hono,
  config: Config,
  opts: YouTubeRouteOptions = {},
): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;
  const now = opts.now ?? Date.now;

  /**
   * ONE map per REGISTRATION, not one per module — the truthful scope, since a
   * process registers these routes exactly once and the claim is about "a
   * capture this app has started". Module-level it would also be process-level
   * state with no seam, so a claim leaked by one test case would answer
   * `in_flight` for every later case touching that video.
   */
  const inFlight = new Map<string, YouTubeFlight>();

  function claimVideo(videoId: string): YouTubeFlight {
    let settle!: () => void;
    const decided = new Promise<void>((resolve) => { settle = resolve; });
    const flight: YouTubeFlight = { jobId: null, decided, settle };
    inFlight.set(videoId, flight);
    return flight;
  }

  function releaseVideo(videoId: string, flight: YouTubeFlight): void {
    if (inFlight.get(videoId) === flight) inFlight.delete(videoId);
    flight.settle();
  }

  /**
   * The videos this process has INGESTED but huginn has not listed yet — the
   * third state of a video id, and the one that was owned by nothing.
   *
   * A video id is in exactly one of four states, and dedup needs a guard for
   * each:
   *
   *  1. absent everywhere                → capture it;
   *  2. claimed in-flight                → `inFlight`, answered `in_flight`;
   *  3. **ingested, not yet listed**     → THIS map, answered `duplicate`;
   *  4. listed by huginn                 → `findExistingByVideoId`, `duplicate`.
   *
   * State 3 exists because the two guards either side of it end and begin at
   * different instants. `GET /api/collection/<c>/documents` is derived from
   * huginn's `index_document_mapping.json`, which moves only when the background
   * reindex enqueued AFTER an ingest has run — seconds to minutes later — while
   * the in-flight claim is given back the moment the capture settles.
   *
   * **And on THIS vertical the consequence of missing it is worse than a double
   * spend.** huginn's YouTube ingest keys on the FILE PATH
   * (`<category>/<sanitized title>.md`, `write_categorized_markdown`) and then
   * compares the STORED url: same path + same url overwrites, same path + a
   * DIFFERENT url forks `Title (2).md`. So a re-capture whose auto-picked
   * category or resolved title differs by a character writes a SECOND document
   * under a second path — which is also why everything stored below is built
   * from the validated id rather than from `body.url`. (On the Vimeo side path
   * and url both match on a re-capture, which is what made the same bug
   * invisible there.) This map is the only thing in front of that.
   *
   * Bounded on BOTH axes because it is a cache whose only invalidation is the
   * delete signal below: the listing is the authority, this only covers the gap
   * in front of it.
   */
  const recentIngests = new Map<string, YouTubeRecentIngest>();

  function rememberIngest(videoId: string, documentId: string, existingUrl: string): void {
    // A plain `set`, and that is only correct because this key is NEVER already
    // present — `Map.set` on an existing key keeps its ORIGINAL insertion
    // position, so a re-insert would age wrongly under the eviction below.
    // Enumerated: this runs only from the ingest hook of a capture, a capture
    // starts only past `recentIngest(videoId)` returning null (which DELETES an
    // entry it found expired), and `inFlight` admits one capture per video at a
    // time.
    recentIngests.set(videoId, { documentId, existingUrl, at: now() });
    // The listing's row under this id is a real document again.
    recentDeletes.delete(documentId);
    while (recentIngests.size > YOUTUBE_RECENT_INGEST_MAX) {
      const oldest = recentIngests.keys().next();
      if (oldest.done) break;
      recentIngests.delete(oldest.value);
    }
  }

  // The one invalidation the map has: a `/summaries` Delete goes through
  // `backlog-doc-delete`, which announces the document AFTER huginn confirmed
  // the move. Without this, a capture deleted and re-pasted inside the TTL was
  // answered `duplicate` from memory about a document that no longer existed —
  // with a link to nothing. Matched on the document id, which is what the map
  // holds and what the delete names; the video id is not on the wire there.
  //
  // Never unsubscribed: a registration lives as long as the process, and a test
  // app that outlives its case keeps forgetting only from its OWN map.
  onSummaryDocumentDeleted(({ collection, id }) => {
    if (collection !== YT_COLLECTION) return;
    let deletedVideoId: string | null = null;
    for (const [videoId, hit] of recentIngests) {
      if (hit.documentId === id) {
        recentIngests.delete(videoId);
        deletedVideoId = videoId;
      }
    }
    rememberDelete(id);
    // The kept frames go with the document. The signal carries the DOCUMENT id;
    // the video id comes from the ingest map when the capture was recent, else
    // from the listing row huginn still serves (its DELETE is soft, so the row
    // is there for the reindex window — the same window `recentDeletes` exists
    // for). Async and best-effort: a listing that is down leaves the frames in
    // place, logged, and the document is gone either way. Fired, not awaited —
    // the listener contract is synchronous.
    //
    // Called from INSIDE this listener, never as a second listener of its own:
    // the dedup half above DELETES the ingest entry, so two listeners fanning
    // out in Set order would run this one second, find nothing, and send every
    // delete down the listing fallback.
    void removeKeptFramesForDocument(YOUTUBE_FRAME_SOURCE, id, deletedVideoId, {
      ...(opts.framesRoot !== undefined ? { framesRoot: opts.framesRoot } : {}),
      resolveVideoId: resolveDeletedDocumentVideoId,
    });
  });

  /**
   * The video behind a deleted document, when the ingest map did not know it.
   * Only reached when the frames dir for this source is non-empty, so a
   * transcript-only delete (the common case) costs no listing read.
   */
  async function resolveDeletedDocumentVideoId(documentId: string): Promise<string | null> {
    const data = await fetchKnowledgeApi(KNOWLEDGE_API_URL, `/api/collection/${YT_COLLECTION}/documents`, {
      timeoutMs: 10000,
    });
    const row = ((data?.documents ?? []) as YtDocumentMeta[]).find((d) => d.id === documentId);
    return row?.url != null ? extractYouTubeVideoId(row.url) : null;
  }

  /**
   * The documents a `/summaries` Delete removed that huginn may STILL LIST —
   * the delete's own reindex window, the mirror image of `recentIngests`.
   * Forgetting the ingest map alone would only move the stale `duplicate` from
   * state 3 to state 4, with the same link to nothing.
   */
  const recentDeletes = new Map<string, number>();

  function rememberDelete(documentId: string): void {
    recentDeletes.delete(documentId);
    recentDeletes.set(documentId, now());
    while (recentDeletes.size > YOUTUBE_RECENT_INGEST_MAX) {
      const oldest = recentDeletes.keys().next();
      if (oldest.done) break;
      recentDeletes.delete(oldest.value);
    }
  }

  /** Whether the listing's row for this id is a document the delete removed. */
  function recentlyDeleted(documentId: string): boolean {
    const at = recentDeletes.get(documentId);
    if (at === undefined) return false;
    if (now() - at >= YOUTUBE_RECENT_INGEST_TTL_MS) {
      recentDeletes.delete(documentId);
      return false;
    }
    return true;
  }

  /** The map's answer for this video, or null — an expired entry is dropped. */
  function recentIngest(videoId: string): YouTubeRecentIngest | null {
    const hit = recentIngests.get(videoId);
    if (!hit) return null;
    if (now() - hit.at >= YOUTUBE_RECENT_INGEST_TTL_MS) {
      recentIngests.delete(videoId);
      return null;
    }
    return hit;
  }

  /**
   * The one `duplicate` body, shared by both halves of the stored-document
   * check, so a reader (and `/summaries`) cannot tell which one answered.
   */
  function duplicateBody(documentId: string, existingUrl: string | undefined) {
    return {
      duplicate: true as const,
      document_id: documentId,
      existing_url: existingUrl,
      dashboard_url: `/summaries?source=youtube&doc=${encodeURIComponent(documentId)}&duplicate=1`,
    };
  }

  // Shared plumbing: bare-path redirect, CORS preflight, SSE stream, jobs,
  // document/similar proxies (the /youtube page merged into /summaries).
  registerSummaryVertical(app, config, {
    apiBase: YT_SOURCE.apiBase,
    collection: YT_COLLECTION,
    store: { getJob, getRecentJobs, subscribe },
    redirect: { path: "/youtube", source: "youtube" },
    corsPreflight: true,
  });

  /**
   * What this instance can be asked for — the summary kinds and whether slides
   * are available — so the extension popup renders the picker from the SERVER
   * rather than from a catalog of its own. A second hardcoded list in an
   * unpackaged Chrome extension is a list nobody updates: it would offer `deep`
   * on an instance whose summarizer bot cannot run it and get a 400 back.
   *
   * `applyCors` for the same reason the POST has it, and it is not optional
   * here: this module applies CORS inside the summarize handler only, and
   * registers a preflight only for `/summarize`. The extension's `muninnUrl` is
   * user-editable past the manifest's `localhost:3010` grant, so without the
   * header this GET fails silently on every other install and the popup falls
   * back to Standard-only — a picker that is wrong with no way to tell.
   *
   * A SIMPLE request by construction: `GET`, no custom request headers, so the
   * browser sends no preflight and none is registered.
   *
   * Read-only, and the kinds are the same resolution the POST validates against
   * — one call, `requireThinkingControl` on both, so the picker and the 400
   * cannot disagree.
   */
  app.get("/api/youtube/options", (c) => {
    applyCors(c);
    const summarizerBot = resolveSummarizerBot(discoverAllBots());
    if (!summarizerBot) {
      return c.json({ error: "No bots configured", code: "no_bot" }, 500);
    }
    return c.json({
      kinds: capturePresetOptions(youtubeCaptureKinds(summarizerBot)),
      // The id a client sends when the reader picks nothing. Named rather than
      // left as "the first entry", so the popup never has to assume an order.
      default_kind: DEFAULT_CAPTURE_KIND,
      frames: { supported: connectorCapabilities(summarizerBot).supportsExtraDirs },
    });
  });

  app.post("/api/youtube/summarize", async (c) => {
    // CORS STAYS on this route, deliberately: the entry point is a Chrome
    // extension, which is cross-origin by construction (the Vimeo vertical has
    // no extension, which is why it has no CORS). Stated because this PR puts a
    // yt-dlp download, an ffmpeg pass and a 60-image model turn behind it; what
    // bounds that is `MUNINN_ALLOWED_ORIGINS` under `MUNINN_AUTH`, which is
    // what the extension origin is allowlisted in.
    applyCors(c);

    // **`application/json` is REQUIRED** (the `jira-routes.ts` precedent).
    // Hono parses any body whatever the header says, and `text/plain` is a CORS
    // *simple* request — no preflight at all — so without this gate a
    // cross-origin page could start a yt-dlp download, an ffmpeg pass and a
    // 60-image model turn with the browser never asking permission. The
    // extension already sends JSON. A `charset` parameter is fine.
    const contentType = (c.req.header("content-type") ?? "").trim();
    if (!/^application\/json\s*(;|$)/i.test(contentType)) {
      return c.json(
        { error: "This endpoint takes application/json.", code: "bad_content_type" },
        415,
      );
    }

    type Body = { title?: string; url?: string; video_id?: string; frames?: unknown; kind?: unknown };
    const body = await c.req.json<Body>().catch(() => ({} as Body));
    const { title, url, video_id } = body;

    if (!video_id || !url) {
      return c.json({ error: "Missing required fields: url, video_id" }, 400);
    }

    // The id gate is ROUTE-WIDE, not frames-only, and it runs BEFORE the huginn
    // listing read: a malformed id must not cost a round-trip. It is the frames
    // seam's own charset (11 URL-safe base64 characters) because that is what a
    // YouTube id IS — the id is already a path segment of the transcript URL the
    // transcript-only path fetches, and on the frames path it becomes a
    // directory name and a served address. Every real id passes, so the only
    // captures this refuses are ones that would have failed on the transcript
    // fetch anyway.
    //
    // `error` is PROSE and `code` is the machine token — the shape the Vimeo
    // route documents, so the extension popup (which renders `detail`, then
    // `error`) shows a sentence with no client change.
    if (!isFrameId(YOUTUBE_FRAME_SOURCE, video_id)) {
      return c.json(
        { error: `Not a YouTube video id: ${video_id}`, code: "bad_video_id" },
        400,
      );
    }

    // The canonical address of this video, from the id above and nothing else.
    const canonicalUrl = youtubeWatchUrl(video_id);

    if (body.frames !== undefined && typeof body.frames !== "boolean") {
      return c.json({ error: "frames must be a boolean", code: "bad_frames" }, 400);
    }
    const frames = body.frames === true;

    // Resolve the bot and pre-flight the connector BEFORE the duplicate check
    // and before `createJob`. A job created above an early return is never
    // settled and lingers for the whole in-flight grace at the top of
    // /summaries (see the same ordering in tiktok-routes.ts /
    // x-article-routes.ts); above the dedup, because a 503 must not cost a
    // huginn listing read either — the Vimeo ordering.
    const summarizerBot = resolveSummarizerBot(discoverAllBots());
    if (!summarizerBot) {
      return c.json({ error: "No bots configured" }, 500);
    }

    // The summary KIND, validated before the duplicate lookup and before
    // `createJob` — the Vimeo ordering, for the Vimeo reason: a picker value
    // this instance does not offer is a 400 whatever the video, and it must not
    // cost a huginn listing read or leave a job row behind. Absent is the
    // default (an older extension, a curl); present but unknown is REFUSED
    // rather than quietly summarized as `standard`, since the reader would read
    // the result as the kind they picked. `error` is prose and `code` is the
    // machine token — the shape the popup renders.
    if (body.kind !== undefined && typeof body.kind !== "string") {
      return c.json({ error: "Summary kind must be a string", code: "bad_kind" }, 400);
    }
    // PRESENT BUT BLANK is refused with the rest. `findCapturePreset` reads a
    // blank id as ABSENT — the right rule for a key that is not there at all
    // (an older extension, a curl) and the wrong one for a caller that sent the
    // key and put nothing in it, which is a picker that failed to fill. Without
    // this, `kind: ""` ran `standard` and was reported as the kind picked.
    if (typeof body.kind === "string" && body.kind.trim() === "") {
      return c.json(
        { error: "Summary kind must not be blank", code: "bad_kind", kind: body.kind },
        400,
      );
    }
    const preset = findCapturePreset(youtubeCaptureKinds(summarizerBot), body.kind);
    if (!preset) {
      return c.json(
        { error: `Unknown summary kind: ${body.kind}`, code: "bad_kind", kind: body.kind },
        400,
      );
    }

    if (frames && !connectorCapabilities(summarizerBot).supportsExtraDirs) {
      // `error` is the SENTENCE and `code` is the machine token — this file's
      // own rule, which its 400s follow. The extension popup renders `detail`
      // then `error`, so a token in `error` shows the reader the word
      // `frames_unsupported`.
      return c.json(
        {
          error: "Slides are not available on this summarizer bot's connector.",
          code: "frames_unsupported",
          detail:
            `Summarizer bot "${summarizerBot.name}" uses connector "${summarizerBot.connector ?? "claude-cli"}", ` +
            `which cannot read the extracted slide frames (no extra-dirs support). Untick Slides, or set ` +
            `SUMMARIZER_BOT to a claude-cli or claude-sdk bot.`,
        },
        503,
      );
    }

    // A capture of this video already running in this process is the other half
    // of the duplicate check — the stored-document half cannot see it, because
    // nothing is stored until the job finishes.
    let running = inFlight.get(video_id);
    while (running) {
      await running.decided;
      if (running.jobId) {
        return c.json({
          in_flight: true,
          job_id: running.jobId,
          dashboard_url: `/summaries?source=youtube&job=${running.jobId}`,
        });
      }
      // That POST refused (duplicate, no bot, …) and released its claim without
      // starting anything, so this one decides for itself. Re-read rather than
      // fall straight through: another waiter may have claimed it meanwhile.
      const next = inFlight.get(video_id);
      // A claim that settled without a job id and is STILL mapped has nothing
      // left to wait for; awaiting its resolved promise again would wedge the
      // handler. `releaseVideo` deletes and settles together, so this cannot
      // happen today — the guard keeps a future bug a wrong answer rather than
      // a hung request.
      if (next === running) break;
      running = next;
    }

    const flight = claimVideo(video_id);
    let started = false;
    try {
      // State 3 BEFORE state 4: the listing is authoritative, but it does not
      // know about a document ingested inside the reindex window, and asking it
      // first would spend a round-trip to be told "no" about a video this
      // process just captured.
      const recent = recentIngest(video_id);
      if (recent) {
        log.info("YouTube duplicate detected for {videoId} (ingested here, not yet listed): {docId}", {
          videoId: video_id,
          docId: recent.documentId,
        });
        return c.json(duplicateBody(recent.documentId, recent.existingUrl));
      }

      const existing = await findExistingByVideoId(KNOWLEDGE_API_URL, video_id, recentlyDeleted);
      if (existing) {
        log.info("YouTube duplicate detected for {videoId}: {docId}", {
          videoId: video_id,
          docId: existing.id,
        });
        return c.json(duplicateBody(existing.id, existing.url));
      }

      // Everything stored from here on is built from the VALIDATED id, never
      // from `body.url`: a POST naming video X with a url for video Y used to
      // store Y's url as X's `existing_url`, so every later capture of Y was
      // answered `duplicate` with a link to X's document. `url` is still
      // required (the extension contract) and is now stored nowhere — it is
      // only a title fallback, where it is the reader's own paste.
      const jobId = createJob(video_id, capYouTubeTitle(title || canonicalUrl), canonicalUrl);
      flight.jobId = jobId;
      started = true;

      // Fire and forget — background summarization. `summarizeVideo` settles
      // exactly when the job does (both terminal paths are inside it), so this
      // is where the claim is given back. `.finally`, never `.then`: the release
      // must not depend on the log line above it succeeding.
      summarizeVideo(jobId, video_id, capYouTubeTitle(title || canonicalUrl), config, summarizerBot, {
        frames,
        preset,
        // The ONE moment the route can learn that a document now exists: huginn
        // answered the ingest, and its listing will not say so for another
        // reindex cycle.
        onIngested: (videoId, documentId) => rememberIngest(videoId, documentId, canonicalUrl),
      })
        .catch((err) => {
          log.error("YouTube summarization failed: {error}", { error: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => releaseVideo(video_id, flight));

      return c.json({ job_id: jobId, dashboard_url: `/summaries?source=youtube&job=${jobId}` });
    } finally {
      // Every early return under the claim gives it back here; a started capture
      // keeps it until the job settles. Without this one 500 would lock that
      // video out for the life of the process.
      if (!started) releaseVideo(video_id, flight);
      else flight.settle();
    }
  });
}
