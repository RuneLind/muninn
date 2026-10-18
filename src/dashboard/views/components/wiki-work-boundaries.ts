/**
 * The reader's own work-thread boundaries (plan
 * `muninn-wiki-work-thread-grouping`, «Manual boundaries and persistence»,
 * D5, D15): page splits (Make own thread) and kept-apart threads (Keep
 * separate), applied to the server's threads BEFORE any grouping. Pure and
 * DOM-free; the reader, the rail input and the replay call it.
 *
 *  - A split page leaves its thread and becomes a thread of its own, with
 *    exactly the sessions whose kept FOCUS contribution is on it in that
 *    thread (`contributions.rows`, never timestamps). A session that focused
 *    both pages is in both.
 *  - The remainder is RECOMPUTED, never patched (D15): its pages are the ones
 *    left, its key the server's rule over them (the earliest non-hub focus
 *    page, by the contributions' `firstMs`), its sessions those with a focus
 *    row on a page left, its touched pages those its sessions touched. It
 *    stays one thread even when the page that bridged it left. An emptied
 *    source thread disappears.
 *  - A kept-apart anchor isolates the thread that holds it AFTER the splits
 *    (`threadHoldsPin`, the pin's own match), so a split-off anchor isolates
 *    the split page and the remainder groups again. Each anchor re-anchors on
 *    the thread's newest focus page, as the pin does (`reanchor`); the record's
 *    state table decides whether that is written.
 *
 * A definition outlives the eight-day window: one whose page no thread holds
 * is DORMANT, one whose path no longer names a page (and no unambiguous alias
 * does) is MISSING or AMBIGUOUS, one that cannot be attributed (contributions
 * incomplete for its thread, or no focus row on the page) is UNRESOLVED, and
 * two splits that land on one page are a CONFLICT, ignored for that page.
 * Every one of them is listed for the Group menu's reset area; none invents a
 * session.
 */

import type { WikiListing } from "./wiki-filter.ts";
import { normalizeRel } from "./wiki-nav.ts";
import { newestFocusPage, threadHoldsPin, usableThreads } from "./wiki-thread-core.ts";
import type { WorkGroupSplit } from "./wiki-work-group-prefs.ts";
import { readWorkEvidence, threadSessionsAvailability, type WorkGroupUnavailableReason, type WorkUnit } from "./wiki-work-groups.ts";
import { isWorkHub, workSessionRef, type IndexWork, type WorkContribution, type WorkThread } from "../../../wiki/work-focus.ts";

/** Where a stored definition stands this render. */
export type BoundaryState =
  /** Applied. */
  | "active"
  /** Its page is in the listing, but no thread holds it as a focus page. */
  | "dormant"
  /** Its path names no page, and no alias names one. */
  | "missing"
  /** Its path names no page, and several pages carry it as an alias. */
  | "ambiguous"
  /** Two split definitions land on one page: neither applies until repaired. */
  | "conflict"
  /** Contributions are incomplete for its thread (`reasons`). */
  | "incomplete"
  /** Its thread holds the page, but no session's kept focus on it is on record. */
  | "unattributed";

export interface BoundaryDefinition {
  kind: "split" | "keptApart";
  /** A split's stable id. */
  id?: string;
  /** The path as stored. */
  stored: string;
  /** The page it resolved to (normalized), when it resolved. */
  page?: string;
  state: BoundaryState;
  reasons?: WorkGroupUnavailableReason[];
}

/** One thread as the reader's boundaries leave it. */
export interface BoundedThread {
  /** Membership after the boundaries: a raw thread unchanged, a recomputed
   *  remainder, or a split page's own thread. */
  thread: WorkThread;
  /** The thread as the server shipped it: what a split page and its remainder
   *  RANK by, so a split follows its source (D16), and whose key the
   *  contribution rows name. */
  source: WorkThread;
  /** The server's array index of the source. */
  index: number;
  /** 0 for the source or its remainder; 1… for its split pages, in the
   *  source's page order. */
  sub: number;
  /** Set on a split page's thread: the definition's id and its page as the
   *  source spells it. */
  split?: { id: string; page: string };
  /** Set on a remainder: the source lost at least one page. */
  remainder?: true;
  /** Set on a thread kept-apart anchors hold: those anchors, as stored. */
  keptApart?: string[];
}

