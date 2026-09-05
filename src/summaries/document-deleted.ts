/**
 * The one signal that a summary document has LEFT a huginn collection.
 *
 * The delete route (`backlog-doc-delete`, `wiki-gardener-routes.ts`) is where
 * a document is removed, and it knows nothing about the per-vertical state that
 * remembers documents — the Vimeo route's recently-ingested dedup map
 * (`vimeo-routes.ts`), which answers `duplicate` from memory for up to 30 min
 * after an ingest because huginn's listing lags its reindex. Deleting a capture
 * and pasting the url again inside that window was answered `duplicate` about
 * a document that no longer existed, with a link to nothing.
 *
 * A module-level listener set rather than a route option: the two routes are
 * registered by different factories with no shared handle, and the delete
 * route must not import a capture vertical to tell it something. Listeners are
 * called synchronously, after huginn has CONFIRMED the delete, never before —
 * a refused delete leaves every cache as it was, because the document is still
 * there.
 */

import { getLog } from "../logging.ts";

const log = getLog("summaries", "document-deleted");

export interface SummaryDocumentDeleted {
  collection: string;
  /** The document id as huginn lists it (its path inside the collection). */
  id: string;
}

type Listener = (event: SummaryDocumentDeleted) => void;

const listeners = new Set<Listener>();

/** Subscribe; the return value unsubscribes. */
export function onSummaryDocumentDeleted(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fan the event out. A listener that throws must not stop the others, nor the
 * delete route's own response — the document IS gone whatever a cache did.
 */
export function notifySummaryDocumentDeleted(event: SummaryDocumentDeleted): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      // A cache that failed to forget is a stale `duplicate` at worst; the
      // route's answer about the delete stays truthful. Logged, because that
      // stale answer is exactly the symptom this signal exists to remove.
      log.error("A summary-document-deleted listener threw for {collection}/{id}: {error}", {
        collection: event.collection,
        id: event.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
