/**
 * The Work threads rail with the reader's boundaries (PR 4 of plan
 * `muninn-wiki-work-thread-grouping`): splits and kept-apart threads applied
 * before grouping, the pin's split rows (S1–S5, one test each), the Sessions
 * stop under D19 and `▸ split into N sessions`, the card ⋯ data, the reset
 * area, and Save as series on a group card. Synthetic threads only.
 */

import { describe, expect, test } from "bun:test";
import { openWorkCards, railInputFor, threadPinAnchor, workBoundariesOf, type RailWikiFacts, type RailWorkGroupView } from "./wiki-rail-input.ts";
import { buildRail, isRailGroupCard, openWorkThreadCards, threadPinStep, type RailGroupCard, type RailThreadCard, type RailWorkCard } from "./wiki-recents.ts";
import { DEFAULT_ACTIVITY_WEIGHTS } from "./wiki-activity-rank.ts";
import type { WikiFilters, WikiListing } from "./wiki-filter.ts";
import type { WorkGroupEvidenceToggles, WorkGroupSplit } from "./wiki-work-group-prefs.ts";
import { WORK_EVIDENCE_VERSION, type IndexWork, type WorkContribution, type WorkThread } from "../../../wiki/work-focus.ts";
import { CAP_NOW, CapRandom, nextCapScenario } from "./wiki-rail-work-cap-gen.ts";

const NOW = Date.UTC(2026, 9, 17, 20, 0);
const H = 3_600_000;
const DAY = 24 * H;
const ALL: WorkGroupEvidenceToggles = { series: true, related: true, issue: true };
const INERT: WikiFilters = { q: "", domain: "", folder: "", type: "", tag: "", status: "", followups: "", waiting: "", project: "", jira: "" };

function page(relPath: string, s: { edits?: number; focusAgo?: number; series?: string; seriesLabel?: string; type?: string; parent?: string; pairedBy?: string } = {}): WikiListing {
  const at = NOW - (s.focusAgo ?? 2) * H;
  return {
    relPath,
    name: relPath,
    title: `T ${relPath}`,
    type: s.type ?? "plan",
    domain: "ai",
    tags: [],
    aliases: [],
    linkCount: 0,
    backlinkCount: 0,
    gitCreatedMs: NOW - 40 * DAY,
    ...(s.series ? { series: s.series } : {}),
    ...(s.seriesLabel ? { seriesLabel: s.seriesLabel } : {}),
    ...(s.parent ? { parent: s.parent, pairedBy: s.pairedBy ?? "stem" } : {}),
    work: { sinceMs: NOW - 8 * DAY, state: "F", focusMs: at, events: [[at, s.edits ?? 3, "focus"]] },
  } as WikiListing;
}
const sess = (id: string, ago: number) => ({ id, provider: "claude", first: NOW - (ago + 1) * H, last: NOW - ago * H, title: `title ${id}` });
const row = (id: string, p: string, t: string, ago: number, kind: "focus" | "touch" = "focus"): WorkContribution => [`claude-code:${id}`, p, t, kind, 2, NOW - ago * H, NOW - (ago - 1) * H];

/**
 * Thread T (key plans/k.md): plans/k.md (s1), plans/p.md (s1, s2), plans/q.md
 * (s3) — p.md is T's newest focus page. Thread A (plans/a.md, series alpha)
 * and thread B (plans/b.md, series alpha) form a SERIES group; T relates to
 * nothing. Thread L (notes/l.md) is a lone reference page.
 */
function fixture(o: { cut?: boolean } = {}) {
  const pages = [
    page("plans/k.md", { edits: 50, focusAgo: 8 }),
    page("plans/p.md", { edits: 40, focusAgo: 1 }),
    page("plans/q.md", { edits: 30, focusAgo: 5 }),
    page("plans/a.md", { edits: 20, series: "alpha", seriesLabel: "Alpha" }),
    page("plans/b.md", { edits: 10, series: "alpha" }),
    page("notes/l.md", { edits: 5, type: "note" }),
  ];
  const T: WorkThread = { key: "plans/k.md", pages: ["plans/k.md", "plans/p.md", "plans/q.md"], touched: [], sessions: [sess("s2", 1), sess("s1", 3), sess("s3", 5)] };
  const A: WorkThread = { key: "plans/a.md", pages: ["plans/a.md"], touched: [], sessions: [sess("s4", 2)] };
  const B: WorkThread = { key: "plans/b.md", pages: ["plans/b.md"], touched: [], sessions: [sess("s5", 3)] };
  const L: WorkThread = { key: "notes/l.md", pages: ["notes/l.md"], touched: [], sessions: [sess("s6", 4)] };
  const threads = [T, A, B, L];
  const rows = [
    row("s1", "plans/k.md", "plans/k.md", 9),
    row("s1", "plans/p.md", "plans/k.md", 4),
    row("s2", "plans/p.md", "plans/k.md", 2),
    row("s3", "plans/q.md", "plans/k.md", 6),
    row("s4", "plans/a.md", "plans/a.md", 3),
    row("s5", "plans/b.md", "plans/b.md", 4),
    row("s6", "notes/l.md", "notes/l.md", 5),
  ];
  const work: IndexWork = {
    asOfMs: NOW - H,
    sinceMs: NOW - 8 * DAY,
    threads,
    evidence: {
      version: WORK_EVIDENCE_VERSION,
      threads: { candidates: 4, shipped: 4 },
      relations: { complete: true, reasons: [], series: { "plans/a.md": "alpha", "plans/b.md": "alpha" }, projects: {}, related: [], issues: [], ambiguousIssues: [], relatedSkipped: { skipped: 0, ambiguous: 0 } },
      contributions: o.cut
        ? { complete: false, reasons: ["contributions-cap"], cut: ["plans/k.md"], rows: rows.filter((r) => r[2] !== "plans/k.md") }
        : { complete: true, reasons: [], cut: [], rows },
    },
  };
  return { pages, work };
}

