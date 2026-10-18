/**
 * The series editor's WRITE LOOP, out of the popover's state so two callers
 * share it: the `⋯` series menu (`applySeriesWrites` in `wiki-browser.ts`) and
 * the Work threads' Save as series (plan `muninn-wiki-work-thread-grouping`,
 * D14). DOM-free: the caller hands in the CAS bases it fetched FIRST and a
 * poster for `POST /api/wiki/series`, so the loop is unit-testable.
 *
 * One page per call, in order, stopping at the FIRST failure: `writeWikiPage`
 * is one file per call and the wiki has no rollback, so a written page stays
 * written and the outcome says how far the sequence got (`written` of
 * `total`) and which write failed.
 */

import type { SeriesWrite } from "./wiki-series-menu.ts";

/** What `POST /api/wiki/series` answers, as the loop reads it. */
export interface SeriesPostAnswer {
  ok: boolean;
  status: number;
  body: {
    error?: string;
    hash?: string;
    written?: boolean;
    clearedLabel?: { series?: string; label?: string };
  } | null;
}

export type SeriesPoster = (body: SeriesWrite & { baseHash: string }) => Promise<SeriesPostAnswer>;

export interface SeriesWriteOutcome {
  /** Writes that landed (an all-noop answer counts: the route accepted it). */
  written: number;
  total: number;
  /** Did any answer report bytes moved? An answer with no `written` is a write. */
  wrote: boolean;
  /** The series a move left without a label, when the route reported one. */
  cleared: string | null;
  /** The page hash each landed write answered, by relPath as sent. */
  hashes: Map<string, string>;
  /** The write that stopped the sequence: no base (`status` 0), or refused. */
  failure?: { write: SeriesWrite; status: number; error: string };
}

/** Run `writes` in order against `bases` (relPath as sent → CAS hash),
 *  stopping at the first write with no base or a refused answer. */
export async function runSeriesWrites(writes: readonly SeriesWrite[], bases: ReadonlyMap<string, string>, post: SeriesPoster): Promise<SeriesWriteOutcome> {
  const out: SeriesWriteOutcome = { written: 0, total: writes.length, wrote: false, cleared: null, hashes: new Map() };
  for (const write of writes) {
    const baseHash = bases.get(write.relPath);
    if (!baseHash) {
      out.failure = { write, status: 0, error: `Could not read ${write.relPath}` };
      return out;
    }
    const res = await post({ ...write, baseHash });
    if (!res.ok) {
      out.failure = { write, status: res.status, error: res.body?.error || `Write refused (${res.status})` };
      return out;
    }
    out.written++;
    if (typeof res.body?.hash === "string") out.hashes.set(write.relPath, res.body.hash);
    const dropped = res.body?.clearedLabel?.series;
    if (typeof dropped === "string" && dropped) out.cleared = dropped;
    if (res.body?.written !== false) out.wrote = true;
  }
  return out;
}

/** Fetch every page's CAS base before any write (D14: bases first). Pages
 *  whose base could not be read are listed in `missing`; the caller writes
 *  nothing then. */
export async function loadSeriesBaseMap(
  relPaths: readonly string[],
  hashOf: (relPath: string) => Promise<string | null>,
): Promise<{ bases: Map<string, string>; missing: string[] }> {
  const bases = new Map<string, string>();
  const missing: string[] = [];
  await Promise.all(
    [...new Set(relPaths)].map(async (rel) => {
      const h = await hashOf(rel);
      if (h) bases.set(rel, h);
      else missing.push(rel);
    }),
  );
  missing.sort();
  return { bases, missing };
}
