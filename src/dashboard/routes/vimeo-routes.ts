import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { createJob, getJob, getRecentJobs, subscribe } from "../../vimeo/state.ts";
import { summarizeVimeo } from "../../vimeo/summarizer.ts";
import { VIMEO_MAX_DURATION_SEC } from "../../vimeo/limits.ts";
import { canonicalVimeoUrl, resolveVimeoRef } from "../../vimeo/url.ts";
import { fetchVimeoOembed, isNotPublic } from "../../vimeo/oembed.ts";
import { speakerFromTitle } from "../../vimeo/metadata.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { findCapturePreset, resolveCapturePresets } from "../../summaries/presets.ts";
import { DEFAULT_CAPTURE_LANG, isCaptureLang } from "../../summaries/language.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { getSummarySource } from "../../summaries/sources.ts";
import { registerSummaryVertical } from "./summary-vertical.ts";
import { onSummaryDocumentDeleted } from "../../summaries/document-deleted.ts";

const log = getLog("dashboard");

// The registry owns the collection name; `src/vimeo/summarizer.ts` derives its
// `VIMEO_COLLECTION` from the same entry, so the collection this route dedups
// against and the one the job ingests into cannot drift apart.
const VIMEO_SOURCE = getSummarySource("vimeo")!;
const VIMEO_COLLECTION = VIMEO_SOURCE.collection;

interface VimeoDocumentMeta { id: string; url?: string }

/**
 * How long a just-ingested video is answered from memory rather than from
 * huginn's listing.
 *
 * The window this covers is huginn's REINDEX lag (seconds to a minute or two on
 * this corpus), so 30 minutes is generous slack rather than a fitted number —
 * the listing is authoritative the moment it catches up, and an entry that
 * outlives its usefulness costs nothing but a map slot. It is not longer,
 * because the map is the one dedup half with no evidence behind it: a document
 * deleted from huginn in the meantime would keep answering `duplicate` for as
 * long as this lasts.
 */
export const VIMEO_RECENT_INGEST_TTL_MS = 30 * 60 * 1000;

/**
 * How many videos the recently-ingested map remembers.
 *
 * Sized to be unreachable in practice (a capture is minutes of model time, so
 * 200 of them inside one TTL is not a real load) and bounded anyway, because
 * this map is the only unbounded-by-nature structure in the route: `inFlight`
 * empties itself when jobs settle, this one only ages out. Eviction is
 * oldest-INSERTED first, which is also oldest-ingested.
 */
export const VIMEO_RECENT_INGEST_MAX = 200;

/**
 * A video this process ingested but has not yet seen in huginn's listing.
 *
 * `documentId` is huginn's own `file_path` — the same string its `/documents`
 * listing reports as `id` — so the `duplicate` body this produces is
 * indistinguishable from the listing's.
 */
interface VimeoRecentIngest {
  documentId: string;
  existingUrl: string;
  /** When the ingest landed, read from the injected clock. */
  at: number;
}

