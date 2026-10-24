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
 *  2. roll-up (D3) — a rail attachment (`pairedBy` `stem`, `suffix` or `link`)
 *     is part of its parent's family and counts at full weight toward it
 *     (pick-up D1); a written file that is not a page counts at half weight
 *     toward the page that reads it (`csv=`/`sql=`/`src=`), else toward a page
 *     in an ancestor folder whose stem (or undated stem) names a folder on the
 *     file's path; a page keeps its old path's rows through a path-shaped alias;
 *  3. bookkeeping out (D16) — `index`/`log`/`CLAUDE` pages carry no events;
 *  4. named and elsewhere (D18) — what the session's first prompt (or title)
 *     names, judged here against the page set and the registry;
 *  5. passes (D4) — a `bulk` or `elsewhere` session's events are weight-0
 *     markers;
 *  6. focus (D2) — named, created (the session wrote the first row of a
 *     family member born in the window), or busy (≥3 edits and ≥ half the
 *     session's busiest page); every other write is a touch. Then the weak-link rule
 *     (pick-up D1/D10, `demoteWeakLinks`): beside a strong non-hub focus
 *     family, a non-hub focus family under 2 weighted edits that the session
 *     did not create is a touch;
 *  7. threads (D6) — non-pass sessions joined by a shared non-hub focus page.
 *
 * A family's events, threads and contributions name the parent. Each
 * attachment also gets a `PageWork` of its own rows, at the kind its family
 * had in each session, so a client reading the child alone sees the family's
 * classification.
 */

import { isMetaStem } from "../dashboard/views/components/wiki-filter.ts";
import { normalizeWorkedPath } from "./rel-path.ts";
import { mapLedgerProvider } from "./provenance.ts";

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
  /** The grouping layer's input (`work-evidence.ts`), versioned. Absent from an
   *  older server; a client that does not read it sees today's payload. */
  evidence?: WorkEvidence;
}

export const WORK_EVIDENCE_VERSION = 1;

/** Why a block of the evidence is incomplete. */
export type WorkEvidenceReason =
  /** The relation lists hit their bound (`WORK_EVIDENCE_RELATIONS_MAX`). */
  | "relations-cap"
  /** claude-usage clipped the sessions answer: the oldest sessions are missing. */
  | "ledger-truncated"
  /** The contribution rows hit their bound (`WORK_EVIDENCE_CONTRIBUTIONS_MAX`). */
  | "contributions-cap";

/**
 * The grouping layer's evidence over the SHIPPED threads' focus pages
 * (`work-evidence.ts`; plan `muninn-wiki-work-thread-grouping`, «Evidence and
 * payload»). Page-level, so a client can regroup or split threads without a
 * request: every witness names focus pages, never threads.
 */
export interface WorkEvidence {
  version: typeof WORK_EVIDENCE_VERSION;
  /** Threads before and after the {@link WORK_THREADS_MAX} cut. The blocks
   *  below cover the shipped ones only, so a cut is not incompleteness. */
  threads: { candidates: number; shipped: number };
  relations: {
    complete: boolean;
    reasons: WorkEvidenceReason[];
    /** Focus page → its series' census key (`seriesCensusKey`), for series
     *  members (`seriesMembersByFoldKey`). */
    series: Record<string, string>;
    /** Focus page → its listing project. */
    projects: Record<string, string>;
    /** A resolved authored `related:` entry between two focus pages, as written
     *  (from → to). */
    related: [from: string, to: string][];
    /** An issue's unique owning focus page (`owns:`) and a focus page that
     *  names it by a ref that counts (`facetJiraKeys`). */
    issues: [key: string, owner: string, referrer: string][];
    /** An issue some focus page owns or names, with more than one owner in the
     *  wiki: no edge. */
    ambiguousIssues: { key: string; owners: string[] }[];
    /** `related:` entries on focus pages that resolved to no page (prose, Jira
     *  keys, outside the root) or to more than one. Counts, never incompleteness. */
    relatedSkipped: { skipped: number; ambiguous: number };
  };
  contributions: {
    complete: boolean;
    reasons: WorkEvidenceReason[];
    /** Keys of shipped threads whose rows were left out WHOLE by
     *  `WORK_EVIDENCE_CONTRIBUTIONS_MAX` (in thread order); every other
     *  thread's rows ship whole. Non-empty exactly when `reasons` holds
     *  `contributions-cap`. A thread's rows are complete when its key is not
     *  here and `reasons` does not hold `ledger-truncated`. */
    cut: string[];
    rows: WorkContribution[];
  };
}

