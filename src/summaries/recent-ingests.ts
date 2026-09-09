/**
 * "This process just ingested a document" — announced to whoever owns the
 * vertical's reindex-window memory.
 *
 * Every video vertical keeps a `recentIngests` map (`videoId → {documentId,
 * existingUrl, at}`) that answers `duplicate` for the seconds-to-minutes between
 * huginn accepting an ingest and its listing reporting the document. The map is
 * CLOSURE-PRIVATE inside `registerYouTubeRoutes` / `registerVimeoRoutes` — one
 * map per registration, which is the truthful scope and the reason it is not
 * module state with a seam — and the capture summarizer feeds it through an
 * `onIngested` hook it is handed at `summarizeVideo` time.
 *
 * The capture RE-RUN ingests without going through either of those doors: it is
 * a route of its own, in a module of its own, and it never calls the vertical's
 * summarizer. Left unannounced, a re-run's own document would be invisible to
 * the dedup for the whole reindex window — a paste of the same video right after
 * a re-run would be captured a SECOND time, and on YouTube (where huginn keys on
 * `<category>/<title>.md` and forks `(2)` on a differing url) that is a shadow
 * copy of the talk rather than only a double spend.
 *
 * So this is the minimal seam: each route registration hands over the function
 * it already has, and the re-run calls it by source name. Nothing about the maps
 * themselves moves — the eviction order, the TTL and the bounds stay exactly
 * where they are documented.
 *
 * **A Set of sinks per source, never last-registration-wins**, mirroring
 * `onSummaryDocumentDeleted`: a test that registers two apps in one process
 * would otherwise silently stop feeding the first one's map. A sink belonging to
 * a retired registration writes an entry nothing reads, which is inert.
 */

import { getLog } from "../logging.ts";

const log = getLog("summaries", "recent-ingests");

/** What a vertical's `rememberIngest` takes: the video, the stored document,
 *  and the url that document was written with. */
export type RecentIngestSink = (videoId: string, documentId: string, url: string) => void;

const sinks = new Map<string, Set<RecentIngestSink>>();

/**
 * Register a vertical's reindex-window memory under its SOURCE id (`youtube`,
 * `vimeo`, …). Returns an unsubscribe, which production never calls and a test
 * may.
 */
export function registerRecentIngestSink(source: string, sink: RecentIngestSink): () => void {
  let set = sinks.get(source);
  if (!set) {
    set = new Set();
    sinks.set(source, set);
  }
  const own = set;
  own.add(sink);
  return () => {
    own.delete(sink);
    if (own.size === 0 && sinks.get(source) === own) sinks.delete(source);
  };
}

/**
 * Tell every registered sink for `source` that this process stored
 * `documentId` for `videoId` at `url`.
 *
 * A sink that throws is logged and the rest still run: this is bookkeeping in
 * front of a dedup, and a capture that really did ingest must not be reported
 * as failed because a map update threw.
 */
export function notifyCaptureIngest(
  source: string,
  videoId: string,
  documentId: string,
  url: string,
): void {
  const set = sinks.get(source);
  if (!set) return;
  for (const sink of set) {
    try {
      sink(videoId, documentId, url);
    } catch (err) {
      log.warn("A {source} recent-ingest sink threw for {documentId}: {error}", {
        source,
        documentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Test-only: how many sinks are registered for a source. */
export function __recentIngestSinkCount(source: string): number {
  return sinks.get(source)?.size ?? 0;
}
