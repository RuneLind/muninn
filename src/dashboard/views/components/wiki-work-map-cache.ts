/**
 * The one work-map cache the Your work card, the rail and the effort page
 * share, keyed on the listing's run time, and the rail's effort index (P4)
 * built from it. DOM-free, and it imports neither the rail nor the effort
 * controller: the rail reads it directly instead of through `RailDeps`, and
 * a repaint arrives as a callback (mimir plan muninn-wiki-browser-split,
 * follow-up). This module is the cache's only writer.
 */
import type { WorkMapGetBody } from "./wiki-work-card.ts";
import type { AnyWorkMap } from "../../../wiki/work-map/join.ts";
import { railEffortIndex, type RailEffort } from "./wiki-effort-rail.ts";
import { effortUrl } from "./wiki-effort-page.ts";
import { urlWithJira, urlWithProject, type WikiFilters, type WikiListing } from "./wiki-filter.ts";
import { getWorkMapRunAt, setWorkMapRunAt } from "./wiki-shell-state.ts";

export type WorkMapGet = { ok: boolean; status: number; body: WorkMapGetBody | null };
type CachedMap = { runAt: number; body: WorkMapGetBody & { map: AnyWorkMap } };

/** The cached map, keyed on the run time it was fetched for. */
let workMapCache: CachedMap | null = null;
/** The map GET in flight and the run time it was started for: a repaint while
 *  it runs (a facet change, an adopt) waits on it instead of sending another. */
let effortMapFetch: { runAt: number; done: Promise<WorkMapGet> } | null = null;
/** The run time whose map GET failed for the rail, so a repaint does not
 *  re-fetch on every render; a new run time (or a reload) tries again. */
let railMapFailedAt: number | null = null;
/** The run time the rail is waiting on a map GET for (one listener per GET). */
let railMapPending: number | null = null;
/** The last effort index the rail built, and what it was built from. */
let railEffortMemo: { map: AnyWorkMap; pages: WikiListing[]; index: Map<string, RailEffort> } | null = null;

export function getWorkMapCache(): CachedMap | null {
  return workMapCache;
}

export function getRailMapFailedAt(): number | null {
  return railMapFailedAt;
}

export function getWorkMap(withWiki: (url: string) => string): Promise<WorkMapGet> {
  return fetch(withWiki("/api/wiki/work-map")).then(async (r) => ({
    ok: r.ok,
    status: r.status,
    body: (await r.json().catch(() => null)) as WorkMapGetBody | null,
  }));
}

/** The map for one run time: the cache, else the GET in flight, else a new
 *  GET whose map lands in the cache. A failed GET is not cached. */
export function workMapFetchFor(runAt: number, withWiki: (url: string) => string): Promise<WorkMapGet> {
  if (workMapCache?.runAt === runAt) return Promise.resolve({ ok: true, status: 200, body: workMapCache.body });
  if (effortMapFetch?.runAt !== runAt) {
    const done = getWorkMap(withWiki).then((r) => {
      if (r.ok && r.body?.map && getWorkMapRunAt() === runAt) workMapCache = { runAt, body: r.body as CachedMap["body"] };
      return r;
    });
    const entry = { runAt, done };
    effortMapFetch = entry;
    const clear = () => {
      if (effortMapFetch === entry) effortMapFetch = null;
    };
    done.then(clear, clear);
  }
  return effortMapFetch!.done;
}

/** A map newer than the listing's run becomes the run time and the cache;
 *  `false` (nothing changed) for an older or same run, or no listing run yet. */
export function adoptIfNewer(body: WorkMapGetBody): boolean {
  const runAt = getWorkMapRunAt();
  if (!body.map || runAt === null || body.map.runAtMs <= runAt) return false;
  setWorkMapRunAt(body.map.runAtMs);
  workMapCache = { runAt: body.map.runAtMs, body: body as CachedMap["body"] };
  return true;
}

/**
 * The rail's effort index (P4), or null: no map on this wiki, the map not
 * loaded yet (the GET starts here and `repaint` runs when it lands, so
 * Activity draws plain until then), or a failed GET. `pages` is compared by
 * identity for the memo, so pass the listing array itself, not a copy.
 */
export function railEffortsIndex(
  now: number,
  pages: WikiListing[],
  withWiki: (url: string) => string,
  repaint: () => void,
): Map<string, RailEffort> | null {
  const runAt = getWorkMapRunAt();
  if (runAt === null) return null;
  const map = workMapCache?.runAt === runAt ? workMapCache.body.map : null;
  if (!map) {
    if (railMapFailedAt !== runAt && railMapPending !== runAt) {
      railMapPending = runAt;
      const settle = () => {
        if (railMapPending === runAt) railMapPending = null;
      };
      workMapFetchFor(runAt, withWiki)
        .then((r) => {
          settle();
          if (getWorkMapRunAt() !== runAt) return;
          // X1: a failed GET repaints too, so the rail stops waiting and draws Work threads.
          if (!r.ok || !r.body?.map) railMapFailedAt = runAt;
          repaint();
        })
        .catch(() => {
          settle();
          if (getWorkMapRunAt() !== runAt) return;
          railMapFailedAt = runAt;
          repaint();
        });
    }
    return null;
  }
  if (railEffortMemo?.map !== map || railEffortMemo.pages !== pages) {
    railEffortMemo = { map, pages, index: railEffortIndex(map, pages, now) };
  }
  return railEffortMemo.index;
}

/** An effort's reader URL, carrying the facets an article URL carries. */
export function effortHrefFor(wiki: string, filters: WikiFilters, id: string): string {
  return urlWithJira(urlWithProject(effortUrl(wiki, id), filters.project), filters.jira);
}