/** Options a caller may inject; production passes none. */
export interface VimeoRouteOptions {
  /** The clock the recently-ingested TTL is measured on. */
  now?: () => number;
}

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
  /** Rows to pass over — a document a `/summaries` Delete just removed, which
   *  huginn keeps listing until its reindex lands. Applied per ROW, not to the
   *  first match: two rows can resolve to one video (`/<id>` and
   *  `/<id>/<hash>`; a title collision suffixed `(2)`), and skipping only the
   *  first would hide a live document behind a deleted one. */
  isGone: (documentId: string) => boolean = () => false,
): Promise<VimeoDocumentMeta | null> {
  try {
    const data = await fetchKnowledgeApi(
      baseUrl,
      `/api/collection/${VIMEO_COLLECTION}/documents`,
      { timeoutMs: 10000 },
    );
    const docs = (data?.documents ?? []) as VimeoDocumentMeta[];
    return (
      docs.find(
        (d) => d.url !== undefined && resolveVimeoRef(d.url)?.id === videoId && !isGone(d.id),
      ) ?? null
    );
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

export function registerVimeoRoutes(
  app: Hono,
  config: Config,
  opts: VimeoRouteOptions = {},
): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;
  const now = opts.now ?? Date.now;

  /**
   * ONE map per REGISTRATION, not one per module — the truthful scope, since a
   * process registers these routes exactly once and the claim is about "a
   * capture this app has started".
   *
   * Module-level it was also process-level state with no seam, which is a
   * testing hazard rather than a production one: a test builds a fresh app per
   * case, so a claim leaked by one case (a handler that threw between the claim
   * and its release) outlived it and answered `in_flight` for every later case
   * touching that video — measured: one leaked claim failed between 6 and 14
   * unrelated cases depending on the file's shape at the time, none of them
   * naming the route that leaked. Deliberately NOT a
   * test-only reset export: the scope is what was wrong, and an export would
   * leave the wrong scope in place behind a lever only tests pull.
   */
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
   * the in-flight claim is given back the moment the capture settles. Measured:
   * a completed capture re-POSTed immediately started a SECOND job and spent a
   * second model call, and the corpus hid it, because huginn's writer overwrote
   * the same category/title/url and only one document remained.
   *
   * Bounded on BOTH axes ({@link VIMEO_RECENT_INGEST_TTL_MS},
   * {@link VIMEO_RECENT_INGEST_MAX}) because it is a cache whose only
   * invalidation is the delete signal below: the listing is the authority, this
   * only covers the gap in front of it, and an entry that outlives the reindex
   * is answering from memory about a document it can no longer see.
   *
   * Same scope as `inFlight` — one map per REGISTRATION — for the same reason:
   * "a capture this app has started" is the truthful scope, and a module-level
   * map would leak one case's ingest into every later one.
   */
  const recentIngests = new Map<string, VimeoRecentIngest>();

  function rememberIngest(videoId: string, documentId: string, existingUrl: string): void {
    // A plain `set`, and that is only correct because this key is NEVER already
    // present — `Map.set` on an existing key keeps its ORIGINAL insertion
    // position, so a re-insert would age wrongly under the eviction below.
    //
    // Enumerated rather than assumed: this runs only from the ingest hook of a
    // capture, a capture starts only past `recentIngest(videoId)` returning null
    // (which DELETES an entry it found expired), and `inFlight` admits one
    // capture per video at a time — so no live entry can exist here. A change
    // that breaks any of those three needs a `delete` before this line.
    recentIngests.set(videoId, { documentId, existingUrl, at: now() });
    // The listing's row under this id is a real document again.
    recentDeletes.delete(documentId);
    while (recentIngests.size > VIMEO_RECENT_INGEST_MAX) {
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
  // Never unsubscribed: a registration lives as long as the process, and a
  // test app that outlives its case keeps forgetting only from its OWN map.
  onSummaryDocumentDeleted(({ collection, id }) => {
    if (collection !== VIMEO_COLLECTION) return;
    for (const [videoId, hit] of recentIngests) {
      if (hit.documentId === id) recentIngests.delete(videoId);
    }
    rememberDelete(id);
  });

  /**
   * The documents a `/summaries` Delete removed that huginn may STILL LIST —
   * the delete's own reindex window, the mirror image of `recentIngests`.
   *
   * huginn's DELETE is a soft delete: it moves the file and enqueues a reindex,
   * and the listing keeps naming the document until that reindex lands
   * (seconds to minutes when a reindex runs; huginn schedules NONE when that
   * collection's update was already running, and the UI's delete flow gives up
   * polling after 120 s saying the doc may reappear — so the TTL below bounds
   * this map, not the window). Forgetting the map alone moved the stale
   * `duplicate` from state 3 to state 4 — same body, same link to nothing — so
   * the listing half passes over a row naming one of these ids. An entry is
   * dropped the moment a capture ingests under that id again
   * (`rememberIngest`), when the row IS a document once more, and otherwise
   * expires with the same TTL and cap as its sibling. The two maps never hold
   * the same id at once (the delete listener drops the ingest entry and
   * `rememberIngest` drops the delete stamp), so the ways the listing half can
   * again answer `duplicate` about a REMOVED document are exactly this map's
   * own TTL expiry and its own cap eviction — both pinned in
   * `capture-route-job-ordering.test.ts`.
   */
  const recentDeletes = new Map<string, number>();

  function rememberDelete(documentId: string): void {
    recentDeletes.delete(documentId);
    recentDeletes.set(documentId, now());
    while (recentDeletes.size > VIMEO_RECENT_INGEST_MAX) {
      const oldest = recentDeletes.keys().next();
      if (oldest.done) break;
      recentDeletes.delete(oldest.value);
    }
  }

  /** Whether the listing's row for this id is a document the delete removed. */
  function recentlyDeleted(documentId: string): boolean {
    const at = recentDeletes.get(documentId);
    if (at === undefined) return false;
    if (now() - at >= VIMEO_RECENT_INGEST_TTL_MS) {
      recentDeletes.delete(documentId);
      return false;
    }
    return true;
  }

  /** The map's answer for this video, or null — an expired entry is dropped. */
  function recentIngest(videoId: string): VimeoRecentIngest | null {
    const hit = recentIngests.get(videoId);
    if (!hit) return null;
    if (now() - hit.at >= VIMEO_RECENT_INGEST_TTL_MS) {
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
      dashboard_url: `/summaries?source=vimeo&doc=${encodeURIComponent(documentId)}&duplicate=1`,
    };
  }

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
    type Body = { url?: string; kind?: unknown; lang?: unknown };
    const body = await c.req.json<Body>().catch(() => ({} as Body));
    const url = body.url;

    if (!url) {
      return c.json({ error: "Missing required field: url" }, 400);
    }

    const ref = resolveVimeoRef(url);
    if (!ref) {
      return c.json({ error: `Not a Vimeo video URL: ${url}` }, 400);
    }

    // The KIND and the LANGUAGE the reader picked, validated before anything is
    // spent on this paste — the oEmbed call below is a network round-trip, and
    // a picker value the server does not offer is a 400 whatever the video.
    // Absent is the default on both (an older client, a curl); present but
    // unknown is refused rather than silently summarized as `standard` — the
    // reader would read the result as the kind they picked. The kind set is
    // the SUMMARIZER bot's (a per-bot `captureSummary.<id>.md` adds one), so
    // the bot is resolved here, ahead of dedup, and a missing bot is answered
    // here too — and the kind set is narrowed by the bot's CONNECTOR, so a
    // `deep` a picker built for another bot cannot land on one that would run
    // it on its own model. Both 400s carry a machine `code` the card has a
    // sentence for.
    const summarizerBot = resolveSummarizerBot(discoverAllBots());
    if (!summarizerBot) {
      return c.json({ error: "No bots configured" }, 500);
    }
    // `error` is PROSE and `code` is the machine token, the shape the URL 400
    // above set: the card looks the code up in its sentence map and falls back
    // to `error`, so a code that ever loses its sentence still reads as a
    // sentence rather than as the token itself.
    if (body.kind !== undefined && typeof body.kind !== "string") {
      return c.json({ error: "Summary kind must be a string", code: "bad_kind" }, 400);
    }
    const preset = findCapturePreset(
      resolveCapturePresets(summarizerBot.prompts, summarizerBot.connector),
      body.kind,
    );
    if (!preset) {
      return c.json(
        { error: `Unknown summary kind: ${body.kind}`, code: "bad_kind", kind: body.kind },
        400,
      );
    }
    const lang = body.lang === undefined || body.lang === "" ? DEFAULT_CAPTURE_LANG : body.lang;
    if (!isCaptureLang(lang)) {
      return c.json(
        { error: `Unknown output language: ${String(body.lang)}`, code: "bad_lang", lang: body.lang },
        400,
      );
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

    const canonicalUrl = canonicalVimeoUrl(ref.id);
    // oEmbed can answer 200 with no title (`toMetadata` degrades every field to
    // ""), and huginn derives the document's FILENAME from the title — an empty
    // one would collide with every other title-less capture (huginn suffixes
    // `(2)`, so the corpus would carry near-identical rows nothing can tell
    // apart). The url is a usable, unique stand-in.
    //
    // Resolved HERE, above the in-flight wait, because the `in_flight` answer
    // below needs a title too and would otherwise be the one answer that has
    // none.
    const title = meta.title || canonicalUrl;

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
          // The RUNNING job's own title, so a second paste attaching to it
          // labels the card the way the first paste did. `?? title` covers the
          // job having been reaped between the claim and this read.
          title: getJob(running.jobId)?.title ?? title,
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

    const flight = claimVideo(ref.id);
    let started = false;
    try {
      // State 3 BEFORE state 4: the listing is authoritative, but it does not
      // know about a document ingested inside the reindex window, and asking it
      // first would spend a round-trip to be told "no" about a video this
      // process just captured.
      const recent = recentIngest(ref.id);
      if (recent) {
        log.info("Vimeo duplicate detected for {videoId} (ingested here, not yet listed): {docId}", {
          videoId: ref.id,
          docId: recent.documentId,
        });
        return c.json(duplicateBody(recent.documentId, recent.existingUrl));
      }

      const existing = await findExistingByVideoId(KNOWLEDGE_API_URL, ref.id, recentlyDeleted);
      if (existing) {
        log.info("Vimeo duplicate detected for {videoId}: {docId}", {
          videoId: ref.id,
          docId: existing.id,
        });
        return c.json(duplicateBody(existing.id, existing.url));
      }

      const jobId = createJob(ref.id, title, canonicalUrl);
      flight.jobId = jobId;
      started = true;

      // Fire and forget — background capture. `summarizeVimeo` settles exactly
      // when the job does (it never rethrows; both terminal paths are inside
      // it), so this is where the claim is given back — on `completeJob` and on
      // `failJob` alike, and on a throw the catch below would report.
      //
      // `.finally`, never `.then`: the release must not depend on the log line
      // above it succeeding. The two spellings differ in exactly one cell of
      // this chain's state space — a settled capture is fulfilled (both run) or
      // rejected, and a rejection either logs cleanly (the catch fulfils, both
      // run) or throws inside the catch, where only `.finally` still releases.
      // A throwing catch is not hypothetical: `String(err)` runs a rejection
      // value's own `toString`.
      summarizeVimeo(
        jobId,
        {
          videoId: ref.id,
          ...(ref.hash ? { hash: ref.hash } : {}),
          url: canonicalUrl,
          title,
          durationSec: meta.durationSec,
          uploadDate: meta.uploadDate,
          author: meta.author,
          thumbnailUrl: meta.thumbnailUrl,
          // From oEmbed's own title, not the url-fallback `title` above: the
          // fallback is an address and has no speaker in it.
          ...(speakerFromTitle(meta.title, meta.author) !== undefined
            ? { speaker: speakerFromTitle(meta.title, meta.author) }
            : {}),
          preset,
          lang,
        },
        config,
        summarizerBot,
        undefined,
        // The ONE moment the route can learn that a document now exists: huginn
        // answered the ingest, and its listing will not say so for another
        // reindex cycle. `canonicalUrl` is closed over rather than re-derived —
        // it is the exact string the capture posted as the document's `url`.
        (videoId, documentId) => rememberIngest(videoId, documentId, canonicalUrl),
      )
        .catch((err) => {
          log.error("Vimeo summarization failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => releaseVideo(ref.id, flight));

      // `title` rides along so the card is labelled with the video's name from
      // the first frame. Without it the page had the pasted URL and nothing
      // else, so a capture ran for minutes under a title a RELOAD then replaced
      // with the real one.
      return c.json({ job_id: jobId, title, dashboard_url: `/summaries?source=vimeo&job=${jobId}` });
    } finally {
      // Every early return under the claim gives it back here; a started capture
      // keeps it until the job settles. Without this one 500 would lock that
      // video out for the life of the process.
      if (!started) releaseVideo(ref.id, flight);
      else flight.settle();
    }
  });
}
