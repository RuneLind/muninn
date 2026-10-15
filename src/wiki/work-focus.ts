/**
 * Work facts: which pages each recent agent session was ABOUT, and which
 * sessions belong to one piece of work (a thread). Pure — no IO, no clock.
 *
 * Input is claude-usage's sessions form (`/api/files?sessions=1`) plus its
 * summary form at `until = sinceMs` (each page's newest write before the
 * window), the page set, and this wiki's identity (its REGISTERED root and
 * registry name — on a replay clone the pages live elsewhere, the prompts still
 * name the registered root). Output is per-page events and the threads.
 *
 * The rules, in the order they run (plan `muninn-wiki-work-threads`, «Design»):
 *  1. fork dedupe (D23) — a row identical in path, firstMs, lastMs and edits to
 *     one already counted is dropped;
 *  2. roll-up (D3) — a written file that is not a page counts at half weight
 *     toward the page that reads it (`csv=`/`sql=`/`src=`), else toward a page
 *     in an ancestor folder whose stem (or undated stem) names a folder on the
 *     file's path; a page keeps its old path's rows through a path-shaped alias;
 *  3. bookkeeping out (D16) — `index`/`log`/`CLAUDE` pages carry no events;
 *  4. named and elsewhere (D18) — what the session's first prompt (or title)
 *     names, judged here against the page set and the registry;
 *  5. passes (D4) — a `bulk` or `elsewhere` session's events are weight-0
 *     markers;
 *  6. focus (D2) — named, created, or busy (≥3 edits and ≥ half the session's
 *     busiest page); every other write is a touch;
 *  7. threads (D6) — non-pass sessions joined by a shared non-hub focus page.
 */

import { isMetaStem } from "../dashboard/views/components/wiki-filter.ts";
import { normalizeRelPath } from "./rel-path.ts";

// ── Wire shapes ─────────────────────────────────────────────────────────────

/** One file row of a session, as claude-usage sends it (`p` root-relative). */
export interface WorkSessionFile {
  p: string;
  /** Non-read op count (`write` + `bash`). */
  edits: number;
  firstMs: number;
  lastMs: number;
}

/** One session of the sessions form. */
export interface WorkSession {
  id: string;
  provider: string;
  title: string;
  first: number;
  last: number;
  bulk: boolean;
  text: {
    from: "prompt" | "title";
    paths: string[];
    links: { wiki: string | null; relPath: string }[];
    files: string[];
  };
  files: WorkSessionFile[];
}

export type WorkEventKind = "focus" | "touch" | "pass";
/** `[lastMs, edits, kind]` — one session's work on one page. */
export type WorkEvent = [lastMs: number, edits: number, kind: WorkEventKind];
/** D22: F focus in the window · T only touches/passes, with a pre-touch
 *  position · T0 the same with none. N (no events) is a page with no `work`. */
export type WorkState = "F" | "T" | "T0";

export interface PageWork {
  sinceMs: number;
  /** The pre-touch position: the newer of the ledger's newest write before
   *  the window and the newest non-sweep commit at or before it. */
  preMs?: number;
  state: WorkState;
  /** Newest focus event's `lastMs`; absent unless `state` is F. */
  focusMs?: number;
  /** Newest first: at most 12 focus events, the newest touch, the newest pass. */
  events: WorkEvent[];
}

export interface WorkThreadSession {
  id: string;
  provider: string;
  first: number;
  last: number;
  title: string;
}

export interface WorkThread {
  /** relPath of the thread's earliest focus event on a non-hub page. */
  key: string;
  /** Focus pages, most raw work first. */
  pages: string[];
  /** Pages the thread only touched. */
  touched: string[];
  sessions: WorkThreadSession[];
}

export interface IndexWork {
  asOfMs: number;
  sinceMs: number;
  threads: WorkThread[];
}

// ── Constants ───────────────────────────────────────────────────────────────