/** One session's kept work on one page of a shipped thread:
 *  `[provider:id, owner page, thread key, kind, rolled-up edits, firstMs, lastMs]`.
 *  The session is `workSessionRef`'s spelling (`claude-code:<id>`), so a row
 *  joins a `WorkThreadSession` through `workSessionRef(session)`, not through
 *  its raw `provider`.
 *  `kind` is the kind the THREAD kept — a hub focus that `buildThreads` moved to
 *  another thread is a `touch` here. Pass events never appear. */
export type WorkContribution = [
  session: string,
  page: string,
  thread: string,
  kind: "focus" | "touch",
  edits: number,
  firstMs: number,
  lastMs: number,
];

// ── Constants ───────────────────────────────────────────────────────────────

export const WORK_WINDOW_MS = 8 * 86_400_000;
export const WORK_HALF_LIFE_MS = 2 * 86_400_000;
/** A hub page: more backlinks than `RELATED_HUB_BACKLINKS` (25). */
export const WORK_HUB_BACKLINKS = 25;
/** The one hub test: the server's thread keys and D16 ownership, and the
 *  client's pin anchor, all read it (the listing's `backlinkCount` is the same
 *  count as `WorkPageInput.backlinks`). */
export function isWorkHub(backlinks: number): boolean {
  return backlinks > WORK_HUB_BACKLINKS;
}
export const WORK_FOCUS_EVENTS_MAX = 12;
export const WORK_THREADS_MAX = 20;
export const WORK_TITLE_MAX = 140;
/** The created rule's commit-lag allowance. */
export const WORK_CREATED_SLACK_MS = 10 * 60_000;
const BUSY_MIN_EDITS = 3;
/** The weak-link bar (pick-up D1): a focus family under this many weighted
 *  edits, not created by the session, is a weak link. */
const STRONG_MIN_EDITS = 2;
const ATTACHMENT_WEIGHT = 0.5;
/** The pairings that make a family; `superseded` keeps two pages. */
const FAMILY_PAIRINGS: ReadonlySet<WorkPairedBy> = new Set(["stem", "suffix", "link"]);
const KIND_WEIGHT: Record<WorkEventKind, number> = { focus: 1, touch: 0.15, pass: 0 };

// ── Inputs ──────────────────────────────────────────────────────────────────

/** `WikiPageMeta.pairedBy`'s values (`store.ts` `PairedBy`). */
export type WorkPairedBy = "stem" | "suffix" | "link" | "superseded";

export interface WorkPageInput {
  relPath: string;
  /** The rail attachment parent (`WikiPageMeta.parent`). With `pairedBy`
   *  `stem`, `suffix` or `link` this page is part of the parent's family: its
   *  rows count toward the parent at full weight and it carries no `work` of
   *  its own. A `superseded` pair stays two pages. */
  parent?: string;
  pairedBy?: WorkPairedBy;
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
  /** This wiki: the spellings of its registered root, and every registry name
   *  on that root (an aliased root answers to each). */
  identity: { roots: readonly string[]; names?: readonly string[] };
  /** Every other registered root that is not read-only. */
  otherRoots: readonly string[];
}

export interface WorkFocusResult {
  /** relPath → work: each family under its parent, and each attachment with
   *  its own rows at the family's kind per session. */
  pages: Map<string, PageWork>;
  threads: WorkThread[];
  /** Threads before the {@link WORK_THREADS_MAX} cut. */
  candidates: number;
  /** Every non-pass event of a shipped thread's sessions, in thread order —
   *  a projection that changes neither `pages` nor `threads`. */
  contributions: WorkContribution[];
  /** Session × family pairs the weak-link rule turned from focus into touch. */
  weakLinks: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The one key for ledger paths, prompt tokens and page relPaths: the worked
 *  ledger's `normalizeWorkedPath`, NFC fold included. */
export function workPathKey(p: string): string {
  return normalizeWorkedPath(p);
}

const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}-/;
const PAGE_EXT_RE = /\.(?:mdx?|html)$/i;

function stemOf(p: string): string {
  return p.split("/").pop()!.replace(/\.[^.]+$/, "");
}

function rootPrefix(root: string): string {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return r.toLowerCase().normalize("NFC") + "/";
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
  /** The family's pre-touch position (parent and attachments). */
  preMs?: number;
}

