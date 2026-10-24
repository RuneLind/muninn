/**
 * Seeded synthetic work threads for the five-card cap's property test
 * (`wiki-rail-work-cap.test.ts`, plan D20) and its frozen origin fixture
 * (`scripts/wiki-work-cap-freeze.ts`). Threads are built the way the server
 * builds them: sessions joined by a shared non-hub focus page, a hub's focus
 * row kept by the thread that works it most, the key the earliest non-hub
 * focus event. The draw order of the random stream is fixed: a scenario at
 * a given seed state is the same scenario in both files.
 */

import type { WikiFilters, WikiListing } from "./wiki-filter.ts";
import type { WorkGroupEvidenceToggles, WorkGroupSplit, WorkGroupStop } from "./wiki-work-group-prefs.ts";
import { WORK_EVIDENCE_VERSION, type IndexWork, type WorkContribution, type WorkThread } from "../../../wiki/work-focus.ts";

export const CAP_NOW = Date.UTC(2026, 9, 17, 20, 0);
const H = 3_600_000;
const DAY = 24 * H;
export const CAP_INERT: WikiFilters = { q: "", domain: "", folder: "", type: "", tag: "", status: "", followups: "", waiting: "", project: "", jira: "" };
export const CAP_STOPS = ["threads", "related", "areas"] as const satisfies readonly WorkGroupStop[];
/** The stream the property test and the frozen fixture walk: 1,700 scenarios
 *  at three stops, 5,100 cases. */
export const CAP_FIXTURE_START = 20261018;
export const CAP_FIXTURE_SCENARIOS = 1700;

