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
import { normalizeRel } from "./wiki-nav.ts";

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

export type SeriesPoster = (body: SeriesWrite & { baseHash: string; batch?: "defer" | "last" }) => Promise<SeriesPostAnswer>;

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
  /** The write that stopped the sequence: no base or a network error
   *  (`status` 0), or refused. */
  failure?: { write: SeriesWrite; status: number; error: string };
}

/** Run `writes` in order against `bases` (relPath as sent → CAS hash),
 *  stopping at the first write with no base or a refused answer. `batch`
 *  marks every write but the last `defer` and the last `last`, so the route
 *  refreshes the index once for the whole sequence (arch review 2026-10,
 *  finding 75); a sequence that stops early leaves the refresh to the caller's
 *  own listing refetch. */
export async function runSeriesWrites(
  writes: readonly SeriesWrite[],
  bases: ReadonlyMap<string, string>,
  post: SeriesPoster,
  opts: { batch?: boolean } = {},
): Promise<SeriesWriteOutcome> {
  const out: SeriesWriteOutcome = { written: 0, total: writes.length, wrote: false, cleared: null, hashes: new Map() };
  for (const [i, write] of writes.entries()) {
    const baseHash = bases.get(write.relPath);
    if (!baseHash) {
      out.failure = { write, status: 0, error: `Could not read ${write.relPath}` };
      return out;
    }
    let res: SeriesPostAnswer;
    try {
      const batch = opts.batch && writes.length > 1 ? (i === writes.length - 1 ? "last" : "defer") : undefined;
      res = await post({ ...write, baseHash, ...(batch ? { batch } : {}) });
    } catch (err) {
      // A rejected fetch (network down, connection reset) is a failed write.
      out.failure = { write, status: 0, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
      return out;
    }
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

/** The open page as the reader loaded it: its relPath and the hash it loaded
 *  with. Both callers snapshot it before reading the bases. */
export interface OpenPageAtLoad {
  relPath: string | null;
  loadedHash: string | null;
}

/** The open page, named as `bases` holds it, when its fresh base is not the
 *  hash the reader loaded (arch review 2026-10, finding 66); `null` when it is
 *  the same, has no fresh base, or no hash was loaded. */
export function openPageChanged(open: OpenPageAtLoad, bases: ReadonlyMap<string, string>): string | null {
  if (!open.relPath || !open.loadedHash) return null;
  const rel = normalizeRel(open.relPath);
  for (const [k, hash] of bases) if (normalizeRel(k) === rel && hash !== open.loadedHash) return k;
  return null;
}

/** The refusal {@link writeSeriesUnlessOpenChanged} makes before
 *  any write (arch review 2026-10, finding 66): the open page changed on disk
 *  since the reader loaded it AND the sequence writes it ⇒ write nothing and
 *  say so. `null` ⇒ proceed. An open page outside the writes is not this
 *  sequence's to refuse. */
export function openPageRefusal(
  openChanged: string | null,
  writes: readonly { relPath: string }[],
): string | null {
  if (!openChanged) return null;
  const open = normalizeRel(openChanged);
  if (!writes.some((w) => normalizeRel(w.relPath) === open)) return null;
  return `${openChanged} changed since you opened it — reload it; nothing written`;
}

/** The one write entry both callers use — the `⋯` menu and Save as series:
 *  refuse the whole sequence when the open page changed since it loaded and
 *  is among the writes (`openPageChanged`, `openPageRefusal`), else run it.
 *  `bases` are the ones read FRESH before the call, the open page included. */
export async function writeSeriesUnlessOpenChanged(input: {
  writes: readonly SeriesWrite[];
  bases: ReadonlyMap<string, string>;
  open: OpenPageAtLoad;
  post: SeriesPoster;
  batch?: boolean;
}): Promise<{ refusal: string; run?: undefined } | { refusal: null; run: SeriesWriteOutcome }> {
  const refusal = openPageRefusal(openPageChanged(input.open, input.bases), input.writes);
  if (refusal) return { refusal };
  return { refusal: null, run: await runSeriesWrites(input.writes, input.bases, input.post, { batch: input.batch }) };
}