export const WORK_WINDOW_MS = 8 * 86_400_000;
export const WORK_HALF_LIFE_MS = 2 * 86_400_000;
/** A hub page: more backlinks than `RELATED_HUB_BACKLINKS` (25). */
export const WORK_HUB_BACKLINKS = 25;
export const WORK_FOCUS_EVENTS_MAX = 12;
export const WORK_THREADS_MAX = 20;
export const WORK_TITLE_MAX = 140;
/** The created rule's commit-lag allowance. */
export const WORK_CREATED_SLACK_MS = 10 * 60_000;
const BUSY_MIN_EDITS = 3;
const ATTACHMENT_WEIGHT = 0.5;
const KIND_WEIGHT: Record<WorkEventKind, number> = { focus: 1, touch: 0.15, pass: 0 };

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface WorkPageInput {
  relPath: string;
  /** `gitCreatedMs` and `birthtimeMs` — the created rule's anchor is their
   *  minimum, and with neither the rule does not apply. */
  gitCreatedMs?: number;
  birthtimeMs?: number;
  backlinks: number;
  /** `csv=`/`sql=`/`src=` refs, resolved wiki-relative. */
  refs?: readonly string[];
  /** Normalized old paths from path-shaped `aliases:` (`aliasWorkedPaths`). */
  aliasPaths?: readonly string[];
  /** Newest non-sweep commit at or before `sinceMs`. */
  preGitMs?: number;
}

export interface WorkFocusInput {
  sessions: readonly WorkSession[];
  /** Normalized path → newest write before the window (summary form). */
  pre: ReadonlyMap<string, number>;
  sinceMs: number;
  asOfMs: number;
  pages: readonly WorkPageInput[];
  /** This wiki: the spellings of its registered root, and its registry name. */
  identity: { roots: readonly string[]; name?: string };
  /** Every other registered root that is not read-only. */
  otherRoots: readonly string[];
}

export interface WorkFocusResult {
  pages: Map<string, PageWork>;
  threads: WorkThread[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The ledger's path spelling (`normalizeWorkedPath`'s rule, kept here so this
 *  module imports nothing with IO). */
export function workPathKey(p: string): string {
  return normalizeRelPath(p.replace(/\\/g, "/")).replace(/^\/+/, "");
}

const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}-/;
const PAGE_EXT_RE = /\.(?:mdx?|html)$/i;

function stemOf(p: string): string {
  return p.split("/").pop()!.replace(/\.[^.]+$/, "");
}

function rootPrefix(root: string): string {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return r.toLowerCase() + "/";
}

/** The raw work one event carries at `now`. */
export function eventRaw(ev: WorkEvent, now: number): number {
  const age = Math.max(0, now - ev[0]);
  return Math.log2(1 + ev[1]) * KIND_WEIGHT[ev[2]] * 0.5 ** (age / WORK_HALF_LIFE_MS);
}

/** `raw(page, now)` over a page's shipped events (D5/D6). */
export function rawWork(events: readonly WorkEvent[], now: number): number {
  let sum = 0;
  for (const ev of events) sum += eventRaw(ev, now);
  return sum;
}

/** Whitespace collapsed, at most {@link WORK_TITLE_MAX} code points. */
export function cleanSessionTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  const cps = [...flat];
  return cps.length <= WORK_TITLE_MAX ? flat : cps.slice(0, WORK_TITLE_MAX - 1).join("").trimEnd() + "…";
}

interface PageRec {
  relPath: string;
  key: string;
  hub: boolean;
  createdAnchor?: number;
  preMs?: number;
}

/** One session's work on one page, after roll-up. */
interface Contribution {
  page: PageRec;
  edits: number;
  firstMs: number;
  lastMs: number;
  /** Earliest `firstMs` of the page's OWN rows (not attachments). */
  ownFirstMs?: number;
}