export interface WorkBoundaries {
  /** In the server's order, each source's remainder before its split pages. */
  threads: BoundedThread[];
  /** The same, as the grouping model's units: a split page and a kept-apart
   *  thread are isolated. */
  units: WorkUnit[];
  /** The membership the pin and the Threads stop read. */
  derived: WorkThread[];
  /** thread key → what it ranks by (`rankThreadCards`). */
  rank: Map<string, { rank: WorkThread; sub: number }>;
  /** Every stored definition, with where it stands. */
  definitions: BoundaryDefinition[];
  /** Kept-apart anchors to move: `[stored, newest focus page of its thread]`. */
  reanchor: [string, string][];
}

export interface WorkBoundariesInput {
  work: Partial<Pick<IndexWork, "threads" | "evidence">> | null | undefined;
  allPages: readonly WikiListing[];
  splits: readonly WorkGroupSplit[];
  keptApart: readonly string[];
}

/** The page a stored path names: itself when the listing holds it, else the
 *  ONE page that carries it (or its stem) as an alias. */
function resolverFor(allPages: readonly WikiListing[]): (stored: string) => { page?: string; state?: "missing" | "ambiguous" } {
  const byRel = new Set(allPages.map((p) => normalizeRel(p.relPath)));
  let aliases: Map<string, Set<string>> | null = null;
  const key = (v: string) => normalizeRel(v.trim()).replace(/\.mdx?$/i, "");
  const stemOf = (v: string) => key(v).split("/").pop() ?? "";
  return (stored) => {
    const rel = normalizeRel(stored);
    if (byRel.has(rel)) return { page: rel };
    if (!aliases) {
      aliases = new Map();
      for (const p of allPages)
        for (const a of p.aliases ?? []) {
          if (typeof a !== "string" || !a.trim()) continue;
          const k = key(a);
          const set = aliases.get(k) ?? new Set<string>();
          set.add(normalizeRel(p.relPath));
          aliases.set(k, set);
        }
    }
    const hits = new Set([...(aliases.get(key(stored)) ?? []), ...(aliases.get(stemOf(stored)) ?? [])]);
    if (hits.size === 1) return { page: [...hits][0]! };
    return { state: hits.size ? "ambiguous" : "missing" };
  };
}

/** The remainder's key (D15): the server's rule over the pages left — the
 *  earliest focus event on a non-hub page (a thread of hubs only: on a hub),
 *  a tie on the smaller relPath. */
function remainderKey(pages: readonly string[], rows: readonly WorkContribution[], byRel: ReadonlyMap<string, WikiListing>): string {
  const hub = (rel: string) => isWorkHub(byRel.get(normalizeRel(rel))?.backlinkCount ?? 0);
  const pool = pages.some((p) => !hub(p)) ? pages.filter((p) => !hub(p)) : pages;
  const firstOf = new Map<string, number>();
  for (const [, page, , kind, , firstMs] of rows) {
    if (kind !== "focus") continue;
    const k = normalizeRel(page);
    firstOf.set(k, Math.min(firstOf.get(k) ?? Infinity, firstMs));
  }
  let best: { rel: string; ms: number } | null = null;
  for (const rel of pool) {
    const ms = firstOf.get(normalizeRel(rel)) ?? Infinity;
    if (!best || ms < best.ms || (ms === best.ms && rel < best.rel)) best = { rel, ms };
  }
  return best!.rel;
}

/** A thread over `pages` of `source`, attributed from `rows` (the source's own
 *  contribution rows): the sessions with a focus row on one of the pages, and
 *  the source's touched pages one of those sessions touched. */
