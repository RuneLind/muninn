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

/**
 * The longest a series request (the base GET, the POST) or a base read's wait
 * for the reader's own writes runs before the reader is told and the popover
 * is free again. Bun does not cut a hung request at its `idleTimeout`
 * (`src/wiki/CLAUDE.md`), and an unbounded wait here left every later ⋯ stuck
 * on "Saving…". 30 s is three times the 10 s the server's own bounded fetches
 * use (`BOUNDED_FETCH_TIMEOUT_MS`), because one POST may wait out the 2 s
 * cross-process lock (`WIKI_LOCK_WAIT_MS`), rebuild the index and commit.
 */
export const SERIES_REQUEST_TIMEOUT_MS = 30_000;

/** What a write says when the reader's earlier save has not answered within
 *  {@link SERIES_REQUEST_TIMEOUT_MS}: nothing is sent under bases read while
 *  that save may still move the page. */
export const SERIES_STALLED_COPY =
  "An earlier series save has not answered yet — nothing written. Close and reopen this menu in a moment, or reload the page";

/** What a POST that got no answer within the bound says. The server may have
 *  written the page, so the step is to look. */
export function seriesTimeoutCopy(relPath: string): string {
  return `No answer for ${relPath} after ${SERIES_REQUEST_TIMEOUT_MS / 1000} s — it may have been written; reload the page to see`;
}

/** `p`, or `fallback` when `p` has not settled within `ms`. For an await the
 *  series writers hold a popover on that is not a request of their own (the
 *  listing refresh after a write): `p` still runs and lands as it would. */
