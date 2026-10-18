/**
 * The work-thread grouping model (plan `muninn-wiki-work-thread-grouping`,
 * «Grouping behavior»): the four stops — Sessions, Threads, Related, Areas —
 * derived from the work threads and their evidence block (`IndexWork.evidence`,
 * `src/wiki/work-evidence.ts`). Pure and DOM-free, so the reader's bundle and
 * the work replay run the same code.
 *
 * Two layers, kept apart on purpose:
 *  - {@link groupWorkThreads} decides MEMBERSHIP over the full snapshot: which
 *    threads form a group, its name and fold key, each child's owned focus
 *    pages, evidence and `also` chips. Nothing here reads the facets, so a
 *    checkbox or facet change never renames a child or moves its pages.
 *  - {@link projectWorkGroups} and {@link projectSessionCards} apply the pool
 *    and facets to the rows, drop empty children and cards, count, and cap.
 *
 * The rules (D3, D16): units are ordered by `threadRankScore` at
 * `max(now, asOfMs)`, then the server's thread index, then key. The first
 * unassigned unit anchors a group; each next unit joins the FIRST anchor it
 * connects to directly through checked evidence (OR over the kinds), else it
 * anchors a group of its own. A child is never compared with: A–B and B–C do
 * not join A and C. The pin applies after grouping.
 */

import { pageWorkTerm } from "./wiki-activity-rank.ts";
import { displayTitleOf, filterPages, type WikiFilters, type WikiListing } from "./wiki-filter.ts";
import { seriesHead, seriesKeyOf, seriesMembersByFoldKey } from "./wiki-groups.ts";
import { normalizeRel } from "./wiki-nav.ts";
import { normalizeFoldKey, railSectionsVisible, THREAD_CARDS_MAX, threadFoldKey } from "./wiki-recents.ts";
import {
  claimOwnedFocus,
  newestFocusPage,
  threadCardRows,
  threadHoldsPin,
  threadName,
  threadRankScore,
  usableThreads,
  workGroupingInstant,
  workTermOrder,
} from "./wiki-thread-core.ts";
import type { WorkGroupEvidenceToggles, WorkGroupStop } from "./wiki-work-group-prefs.ts";
import {
  WORK_EVIDENCE_VERSION,
  workSessionRef,
  type IndexWork,
  type WorkContribution,
  type WorkEvidence,
  type WorkEvidenceReason,
  type WorkThread,
  type WorkThreadSession,
} from "../../../wiki/work-focus.ts";

// ── Evidence on the wire ────────────────────────────────────────────────────

/** Why a stop (or a thread's session split) is unavailable. */
export type WorkGroupUnavailableReason =
  /** No work threads: today's no-thread fallback. */
  | "no-threads"
  /** The payload has no evidence block (an older server). */
  | "evidence-absent"
  /** The evidence block is another version, or not the shape this client reads. */
  | "evidence-unreadable"
  | WorkEvidenceReason;