function attributed(source: WorkThread, key: string, pages: readonly string[], rows: readonly WorkContribution[]): WorkThread {
  const mine = new Set(pages.map(normalizeRel));
  const refs = new Set<string>();
  for (const [ref, page, , kind] of rows) if (kind === "focus" && mine.has(normalizeRel(page))) refs.add(ref);
  const touchedBy = new Set<string>();
  for (const [ref, page, , kind] of rows) if (kind === "touch" && refs.has(ref)) touchedBy.add(normalizeRel(page));
  const sessions = source.sessions.filter((s) => refs.has(workSessionRef(s)));
  return {
    key,
    pages: [...pages],
    touched: source.touched.filter((p) => touchedBy.has(normalizeRel(p)) && !mine.has(normalizeRel(p))),
    // A remainder whose pages carry no focus row breaks the evidence contract;
    // it keeps the source's sessions rather than vanish as an unusable thread.
    sessions: sessions.length ? sessions : source.sessions,
  };
}

/**
 * The server's threads with the reader's boundaries applied. With no
 * definition the threads come back unchanged, so the
 * Threads stop stays byte for byte.
 */
export function applyWorkBoundaries(input: WorkBoundariesInput): WorkBoundaries {
  const raw = usableThreads(input.work?.threads);
  // No definition (the common case, every render): today's threads, without
  // reading the evidence.
  if (!input.splits.length && !input.keptApart.length) {
    const threads = raw.map((thread, index): BoundedThread => ({ thread, source: thread, index, sub: 0 }));
    return {
      threads,
      units: threads.map((b) => ({ key: b.thread.key, index: b.index, sub: 0, rank: b.source, thread: b.thread, isolated: false })),
      derived: raw,
      rank: new Map(threads.map((b) => [b.thread.key, { rank: b.source, sub: 0 }] as const)),
      definitions: [],
      reanchor: [],
    };
  }
  const byRel = new Map<string, WikiListing>();
  for (const p of input.allPages) byRel.set(normalizeRel(p.relPath), p);
  const { evidence, reason } = readWorkEvidence(input.work?.evidence, input.work?.threads);
  const rows = evidence?.contributions?.rows ?? [];
  const resolve = resolverFor(input.allPages);
  const definitions: BoundaryDefinition[] = [];

  // ── Splits ──
  const resolved = input.splits.map((s) => ({ s, ...resolve(s.page) }));
  const landings = new Map<string, number>();
  for (const r of resolved) if (r.page) landings.set(r.page, (landings.get(r.page) ?? 0) + 1);
  /** source key → split pages (normalized) → definition id. */
  const splitsOf = new Map<string, Map<string, string>>();
  for (const r of resolved) {
    const base = { kind: "split" as const, id: r.s.id, stored: r.s.page };
    if (!r.page) {
      definitions.push({ ...base, state: r.state! });
      continue;
    }
    if (landings.get(r.page)! > 1) {
      definitions.push({ ...base, page: r.page, state: "conflict" });
      continue;
    }
    const t = raw.find((x) => x.pages.some((p) => normalizeRel(p) === r.page));
    if (!t) {
      definitions.push({ ...base, page: r.page, state: "dormant" });
      continue;
    }
    const avail = threadSessionsAvailability(evidence, t.key, reason);
    if (!avail.available) {
      definitions.push({ ...base, page: r.page, state: "incomplete", reasons: avail.reasons });
      continue;
    }
    const focused = rows.some(([, page, thread, kind]) => thread === t.key && kind === "focus" && normalizeRel(page) === r.page);
    if (!focused) {
      definitions.push({ ...base, page: r.page, state: "unattributed" });
      continue;
    }
    definitions.push({ ...base, page: r.page, state: "active" });
    const m = splitsOf.get(t.key) ?? new Map<string, string>();
    m.set(r.page, r.s.id);
    splitsOf.set(t.key, m);
  }

  const threads: BoundedThread[] = [];
  raw.forEach((source, index) => {
    const split = splitsOf.get(source.key);
    if (!split) {
      threads.push({ thread: source, source, index, sub: 0 });
      return;
    }
    const own = rows.filter(([, , thread]) => thread === source.key);
    const left = source.pages.filter((p) => !split.has(normalizeRel(p)));
    if (left.length) {
      threads.push({ thread: attributed(source, remainderKey(left, own, byRel), left, own), source, index, sub: 0, remainder: true });
    }
    let sub = 0;
    for (const p of source.pages) {
      const id = split.get(normalizeRel(p));
      if (id === undefined) continue;
      sub++;
      threads.push({ thread: attributed(source, p, [p], own), source, index, sub, split: { id, page: p } });
    }
  });

  // ── Kept apart, over the threads after the splits ──
  const reanchor: [string, string][] = [];
  for (const stored of input.keptApart) {
    const r = resolve(stored);
    if (!r.page) {
      definitions.push({ kind: "keptApart", stored, state: r.state! });
      continue;
    }
    const b = threads.find((x) => threadHoldsPin(x.thread, byRel, r.page!));
    if (!b) {
      definitions.push({ kind: "keptApart", stored, page: r.page, state: "dormant" });
      continue;
    }
    definitions.push({ kind: "keptApart", stored, page: r.page, state: "active" });
    (b.keptApart ??= []).push(stored);
    const newest = newestFocusPage(b.thread, byRel);
    if (newest !== normalizeRel(stored)) reanchor.push([stored, newest]);
  }

  const units: WorkUnit[] = threads.map((b) => ({
    key: b.thread.key,
    index: b.index,
    sub: b.sub,
    rank: b.source,
    thread: b.thread,
    isolated: !!b.split || !!b.keptApart,
    ...(b.split ? { split: b.split } : {}),
    ...(b.keptApart ? { keptApart: b.keptApart } : {}),
  }));
  const rank = new Map(threads.map((b) => [b.thread.key, { rank: b.source, sub: b.sub }] as const));
  return { threads, units, derived: threads.map((b) => b.thread), rank, definitions, reanchor };
}