/** One page of a family (the parent or an attachment), as the created rule
 *  and the attachment's own `PageWork` read it. */
interface MemberRec {
  relPath: string;
  family: PageRec;
  /** True for an attachment, false for the parent itself. */
  child: boolean;
  createdAnchor?: number;
  /** This page's own pre-touch position. */
  preMs?: number;
}

interface Span {
  edits: number;
  firstMs: number;
  lastMs: number;
}

/** One session's work on one page, after roll-up. */
interface Contribution extends Span {
  page: PageRec;
  /** Earliest `firstMs` of each member's own rows (path or alias). */
  memberFirst: Map<MemberRec, number>;
  /** An attachment's own rows in this session. */
  childRows: Map<MemberRec, Span>;
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
  const pre = new Map<string, number>();
  for (const [p, ms] of input.pre) {
    const k = workPathKey(p);
    pre.set(k, Math.max(ms, pre.get(k) ?? ms));
  }
  // An alias path a live page sits at is that page's (the worked post-pass's
  // `livePaths` rule), for the pre-touch position and the roll-up alike.
  const liveKeys = new Set(sorted.map((p) => workPathKey(p.relPath)));
  const aliasesOf = (p: WorkPageInput): string[] =>
    [...new Set((p.aliasPaths ?? []).map(workPathKey))].filter((a) => !liveKeys.has(a));
  const preOf = (p: WorkPageInput): number | undefined =>
    maxDefined([pre.get(workPathKey(p.relPath)), ...aliasesOf(p).map((a) => pre.get(a)), p.preGitMs]);
  const metaKeys = new Set<string>();
  for (const p of sorted) if (isMetaStem(stemOf(p.relPath))) metaKeys.add(workPathKey(p.relPath));
  // Families (pick-up D1): an attachment whose parent is a page of its own here
  // folds into that parent. Pairing is one level deep, so a parent is never a
  // child; a meta-stemmed page stays out of every family.
  const inputByKey = new Map(sorted.map((p) => [workPathKey(p.relPath), p] as const));
  const pairedParent = (p: WorkPageInput): string | undefined =>
    p.parent && p.pairedBy && FAMILY_PAIRINGS.has(p.pairedBy) ? workPathKey(p.parent) : undefined;
  const parentKeyOf = (p: WorkPageInput): string | undefined => {
    const k = pairedParent(p);
    if (k === undefined || metaKeys.has(k)) return undefined;
    const parent = inputByKey.get(k);
    return parent && pairedParent(parent) === undefined ? k : undefined;
  };
  const byKey = new Map<string, PageRec>();
  const recs: PageRec[] = [];
  const selfMember = new Map<PageRec, MemberRec>();
  const memberOf = (p: WorkPageInput, family: PageRec, child: boolean): MemberRec => {
    const anchors = [p.gitCreatedMs, p.birthtimeMs].filter((v): v is number => typeof v === "number" && v > 0);
    const preMs = preOf(p);
    return {
      relPath: p.relPath,
      family,
      child,
      ...(anchors.length ? { createdAnchor: Math.min(...anchors) } : {}),
      ...(preMs !== undefined ? { preMs } : {}),
    };
  };
  for (const p of sorted) {
    const key = workPathKey(p.relPath);
    if (metaKeys.has(key) || parentKeyOf(p) !== undefined) continue;
    const rec: PageRec = { relPath: p.relPath, key, hub: isWorkHub(p.backlinks) };
    const preMs = preOf(p);
    if (preMs !== undefined) rec.preMs = preMs;
    byKey.set(key, rec);
    recs.push(rec);
    selfMember.set(rec, memberOf(p, rec, false));
  }
  /** The family a non-meta page belongs to: its own rec, or its parent's. */
  const familyOf = (p: WorkPageInput): PageRec | undefined => {
    const key = workPathKey(p.relPath);
    if (metaKeys.has(key)) return undefined;
    return byKey.get(parentKeyOf(p) ?? key);
  };
  // An attachment's own path and its aliases count toward its parent at full
  // weight, as that attachment's own rows.
  const memberOwner = new Map<string, MemberRec>();
  const members: { p: WorkPageInput; rec: PageRec; member: MemberRec }[] = [];
  for (const p of sorted) {
    if (parentKeyOf(p) === undefined) continue;
    const rec = familyOf(p)!;
    const member = memberOf(p, rec, true);
    members.push({ p, rec, member });
    memberOwner.set(workPathKey(p.relPath), member);
    if (member.preMs !== undefined && (rec.preMs === undefined || member.preMs > rec.preMs)) rec.preMs = member.preMs;
  }
  const aliasOwner = new Map<string, PageRec>();
  for (const p of sorted) {
    const rec = byKey.get(workPathKey(p.relPath));
    if (!rec) continue;
    for (const a of aliasesOf(p)) if (!aliasOwner.has(a)) aliasOwner.set(a, rec);
  }
  for (const { p, member } of members) {
    for (const a of aliasesOf(p)) if (!aliasOwner.has(a) && !memberOwner.has(a)) memberOwner.set(a, member);
  }
  const refOwner = new Map<string, PageRec>();
  for (const p of sorted) {
    const rec = familyOf(p);
    if (!rec) continue;
    for (const r of p.refs ?? []) {
      const k = workPathKey(r);
      if (!refOwner.has(k)) refOwner.set(k, rec);
    }
  }
  // folder → (folder-name candidate → the family of the first page in that
  // folder naming it).
  const folderStems = new Map<string, Map<string, PageRec>>();
  for (const p of sorted) {
    const rec = familyOf(p);
    if (!rec) continue;
    const key = workPathKey(p.relPath);
    const slash = key.lastIndexOf("/");
    const dir = slash === -1 ? "" : key.slice(0, slash);
    const stem = stemOf(key);
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
  /** Who a written path counts toward, at what weight, and which family
   *  member's own row it is (none for a ref or folder file). */
  const ownerOf = (key: string): { rec: PageRec; weight: number; member?: MemberRec } | undefined => {
    if (metaKeys.has(key)) return undefined;
    const direct = byKey.get(key) ?? aliasOwner.get(key);
    if (direct) return { rec: direct, weight: 1, member: selfMember.get(direct)! };
    const member = memberOwner.get(key);
    if (member) return { rec: member.family, weight: 1, member };
    const rolled = refOwner.get(key) ?? folderOwner(key);
    return rolled ? { rec: rolled, weight: ATTACHMENT_WEIGHT } : undefined;
  };

  // The named vocabulary (D18): unique file names, with and without the date
  // prefix.
  const nameCount = new Map<string, PageRec | null>();
  const addName = (name: string, rec: PageRec) => {
    const prev = nameCount.get(name);
    nameCount.set(name, prev === undefined ? rec : prev === rec ? rec : null);
  };
  const nameOwners: [key: string, rec: PageRec][] = [
    ...recs.map((r): [string, PageRec] => [r.key, r]),
    ...members.map(({ p, rec }): [string, PageRec] => [workPathKey(p.relPath), rec]),
  ];
  for (const [key, rec] of nameOwners) {
    const base = key.split("/").pop()!;
    addName(base, rec);
    const undated = base.replace(DATE_PREFIX_RE, "");
    if (undated !== base) addName(undated, rec);
  }
  const idRoots = input.identity.roots.map(rootPrefix);
  const otherRoots = input.otherRoots.map(rootPrefix).filter((r) => !idRoots.includes(r));
  const wikiNames = new Set((input.identity.names ?? []).map((n) => n.toLowerCase()));
  const pageByToken = (token: string): PageRec | undefined => {
    const k = workPathKey(token);
    return byKey.get(k) ?? aliasOwner.get(k) ?? memberOwner.get(k)?.family;
  };
  const namedBy = (s: WorkSession): Set<PageRec> => {
    const out = new Set<PageRec>();
    for (const raw of s.text.paths) {
      const t = raw.replace(/\\/g, "/").normalize("NFC");
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
      if (!l.wiki || !wikiNames.has(l.wiki.toLowerCase())) continue;
      const hit = pageByToken(l.relPath);
      if (hit) out.add(hit);
    }
    for (const f of s.text.files) {
      if (!PAGE_EXT_RE.test(f)) continue;
      const hit = nameCount.get(f.toLowerCase().normalize("NFC"));
      if (hit) out.add(hit);
    }
    return out;
  };
  const isElsewhere = (s: WorkSession, named: Set<PageRec>): boolean => {
    if (named.size > 0) return false;
    return s.text.paths.some((raw) => {
      const lower = raw.replace(/\\/g, "/").toLowerCase().normalize("NFC");
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
  const earliestOwn = new Map<MemberRec, number>();
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
      const c = contribs.get(owner.rec) ?? {
        page: owner.rec,
        edits: 0,
        firstMs: f.firstMs,
        lastMs: f.lastMs,
        memberFirst: new Map(),
        childRows: new Map(),
      };
      c.edits += f.edits * owner.weight;
      c.firstMs = Math.min(c.firstMs, f.firstMs);
      c.lastMs = Math.max(c.lastMs, f.lastMs);
      const m = owner.member;
      if (m) {
        c.memberFirst.set(m, Math.min(c.memberFirst.get(m) ?? f.firstMs, f.firstMs));
        const e = earliestOwn.get(m);
        if (e === undefined || f.firstMs < e) earliestOwn.set(m, f.firstMs);
        if (m.child) {
          const row = c.childRows.get(m) ?? { edits: 0, firstMs: f.firstMs, lastMs: f.lastMs };
          row.edits += f.edits;
          row.firstMs = Math.min(row.firstMs, f.firstMs);
          row.lastMs = Math.max(row.lastMs, f.lastMs);
          c.childRows.set(m, row);
        }
      }
      contribs.set(owner.rec, c);
    }
    if (contribs.size) perSession.push({ s, contribs: [...contribs.values()] });
  }

  // 4–6: named, passes, focus, then the weak-link rule.
  const events: SessionEvent[] = [];
  /** Each attachment's own rows at its family's kind in that session. */
  const childEvents = new Map<MemberRec, (Span & { kind: WorkEventKind })[]>();
  /** A member page born in the window whose first own row this session wrote
   *  (a page with a pre-touch position existed before the window, whatever git
   *  dates its creation: a rename-and-rewrite defeats rename detection). */
  const createdBy = (m: MemberRec, first: number): boolean =>
    m.createdAnchor !== undefined &&
    m.preMs === undefined &&
    m.createdAnchor >= sinceMs &&
    first === earliestOwn.get(m) &&
    first <= m.createdAnchor + WORK_CREATED_SLACK_MS;
  let weakLinks = 0;
  for (const { s, contribs } of perSession) {
    const named = namedBy(s);
    const pass = s.bulk || isElsewhere(s, named);
    const busiest = Math.max(...contribs.map((c) => c.edits));
    const classed: ClassedContribution[] = contribs.map((c) => {
      if (pass) return { c, kind: "pass", created: false };
      const created = [...c.memberFirst].some(([m, first]) => createdBy(m, first));
      const busy = c.edits >= BUSY_MIN_EDITS && c.edits * 2 >= busiest;
      return { c, kind: named.has(c.page) || created || busy ? "focus" : "touch", created };
    });
    weakLinks += demoteWeakLinks(classed);
    for (const { c, kind } of classed) {
      events.push({ session: s, page: c.page, edits: c.edits, firstMs: c.firstMs, lastMs: c.lastMs, kind });
      for (const [m, row] of c.childRows) childEvents.set(m, [...(childEvents.get(m) ?? []), { ...row, kind }]);
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
    const w = pageWorkOf(list, rec.preMs, sinceMs);
    pages.set(rec.relPath, w);
    pageRaw.set(rec, rawWork(w.events, asOfMs));
  }
  for (const [m, list] of childEvents) pages.set(m.relPath, pageWorkOf(list, m.preMs, sinceMs));

  const built = buildThreads(events, pageRaw, asOfMs);
  return {
    pages,
    threads: built.threads,
    candidates: built.candidates,
    contributions: projectContributions(events, built.kept),
    weakLinks,
  };
}

/** One page's shipped events (newest first: at most 12 focus events, the
 *  newest touch, the newest pass) and its state. */
function pageWorkOf(list: readonly (Span & { kind: WorkEventKind })[], preMs: number | undefined, sinceMs: number): PageWork {
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
  const state: WorkState = focus ? "F" : preMs !== undefined ? "T" : "T0";
  return {
    sinceMs,
    ...(preMs !== undefined ? { preMs } : {}),
    state,
    ...(focus ? { focusMs: focus[0] } : {}),
    events: shipped,
  };
}

interface ClassedContribution {
  c: Contribution;
  kind: WorkEventKind;
  created: boolean;
}

/**
 * The weak-link rule (plan `muninn-wiki-pick-up`, D1/D10), over one session's
 * classified families, in place. Hubs are left out of the count and stay as
 * they are (D16 owns them). Among the other focus families: one alone stays
 * focus; beside a strong one (≥ {@link STRONG_MIN_EDITS} weighted edits, or
 * created), a weak one is a touch; when all are weak, the strongest stays
 * (most edits, then earliest event, then relPath). Returns the demotions.
 */
function demoteWeakLinks(classed: ClassedContribution[]): number {
  const focus = classed.filter((x) => x.kind === "focus" && !x.c.page.hub);
  if (focus.length < 2) return 0;
  const strong = (x: ClassedContribution) => x.created || x.c.edits >= STRONG_MIN_EDITS;
  const keep = focus.some(strong)
    ? new Set(focus.filter(strong))
    : new Set([
        [...focus].sort(
          (a, b) =>
            b.c.edits - a.c.edits ||
            a.c.firstMs - b.c.firstMs ||
            (a.c.page.relPath < b.c.page.relPath ? -1 : a.c.page.relPath > b.c.page.relPath ? 1 : 0),
        )[0]!,
      ]);
  let n = 0;
  for (const x of focus) {
    if (keep.has(x)) continue;
    x.kind = "touch";
    n++;
  }
  return n;
}

/** The `provider:id` a contribution names a session by: the ledger's
 *  provider through `mapLedgerProvider`, the one mapping the page `sessions:`
 *  frontmatter and `providerGlyph` use (`claude` → `claude-code`). A client
 *  joins a row to a thread's session by `workSessionRef(threadSession)`, since
 *  `WorkThreadSession.provider` keeps the ledger's spelling. */
export function workSessionRef(s: { provider: string; id: string }): string {
  return `${mapLedgerProvider(s.provider) ?? s.provider}:${s.id}`;
}

/**
 * The contributions of the shipped threads, read off the same events
 * `buildThreads` grouped — never rebuilt from timestamps. Pass events and
 * sessions outside a shipped thread (touch-only, a dropped hub-only group,
 * past the cap) contribute nothing. Order: thread order, then newest
 * `lastMs`, then session ref, then page.
 */
function projectContributions(events: readonly SessionEvent[], kept: readonly KeptThread[]): WorkContribution[] {
  const out: WorkContribution[] = [];
  const order = (a: WorkContribution, b: WorkContribution) =>
    b[6] - a[6] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  for (const t of kept) {
    const rows: WorkContribution[] = [];
    for (const e of events) {
      if (e.kind === "pass" || !t.sessions.has(e.session)) continue;
      const kind = e.kind === "focus" && t.focus.has(e.page) ? "focus" : "touch";
      rows.push([workSessionRef(e.session), e.page.relPath, t.key, kind, e.edits, e.firstMs, e.lastMs]);
    }
    out.push(...rows.sort(order));
  }
  return out;
}

function maxDefined(vals: (number | undefined)[]): number | undefined {
  let out: number | undefined;
  for (const v of vals) if (typeof v === "number" && (out === undefined || v > out)) out = v;
  return out;
}

// ── Threads (D6, D16) ───────────────────────────────────────────────────────

/** A shipped thread's membership, which `buildThreads` returns beside it: its
 *  sessions and the focus pages it KEPT (after the D16 hub moves). */
interface KeptThread {
  key: string;
  sessions: ReadonlySet<WorkSession>;
  focus: ReadonlySet<PageRec>;
}

function buildThreads(
  events: readonly SessionEvent[],
  pageRaw: ReadonlyMap<PageRec, number>,
  asOfMs: number,
): { threads: WorkThread[]; candidates: number; kept: KeptThread[] } {
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
  const out: { thread: WorkThread; score: number; group: Group }[] = [];
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
      group: g,
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
  const shipped = out.slice(0, WORK_THREADS_MAX);
  return {
    threads: shipped.map((t) => t.thread),
    candidates: out.length,
    kept: shipped.map((t) => ({ key: t.thread.key, sessions: t.group.sessions, focus: new Set(t.group.focus.keys()) })),
  };
}

/** The thread order score at `now` from the shipped per-page events — the
 *  client's input as well (D10: the browser orders). */
export function threadScore(thread: WorkThread, pageWork: (relPath: string) => PageWork | undefined, now: number): number {
  const raws = thread.pages.map((p) => rawWork(pageWork(p)?.events ?? [], now));
  if (!raws.length) return 0;
  return raws[0]! + 0.3 * raws.slice(1).reduce((s, r) => s + r, 0);
}
