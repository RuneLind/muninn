/**
 * DOM-free helpers for the /wiki reader's **listing refresh** — the throttle, the
 * request-ordering guard, the apply/defer decision and the two "don't adopt this"
 * guards behind re-pulling `/api/wiki/pages` while a tab stays open.
 *
 * Split out of `wiki-browser.ts` (which runs DOM code at module load, so it can't
 * be imported in tests) for the same reason as `wiki-explain.ts` and
 * `wiki-ask-render.ts`: the decision logic is the part worth testing, and it has
 * nothing to do with the DOM. NB the helpers MUTATE the model they are handed —
 * "DOM-free", not "pure".
 *
 * The rules the model encodes:
 * - a fresh page set may only land while the reader is on the browse/start view.
 *   Applied under an OPEN ARTICLE it would re-sort the left list out from under
 *   someone who is reading — so it is stashed and applied on the next return to
 *   the start view (or the next navigation), exactly once;
 * - responses are adopted in ISSUE order. Every request carries a sequence
 *   number and a response older than one already folded in is dropped, so a slow
 *   boot fetch can't revert a newer refetch's data;
 * - a refetch never replaces a non-empty listing with an empty one, and never
 *   re-adopts a payload byte-identical (modulo `scannedAt`) to the one on screen.
 */

import type { WikiListing } from "./wiki-filter.ts";

/** The `/api/wiki/pages` payload (mirrors `src/dashboard/routes/wiki-routes.ts`).
 *  It lives here rather than in `wiki-browser.ts` so this module can name it
 *  concretely instead of carrying a single-use type parameter. */
export interface WikiPagesResponse {
  pages: WikiListing[];
  scannedAt: number | null;
  types?: { order: string[]; labels: Record<string, string> };
  error?: string;
}

/** Floor between two `/api/wiki/pages` fetches. A tab that is alt-tabbed in and
 *  out repeatedly must not hammer the route (a focus refetch asks the server to
 *  re-scan the wiki index behind it), and the listing simply does not change fast
 *  enough to warrant a tighter window. Counted from the last fetch that was
 *  STARTED, including the boot load. */
export const WIKI_REFETCH_MIN_INTERVAL_MS = 30_000;

/**
 * Heartbeat for the never-blurred tab. A `/wiki` left visible on a second monitor
 * fires neither `focus` nor `visibilitychange` — the canonical hours-stale tab is
 * exactly the one the event-driven path can never reach. This tick runs through
 * the same throttle gate, but issues the PLAIN fetch: idle drift is well served by
 * the server's own index TTL, and `refresh=1` stays reserved for a user actively
 * returning to the tab.
 */
export const WIKI_REFETCH_TICK_MS = 5 * 60_000;

/**
 * What the reader's middle pane is showing:
 * - `start`   — the browse/start view (hubs / timeline / atlas + the page list)
 * - `article` — a wiki page is open, or one is being fetched
 * - `answer`  — an Ask / Explain / Fact-check answer is painted in the pane
 *
 * Only `start` is a safe moment to re-sort the list: the other two mean someone
 * is reading something in the pane beside it.
 */
export type WikiViewState = "start" | "article" | "answer";

/**
 * Derive the view state from the three signals `wiki-browser.ts` holds.
 *
 * `article` beats `answer` (an open page owns the pane even if a stale answer
 * body is still in the DOM), and an in-flight navigation counts as `article`
 * even though `currentName` is not set yet: `loadPage` only learns the name from
 * the response, so a refetch resolving mid-click would otherwise read `start` and
 * re-sort the list under the row the user just clicked.
 */
export function viewStateOf(
  currentName: string | null,
  navInFlight: boolean,
  hasAnswerBody: boolean,
): WikiViewState {
  if (currentName !== null || navInFlight) return "article";
  if (hasAnswerBody) return "answer";
  return "start";
}

/** A payload stashed while the reader was busy, with the fingerprint it was
 *  received under (so applying it later still updates the skip-if-unchanged key). */
export interface PendingPages {
  data: WikiPagesResponse;
  fingerprint: string;
}

/** Refresh bookkeeping: throttle stamp, request ordering, the stash, and what the
 *  screen currently holds. */
export interface PagesRefreshModel {
  /** Epoch ms of the last fetch STARTED (boot load included). */
  lastFetchAt: number;
  /** Sequence number of the last request ISSUED. */
  seq: number;
  /** Sequence number of the newest response already folded in — anything older
   *  that lands afterwards is dropped. */
  lastSeenSeq: number;
  /** Fresh payload stashed while the reader had something open; null when none. */
  pending: PendingPages | null;
  /** True once a payload has been adopted through the full boot render path.
   *  While false the next successful adopt must run that path (a boot that failed
   *  left an error pane and no facets — half-healing it populates the list beside
   *  a permanent error). */
  bootRendered: boolean;
  /** Page count of the last adopted set — the zero-page guard's referent. */
  appliedCount: number;
  /** Fingerprint of the last adopted payload; null before the first adopt. */
  appliedKey: string | null;
}