/** What a focus row's ⋯ offers for its page. */
export type RowBoundaryAction =
  /** The page is a split: Return to its thread. */
  | { kind: "return"; id: string }
  /** Make own thread, or why not. */
  | { kind: "split"; available: true }
  | { kind: "split"; available: false; reason: WorkGroupUnavailableReason | "unattributed" | "conflict" };

/**
 * The boundary item a focus row's ⋯ holds for `rel`: Return to its thread on
 * a split page, else Make own thread when its thread's contributions ship
 * whole and a kept focus on the page is on record (otherwise the item shows
 * disabled with the reason). A page two split definitions land on is a
 * conflict: a click would add a definition the record already holds, so the
 * item shows disabled and points at the reset area. Null when no thread holds
 * the page.
 */
export function rowBoundaryAction(
  b: WorkBoundaries,
  work: Partial<Pick<IndexWork, "threads" | "evidence">> | null | undefined,
  rel: string,
): RowBoundaryAction | null {
  const k = normalizeRel(rel);
  const holder = b.threads.find((x) => x.thread.pages.some((p) => normalizeRel(p) === k));
  if (!holder) return null;
  if (holder.split) return { kind: "return", id: holder.split.id };
  if (b.definitions.some((d) => d.state === "conflict" && d.page === k)) return { kind: "split", available: false, reason: "conflict" };
  const { evidence, reason } = readWorkEvidence(work?.evidence, work?.threads);
  const avail = threadSessionsAvailability(evidence, holder.source.key, reason);
  if (!avail.available) return { kind: "split", available: false, reason: avail.reasons[0]! };
  const rows = evidence?.contributions?.rows ?? [];
  const focused = rows.some(([, page, thread, kind]) => thread === holder.source.key && kind === "focus" && normalizeRel(page) === k);
  return focused ? { kind: "split", available: true } : { kind: "split", available: false, reason: "unattributed" };
}
