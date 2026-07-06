/**
 * Summary-source registry.
 *
 * The unified "Summaries" dashboard page lists AI summaries of external content
 * (YouTube videos, X articles, …) merged into one browse view. Each summary
 * source is one entry here — that's the single place to add a new source.
 *
 * Used on both sides of the wire:
 *  - server (summaries-routes.ts): `collection` drives the merged documents fetch
 *  - client (the page script): `apiBase`, `badge`, `linkLabel` drive per-source
 *    document/similar/stream/jobs calls, the row badge, and the "open original"
 *    link. A minimal JSON projection is injected into the page via
 *    `clientSourcesJson()`.
 *
 * Adding a source = add an entry here + a routes module that calls
 * `registerSummaryVertical()` (dashboard/routes/summary-vertical.ts) for the
 * shared plumbing (stream/jobs/document/similar/CORS/redirect) plus its own
 * bespoke `POST <apiBase>/summarize` handler, a job store instantiated from
 * `createJobStore()` (summaries/job-store.ts), and an ingest collection in
 * huginn. youtube-routes.ts is the smallest worked example.
 */

export interface SummarySource {
  /** Stable id — used in `?source=` and as the per-doc `source` tag. */
  id: string;
  /** Human label (source filter chip). */
  label: string;
  /** Short badge text shown on each summary row. */
  badge: string;
  /** Knowledge API collection name (server-side merged fetch). */
  collection: string;
  /** Client API prefix for document/similar/stream/jobs/summarize calls. */
  apiBase: string;
  /** Link text for the "open original" anchor on a row (when the doc has a url). */
  linkLabel: string;
}

export const SUMMARY_SOURCES: SummarySource[] = [
  {
    id: "youtube",
    label: "YouTube",
    badge: "YouTube",
    collection: "youtube-summaries",
    apiBase: "/api/youtube",
    linkLabel: "YouTube ↗",
  },
  {
    id: "x-article",
    label: "X",
    badge: "X",
    collection: "x-articles",
    apiBase: "/api/x-articles",
    linkLabel: "View on X ↗",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    badge: "Claude",
    collection: "anthropic-summaries",
    apiBase: "/api/anthropic",
    linkLabel: "Read on docs ↗",
  },
  {
    id: "tiktok",
    label: "TikTok",
    badge: "TikTok",
    collection: "tiktok-summaries",
    apiBase: "/api/tiktok",
    linkLabel: "View on TikTok ↗",
  },
];

export function getSummarySource(id: string): SummarySource | undefined {
  return SUMMARY_SOURCES.find((s) => s.id === id);
}

/**
 * Minimal registry projection for the browser. Keyed by source id so client
 * code can do `SOURCES[doc.source].apiBase` without a lookup helper.
 */
export function clientSourcesJson(): string {
  const map: Record<string, { label: string; badge: string; apiBase: string; linkLabel: string }> = {};
  for (const s of SUMMARY_SOURCES) {
    map[s.id] = { label: s.label, badge: s.badge, apiBase: s.apiBase, linkLabel: s.linkLabel };
  }
  return JSON.stringify(map);
}