export async function withinSeriesBound<T>(p: Promise<T>, fallback: T, ms = SERIES_REQUEST_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((r) => (timer = setTimeout(() => r(fallback), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

const isTimeout = (err: unknown): boolean => (err as { name?: unknown } | null)?.name === "TimeoutError";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
interface RequestOpts {
  fetch?: FetchLike;
  timeoutMs?: number;
}

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
async function runSeriesWrites(
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
      // A rejected fetch (network down, connection reset, no answer within
      // the bound) is a failed write.
      const error = isTimeout(err) ? seriesTimeoutCopy(write.relPath) : `Network error: ${err instanceof Error ? err.message : String(err)}`;
      out.failure = { write, status: 0, error };
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
 *  refuse the whole sequence when its base read gave up waiting for an earlier
 *  save (`stalled`, {@link SERIES_STALLED_COPY}), or when the open page changed
 *  since it loaded and is among the writes (`openPageChanged`,
 *  `openPageRefusal`), else run it. `bases` are the ones read FRESH before the
 *  call, the open page included. */
export async function writeSeriesUnlessOpenChanged(input: {
  writes: readonly SeriesWrite[];
  bases: ReadonlyMap<string, string>;
  open: OpenPageAtLoad;
  post: SeriesPoster;
  batch?: boolean;
  stalled?: boolean;
}): Promise<{ refusal: string; run?: undefined } | { refusal: null; run: SeriesWriteOutcome }> {
  if (input.stalled) return { refusal: SERIES_STALLED_COPY };
  const refusal = openPageRefusal(openPageChanged(input.open, input.bases), input.writes);
  if (refusal) return { refusal };
  return { refusal: null, run: await runSeriesWrites(input.writes, input.bases, input.post, { batch: input.batch }) };
}

/** What a 409 on `failedRel` says, and what the next click on the same menu
 *  says (`again`). The step follows the page. A reopened menu reads every base
 *  fresh, the open page's included, but keeps the open page's LOAD-time hash;
 *  at the click, a verb that writes the open page compares the two and is
 *  refused ({@link openPageRefusal}) — so for the OPEN page reloading is the
 *  step. Any other page's fresh base is what the next write sends, so
 *  reopening is. */
export function seriesConflictCopy(failedRel: string, openRel: string | null): { note: string; again: string } {
  return openRel && normalizeRel(openRel) === normalizeRel(failedRel)
    ? { note: `${failedRel} changed since this menu opened — reload it`, again: "Reload the page — it has changed" }
    : { note: `${failedRel} changed since this menu opened — close and reopen it`, again: "Close and reopen this menu — the page has changed" };
}

/** The series write sequences in flight, each as a promise that settles (never
 *  rejects) once the caller's sequence has finished. */
const writesInFlight = new Set<Promise<void>>();

/** How many sequences are in flight — the set must empty once each settles,
 *  late or not (`wiki-series-write.test.ts`). */
export function seriesWritesInFlight(): number {
  return writesInFlight.size;
}

/** Run `fn` — one caller's write sequence, from the click until its answers
 *  have moved the reader's load-time hash — as a sequence every base read
 *  started meanwhile waits for ({@link readSeriesBasesAfterWrites}). Returns
 *  `fn`'s own result or rejection. */
export function trackSeriesWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = fn();
  const settled: Promise<void> = run.then(
    () => { writesInFlight.delete(settled); },
    () => { writesInFlight.delete(settled); },
  );
  writesInFlight.add(settled);
  return run;
}

/** Read the bases both series writers send, and the open-page snapshot they
 *  compare with, AFTER every write sequence in flight when the read starts
 *  (fix round 2, finding 1): the reader's own write moves the open page's bytes
 *  before its answer moves the load-time hash, so a snapshot taken in between
 *  blames the reader for their own change. The snapshot is taken before the
 *  base fetch, so a page that moves during it reads as changed, never the
 *  reverse. A sequence that starts later is not waited for, so a sequence may
 *  await a read it started before.
 *
 *  The wait is bounded (`waitMs`, {@link SERIES_REQUEST_TIMEOUT_MS}): past it
 *  the read is `stalled`, reads nothing and hands back no base, so a write
 *  from it is refused ({@link writeSeriesUnlessOpenChanged}) rather than sent
 *  under a base the unanswered save may still move. A sequence that settles
 *  later leaves the in-flight set as any other does. */
export async function readSeriesBasesAfterWrites(
  relPaths: readonly string[],
  hashOf: (relPath: string) => Promise<string | null>,
  openNow: () => OpenPageAtLoad,
  opts: { waitMs?: number } = {},
): Promise<{ bases: Map<string, string>; missing: string[]; open: OpenPageAtLoad; stalled: boolean }> {
  const pending = [...writesInFlight];
  if (pending.length) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      Promise.all(pending).then(() => true),
      new Promise<false>((r) => (timer = setTimeout(() => r(false), opts.waitMs ?? SERIES_REQUEST_TIMEOUT_MS))),
    ]);
    clearTimeout(timer);
    if (!settled) {
      return { bases: new Map(), missing: [...new Set(relPaths)].sort(), open: { relPath: null, loadedHash: null }, stalled: true };
    }
  }
  const open = openNow();
  const { bases, missing } = await loadSeriesBaseMap(relPaths, hashOf);
  return { bases, missing, open, stalled: false };
}

/** The page's current content hash — the CAS base — read through `urlOf`
 *  under the bound. `null` when it cannot be read: an error status or body, a
 *  network error, or no answer in time; the caller writes nothing then. */
export function seriesBaseReader(
  urlOf: (relPath: string) => string,
  opts: RequestOpts = {},
): (relPath: string) => Promise<string | null> {
  const f = opts.fetch ?? ((u, i) => fetch(u, i));
  const ms = opts.timeoutMs ?? SERIES_REQUEST_TIMEOUT_MS;
  return async (relPath) => {
    try {
      const res = await f(urlOf(relPath), { signal: AbortSignal.timeout(ms) });
      const data = (await res.json()) as { hash?: unknown };
      return typeof data.hash === "string" && data.hash ? data.hash : null;
    } catch {
      return null;
    }
  };
}

/** `POST /api/wiki/series` for one page, under the bound. The wiki rides the
 *  BODY, not the query — the Stamp route's contract, and the reason the route
 *  reads one place: a write must name its target in the payload it is
 *  validated against, never in a string the client happened to append. A
 *  request with no answer in time rejects with a `TimeoutError`, which the
 *  loop reports as {@link seriesTimeoutCopy}. */
export function seriesPoster(wiki: string, opts: RequestOpts = {}): SeriesPoster {
  const f = opts.fetch ?? ((u, i) => fetch(u, i));
  const ms = opts.timeoutMs ?? SERIES_REQUEST_TIMEOUT_MS;
  return async (write) => {
    const res = await f("/api/wiki/series", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki, ...write }),
      signal: AbortSignal.timeout(ms),
    });
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as SeriesPostAnswer["body"] };
  };
}
