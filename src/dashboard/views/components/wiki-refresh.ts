/**
 * Pure, DOM-free helpers for the /wiki reader's **focus refetch** — the throttle
 * and the apply/defer decision behind re-pulling `/api/wiki/pages` when a
 * long-open tab comes back to the foreground.
 *
 * Split out of `wiki-browser.ts` (which runs DOM code at module load, so it can't
 * be imported in tests) for the same reason as `wiki-explain.ts` and
 * `wiki-ask-render.ts`: the decision logic is the part worth testing, and it has
 * nothing to do with the DOM.
 *
 * The rule the model encodes: a fresh page set may only land while the reader is
 * on the browse/start view. A page set applied under an OPEN ARTICLE would
 * re-sort the left list out from under someone who is reading — so it is stashed
 * and applied on the next return to the start view (or the next navigation),
 * exactly once.
 */

/** Floor between two `/api/wiki/pages` fetches. A tab that is alt-tabbed in and
 *  out repeatedly must not hammer the route (the server re-scans the wiki index
 *  behind it), and the listing simply does not change fast enough to warrant a
 *  tighter window. Counted from the last fetch that was STARTED, including the
 *  boot load. */
export const WIKI_REFETCH_MIN_INTERVAL_MS = 30_000;

/**
 * What the reader's middle pane is showing:
 * - `start`   — the browse/start view (hubs / timeline / atlas + the page list)
 * - `article` — a wiki page is open
 * - `answer`  — an Ask / Explain / Fact-check answer is painted in the pane
 *
 * Only `start` is a safe moment to re-sort the list: the other two mean someone
 * is reading something in the pane beside it.
 */
export type WikiViewState = "start" | "article" | "answer";

/** Refetch bookkeeping: when the last fetch went out, and any payload that
 *  arrived while the reader was busy and is waiting to be applied. */
export interface PagesRefreshModel<T> {
  /** Epoch ms of the last fetch STARTED (boot load included). */
  lastFetchAt: number;
  /** Fresh payload stashed while the reader had something open; null when none. */
  pending: T | null;
}

export function createRefreshModel<T>(lastFetchAt = 0): PagesRefreshModel<T> {
  return { lastFetchAt, pending: null };
}

/** Throttle gate — true once `minIntervalMs` has fully elapsed since the last
 *  fetch. The boundary is inclusive (exactly `minIntervalMs` later ⇒ allowed). */
export function shouldRefetch<T>(
  model: PagesRefreshModel<T>,
  now: number,
  minIntervalMs: number = WIKI_REFETCH_MIN_INTERVAL_MS,
): boolean {
  return now - model.lastFetchAt >= minIntervalMs;
}

/** Stamp a fetch as started. Called when the request goes out, not when it
 *  lands, so a slow/hung request can't open the gate for a pile-up behind it. */
export function markFetched<T>(model: PagesRefreshModel<T>, now: number): void {
  model.lastFetchAt = now;
}

/** The apply/defer decision, by view state alone. */
export function shouldApplyNow(view: WikiViewState): boolean {
  return view === "start";
}

/**
 * Fold an arrived payload into the model: `apply` (the caller should adopt it
 * now) or `defer` (it has been stashed on `model.pending`).
 *
 * A stashed payload is REPLACED by a newer one — the reader only ever wants the
 * freshest listing, and the older one has no value once superseded. An `apply`
 * likewise clears any stash: the caller is adopting something at least as fresh.
 */
export function receivePages<T>(
  model: PagesRefreshModel<T>,
  data: T,
  view: WikiViewState,
): "apply" | "defer" {
  if (shouldApplyNow(view)) {
    model.pending = null;
    return "apply";
  }
  model.pending = data;
  return "defer";
}

/** Take the stashed payload, clearing it — so a deferred page set is applied
 *  exactly once no matter how many view transitions call this. */
export function takePending<T>(model: PagesRefreshModel<T>): T | null {
  const pending = model.pending;
  model.pending = null;
  return pending;
}