interface SessionEvent {
  session: WorkSession;
  page: PageRec;
  edits: number;
  firstMs: number;
  lastMs: number;
  kind: WorkEventKind;
}

// ── The computation ─────────────────────────────────────────────────────────

export function computeWorkFocus(input: WorkFocusInput): WorkFocusResult {
  const { sinceMs, asOfMs } = input;

  // The vocabulary. Bookkeeping pages are dropped from every event, so they
  // are not in any map below.
  const sorted = [...input.pages].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const byKey = new Map<string, PageRec>();
  const metaKeys = new Set<string>();
  const recs: PageRec[] = [];
  for (const p of sorted) {
    const key = workPathKey(p.relPath);
    if (isMetaStem(stemOf(p.relPath))) {
      metaKeys.add(key);
      continue;
    }
    const anchors = [p.gitCreatedMs, p.birthtimeMs].filter((v): v is number => typeof v === "number" && v > 0);
    const rec: PageRec = {
      relPath: p.relPath,
      key,
      hub: p.backlinks > WORK_HUB_BACKLINKS,
      ...(anchors.length ? { createdAnchor: Math.min(...anchors) } : {}),
    };
    const preLedger = maxDefined([input.pre.get(key), ...(p.aliasPaths ?? []).map((a) => input.pre.get(a))]);
    const pre = maxDefined([preLedger, p.preGitMs]);
    if (pre !== undefined) rec.preMs = pre;
    byKey.set(key, rec);
    recs.push(rec);
  }
  const aliasOwner = new Map<string, PageRec>();
  sorted.forEach((p) => {
    const rec = byKey.get(workPathKey(p.relPath));
    if (!rec) return;
    for (const a of p.aliasPaths ?? []) if (!byKey.has(a) && !metaKeys.has(a) && !aliasOwner.has(a)) aliasOwner.set(a, rec);
  });
  const refOwner = new Map<string, PageRec>();
  for (const p of sorted) {
    const rec = byKey.get(workPathKey(p.relPath));
    if (!rec) continue;
    for (const r of p.refs ?? []) {
      const k = workPathKey(r);
      if (!refOwner.has(k)) refOwner.set(k, rec);
    }
  }
  // folder → (folder-name candidate → first page in that folder naming it).
  const folderStems = new Map<string, Map<string, PageRec>>();
  for (const rec of recs) {
    const slash = rec.key.lastIndexOf("/");
    const dir = slash === -1 ? "" : rec.key.slice(0, slash);
    const stem = stemOf(rec.key);
    const m = folderStems.get(dir) ?? new Map<string, PageRec>();
    for (const name of [stem, stem.replace(DATE_PREFIX_RE, "")]) if (name && !m.has(name)) m.set(name, rec);
    folderStems.set(dir, m);
  }
  const folderOwner = (key: string): PageRec | undefined => {
    const segs = key.split("/");
    // Deepest folder first: the file's own parent folder is segs[length-2],
    // and a page beside that folder (in segs[0..i-1]) names it.
    for (let i = segs.length - 2; i >= 0; i--) {
      const dir = segs.slice(0, i).join("/");
      const hit = folderStems.get(dir)?.get(segs[i]!);
      if (hit) return hit;
    }
    return undefined;
  };
  const ownerOf = (key: string): { rec: PageRec; own: boolean } | undefined => {
    if (metaKeys.has(key)) return undefined;
    const direct = byKey.get(key) ?? aliasOwner.get(key);
    if (direct) return { rec: direct, own: true };
    const rolled = refOwner.get(key) ?? folderOwner(key);
    return rolled ? { rec: rolled, own: false } : undefined;
  };

  // The named vocabulary (D18): unique file names, with and without the date
  // prefix.
  const nameCount = new Map<string, PageRec | null>();
  const addName = (name: string, rec: PageRec) => {
    const prev = nameCount.get(name);
    nameCount.set(name, prev === undefined ? rec : prev === rec ? rec : null);
  };
  for (const rec of recs) {
    const base = rec.key.split("/").pop()!;
    addName(base, rec);
    const undated = base.replace(DATE_PREFIX_RE, "");
    if (undated !== base) addName(undated, rec);
  }
  const idRoots = input.identity.roots.map(rootPrefix);
  const otherRoots = input.otherRoots.map(rootPrefix).filter((r) => !idRoots.includes(r));
  const wikiName = input.identity.name?.toLowerCase();
  const pageByToken = (token: string): PageRec | undefined => {
    const k = workPathKey(token);
    return byKey.get(k) ?? aliasOwner.get(k);
  };
  const namedBy = (s: WorkSession): Set<PageRec> => {
    const out = new Set<PageRec>();
    for (const raw of s.text.paths) {
      const t = raw.replace(/\\/g, "/");
      if (t.startsWith("/")) {
        const lower = t.toLowerCase();
        const root = idRoots.find((r) => lower.startsWith(r));
        if (!root) continue;
        const hit = pageByToken(t.slice(root.length));
        if (hit) out.add(hit);
      } else {
        const hit = pageByToken(t);
        if (hit) out.add(hit);
      }
    }
    for (const l of s.text.links) {
      if (!l.wiki || !wikiName || l.wiki.toLowerCase() !== wikiName) continue;
      const hit = pageByToken(l.relPath);
      if (hit) out.add(hit);
    }
    for (const f of s.text.files) {
      if (!PAGE_EXT_RE.test(f)) continue;
      const hit = nameCount.get(f.toLowerCase());
      if (hit) out.add(hit);
    }
    return out;
  };
  const isElsewhere = (s: WorkSession, named: Set<PageRec>): boolean => {
    if (named.size > 0) return false;
    return s.text.paths.some((raw) => {
      const lower = raw.replace(/\\/g, "/").toLowerCase();
      if (!lower.startsWith("/")) return false;
      if (idRoots.some((r) => lower.startsWith(r))) return false;
      return otherRoots.some((r) => lower.startsWith(r));
    });
  };

  // 1–3: dedupe, roll-up, bookkeeping out. Sessions oldest first, so a fork's
  // repeated rows are the ones dropped.
  const sessions = [...input.sessions].sort((a, b) => a.first - b.first || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seenRows = new Set<string>();
  const perSession: { s: WorkSession; contribs: Contribution[] }[] = [];
  const earliestOwn = new Map<PageRec, number>();
  for (const s of sessions) {
    const contribs = new Map<PageRec, Contribution>();
    for (const f of s.files) {
      if (!(f.edits > 0) || f.lastMs < sinceMs || f.lastMs > asOfMs) continue;
      const key = workPathKey(f.p);
      const rowKey = `${key}\u0000${f.firstMs}\u0000${f.lastMs}\u0000${f.edits}`;
      if (seenRows.has(rowKey)) continue;
      seenRows.add(rowKey);
      const owner = ownerOf(key);
      if (!owner) continue;
      const c = contribs.get(owner.rec) ?? { page: owner.rec, edits: 0, firstMs: f.firstMs, lastMs: f.lastMs };
      c.edits += owner.own ? f.edits : f.edits * ATTACHMENT_WEIGHT;
      c.firstMs = Math.min(c.firstMs, f.firstMs);
      c.lastMs = Math.max(c.lastMs, f.lastMs);
      if (owner.own) {
        c.ownFirstMs = Math.min(c.ownFirstMs ?? f.firstMs, f.firstMs);
        const e = earliestOwn.get(owner.rec);
        if (e === undefined || f.firstMs < e) earliestOwn.set(owner.rec, f.firstMs);
      }
      contribs.set(owner.rec, c);
    }
    if (contribs.size) perSession.push({ s, contribs: [...contribs.values()] });
  }

  // 4–6: named, passes, focus.
  const events: SessionEvent[] = [];
  for (const { s, contribs } of perSession) {
    const named = namedBy(s);
    const pass = s.bulk || isElsewhere(s, named);
    const busiest = Math.max(...contribs.map((c) => c.edits));
    for (const c of contribs) {
      let kind: WorkEventKind;
      if (pass) kind = "pass";
      else {
        const anchor = c.page.createdAnchor;
        const created =
          anchor !== undefined &&
          anchor >= sinceMs &&
          c.ownFirstMs !== undefined &&
          c.ownFirstMs === earliestOwn.get(c.page) &&
          c.ownFirstMs <= anchor + WORK_CREATED_SLACK_MS;
        const busy = c.edits >= BUSY_MIN_EDITS && c.edits * 2 >= busiest;
        kind = named.has(c.page) || created || busy ? "focus" : "touch";
      }
      events.push({ session: s, page: c.page, edits: c.edits, firstMs: c.firstMs, lastMs: c.lastMs, kind });
    }
  }

  // Per-page shipped events and states.
  const byPage = new Map<PageRec, SessionEvent[]>();
  for (const ev of events) {
    const list = byPage.get(ev.page) ?? [];
    list.push(ev);
    byPage.set(ev.page, list);
  }
  const pages = new Map<string, PageWork>();
  const pageRaw = new Map<PageRec, number>();
  for (const [rec, list] of byPage) {
    const desc = [...list].sort((a, b) => b.lastMs - a.lastMs);
    const shipped: WorkEvent[] = [];
    let focusN = 0;
    let touch = false;
    let pass = false;
    for (const ev of desc) {
      if (ev.kind === "focus" && focusN < WORK_FOCUS_EVENTS_MAX) focusN++;
      else if (ev.kind === "touch" && !touch) touch = true;
      else if (ev.kind === "pass" && !pass) pass = true;
      else continue;
      shipped.push([ev.lastMs, ev.edits, ev.kind]);
    }
    const focus = shipped.find((e) => e[2] === "focus");
    const state: WorkState = focus ? "F" : rec.preMs !== undefined ? "T" : "T0";
    pages.set(rec.relPath, {
      sinceMs,
      ...(rec.preMs !== undefined ? { preMs: rec.preMs } : {}),
      state,
      ...(focus ? { focusMs: focus[0] } : {}),
      events: shipped,
    });
    pageRaw.set(rec, rawWork(shipped, asOfMs));
  }

  return { pages, threads: buildThreads(events, pageRaw, asOfMs) };
}

function maxDefined(vals: (number | undefined)[]): number | undefined {
  let out: number | undefined;
  for (const v of vals) if (typeof v === "number" && (out === undefined || v > out)) out = v;
  return out;
}

// ── Threads (D6, D16) ───────────────────────────────────────────────────────

function buildThreads(events: readonly SessionEvent[], pageRaw: ReadonlyMap<PageRec, number>, asOfMs: number): WorkThread[] {
  const work = events.filter((e) => e.kind !== "pass");
  const focusSessions = new Set(work.filter((e) => e.kind === "focus").map((e) => e.session));

  // Union-find over sessions, joined by a shared non-hub focus page.
  const parent = new Map<WorkSession, WorkSession>();
  const find = (s: WorkSession): WorkSession => {
    let r = s;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = s;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const s of focusSessions) parent.set(s, s);
  const firstFocuser = new Map<PageRec, WorkSession>();
  for (const e of work) {
    if (e.kind !== "focus" || e.page.hub) continue;
    const prev = firstFocuser.get(e.page);
    if (!prev) firstFocuser.set(e.page, e.session);
    else parent.set(find(e.session), find(prev));
  }

  interface Group {
    sessions: Set<WorkSession>;
    focus: Map<PageRec, SessionEvent[]>;
    touched: Set<PageRec>;
  }
  const groups = new Map<WorkSession, Group>();
  const groupOf = (s: WorkSession): Group => {
    const r = find(s);
    let g = groups.get(r);
    if (!g) {
      g = { sessions: new Set(), focus: new Map(), touched: new Set() };
      groups.set(r, g);
    }
    return g;
  };
  for (const e of work) {
    if (!focusSessions.has(e.session)) continue; // a touch-only session joins no thread
    const g = groupOf(e.session);
    g.sessions.add(e.session);
    if (e.kind === "focus") {
      const list = g.focus.get(e.page) ?? [];
      list.push(e);
      g.focus.set(e.page, list);
    } else g.touched.add(e.page);
  }

  // A hub focused by several threads keeps its focus row in the one with the
  // most raw work on it (ties to the newest session); the others list it as
  // touched (D16).
  const hubGroups = new Map<PageRec, Group[]>();
  for (const g of groups.values()) for (const p of g.focus.keys()) if (p.hub) hubGroups.set(p, [...(hubGroups.get(p) ?? []), g]);
  for (const [hub, gs] of hubGroups) {
    if (gs.length < 2) continue;
    const score = (g: Group) => {
      const evs = g.focus.get(hub)!;
      const raw = evs.reduce((sum, e) => sum + eventRaw([e.lastMs, e.edits, "focus"], asOfMs), 0);
      const newest = Math.max(...evs.map((e) => e.session.last));
      return { raw, newest };
    };
    const best = [...gs].sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      return sb.raw - sa.raw || sb.newest - sa.newest;
    })[0]!;
    for (const g of gs) {
      if (g === best) continue;
      g.focus.delete(hub);
      g.touched.add(hub);
    }
  }

  const rawOf = (p: PageRec) => pageRaw.get(p) ?? 0;
  const byRaw = (a: PageRec, b: PageRec) => rawOf(b) - rawOf(a) || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
  const out: { thread: WorkThread; score: number }[] = [];
  for (const g of groups.values()) {
    if (g.focus.size === 0) continue;
    const focusPages = [...g.focus.keys()].sort(byRaw);
    const touched = [...g.touched].filter((p) => !g.focus.has(p)).sort(byRaw);
    const keyPool = focusPages.some((p) => !p.hub) ? focusPages.filter((p) => !p.hub) : focusPages;
    let key: { firstMs: number; relPath: string } | undefined;
    for (const p of keyPool) {
      for (const e of g.focus.get(p)!) {
        if (!key || e.firstMs < key.firstMs || (e.firstMs === key.firstMs && p.relPath < key.relPath)) {
          key = { firstMs: e.firstMs, relPath: p.relPath };
        }
      }
    }
    const score = rawOf(focusPages[0]!) + 0.3 * focusPages.slice(1).reduce((sum, p) => sum + rawOf(p), 0);
    out.push({
      score,
      thread: {
        key: key!.relPath,
        pages: focusPages.map((p) => p.relPath),
        touched: touched.map((p) => p.relPath),
        sessions: [...g.sessions]
          .sort((a, b) => b.last - a.last || (a.id < b.id ? -1 : 1))
          .map((s) => ({ id: s.id, provider: s.provider, first: s.first, last: s.last, title: cleanSessionTitle(s.title) })),
      },
    });
  }
  out.sort((a, b) => b.score - a.score || (a.thread.key < b.thread.key ? -1 : a.thread.key > b.thread.key ? 1 : 0));
  return out.slice(0, WORK_THREADS_MAX).map((t) => t.thread);
}

/** The thread order score at `now` from the shipped per-page events — the
 *  client's input as well (D10: the browser orders). */
export function threadScore(thread: WorkThread, pageWork: (relPath: string) => PageWork | undefined, now: number): number {
  const raws = thread.pages.map((p) => rawWork(pageWork(p)?.events ?? [], now));
  if (!raws.length) return 0;
  return raws[0]! + 0.3 * raws.slice(1).reduce((s, r) => s + r, 0);
}
