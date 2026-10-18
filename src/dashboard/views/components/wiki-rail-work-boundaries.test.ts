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

describe("a split card rides past the five-card cap with its source", () => {
  test("a source drawn fifth keeps its split page on screen (Threads and Related); an undrawn source's split stays cut", () => {
    const fx = fixture();
    // Four busier lone threads push T to the fifth card.
    for (const i of [1, 2, 3, 4]) {
      const rel = `notes/busy-${i}.md`;
      fx.pages.push(page(rel, { edits: 500 + i, type: "note" }));
      fx.work.threads.unshift({ key: rel, pages: [rel], touched: [], sessions: [sess(`z${i}`, 1)] });
      fx.work.evidence!.contributions.rows.push(row(`z${i}`, rel, rel, 2));
    }
    fx.work.evidence!.threads = { candidates: 8, shipped: 8 };
    for (const stop of ["threads", "related"] as const) {
      const keys = at(stop, { splits: [P] }, fx).cards.map((c) => c.key);
      expect(keys.slice(4)).toEqual(["plans/k.md", "plans/p.md"]);
    }
    // A sixth source (b.md at Threads) is cut, and so is its split.
    const cut = at("threads", { splits: [{ id: "sb", page: "plans/b.md" }] }, fx).cards.map((c) => c.key);
    expect(cut).toHaveLength(5);
    expect(cut).not.toContain("plans/b.md");
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