/** A mulberry32 stream whose state is readable, so a failure names its seed. */
export class CapRandom {
  constructor(public state: number) {}
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

export interface CapWorld {
  pages: WikiListing[];
  work: IndexWork;
  /** Every thread's focus pages, in thread order. */
  focus: string[];
}

export interface CapScenario {
  /** The stream state the scenario started from. */
  seed: number;
  world: CapWorld;
  filters: WikiFilters;
  pin: string | null;
  splits: WorkGroupSplit[];
  keptApart: string[];
  /** The evidence boxes per stop, in `CAP_STOPS` order. */
  evidence: WorkGroupEvidenceToggles[];
}

function world(r: CapRandom): CapWorld {
  const NP = 15 + r.int(20);
  const NS = 12 + r.int(25);
  const pages = Array.from({ length: NP }, (_, i) => {
    const rel = `p${String(i).padStart(2, "0")}.md`;
    const hub = r.next() < 0.1;
    const at = CAP_NOW - (1 + r.int(150)) * H;
    return {
      relPath: rel,
      name: rel,
      title: `T ${rel}`,
      type: r.next() < 0.3 ? "note" : "plan",
      domain: r.next() < 0.2 ? "life" : "ai",
      tags: [],
      aliases: [],
      linkCount: 0,
      backlinkCount: hub ? 30 : 0,
      gitCreatedMs: CAP_NOW - 40 * DAY,
      work: { sinceMs: CAP_NOW - 8 * DAY, state: "F", focusMs: at, events: [[at, 1 + r.int(40), "focus"]] },
    } as unknown as WikiListing & { project?: string };
  });
  const isHub = (rel: string) => pages.find((p) => p.relPath === rel)!.backlinkCount > 25;
  const sessions = Array.from({ length: NS }, (_, i) => ({ id: `s${i}`, provider: "claude", first: CAP_NOW - (100 + r.int(80)) * H, last: CAP_NOW - r.int(90) * H, title: `S${i}` }));
  interface Ev {
    s: number;
    page: string;
    kind: "focus" | "touch";
    first: number;
    edits: number;
  }
  const evs: Ev[] = [];
  for (let s = 0; s < NS; s++) {
    const n = 1 + r.int(3);
    const used = new Set<string>();
    for (let k = 0; k < n; k++) {
      const page = pages[r.int(NP)]!.relPath;
      if (used.has(page)) continue;
      used.add(page);
      evs.push({ s, page, kind: r.next() < 0.8 ? "focus" : "touch", first: CAP_NOW - r.int(180) * H, edits: 1 + r.int(9) });
    }
  }
  const parent = Array.from({ length: NS }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  const firstFocuser = new Map<string, number>();
  for (const e of evs)
    if (e.kind === "focus" && !isHub(e.page)) {
      const p = firstFocuser.get(e.page);
      if (p === undefined) firstFocuser.set(e.page, e.s);
      else parent[find(e.s)] = find(p);
    }
  const focusing = new Set(evs.filter((e) => e.kind === "focus").map((e) => e.s));
  interface G {
    ss: Set<number>;
    focus: Map<string, Ev[]>;
    touched: Set<string>;
  }
  const groups = new Map<number, G>();
  for (const e of evs) {
    if (!focusing.has(e.s)) continue;
    const root = find(e.s);
    const g = groups.get(root) ?? { ss: new Set(), focus: new Map(), touched: new Set() };
    groups.set(root, g);
    g.ss.add(e.s);
    if (e.kind === "focus") g.focus.set(e.page, [...(g.focus.get(e.page) ?? []), e]);
    else g.touched.add(e.page);
  }
  const hubGroups = new Map<string, G[]>();
  for (const g of groups.values()) for (const p of g.focus.keys()) if (isHub(p)) hubGroups.set(p, [...(hubGroups.get(p) ?? []), g]);
  for (const [h, gs] of hubGroups) {
    if (gs.length < 2) continue;
    const best = gs.sort((a, b) => b.focus.get(h)!.length - a.focus.get(h)!.length)[0]!;
    for (const g of gs)
      if (g !== best) {
        g.focus.delete(h);
        g.touched.add(h);
      }
  }
  const threads: WorkThread[] = [];
  const rows: WorkContribution[] = [];
  for (const g of groups.values()) {
    if (!g.focus.size) continue;
    const fp = [...g.focus.keys()].sort();
    const pool = fp.some((p) => !isHub(p)) ? fp.filter((p) => !isHub(p)) : fp;
    let key: { ms: number; rel: string } | undefined;
    for (const p of pool) for (const e of g.focus.get(p)!) if (!key || e.first < key.ms || (e.first === key.ms && p < key.rel)) key = { ms: e.first, rel: p };
    const t: WorkThread = {
      key: key!.rel,
      pages: fp,
      touched: [...g.touched].filter((p) => !g.focus.has(p)).sort(),
      sessions: [...g.ss].map((i) => sessions[i]!).sort((a, b) => b.last - a.last || (a.id < b.id ? -1 : 1)),
    };
    threads.push(t);
    for (const e of evs) if (g.ss.has(e.s)) rows.push([`claude-code:s${e.s}`, e.page, t.key, e.kind === "focus" && g.focus.has(e.page) ? "focus" : "touch", e.edits, e.first, e.first + H]);
  }
  threads.sort(() => r.next() - 0.5);
  const focus = threads.flatMap((t) => t.pages);
  const related: [string, string][] = [];
  const series: Record<string, string> = {};
  const projects: Record<string, string> = {};
  for (let k = 0; k < 5 + r.int(25); k++) {
    const a = focus[r.int(focus.length)]!;
    const b = focus[r.int(focus.length)]!;
    if (a !== b) related.push([a, b]);
  }
  for (const p of focus) {
    if (r.next() < 0.2) series[p] = `ser${r.int(3)}`;
    if (r.next() < 0.4) projects[p] = `proj${r.int(3)}`;
  }
  for (const p of pages) if (projects[p.relPath]) (p as { project?: string }).project = projects[p.relPath];
  const work = {
    asOfMs: CAP_NOW - H,
    sinceMs: CAP_NOW - 8 * DAY,
    threads,
    evidence: {
      version: WORK_EVIDENCE_VERSION,
      threads: { candidates: threads.length, shipped: threads.length },
      relations: { complete: true, reasons: [], series, projects, related, issues: [], ambiguousIssues: [], relatedSkipped: { skipped: 0, ambiguous: 0 } },
      contributions: { complete: true, reasons: [], cut: [], rows },
    },
  } as unknown as IndexWork;
  return { pages, work, focus };
}

/** The next scenario on the stream: a world with at least one thread (an
 *  empty one is drawn past), then the facet, the pin, the splits, the
 *  kept-apart anchors and each stop's evidence boxes. */
export function nextCapScenario(r: CapRandom): CapScenario {
  for (;;) {
    const seed = r.state;
    const w = world(r);
    if (!w.work.threads.length) continue;
    const filters = r.next() < 0.3 ? { ...CAP_INERT, domain: "ai" } : CAP_INERT;
    const pin = r.next() < 0.4 ? w.focus[r.int(w.focus.length)]! : null;
    const splits = w.focus.filter(() => r.next() < 0.25).map((page, i) => ({ id: `x${i}`, page }));
    const keptApart = w.work.threads.filter(() => r.next() < 0.3).map((t) => t.pages[r.int(t.pages.length)]!);
    const evidence = CAP_STOPS.map(() => ({ series: r.next() < 0.8, related: r.next() < 0.8, issue: true }));
    return { seed, world: w, filters, pin, splits, keptApart, evidence };
  }
}

/** A card list as the frozen fixture compares it: PR 4's boundary fields
 *  (the chip, the card ⋯, `▸ split into N sessions`) and the Pick up plan's
 *  additive fields (the age chip's `ageMs`, a group's `hiddenChildren`) left
 *  out, since origin has none of them. */
const DIGEST_SKIP = new Set(["sessionSplit", "menu", "boundary", "ageMs", "hiddenChildren"]);
export function capCardsDigest(cards: unknown): string {
  const json = JSON.stringify(cards, (k, v) => (DIGEST_SKIP.has(k) ? undefined : v));
  return Bun.hash(json).toString(16);
}