export interface WorkStopAvailability {
  available: boolean;
  reasons: WorkGroupUnavailableReason[];
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The relations part as the model reads it. */
export type ReadWorkRelations = Pick<WorkEvidence["relations"], "complete" | "reasons" | "series" | "projects" | "related" | "issues">;
/** The contributions part as the model reads it. */
export type ReadWorkContributions = WorkEvidence["contributions"];

/**
 * The evidence the model reads, part by part: a part that is malformed is
 * null, so relations and contributions fail apart (the plan's «relations
 * incomplete» and «contributions incomplete» rules). Fields the model never
 * reads (`threads`, `ambiguousIssues`, `relatedSkipped`) are not parsed.
 */
export interface ReadWorkEvidence {
  relations: ReadWorkRelations | null;
  contributions: ReadWorkContributions | null;
}

/** `complete` and `reasons` agree: complete exactly when there is no reason. */
function completeness(v: Record<string, unknown>): { complete: boolean; reasons: WorkEvidenceReason[] } | null {
  const { complete, reasons } = v;
  if (typeof complete !== "boolean" || !Array.isArray(reasons) || !reasons.every(isStr)) return null;
  if (complete !== (reasons.length === 0)) return null;
  return { complete, reasons: reasons as WorkEvidenceReason[] };
}

function strRecord(v: unknown): Record<string, string> | null {
  if (!isRec(v)) return null;
  for (const x of Object.values(v)) if (!isStr(x)) return null;
  return v as Record<string, string>;
}

function strTuples<T extends string[]>(v: unknown, n: number): T[] | null {
  if (!Array.isArray(v)) return null;
  return v.every((x) => Array.isArray(x) && x.length === n && x.every(isStr)) ? (v as T[]) : null;
}

function readRelations(r: unknown): ReadWorkRelations | null {
  if (!isRec(r)) return null;
  const c = completeness(r);
  const series = strRecord(r.series);
  const projects = strRecord(r.projects);
  const related = strTuples<[string, string]>(r.related, 2);
  const issues = strTuples<[string, string, string]>(r.issues, 3);
  if (!c || !series || !projects || !related || !issues) return null;
  return { ...c, series, projects, related, issues };
}

/** Every row is well-formed and joins its OWN shipped thread's sessions
 *  through `workSessionRef` (the evidence contract), so a session card
 *  always has the ledger's title and span. */
function readContributions(c: unknown, threads: readonly WorkThread[]): ReadWorkContributions | null {
  if (!isRec(c)) return null;
  const done = completeness(c);
  if (!done || !Array.isArray(c.cut) || !c.cut.every(isStr) || !Array.isArray(c.rows)) return null;
  const cut = c.cut as string[];
  // `cut` is non-empty exactly when `reasons` holds the cap.
  if ((cut.length > 0) !== done.reasons.includes("contributions-cap")) return null;
  const refsOf = new Map(threads.map((t) => [t.key, new Set(t.sessions.map(workSessionRef))] as const));
  for (const x of c.rows as unknown[]) {
    if (!Array.isArray(x) || x.length !== 7) return null;
    const [ref, page, thread, kind, edits, first, last] = x;
    if (!isStr(ref) || !isStr(page) || !isStr(thread) || (kind !== "focus" && kind !== "touch")) return null;
    if (!isNum(edits) || !isNum(first) || !isNum(last)) return null;
    // The join also refuses a ref with no `provider:` prefix: every
    // `workSessionRef` has one.
    if (cut.includes(thread) || !refsOf.get(thread)?.has(ref)) return null;
  }
  return { ...done, cut, rows: c.rows as WorkContribution[] };
}

/**
 * The evidence block of a payload, as this client can read it. Absent, not
 * an object or another version: no evidence at all. Otherwise each part is
 * validated whole against the shipped `threads` — one malformed entry makes
 * that part unreadable (null), never a silently shorter list.
 */
export function readWorkEvidence(
  raw: unknown,
  threads: unknown,
): { evidence: ReadWorkEvidence | null; reason?: "evidence-absent" | "evidence-unreadable" } {
  if (raw === undefined || raw === null) return { evidence: null, reason: "evidence-absent" };
  if (!isRec(raw) || raw.version !== WORK_EVIDENCE_VERSION) return { evidence: null, reason: "evidence-unreadable" };
  return { evidence: { relations: readRelations(raw.relations), contributions: readContributions(raw.contributions, usableThreads(threads)) } };
}

// ── Units ───────────────────────────────────────────────────────────────────

/**
 * What the grouping orders and joins: a thread, or (PR 4) a page split off a
 * thread or a thread kept apart. PR 4 applies page assignments by handing
 * {@link groupWorkThreads} its own units; the model never reads the
 * preference record itself.
 */
export interface WorkUnit {
  /** The thread key — for a split page, the page. */
  key: string;
  /** The server's array index of the source thread: the order tie-break. */
  index: number;
  /** 0 for a thread; a split page sorts after its source by this. */
  sub: number;
  /** The thread the unit is RANKED by: the source thread as the server
   *  shipped it, so a split page follows its source thread. */
  rank: WorkThread;
  /** Membership: focus pages, touched pages and sessions. */
  thread: WorkThread;
  /** Never joins a group and is never joined (a split page, a kept-apart thread). */
  isolated: boolean;
  /** PR 4: the Make own thread definition this unit is (`wiki-work-boundaries.ts`). */
  split?: { id: string; page: string };
  /** PR 4: the kept-apart anchors that isolate this unit, as stored. */
  keptApart?: string[];
}

/** One unit per usable thread, in the server's order — today's membership. */
export function workUnitsFromThreads(threads: unknown): WorkUnit[] {
  return usableThreads(threads).map((t, index) => ({ key: t.key, index, sub: 0, rank: t, thread: t, isolated: false }));
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export { workGroupingInstant };

/** Units in grouping order (D16): `threadRankScore` descending, then the
 *  server's index, then `sub`, then key. No pin step. */
export function orderWorkUnits(
  units: readonly WorkUnit[],
  byRel: ReadonlyMap<string, WikiListing>,
  at: number,
): { unit: WorkUnit; score: number }[] {
  const scoreOf = new Map<WorkThread, number>();
  const score = (t: WorkThread) => {
    let s = scoreOf.get(t);
    if (s === undefined) scoreOf.set(t, (s = threadRankScore(t, byRel, at)));
    return s;
  };
  return units
    .map((unit) => ({ unit, score: score(unit.rank) }))
    .sort((a, b) => b.score - a.score || a.unit.index - b.unit.index || a.unit.sub - b.unit.sub || cmpStr(a.unit.key, b.unit.key));
}

// ── Evidence between two units ──────────────────────────────────────────────

export type WorkEvidenceKind = "series" | "related" | "issue" | "project";
export const WORK_EVIDENCE_KINDS: readonly WorkEvidenceKind[] = ["series", "related", "issue", "project"];

/** One reason two threads connect, naming focus pages (as the evidence spells them). */
export type WorkWitness =
  | { kind: "series"; key: string; label: string }
  | { kind: "related"; from: string; to: string }
  | { kind: "issue"; key: string; owner: string; referrer: string }
  | { kind: "project"; key: string };

interface EvidenceIndex {
  seriesOf: Map<string, string>;
  projectOf: Map<string, string>;
  related: readonly [string, string][];
  issues: readonly [string, string, string][];
  seriesLabel: (key: string) => string;
}

function evidenceIndex(rel: ReadWorkRelations | null, allPages: readonly WikiListing[]): EvidenceIndex {
  const seriesOf = new Map<string, string>();
  const projectOf = new Map<string, string>();
  for (const [p, k] of Object.entries(rel?.series ?? {})) seriesOf.set(normalizeRel(p), k);
  for (const [p, k] of Object.entries(rel?.projects ?? {})) projectOf.set(normalizeRel(p), k);
  let census: Map<string, WikiListing[]> | null = null;
  const labels = new Map<string, string>();
  const seriesLabel = (key: string): string => {
    let l = labels.get(key);
    if (l !== undefined) return l;
    census ??= seriesMembersByFoldKey(allPages);
    const head = seriesHead(census.get(key) ?? []);
    l = head?.seriesLabel || (head ? seriesKeyOf(head) : "") || key;
    labels.set(key, l);
    return l;
  };
  return { seriesOf, projectOf, related: rel?.related ?? [], issues: rel?.issues ?? [], seriesLabel };
}

interface UnitFacts {
  pages: Set<string>;
  /** Census keys, in page order, deduped. */
  series: string[];
  projects: string[];
  /** The top focus page's series and project — "the anchor's own value". */
  topSeries?: string;
  topProject?: string;
}

function unitFacts(u: WorkUnit, ix: EvidenceIndex): UnitFacts {
  const pages = u.thread.pages.map(normalizeRel);
  const uniq = (vals: (string | undefined)[]) => [...new Set(vals.filter(isStr))];
  return {
    pages: new Set(pages),
    series: uniq(pages.map((p) => ix.seriesOf.get(p))),
    projects: uniq(pages.map((p) => ix.projectOf.get(p))),
    topSeries: pages[0] ? ix.seriesOf.get(pages[0]) : undefined,
    topProject: pages[0] ? ix.projectOf.get(pages[0]) : undefined,
  };
}

/** Every checked witness between `a` and `b` (either direction). Project
 *  counts only at Areas, where it is always on. */
function witnessesBetween(
  a: UnitFacts,
  b: UnitFacts,
  ix: EvidenceIndex,
  toggles: WorkGroupEvidenceToggles,
  areas: boolean,
): WorkWitness[] {
  const out: WorkWitness[] = [];
  if (toggles.series) for (const k of a.series) if (b.series.includes(k)) out.push({ kind: "series", key: k, label: ix.seriesLabel(k) });
  if (toggles.related) {
    for (const [from, to] of ix.related) {
      const f = normalizeRel(from);
      const t = normalizeRel(to);
      if ((a.pages.has(f) && b.pages.has(t)) || (b.pages.has(f) && a.pages.has(t))) out.push({ kind: "related", from, to });
    }
  }
  if (toggles.issue) {
    for (const [key, owner, referrer] of ix.issues) {
      const o = normalizeRel(owner);
      const r = normalizeRel(referrer);
      if ((a.pages.has(o) && b.pages.has(r)) || (b.pages.has(o) && a.pages.has(r))) out.push({ kind: "issue", key, owner, referrer });
    }
  }
  if (areas) for (const k of a.projects) if (b.projects.includes(k)) out.push({ kind: "project", key: k });
  return uniqueWitnesses(out);
}

/** Witnesses without repeats, first spelling kept. A related pair is
 *  unordered: `[a, b]` and `[b, a]` are one witness. */
function uniqueWitnesses(ws: readonly WorkWitness[]): WorkWitness[] {
  const seen = new Set<string>();
  return ws.filter((w) => {
    const k =
      w.kind === "related"
        ? JSON.stringify(["related", ...[normalizeRel(w.from), normalizeRel(w.to)].sort()])
        : JSON.stringify(w);
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

const kindsOf = (ws: readonly WorkWitness[]): WorkEvidenceKind[] => WORK_EVIDENCE_KINDS.filter((k) => ws.some((w) => w.kind === k));

// ── The model ───────────────────────────────────────────────────────────────

export interface WorkGroupChild {
  unit: WorkUnit;
  key: string;
  /** Today's `thread:<key>`. */
  foldKey: string;
  /** The top page the child OWNS in the full listing, cut at ` — `. */
  name: string;
  score: number;
  /** The child holding the reader's pinned page (D7). */
  pinned: boolean;
  /** The page a 📌 on this child stores (`newestFocusPage`). */
  pinAnchor: string;
  /** Focus pages this child owns in the full listing, by work term (a page an
   *  earlier child owns is not here — a hub has one owner, D16). */
  owned: WikiListing[];
  /** The evidence kinds that joined this child to the anchor; empty for the
   *  anchor and for a thread on its own (the third meta line). */
  joinedBy: WorkEvidenceKind[];
  witnesses: WorkWitness[];
  /** D9: series this child has focus pages in other than the group's name,
   *  by label. Empty outside a group of two or more. */
  also: { key: string; label: string }[];
  /** `▸ split into N sessions` and Make own thread need this thread's
   *  contribution rows whole. */
  sessions: WorkStopAvailability;
}

/** How a group is named: a series (Related, Areas), a project (Areas), the
 *  anchor's title under a `RELATED` label, or a lone thread's own title. */
export type WorkGroupLabel = "series" | "project" | "related" | "thread";

export interface WorkGroup {
  /** `thread`: one unit, drawn as today's thread card. */
  kind: "group" | "thread";
  label: WorkGroupLabel;
  name: string;
  /** The census key or project the name came from. */
  nameKey?: string;
  /** `group:series:<key>`, `group:project:<key>`, `group:anchor:<anchor key>`
   *  (a duplicate name past the first takes the anchor form); a lone thread
   *  keeps `thread:<key>`. Normalized like every fold key. */
  foldKey: string;
  anchorKey: string;
  pinned: boolean;
  /** Anchor first, then the joined children in grouping order. */
  children: WorkGroupChild[];
  /** Every child's witnesses, deduplicated (the group's disclosure). */
  witnesses: WorkWitness[];
}

export interface WorkSessionCard {
  /** `workSessionRef`: `claude-code:<id>`. */
  ref: string;
  id: string;
  provider: string;
  /** The ledger's session title, never a derived name. */
  title: string;
  first: number;
  last: number;
  threadKey: string;
  foldKey: string;
  /** Focus pages this card owns: the newest session holding a page owns it (D19). */
  rows: WikiListing[];
  /** Focus pages an earlier (newer) card owns: the non-claiming `also in:` line. */
  alsoIn: WikiListing[];
  touched: WikiListing[];
}

export interface WorkGrouping {
  /** The stop the reader chose. */
  requested: WorkGroupStop;
  /** The stop drawn: `threads` when the chosen one is unavailable. */
  stop: WorkGroupStop;
  /** The checkboxes as chosen — kept even where they do not apply. */
  toggles: WorkGroupEvidenceToggles;
  /** Do the checkboxes apply at the drawn stop (Related, Areas)? Elsewhere
   *  they show disabled with their values. */
  togglesApply: boolean;
  availability: Record<WorkGroupStop, WorkStopAvailability>;
  /** Threads, Related, Areas: the cards. Empty at Sessions. */
  groups: WorkGroup[];
  /** Sessions: the cards. Empty at every other stop. */
  sessions: WorkSessionCard[];
}

export interface WorkGroupingInput {
  /** `/api/wiki/pages`' `work`; null or absent with no sessions memo. */
  work: Partial<Pick<IndexWork, "asOfMs" | "threads" | "evidence">> | null | undefined;
  /** The full listing: rank, names and ownership read it, never the pool. */
  allPages: readonly WikiListing[];
  /** The reader's anchored instant. */
  now: number;
  stop: WorkGroupStop;
  toggles: WorkGroupEvidenceToggles;
  /** The reader's pinned work-thread page, or null. */
  pin?: string | null;
  /** PR 4: units after page assignments. Default {@link workUnitsFromThreads}. */
  units?: readonly WorkUnit[];
  /** D20: the only pages (normalized) a child may own — one base card's
   *  pages, when `openWorkCards` regroups that card's units after the
   *  reader's boundaries, so no boundary moves a page to another card. */
  ownable?: ReadonlySet<string>;
  /** D20: fold keys other cards already hold; a named group whose key is
   *  here takes the anchor form instead. */
  foldKeysTaken?: Iterable<string>;
}

const OK: WorkStopAvailability = { available: true, reasons: [] };
const off = (...r: WorkGroupUnavailableReason[]): WorkStopAvailability => ({ available: false, reasons: r });

/**
 * Whether one thread's contribution rows ship whole (D15, D19): readable
 * contributions, and complete — or incomplete only by the cap, with this
 * thread not among the cut. Any other reason, known or not, holds for every
 * thread. The Sessions stop ({@link availabilityOf}) needs `complete`, so a
 * stop that is available implies every split is.
 */
export function threadSessionsAvailability(evidence: ReadWorkEvidence | null, threadKey: string, absent?: WorkGroupUnavailableReason): WorkStopAvailability {
  if (!evidence) return off(absent ?? "evidence-absent");
  const c = evidence.contributions;
  if (!c) return off("evidence-unreadable");
  if (c.complete) return OK;
  const other = c.reasons.filter((r) => r !== "contributions-cap");
  if (other.length) return off(...c.reasons);
  return c.cut.includes(threadKey) ? off(...c.reasons) : OK;
}

function availabilityOf(hasThreads: boolean, evidence: ReadWorkEvidence | null, absent?: WorkGroupUnavailableReason): Record<WorkGroupStop, WorkStopAvailability> {
  if (!hasThreads) return { sessions: off("no-threads"), threads: off("no-threads"), related: off("no-threads"), areas: off("no-threads") };
  if (!evidence) {
    const a = off(absent ?? "evidence-absent");
    return { sessions: a, threads: OK, related: a, areas: a };
  }
  const part = (p: { complete: boolean; reasons: WorkEvidenceReason[] } | null) =>
    !p ? off("evidence-unreadable") : p.complete ? OK : off(...p.reasons);
  const rel = part(evidence.relations);
  return { sessions: part(evidence.contributions), threads: OK, related: rel, areas: rel };
}

/**
 * The grouping for one stop over the full snapshot. Membership, names, fold
 * keys and ownership only — {@link projectWorkGroups} applies the facets.
 */
export function groupWorkThreads(input: WorkGroupingInput): WorkGrouping {
  const units = input.units ?? workUnitsFromThreads(input.work?.threads);
  const { evidence, reason } = readWorkEvidence(input.work?.evidence, input.work?.threads);
  const availability = availabilityOf(units.length > 0, evidence, reason);
  const stop = availability[input.stop].available ? input.stop : "threads";
  const base = {
    requested: input.stop,
    stop,
    toggles: { ...input.toggles },
    togglesApply: stop === "related" || stop === "areas",
    availability,
  };
  if (!units.length) return { ...base, groups: [], sessions: [] };

  const at = workGroupingInstant(input.now, input.work?.asOfMs);
  if (stop === "sessions") return { ...base, groups: [], sessions: workSessionCards(input.work, input.allPages, at) };

  const byRel = new Map<string, WikiListing>();
  for (const p of input.allPages) byRel.set(normalizeRel(p.relPath), p);
  const ix = evidenceIndex(evidence?.relations ?? null, input.allPages);
  const ordered = orderWorkUnits(units, byRel, at);
  const facts = new Map<WorkUnit, UnitFacts>(ordered.map(({ unit }) => [unit, unitFacts(unit, ix)]));
  const grouping = stop === "related" || stop === "areas";

  // D3: the direct-anchor rule, OR over the checked kinds.
  interface Draft {
    members: { unit: WorkUnit; score: number; witnesses: WorkWitness[] }[];
  }
  const drafts: Draft[] = [];
  for (const { unit, score } of ordered) {
    let joined = false;
    if (grouping && !unit.isolated) {
      for (const d of drafts) {
        const anchor = d.members[0]!.unit;
        if (anchor.isolated) continue;
        const ws = witnessesBetween(facts.get(anchor)!, facts.get(unit)!, ix, input.toggles, stop === "areas");
        if (!ws.length) continue;
        d.members.push({ unit, score, witnesses: ws });
        joined = true;
        break;
      }
    }
    if (!joined) drafts.push({ members: [{ unit, score, witnesses: [] }] });
  }

  // Names and fold keys, in grouping order (before the pin, so a pin never
  // moves a name key between two same-named groups or renames a group).
  const byTerm = workTermOrder(at);
  const ownable = input.ownable;
  const ownPages = (u: WorkUnit) => (ownable ? u.thread.pages.filter((p) => ownable.has(normalizeRel(p))) : u.thread.pages);
  const namedKeys = new Set<string>(input.foldKeysTaken ?? []);
  const freeTaken = new Set<string>();
  const named = drafts.map((d) => {
    const anchor = d.members[0]!.unit;
    // Ownership in this pin-free order, for the RELATED name only.
    const freeOwned = d.members.map((m) => claimOwnedFocus(ownPages(m.unit), byRel, freeTaken, byTerm));
    if (d.members.length === 1) return { label: "thread" as const, foldKey: threadFoldKey(anchor.key), title: "" };
    const fs = d.members.map((m) => facts.get(m.unit)!);
    const af = facts.get(anchor)!;
    const pick = (vals: (f: UnitFacts) => string[], top: string | undefined, labelOf: (k: string) => string) => {
      const cands = vals(fs[0]!).filter((v) => fs.every((f) => vals(f).includes(v)));
      if (!cands.length) return undefined;
      if (top && cands.includes(top)) return top;
      return cands.sort((x, y) => cmpStr(labelOf(x), labelOf(y)) || cmpStr(x, y))[0];
    };
    const series = () => pick((f) => f.series, af.topSeries, ix.seriesLabel);
    let label: WorkGroupLabel = "related";
    let nameKey: string | undefined;
    if (stop === "areas") {
      nameKey = pick((f) => f.projects, af.topProject, (k) => k);
      if (nameKey) label = "project";
    }
    if (!nameKey) {
      nameKey = series();
      if (nameKey) label = "series";
    }
    let foldKey = normalizeFoldKey(`group:anchor:${anchor.key}`);
    if (nameKey) {
      const nk = normalizeFoldKey(`group:${label}:${nameKey}`);
      if (!namedKeys.has(nk)) {
        namedKeys.add(nk);
        foldKey = nk;
      }
    }
    // RELATED: the anchor's title — unless the anchor owns no page (an
    // earlier card's child claimed them all, D16), when that title is another
    // card's row; then the first child that owns one names it.
    const at0 = freeOwned.findIndex((o) => o.length > 0);
    const title = childName(d.members[Math.max(at0, 0)]!.unit, freeOwned[Math.max(at0, 0)]!, byRel);
    return { label, nameKey, foldKey, title };
  });

  // The pin, after grouping: the first unit in order holding the pinned page
  // (`threadHoldsPin`, over the units — after splits) moves its group first.
  const pinKey = input.pin ? normalizeRel(input.pin) : null;
  const pinnedUnit = pinKey ? ordered.find(({ unit }) => threadHoldsPin(unit.thread, byRel, pinKey))?.unit : undefined;
  const order = drafts.map((_, i) => i);
  const pinnedAt = pinnedUnit ? drafts.findIndex((d) => d.members.some((m) => m.unit === pinnedUnit)) : -1;
  if (pinnedAt > 0) {
    order.splice(pinnedAt, 1);
    order.unshift(pinnedAt);
  }

  // Ownership over the full listing in the drawn order: a page an earlier
  // child owns is neither a row nor the name of a later one.
  const taken = new Set<string>();
  const groups: WorkGroup[] = order.map((i) => {
    const d = drafts[i]!;
    const n = named[i]!;
    const nameSeries = n.label === "series" ? n.nameKey : undefined;
    const children: WorkGroupChild[] = d.members.map((m) => {
      const owned = claimOwnedFocus(ownPages(m.unit), byRel, taken, byTerm);
      const also =
        d.members.length > 1
          ? facts
              .get(m.unit)!
              .series.filter((k) => k !== nameSeries)
              .map((k) => ({ key: k, label: ix.seriesLabel(k) }))
              .sort((x, y) => cmpStr(x.label, y.label) || cmpStr(x.key, y.key))
          : [];
      return {
        unit: m.unit,
        key: m.unit.key,
        foldKey: threadFoldKey(m.unit.key),
        name: childName(m.unit, owned, byRel),
        score: m.score,
        pinned: m.unit === pinnedUnit,
        pinAnchor: newestFocusPage(m.unit.thread, byRel),
        owned,
        joinedBy: kindsOf(m.witnesses),
        witnesses: m.witnesses,
        also,
        // The contribution rows name the SOURCE thread (a split's remainder
        // and pages rank by it, `unit.rank`).
        sessions: threadSessionsAvailability(evidence, m.unit.rank.key, reason),
      };
    });
    const witnesses = uniqueWitnesses(children.flatMap((c) => c.witnesses));
    const anchor = children[0]!;
    // The fold key stays the anchor's whichever child names a RELATED group.
    const name =
      n.label === "series" ? ix.seriesLabel(n.nameKey!) : n.label === "project" ? n.nameKey! : n.label === "related" ? n.title : anchor.name;
    return {
      kind: d.members.length > 1 ? "group" : "thread",
      label: n.label,
      name,
      ...(n.nameKey ? { nameKey: n.nameKey } : {}),
      foldKey: n.foldKey,
      anchorKey: anchor.key,
      pinned: children.some((c) => c.pinned),
      children,
      witnesses,
    };
  });
  return { ...base, groups, sessions: [] };
}

/** A child's name: the top page it owns, else its first focus page, cut at ` — `. */
function childName(u: WorkUnit, owned: readonly WikiListing[], byRel: ReadonlyMap<string, WikiListing>): string {
  const top = owned[0] ?? byRel.get(normalizeRel(u.thread.pages[0] ?? ""));
  return top ? threadName(displayTitleOf(top)) : u.key;
}

// ── Sessions (D19) ──────────────────────────────────────────────────────────

/**
 * One card per session with a kept focus contribution, from the contribution
 * rows (never from timestamps): newest `last` first, then the session id (the
 * server's `thread.sessions` order), then the full ref.
 * Each focus page is a row of the first card holding it and an `also in:`
 * link on every later one. With `threadKey`, only that thread's rows — the
 * `▸ split into N sessions` view. Splits and kept-apart threads do not apply.
 */
export function workSessionCards(
  work: Partial<Pick<IndexWork, "threads" | "evidence">> | null | undefined,
  allPages: readonly WikiListing[],
  now: number,
  threadKey?: string,
  /** Only these focus pages (normalized): a split's remainder or page. */
  pages?: ReadonlySet<string>,
): WorkSessionCard[] {
  const contributions = readWorkEvidence(work?.evidence, work?.threads).evidence?.contributions;
  if (!contributions) return [];
  const byRel = new Map<string, WikiListing>();
  for (const p of allPages) byRel.set(normalizeRel(p.relPath), p);
  const meta = new Map<string, WorkThreadSession>();
  for (const t of usableThreads(work?.threads)) for (const s of t.sessions) if (!meta.has(workSessionRef(s))) meta.set(workSessionRef(s), s);

  interface Acc { thread: string; focus: Set<string>; touch: Set<string> }
  const acc = new Map<string, Acc>();
  for (const [ref, page, thread, kind] of contributions.rows) {
    if (threadKey !== undefined && thread !== threadKey) continue;
    if (pages && kind === "focus" && !pages.has(normalizeRel(page))) continue;
    let a = acc.get(ref);
    if (!a) acc.set(ref, (a = { thread, focus: new Set(), touch: new Set() }));
    (kind === "focus" ? a.focus : a.touch).add(normalizeRel(page));
  }
  const term = (p: WikiListing) => pageWorkTerm(p, now);
  const byTerm = (a: WikiListing, b: WikiListing) => term(b) - term(a) || cmpStr(normalizeRel(a.relPath), normalizeRel(b.relPath));
  const listed = (rels: Iterable<string>) => [...rels].map((r) => byRel.get(r)).filter((p): p is WikiListing => !!p);
  const cards = [...acc]
    .filter(([, a]) => a.focus.size > 0)
    .map(([ref, a]) => {
      // `readContributions` refuses a row whose ref joins no shipped session.
      const s = meta.get(ref)!;
      return { ref, id: s.id, provider: s.provider, title: s.title, first: s.first, last: s.last, threadKey: a.thread, acc: a };
    })
    .sort((x, y) => y.last - x.last || cmpStr(x.id, y.id) || cmpStr(x.ref, y.ref));
  const taken = new Set<string>();
  return cards.map(({ acc: a, ...c }) => {
    const focus = listed(a.focus).sort(byTerm);
    const rows = focus.filter((p) => !taken.has(normalizeRel(p.relPath)));
    const alsoIn = focus.filter((p) => taken.has(normalizeRel(p.relPath)));
    for (const p of rows) taken.add(normalizeRel(p.relPath));
    const touched = listed([...a.touch].filter((r) => !a.focus.has(r))).sort(byTerm);
    return { ...c, foldKey: normalizeFoldKey(`session:${c.ref}`), rows, alsoIn, touched };
  });
}

// ── The visible projection ──────────────────────────────────────────────────

export interface WorkGroupChildView {
  child: WorkGroupChild;
  /** The child's owned focus pages in the pool, under the facets. */
  focus: WikiListing[];
  /** Pages created inside the window, normalized. */
  created: string[];
  touched: WikiListing[];
  movesYou: number;
}

export interface WorkGroupView {
  group: WorkGroup;
  children: WorkGroupChildView[];
  /** False only when an active facet hid every row the anchor owns in the
   *  pool and a child is still visible: the name stays, and the card says the
   *  anchor is outside the filters. An anchor with no row even unfiltered
   *  (it owns no page, or Show retired is off and its pages are retired) is
   *  not outside the filters: no label. */
  anchorVisible: boolean;
  /** `N threads · M sessions · ✋ K`: sessions deduplicated by
   *  `workSessionRef` across the visible children. */
  counts: { threads: number; sessions: number; movesYou: number };
}

function visibleSet(pages: readonly WikiListing[], filters: WikiFilters): Set<string> {
  return new Set(filterPages(pages as WikiListing[], filters).map((p) => normalizeRel(p.relPath)));
}

/**
 * The cards as drawn: each child's owned rows in the pool under the facets,
 * a child with no row dropped, a group with no child dropped, then at most
 * `cap` cards. A query draws no section (`railSectionsVisible`).
 */
export function projectWorkGroups(
  grouping: WorkGrouping,
  pool: readonly WikiListing[],
  filters: WikiFilters,
  now: number,
  cap: number = THREAD_CARDS_MAX,
): WorkGroupView[] {
  if (!railSectionsVisible(filters)) return [];
  const visible = visibleSet(pool, filters);
  const unfiltered = new Set(pool.map((p) => normalizeRel(p.relPath)));
  const byRel = new Map(pool.map((p) => [normalizeRel(p.relPath), p] as const));
  const out: WorkGroupView[] = [];
  for (const group of grouping.groups) {
    if (out.length >= cap) break;
    const children: WorkGroupChildView[] = [];
    for (const child of group.children) {
      // The created window stays on the reader's `now`.
      const rows = threadCardRows(child.owned, child.unit.thread.touched, visible, byRel, now);
      if (!rows.focus.length) continue;
      children.push({ child, ...rows });
    }
    if (!children.length) continue;
    const sessions = new Set<string>();
    for (const c of children) for (const s of c.child.unit.thread.sessions) sessions.add(workSessionRef(s));
    out.push({
      group,
      children,
      anchorVisible: children[0]!.child === group.children[0] || !group.children[0]!.owned.some((p) => unfiltered.has(normalizeRel(p.relPath))),
      counts: { threads: children.length, sessions: sessions.size, movesYou: children.reduce((n, c) => n + c.movesYou, 0) },
    });
  }
  return out;
}

export interface WorkSessionCardView {
  card: WorkSessionCard;
  rows: WikiListing[];
  alsoIn: WikiListing[];
  touched: WikiListing[];
}

/** Session cards as drawn: rows, `also in:` links and touched pages in the
 *  pool under the facets; a card left with neither a row nor an `also in:`
 *  link is dropped; then at most `cap` cards. */
export function projectSessionCards(
  cards: readonly WorkSessionCard[],
  pool: readonly WikiListing[],
  filters: WikiFilters,
  cap: number = THREAD_CARDS_MAX,
): WorkSessionCardView[] {
  if (!railSectionsVisible(filters)) return [];
  const visible = visibleSet(pool, filters);
  const vis = (ps: readonly WikiListing[]) => ps.filter((p) => visible.has(normalizeRel(p.relPath)));
  const out: WorkSessionCardView[] = [];
  for (const card of cards) {
    if (out.length >= cap) break;
    const rows = vis(card.rows);
    const alsoIn = vis(card.alsoIn);
    if (!rows.length && !alsoIn.length) continue;
    out.push({ card, rows, alsoIn, touched: vis(card.touched) });
  }
  return out;
}
