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
  /**
   * Can `POST /api/summaries/rerun` act on this source? (Absent ⇒ no.)
   *
   * The doc panel's `↻ Re-run ▾` control is rendered from this flag, which is
   * why it is a field on the registry rather than a list of its own: the panel
   * already reads `SOURCES[source]`, and a second array of four strings is a
   * second place for the answer to be wrong. `summaries-rerun.ts` asserts at
   * load that its per-vertical table names exactly the sources flagged here.
   *
   * `x-article` is flagged for its VIDEO documents: an X video capture stores a
   * transcript, a pasted X article does not, so the route's own `no_transcript`
   * refusal is what tells the two apart — the client does not have to.
   */
  rerun?: boolean;
}

export const SUMMARY_SOURCES: SummarySource[] = [
  {
    id: "youtube",
    label: "YouTube",
    badge: "YouTube",
    collection: "youtube-summaries",
    apiBase: "/api/youtube",
    linkLabel: "YouTube ↗",
    rerun: true,
  },
  {
    id: "x-article",
    label: "X",
    badge: "X",
    collection: "x-articles",
    apiBase: "/api/x-articles",
    linkLabel: "View on X ↗",
    rerun: true,
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
    rerun: true,
  },
  {
    id: "article",
    label: "Articles",
    badge: "Article",
    collection: "article-summaries",
    apiBase: "/api/articles",
    linkLabel: "Open original ↗",
  },
  {
    id: "vimeo",
    label: "Vimeo",
    badge: "Vimeo",
    collection: "vimeo-summaries",
    apiBase: "/api/vimeo",
    linkLabel: "Watch on Vimeo ↗",
    rerun: true,
  },
];

/**
 * A huginn doc id is a path (`<category>/<title>.md`), and the routes that
 * take one interpolate it segment-encoded into `/api/document/<collection>/…`.
 * `encodeURIComponent("..")` is `..`, and `fetch` collapses dot segments, so a
 * `..` popped the COLLECTION out of the path — measured, `?docId=../mimir/x.md`
 * on the vimeo source served a mimir page. A dot segment or an empty one is
 * never a real id; refuse before the fetch.
 */
export function isSafeDocId(docId: string): boolean {
  if (!docId) return false;
  return docId.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function getSummarySource(id: string): SummarySource | undefined {
  return SUMMARY_SOURCES.find((s) => s.id === id);
}

/**
 * A doc id as ONE path fragment of a huginn document URL: every `/` kept as a
 * separator, everything inside a segment percent-encoded.
 *
 * The bare interpolation this replaces truncates at `#`, and a real id carries
 * `/`, spaces and non-ASCII. It lived as three byte-identical copies — the
 * share adapter, the export route and the re-run route — which is three places
 * for one rule to be forgotten. Not a safety gate: {@link isSafeDocId} is, and
 * every caller runs it first.
 */
export function encodeDocIdPath(docId: string): string {
  return docId.split("/").map(encodeURIComponent).join("/");
}

/**
 * Minimal registry projection for the browser. Keyed by source id so client
 * code can do `SOURCES[doc.source].apiBase` without a lookup helper.
 */
export function clientSourcesJson(): string {
  const map: Record<
    string,
    {
      label: string;
      badge: string;
      apiBase: string;
      linkLabel: string;
      collection: string;
      rerun: boolean;
    }
  > = {};
  for (const s of SUMMARY_SOURCES) {
    // `collection` is what the doc panel's 🗑 Delete posts to the gardener's
    // backlog-doc-delete route, which is keyed on the huginn collection, not the
    // source id (the two diverge: `x-article` → `x-articles`).
    //
    // `rerun` is projected as a real boolean rather than passed through as
    // `true | undefined`: the panel reads `SOURCES[source].rerun` directly, and
    // an absent key and `false` are the same answer there.
    map[s.id] = {
      label: s.label,
      badge: s.badge,
      apiBase: s.apiBase,
      linkLabel: s.linkLabel,
      collection: s.collection,
      rerun: s.rerun === true,
    };
  }
  return JSON.stringify(map);
}