export function createRefreshModel(lastFetchAt = 0): PagesRefreshModel {
  return {
    lastFetchAt,
    seq: 0,
    lastSeenSeq: 0,
    pending: null,
    bootRendered: false,
    appliedCount: 0,
    appliedKey: null,
  };
}

/** Throttle gate — true once `WIKI_REFETCH_MIN_INTERVAL_MS` has fully elapsed
 *  since the last fetch. The boundary is inclusive (exactly one interval later ⇒
 *  allowed). */
export function shouldRefetch(model: PagesRefreshModel, now: number): boolean {
  return now - model.lastFetchAt >= WIKI_REFETCH_MIN_INTERVAL_MS;
}

/** Issue a request: stamp the throttle and take the next sequence number.
 *  Stamped when the request goes out, not when it lands, so a slow/hung request
 *  can't open the gate for a pile-up behind it. */
export function startFetch(model: PagesRefreshModel, now: number): number {
  model.lastFetchAt = now;
  model.seq += 1;
  return model.seq;
}

/** The apply/defer decision, by view state alone. */
export function shouldApplyNow(view: WikiViewState): boolean {
  return view === "start";
}

/**
 * Cheap "did anything but the scan instant change?" key over the RAW response
 * text. A focus refetch sends `refresh=1`, so `scannedAt` is re-stamped on every
 * response and the raw bytes always differ; neutralise that one field and the
 * rest of the string IS the page set. Deliberately dumb — one string compare, no
 * parsing, no hashing (measured: 9 of 10 refetches were byte-identical 481 KB
 * payloads re-rendering 953 rows for nothing).
 */
export function pagesFingerprint(text: string): string {
  return text.replace(/"scannedAt":\s*-?\d+(?:\.\d+)?/g, '"scannedAt":0');
}

/** Everything `receivePages` needs about an arrived response. */
export interface ReceivedPages {
  data: WikiPagesResponse;
  view: WikiViewState;
  /** The sequence number `startFetch` returned for THIS request. */
  seq: number;
  fingerprint: string;
}

/**
 * What the caller should do with an arrived payload:
 * - `apply`     — adopt it now
 * - `defer`     — stashed on `model.pending`, apply at the next return/navigation
 * - `stale`     — a newer response was already folded in; drop this one
 * - `empty`     — degraded/empty set that must not wipe a populated listing
 * - `unchanged` — byte-identical (modulo `scannedAt`) to what is already on screen
 */
export type ReceiveOutcome = "apply" | "defer" | "stale" | "empty" | "unchanged";

/**
 * Fold an arrived payload into the model.
 *
 * A stashed payload is REPLACED by a newer one — the reader only ever wants the
 * freshest listing, and the older one has no value once superseded. An `apply`
 * likewise clears any stash: the caller is adopting something at least as fresh.
 * So does `unchanged`, which is the strongest possible statement that the screen
 * already matches the server.
 */
export function receivePages(model: PagesRefreshModel, input: ReceivedPages): ReceiveOutcome {
  const { data, view, seq, fingerprint } = input;
  // Ordering guard FIRST: a stale response must not touch the stash, the
  // fingerprint, or anything else.
  if (seq <= model.lastSeenSeq) return "stale";
  model.lastSeenSeq = seq;

  // A well-formed but EMPTY set is a real state for a brand-new wiki, and boot
  // renders it — but once a listing is on screen it is far more likely a
  // transient mid-checkout scan than 953 pages actually vanishing. Same for a
  // payload carrying an `error`.
  if (!data.pages.length && (model.appliedCount > 0 || data.error)) return "empty";

  if (model.appliedKey !== null && fingerprint === model.appliedKey) {
    // The freshest response says the screen is already correct, which retires any
    // older stash too. (`scannedAt` is deliberately not re-anchored on this path —
    // it only shifts the future-date guard, and the guard's own 48 h slack
    // swallows the difference.)
    model.pending = null;
    return "unchanged";
  }

  if (shouldApplyNow(view)) {
    model.pending = null;
    return "apply";
  }
  model.pending = { data, fingerprint };
  return "defer";
}

/** Record what the screen now holds, after the caller has actually rendered it. */
export function markApplied(model: PagesRefreshModel, applied: PendingPages): void {
  model.appliedCount = applied.data.pages.length;
  model.appliedKey = applied.fingerprint;
  model.bootRendered = true;
}

/** Take the stashed payload, clearing it — so a deferred page set is applied
 *  exactly once no matter how many view transitions call this. */
export function takePending(model: PagesRefreshModel): PendingPages | null {
  const pending = model.pending;
  model.pending = null;
  return pending;
}