type View = Partial<RailWorkGroupView>;
const at = (stop: RailWorkGroupView["stop"], v: View = {}, fx = fixture(), pin: string | null = null, folds: string[] = []) =>
  openWorkCards(fx.work, fx.pages, INERT, folds, pin, NOW, fx.pages, { stop, evidence: ALL, ...v });
const P: WorkGroupSplit = { id: "sp", page: "plans/p.md" };
const flat = (cards: readonly RailWorkCard[]): RailThreadCard[] => cards.flatMap((c) => (isRailGroupCard(c) ? c.children : [c]));
const byKey = (cards: readonly RailWorkCard[], key: string) => flat(cards).find((c) => c.key === key)!;

describe("Make own thread across the stops (D5, D15)", () => {
  test("Threads: the split page is its own card after its source, with its chip; no card ⋯ at Threads; the remainder keeps the rest", () => {
    const { cards, control } = at("threads", { splits: [P] });
    expect(cards.map((c) => c.key)).toEqual(["plans/k.md", "plans/p.md", "plans/a.md", "plans/b.md", "notes/l.md"]);
    // The Group menu counts the cards the stop draws, the split included.
    expect(control.stops.find((x) => x.stop === "threads")!.cards).toBe(5);
    const split = byKey(cards, "plans/p.md");
    expect(split.boundary).toBe("split");
    expect(split.menu).toBeUndefined();
    expect(split.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(byKey(cards, "plans/k.md").focus.map((p) => p.relPath)).toEqual(["plans/k.md", "plans/q.md"]);
  });

  test("Related: a split page and a kept-apart thread never join a group; the card ⋯ says Return / Allow / Keep", () => {
    const fx = fixture();
    const split = at("related", { splits: [{ id: "sa", page: "plans/a.md" }] }, fx).cards;
    // A split off its series group: B is left alone too (a group of one is a lone card).
    expect(split.every((c) => !isRailGroupCard(c))).toBe(true);
    expect(byKey(split, "plans/a.md").menu).toEqual({ action: "return", id: "sa", page: "plans/a.md" });
    const kept = at("related", { keptApart: ["plans/b.md"] }, fx).cards;
    expect(kept.some(isRailGroupCard)).toBe(false);
    expect(byKey(kept, "plans/b.md")).toMatchObject({ boundary: "keptApart", menu: { action: "allow", anchors: ["plans/b.md"] } });
    const plain = at("related", {}, fx).cards;
    const g = plain.find(isRailGroupCard)!;
    expect(g.children.map((c) => c.menu)).toEqual([
      { action: "keep", anchor: "plans/a.md" },
      { action: "keep", anchor: "plans/b.md" },
    ]);
  });

  test("a session that focused both halves is in both; per-page work (scores) is unchanged", () => {
    const fx = fixture();
    const before = fx.pages.map((p) => JSON.stringify(p.work));
    const { cards } = at("threads", { splits: [P] }, fx);
    expect(byKey(cards, "plans/k.md").sessions.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(byKey(cards, "plans/p.md").sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(fx.pages.map((p) => JSON.stringify(p.work))).toEqual(before);
  });

  test("Return to its thread recomputes from current facts: the server's thread again", () => {
    const fx = fixture();
    const back = at("threads", { splits: [] }, fx).cards;
    expect(back.map((c) => c.key)).toEqual(["plans/k.md", "plans/a.md", "plans/b.md", "notes/l.md"]);
    expect(byKey(back, "plans/k.md").focus).toHaveLength(3);
  });

  test("contributions incomplete for a thread: its split does not apply and the reset area says why", () => {
    const fx = fixture({ cut: true });
    const { cards, control } = at("threads", { splits: [P] }, fx);
    expect(cards.map((c) => c.key)).toEqual(["plans/k.md", "plans/a.md", "plans/b.md", "notes/l.md"]);
    expect(control.reset).toEqual({ count: 1, entries: [{ kind: "split", title: "T plans/p.md", state: "incomplete" }] });
    // And the Sessions stop is unavailable with the reason.
    expect(control.stops.find((x) => x.stop === "sessions")).toMatchObject({ available: false, reasons: ["contributions-cap"] });
  });
});

/** `n` busier lone note threads ahead of everything in the fixture. */
function withBusy(n: number, fx = fixture()) {
  for (let i = 1; i <= n; i++) {
    const rel = `notes/busy-${i}.md`;
    fx.pages.push(page(rel, { edits: 500 + i, type: "note" }));
    fx.work.threads.unshift({ key: rel, pages: [rel], touched: [], sessions: [sess(`z${i}`, 1)] });
    fx.work.evidence!.contributions.rows.push(row(`z${i}`, rel, rel, 2));
  }
  fx.work.evidence!.threads = { candidates: fx.work.threads.length, shipped: fx.work.threads.length };
  return fx;
}
const topKeys = (cards: readonly RailWorkCard[]) => cards.map((c) => c.key);
const BUSY = (n: number) => Array.from({ length: n }, (_, i) => `notes/busy-${n - i}.md`);
const drawnPages = (cards: readonly RailWorkCard[]) => flat(cards).flatMap((c) => c.focus.map((p) => p.relPath)).sort();

describe("D20: the cap counts base cards; a base card draws all its pieces in its place", () => {
  const Q: WorkGroupSplit = { id: "sq", page: "plans/q.md" };
  const K: WorkGroupSplit = { id: "sk", page: "plans/k.md" };

  test("a source drawn fifth draws its remainder and its split in its slot (Threads, Related); a sixth source's split stays cut", () => {
    const fx = withBusy(4);
    for (const stop of ["threads", "related"] as const) {
      const keys = at(stop, { splits: [P] }, fx).cards.map((c) => c.key);
      expect(keys.slice(4)).toEqual(["plans/k.md", "plans/p.md"]);
    }
    // b.md's thread is the seventh base card at Threads: cut, and so is its split.
    const cut = at("threads", { splits: [{ id: "sb", page: "plans/b.md" }] }, fx).cards.map((c) => c.key);
    expect(cut).toHaveLength(5);
    expect(cut).not.toContain("plans/b.md");
  });

  test("Make own thread on the PINNED page keeps the rest of its thread: the pinned piece first, then the others, all in the pinned card's place", () => {
    // Reviewer repro: withBusy(4), pin p.md, splits [Q], click Make own thread on p.md.
    for (const stop of ["threads", "related", "areas"] as const) {
      const before = at(stop, { splits: [Q] }, withBusy(4), "plans/p.md").cards;
      expect([stop, topKeys(before)]).toEqual([stop, ["plans/k.md", "plans/q.md", ...BUSY(4)]]);
      const after = at(stop, { splits: [Q, P] }, withBusy(4), "plans/p.md").cards;
      expect([stop, topKeys(after)]).toEqual([stop, ["plans/p.md", "plans/k.md", "plans/q.md", ...BUSY(4)]]);
      expect([stop, drawnPages(after)]).toEqual([stop, drawnPages(before)]);
      expect(flat(after).filter((c) => c.pinned).map((c) => c.key)).toEqual(["plans/p.md"]);
    }
  });

  test("a facet hides the remainder: Make own thread on q.md keeps q.md drawn in its base card's place", () => {
    // Reviewer repro: k.md in domain `life`, the filter domain=ai, withBusy(4).
    // q.md relates to busy-4, so the base grouping puts T in busy-4's group
    // (Related, Areas); at Threads T is the fifth card.
    const fx = withBusy(4);
    fx.work.evidence!.relations.related = [["plans/q.md", "notes/busy-4.md"]];
    fx.pages = fx.pages.map((p) => (p.relPath === "plans/k.md" ? { ...p, domain: "life" as const } : p));
    const ai: WikiFilters = { ...INERT, domain: "ai" };
    const draw = (stop: RailWorkGroupView["stop"], splits: WorkGroupSplit[]) =>
      openWorkCards(fx.work, fx.pages, ai, [], null, NOW, fx.pages, { stop, evidence: ALL, splits, moreOpen: ["group:anchor:notes/busy-4.md"] }).cards;
    for (const stop of ["threads", "related", "areas"] as const) {
      const before = draw(stop, [P]);
      const after = draw(stop, [P, Q]);
      expect(drawnPages(before)).toContain("plans/q.md");
      expect([stop, drawnPages(after)]).toEqual([stop, drawnPages(before)]);
      expect(byKey(after, "plans/q.md").boundary).toBe("split");
    }
    // Related: busy-4's base card holds busy-4, q's split and p's split, then the other base cards.
    expect(topKeys(draw("related", [P, Q]))).toEqual(["notes/busy-4.md", "plans/p.md", "plans/q.md", ...BUSY(3), "plans/a.md"]);
  });

  test("a split whose remainder is drawn stays with it (the source fifth)", () => {
    for (const stop of ["threads", "related", "areas"] as const) {
      const cards = at(stop, { splits: [P, Q] }, withBusy(4)).cards;
      expect([stop, topKeys(cards)]).toEqual([stop, [...BUSY(4), "plans/k.md", "plans/p.md", "plans/q.md"]]);
    }
  });

  test("every page of a source split (no remainder): all its pieces draw in its place; a source past the cap stays cut", () => {
    for (const stop of ["threads", "related", "areas"] as const) {
      const fifth = at(stop, { splits: [K, P, Q] }, withBusy(4)).cards;
      expect([stop, topKeys(fifth)]).toEqual([stop, [...BUSY(4), "plans/k.md", "plans/p.md", "plans/q.md"]]);
      const sixth = at(stop, { splits: [K, P, Q] }, withBusy(5)).cards;
      expect([stop, topKeys(sixth)]).toEqual([stop, BUSY(5)]);
    }
  });

  test("Keep separate on a child of the FIFTH card: the kept-apart thread stays drawn with its chip and its Allow grouping (Related, Areas)", () => {
    // Three busy notes and T ahead: the alpha group (a.md anchor, b.md) is the fifth card.
    const fx = withBusy(3);
    for (const stop of ["related", "areas"] as const) {
      expect(topKeys(at(stop, {}, fx).cards)).toEqual([...BUSY(3), "plans/k.md", "plans/a.md"]);
      const cards = at(stop, { keptApart: ["plans/b.md"] }, fx).cards;
      expect([stop, topKeys(cards)]).toEqual([stop, [...BUSY(3), "plans/k.md", "plans/a.md", "plans/b.md"]]);
      expect(byKey(cards, "plans/b.md")).toMatchObject({ boundary: "keptApart", menu: { action: "allow", anchors: ["plans/b.md"] } });
      // Kept apart on the ANCHOR: the child left behind draws in the same place.
      const anchor = at(stop, { keptApart: ["plans/a.md"] }, fx).cards;
      expect([stop, topKeys(anchor)]).toEqual([stop, [...BUSY(3), "plans/k.md", "plans/a.md", "plans/b.md"]]);
    }
  });

  test("Keep separate on a child of the fifth card plus Make own thread on the other: both stay (Related, Areas)", () => {
    const fx = withBusy(3);
    for (const stop of ["related", "areas"] as const) {
      const cards = at(stop, { keptApart: ["plans/b.md"], splits: [{ id: "sa", page: "plans/a.md" }] }, fx).cards;
      expect([stop, topKeys(cards).sort()]).toEqual([stop, [...BUSY(3), "plans/k.md", "plans/a.md", "plans/b.md"].sort()]);
    }
  });

  test("Threads: Keep separate changes nothing — no group to leave", () => {
    const fx = withBusy(3);
    const plain = topKeys(at("threads", {}, fx).cards);
    expect(plain).toEqual([...BUSY(3), "plans/k.md", "plans/a.md"]);
    expect(topKeys(at("threads", { keptApart: ["plans/b.md"] }, fx).cards)).toEqual(plain);
  });

  test("the pin's own split, its remainder's source far down the rank: the pinned card first, its remainder with it", () => {
    for (const stop of ["threads", "related", "areas"] as const) {
      const cards = at(stop, { splits: [P] }, withBusy(6), "plans/p.md").cards;
      expect([stop, topKeys(cards)]).toEqual([stop, ["plans/p.md", "plans/k.md", ...BUSY(6).slice(0, 4)]]);
    }
  });

  test("Keep separate on a thread of a group only other boundaries formed adds and loses no page (fuzz seed 1569517990, Related)", () => {
    // Reviewer repro: the splits and kept-apart anchors dissolve the first
    // group; p23.md's thread is not among the five base cards, so it is not
    // drawn, and keeping it apart changes nothing.
    const s = nextCapScenario(new CapRandom(1569517990));
    const { work, pages } = s.world;
    const draw = (keptApart: string[]) =>
      openWorkCards(work, pages, s.filters, [], s.pin, CAP_NOW, pages, { stop: "related", evidence: s.evidence[1]!, splits: s.splits, keptApart, moreOpen: pages.map((p) => `group:anchor:${p.relPath}`) }).cards;
    const base = openWorkCards(work, pages, s.filters, [], s.pin, CAP_NOW, pages, { stop: "related", evidence: s.evidence[1]!, moreOpen: pages.map((p) => `group:anchor:${p.relPath}`) }).cards;
    const before = draw(s.keptApart);
    expect(drawnPages(before)).toEqual(drawnPages(base));
    expect(drawnPages(before)).not.toContain("p23.md");
    expect(drawnPages(draw([...s.keptApart, "p23.md"]))).toEqual(drawnPages(before));
  });
});

describe("the pin after splits (S rows)", () => {
  const derived = (splits: WorkGroupSplit[], fx = fixture()) => workBoundariesOf(fx.work, fx.pages, { splits, keptApart: [] }).derived;
  const pinnedKey = (cards: readonly RailWorkCard[]) => flat(cards).find((c) => c.pinned)?.key;

  test("S1 a pin on the split page: the split page's card holds it and is drawn first", () => {
    const fx = fixture();
    expect(threadPinAnchor(derived([P], fx), fx.pages, "plans/p.md")).toBe("plans/p.md");
    const cards = at("threads", { splits: [P] }, fx, "plans/p.md").cards;
    expect([cards[0]!.key, pinnedKey(cards)]).toEqual(["plans/p.md", "plans/p.md"]);
  });

  test("S2 a pin on the remainder stays on the remainder and re-anchors on ITS newest page", () => {
    const fx = fixture();
    expect(threadPinAnchor(derived([P], fx), fx.pages, "plans/k.md")).toBe("plans/q.md");
    expect(pinnedKey(at("threads", { splits: [P] }, fx, "plans/q.md").cards)).toBe("plans/k.md");
  });

  test("S3 a split page that is its source's newest never pulls the pin out of the remainder (raw threads would)", () => {
    const fx = fixture();
    // Over the raw threads the pin re-anchors on p.md, the split page.
    expect(threadPinAnchor(fx.work.threads, fx.pages, "plans/q.md")).toBe("plans/p.md");
    expect(threadPinAnchor(derived([P], fx), fx.pages, "plans/q.md")).toBe("plans/q.md");
    // The state table keeps writing the remainder's anchor (R5: unchanged).
    const st = { held: "plans/q.md", known: "plans/q.md" as string | null };
    expect(threadPinStep(st, { kind: "render", stored: "plans/q.md", focused: true, anchor: threadPinAnchor(derived([P], fx), fx.pages, st.held) }).write).toBe(false);
  });

  test("S4 Return to its thread: a pin on the returned page follows it into the source thread, re-anchored there", () => {
    const fx = fixture();
    expect(threadPinAnchor(derived([], fx), fx.pages, "plans/p.md")).toBe("plans/p.md");
    expect(pinnedKey(at("threads", {}, fx, "plans/p.md").cards)).toBe("plans/k.md");
    // A pin held on the remainder's page re-anchors on the whole thread's newest.
    expect(threadPinAnchor(derived([], fx), fx.pages, "plans/q.md")).toBe("plans/p.md");
  });

  test("S5 a split that leaves the pin matching no thread keeps the pin state (A2)", () => {
    const fx = fixture();
    expect(threadPinAnchor(derived([P], fx), fx.pages, "plans/gone.md")).toBeNull();
    const st = { held: "plans/gone.md", known: "plans/gone.md" as string | null };
    expect(threadPinStep(st, { kind: "render", stored: "plans/gone.md", focused: true, anchor: null }).state.held).toBe("plans/gone.md");
  });
});

describe("the Sessions stop (D19) and ▸ split into N sessions", () => {
  test("one card per session, newest first; a page two sessions focused is a row of the newer card and an also in: link on the older", () => {
    const { cards, control } = at("sessions", { splits: [P], keptApart: ["plans/a.md"] });
    expect(control.stop).toBe("sessions");
    const sc = cards as RailThreadCard[];
    expect(sc.map((c) => c.key)).toEqual(["claude-code:s2", "claude-code:s4", "claude-code:s1", "claude-code:s5", "claude-code:s6"]);
    expect(sc[0]).toMatchObject({ name: "title s2", session: { ref: "claude-code:s2" }, open: true, pinAnchor: "" });
    expect(sc[0]!.focus.map((p) => p.relPath)).toEqual(["plans/p.md"]);
    const s1 = sc.find((c) => c.key === "claude-code:s1")!;
    expect(s1.focus.map((p) => p.relPath)).toEqual(["plans/k.md"]);
    expect(s1.alsoIn!.map((p) => p.relPath)).toEqual(["plans/p.md"]);
    // Splits and kept-apart do not apply: no chip, no ⋯ on a session card.
    expect(sc.every((c) => !c.boundary && !c.menu)).toBe(true);
    // The five-card cap: s3 is the sixth session.
    expect(control.stops.find((x) => x.stop === "sessions")!.cards).toBe(6);
  });

  test("only the open session card's owned rows leave Activity", () => {
    const fx = fixture();
    const facts: RailWikiFacts = { allPages: fx.pages, projects: {}, activityWeights: DEFAULT_ACTIVITY_WEIGHTS, workedGate: { open: true, why: "" } as never, work: fx.work };
    const input = railInputFor(facts, { mode: "updated", now: NOW, filters: INERT, showRetired: false, familiesOn: false, pins: [], openFolds: [], workGroup: { stop: "sessions", evidence: ALL } });
    expect(openWorkThreadCards(input.threads!).flatMap((c) => c.focus.map((p) => p.relPath))).toEqual(["plans/p.md"]);
    const rail = buildRail(input);
    const threadRows = rail.entries.flatMap((e) => (e.kind === "row" && e.section === "threads" ? [e] : []));
    expect(threadRows.map((e) => [e.page.relPath, e.thread?.session])).toEqual([["plans/p.md", true]]);
  });

  test("▸ split into N sessions: offered from two sessions; open, each row in the newest session holding it, the rest on also in:", () => {
    const closed = byKey(at("threads").cards, "plans/k.md");
    expect(closed.sessionSplit).toEqual({ count: 3, available: true, open: false, sessions: [] });
    const open = byKey(at("threads", { sessionsOpen: ["thread:plans/k.md"] }).cards, "plans/k.md").sessionSplit!;
    expect(open.sessions.map((s) => [s.ref, s.rows.map((p) => p.relPath), s.alsoIn.map((p) => p.relPath)])).toEqual([
      ["claude-code:s2", ["plans/p.md"], []],
      ["claude-code:s1", ["plans/k.md"], ["plans/p.md"]],
      ["claude-code:s3", ["plans/q.md"], []],
    ]);
    // A lone one-session thread offers none.
    expect(byKey(at("threads").cards, "plans/a.md").sessionSplit).toBeUndefined();
  });

  test("▸ split into N sessions on a split's remainder counts only the remainder's sessions; incomplete, it is unavailable with the reason", () => {
    expect(byKey(at("threads", { splits: [P] }).cards, "plans/k.md").sessionSplit).toMatchObject({ count: 2, available: true });
    expect(byKey(at("threads", {}, fixture({ cut: true })).cards, "plans/k.md").sessionSplit).toEqual({
      count: 3,
      available: false,
      reason: "contributions-cap",
      open: false,
      sessions: [],
    });
  });

  test("▸ split into N sessions follows the facets: a session with no visible row and no also in: link is not a line, and the count is what shows", () => {
    const fx = fixture();
    fx.pages = fx.pages.map((p) => (p.relPath === "plans/q.md" ? { ...p, domain: "life" as const } : p));
    const ai: WikiFilters = { ...INERT, domain: "ai" };
    const cards = (open: boolean) =>
      openWorkCards(fx.work, fx.pages, ai, [], null, NOW, fx.pages, { stop: "threads", evidence: ALL, ...(open ? { sessionsOpen: ["thread:plans/k.md"] } : {}) }).cards;
    expect(byKey(cards(false), "plans/k.md").sessionSplit).toEqual({ count: 2, available: true, open: false, sessions: [] });
    const open = byKey(cards(true), "plans/k.md").sessionSplit!;
    expect(open.count).toBe(2);
    expect(open.sessions.map((s) => [s.ref, s.rows.map((p) => p.relPath), s.alsoIn.map((p) => p.relPath)])).toEqual([
      ["claude-code:s2", ["plans/p.md"], []],
      ["claude-code:s1", ["plans/k.md"], ["plans/p.md"]],
    ]);
    // Filtered down to one session's pages: nothing left to split.
    const one = fx.pages.map((p) => (p.relPath === "plans/k.md" ? { ...p, domain: "life" as const } : p));
    const solo = openWorkCards(fx.work, one, ai, [], null, NOW, one, { stop: "threads", evidence: ALL }).cards;
    expect(byKey(solo, "plans/k.md").focus.map((p) => p.relPath)).toEqual(["plans/p.md"]);
    // s2 owns p.md; s1 shows p.md only on its also in: line, so it still shows.
    expect(byKey(solo, "plans/k.md").sessionSplit).toMatchObject({ count: 2 });
  });

  test("buildRail draws a split thread as session lines, each followed by its rows, then the also in: line; every row once", () => {
    const fx = fixture();
    const facts: RailWikiFacts = { allPages: fx.pages, projects: {}, activityWeights: DEFAULT_ACTIVITY_WEIGHTS, workedGate: { open: true, why: "" } as never, work: fx.work };
    const rail = buildRail(
      railInputFor(facts, { mode: "updated", now: NOW, filters: INERT, showRetired: false, familiesOn: false, pins: [], openFolds: [], workGroup: { stop: "threads", evidence: ALL, sessionsOpen: ["thread:plans/k.md"] } }),
    );
    const seq = rail.entries
      .filter((e) => e.section === "threads" && e.kind !== "header")
      .map((e) => (e.kind === "row" ? `row ${e.page.relPath}` : e.kind === "thread-session" ? `session ${e.session.ref}` : e.kind === "also-in" ? `also ${e.pages.map((p) => p.relPath)}` : e.kind));
    expect(seq.slice(0, 9)).toEqual([
      "thread",
      "session claude-code:s2",
      "row plans/p.md",
      "session claude-code:s1",
      "row plans/k.md",
      "also plans/p.md",
      "session claude-code:s3",
      "row plans/q.md",
      "thread-sessions",
    ]);
  });
});

describe("Save as series on a group card (D14)", () => {
  test("offered on a RELATED group on a writable wiki, absent on a series group and on a read-only wiki", () => {
    const fx = fixture();
    // Join A and L by a related: entry: a RELATED group, children share no series.
    fx.work.evidence!.relations.series = {};
    fx.pages[3] = { ...fx.pages[3]!, series: undefined, seriesLabel: undefined };
    fx.pages[4] = { ...fx.pages[4]!, series: undefined };
    fx.work.evidence!.relations.related = [["plans/b.md", "plans/a.md"]];
    const g = at("related", { seriesWritable: true }, fx).cards.find(isRailGroupCard) as RailGroupCard;
    expect(g.label).toBe("related");
    expect(g.series).toMatchObject({ available: true, mode: "coin", key: "a", writes: [{ relPath: "plans/a.md" }, { relPath: "plans/b.md" }] });
    expect((at("related", { seriesWritable: false }, fx).cards.find(isRailGroupCard) as RailGroupCard).series).toBeUndefined();
    const series = at("related", { seriesWritable: true }).cards.find(isRailGroupCard) as RailGroupCard;
    expect(series.label).toBe("series");
    expect(series.series).toBeUndefined();
  });
});

/**
 * A small world for the fix-round cases: each thread one session, a focus row
 * per page `ago` hours back in the order given (the first page the thread's
 * key, its earliest event), plus the `related:` links and series named.
 */
function miniWorld(threads: { pages: string[]; edits: number[] }[], o: { related?: [string, string][]; series?: Record<string, string>; hubs?: string[] } = {}) {
  const pages: WikiListing[] = [];
  const ts: WorkThread[] = [];
  const rows: WorkContribution[] = [];
  threads.forEach((t, i) => {
    t.pages.forEach((p, j) => {
      const pg = page(p, { edits: t.edits[j]!, focusAgo: 1 + j, ...(o.series?.[p] ? { series: o.series[p] } : {}) });
      pages.push(o.hubs?.includes(p) ? { ...pg, backlinkCount: 30 } : pg);
      rows.push(row(`m${i}`, p, t.pages[0]!, 20 - j));
    });
    ts.push({ key: t.pages[0]!, pages: [...t.pages].sort(), touched: [], sessions: [sess(`m${i}`, 1)] });
  });
  const work: IndexWork = {
    asOfMs: NOW - H,
    sinceMs: NOW - 8 * DAY,
    threads: ts,
    evidence: {
      version: WORK_EVIDENCE_VERSION,
      threads: { candidates: ts.length, shipped: ts.length },
      relations: { complete: true, reasons: [], series: o.series ?? {}, projects: {}, related: o.related ?? [], issues: [], ambiguousIssues: [], relatedSkipped: { skipped: 0, ambiguous: 0 } },
      contributions: { complete: true, reasons: [], cut: [], rows },
    },
  };
  return { pages, work };
}

describe("D20 fix round 2: fold keys, the pin and + N more across broken base cards", () => {
  const groupKeys = (cards: readonly RailWorkCard[]) => cards.filter(isRailGroupCard).map((c) => c.foldKey);

  test("two base cards each break into two groups named by one series: the series key goes to the first, the second takes its anchor key (Related, Areas)", () => {
    // Base card A: xa.md linked to a1..a4 by related:, a1↔a2 and a3↔a4 too;
    // a3, a4 in series S. Base card B the same with b's. Series joining off.
    // Keep separate on xa.md and xb.md: each card's rest regroups into
    // (1 2) and (3 4), and (3 4) is named by S in both.
    const side = (x: string, top: number) => [
      { pages: [`${x}/x${x}.md`], edits: [top] },
      ...[1, 2, 3, 4].map((n) => ({ pages: [`${x}/${x}${n}.md`], edits: [top - n] })),
    ];
    const links = (x: string): [string, string][] => [
      ...[1, 2, 3, 4].map((n): [string, string] => [`${x}/x${x}.md`, `${x}/${x}${n}.md`]),
      [`${x}/${x}1.md`, `${x}/${x}2.md`],
      [`${x}/${x}3.md`, `${x}/${x}4.md`],
    ];
    const fx = miniWorld([...side("a", 90), ...side("b", 60)], {
      related: [...links("a"), ...links("b")],
      series: { "a/a3.md": "S", "a/a4.md": "S", "b/b3.md": "S", "b/b4.md": "S" },
    });
    for (const stop of ["related", "areas"] as const) {
      const draw = (keptApart: string[]) => openWorkCards(fx.work, fx.pages, INERT, [], null, NOW, fx.pages, { stop, evidence: { series: false, related: true, issue: true }, keptApart }).cards;
      expect([stop, groupKeys(draw([]))]).toEqual([stop, ["group:anchor:a/xa.md", "group:anchor:b/xb.md"]]);
      const keys = groupKeys(draw(["a/xa.md", "b/xb.md"]));
      expect([stop, keys.filter((k, j) => keys.indexOf(k) !== j)]).toEqual([stop, []]);
      // The first broken card's heir keeps its base key (finding 3's rule).
      expect([stop, keys]).toEqual([stop, ["group:anchor:a/xa.md", "group:series:s", "group:anchor:b/xb.md", "group:anchor:b/b3.md"]]);
    }
  });

  test("S1 on a hub: Make own thread on a pinned hub page pins its own card, first in its base card's place (Threads, Related, Areas)", () => {
    // Reviewer repro, fuzz seed 605051321: the pin is h.md, a hub inside k.md's
    // thread, so no base card holds it (a hub pin needs a thread of hubs).
    // Split off, h.md is a thread of hubs only: it holds the pin.
    const fx = miniWorld(
      [
        { pages: ["notes/busy.md"], edits: [500] },
        { pages: ["plans/k.md", "plans/h.md"], edits: [50, 40] },
      ],
      { hubs: ["plans/h.md"] },
    );
    const H_: WorkGroupSplit = { id: "sh", page: "plans/h.md" };
    for (const stop of ["threads", "related", "areas"] as const) {
      const draw = (splits: WorkGroupSplit[]) => openWorkCards(fx.work, fx.pages, INERT, [], "plans/h.md", NOW, fx.pages, { stop, evidence: ALL, splits }).cards;
      expect([stop, flat(draw([])).filter((c) => c.pinned).map((c) => c.key)]).toEqual([stop, []]);
      const after = draw([H_]);
      expect(threadPinAnchor(workBoundariesOf(fx.work, fx.pages, { splits: [H_], keptApart: [] }).derived, fx.pages, "plans/h.md")).toBe("plans/h.md");
      expect([stop, flat(after).filter((c) => c.pinned).map((c) => c.key)]).toEqual([stop, ["plans/h.md"]]);
      // The base order stays boundary-free (busy first); in k.md's place the pinned piece leads.
      expect([stop, topKeys(after)]).toEqual([stop, ["notes/busy.md", "plans/h.md", "plans/k.md"]]);
    }
  });

  test("an expanded group keeps + N more through Make own thread on its anchor's key page (fuzz seed 220300156, Related, Areas)", () => {
    // T (k.md key, p.md, q.md) anchors a related group of four more threads
    // linked from p.md. Splitting k.md renames the remainder (D15); the group
    // keeps its fold key, so `+ N more` stays pressed.
    const fx = miniWorld(
      [
        { pages: ["plans/k.md", "plans/p.md", "plans/q.md"], edits: [90, 80, 70] },
        { pages: ["c/c1.md"], edits: [9] },
        { pages: ["c/c2.md"], edits: [8] },
        { pages: ["c/c3.md"], edits: [7] },
        { pages: ["c/c4.md"], edits: [6] },
      ],
      { related: [["plans/p.md", "c/c1.md"], ["plans/p.md", "c/c2.md"], ["plans/p.md", "c/c3.md"], ["plans/p.md", "c/c4.md"]] },
    );
    for (const stop of ["related", "areas"] as const) {
      const draw = (splits: WorkGroupSplit[], moreOpen: string[]) => openWorkCards(fx.work, fx.pages, INERT, [], null, NOW, fx.pages, { stop, evidence: ALL, splits, moreOpen }).cards;
      const before = draw([], ["group:anchor:plans/k.md"]);
      const g = before.find(isRailGroupCard) as RailGroupCard;
      expect([stop, g.foldKey, g.hidden, g.children.length]).toEqual([stop, "group:anchor:plans/k.md", 0, 5]);
      const after = draw([K_SPLIT], ["group:anchor:plans/k.md"]);
      const ga = after.find(isRailGroupCard) as RailGroupCard;
      expect([stop, ga.foldKey, ga.hidden]).toEqual([stop, "group:anchor:plans/k.md", 0]);
      expect([stop, drawnPages(after)]).toEqual([stop, drawnPages(before)]);
    }
  });

  test("Keep separate on an expanded group's anchor that leaves two groups: both keep + N more, the second through its base card's key (Related, Areas)", () => {
    // x.md linked to m1..m8; m1 m3 m5 m7 and m2 m4 m6 m8 linked among
    // themselves. Kept apart, x.md leaves two groups of four children.
    const ms = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `m/m${n}.md`);
    const related: [string, string][] = ms.map((m): [string, string] => ["m/x.md", m]);
    ms.forEach((m, j) => {
      for (let k = j + 2; k < ms.length; k += 2) related.push([m, ms[k]!]);
    });
    const fx = miniWorld([{ pages: ["m/x.md"], edits: [90] }, ...ms.map((m, j) => ({ pages: [m], edits: [80 - j] }))], { related });
    for (const stop of ["related", "areas"] as const) {
      const draw = (keptApart: string[]) => openWorkCards(fx.work, fx.pages, INERT, [], null, NOW, fx.pages, { stop, evidence: ALL, keptApart, moreOpen: ["group:anchor:m/x.md"] }).cards;
      const before = draw([]);
      expect([stop, before.filter(isRailGroupCard).map((c) => [c.foldKey, c.hidden])]).toEqual([stop, [["group:anchor:m/x.md", 0]]]);
      const after = draw(["m/x.md"]);
      expect([stop, after.filter(isRailGroupCard).map((c) => [c.foldKey, c.children.length, c.hidden])]).toEqual([
        stop,
        [
          ["group:anchor:m/x.md", 4, 0],
          ["group:anchor:m/m2.md", 4, 0],
        ],
      ]);
      expect([stop, drawnPages(after)]).toEqual([stop, drawnPages(before)]);
      // A pin in the second group draws it first; the base key stays where it formed.
      const pinned = openWorkCards(fx.work, fx.pages, INERT, [], "m/m4.md", NOW, fx.pages, { stop, evidence: ALL, keptApart: ["m/x.md"] }).cards;
      expect([stop, pinned.filter(isRailGroupCard).map((c) => [c.foldKey, c.pinned])]).toEqual([
        stop,
        [
          ["group:anchor:m/m2.md", true],
          ["group:anchor:m/x.md", false],
        ],
      ]);
    }
  });

  test("the base key goes to the group holding the base anchor's remainder, not to a pinned group drawn ahead of it (Related, Areas)", () => {
    // Thread X (x.md key, y.md): x.md linked to m2 m4 m6, y.md to m1 m3 m5,
    // and m2↔m4↔m6 among themselves. Make own thread on x.md: the remainder
    // (y.md) keeps m1 m3 m5; m2 m4 m6 form their own group, pinned on m4.md.
    const ms = [1, 2, 3, 4, 5, 6].map((n) => `m/m${n}.md`);
    const related: [string, string][] = ms.map((m, j): [string, string] => [j % 2 ? "m/x.md" : "m/y.md", m]);
    related.push(["m/m2.md", "m/m4.md"], ["m/m2.md", "m/m6.md"]);
    const fx = miniWorld([{ pages: ["m/x.md", "m/y.md"], edits: [90, 85] }, ...ms.map((m, j) => ({ pages: [m], edits: [80 - j] }))], { related });
    for (const stop of ["related", "areas"] as const) {
      const after = openWorkCards(fx.work, fx.pages, INERT, [], "m/m4.md", NOW, fx.pages, { stop, evidence: ALL, splits: [{ id: "sx", page: "m/x.md" }] }).cards;
      const groups = after.filter(isRailGroupCard).map((c) => [c.foldKey, c.pinned, c.children.map((t) => t.key).join(" ")]);
      expect([stop, groups]).toEqual([
        stop,
        [
          ["group:anchor:m/m2.md", true, "m/m2.md m/m4.md m/m6.md"],
          ["group:anchor:m/x.md", false, "m/y.md m/m1.md m/m3.md"],
        ],
      ]);
    }
  });
});
const K_SPLIT: WorkGroupSplit = { id: "sk2", page: "plans/k.md" };
