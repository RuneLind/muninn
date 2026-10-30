/**
 * The rail's `group by effort` mode (work map P4): the effort index off the
 * map, the mode key, and `buildRail`'s effort folds — placement, the default
 * open three, the stored exceptions, the forced-open page, and the one-row
 * invariant across Pick up, Work threads and Activity.
 */
import { describe, expect, test } from "bun:test";
import {
  EFFORTS_OFF_TOGGLE_KEY,
  EFFORTS_OPEN_DEFAULT,
  effortFoldKey,
  effortsOn,
  railEffortIndex,
  type RailEffort,
} from "./wiki-effort-rail.ts";
import { buildRail, capFolds, isModeFoldKey, railMemberWhy, toggleFold, type RailEntry, type RailThreadCard } from "./wiki-recents.ts";
import { closedFoldKey } from "./wiki-groups.ts";
import type { WikiFilters, WikiListing } from "./wiki-filter.ts";
import type { ActivityRow } from "./wiki-activity-rank.ts";
import type { PickUpRow } from "./wiki-pick-up.ts";
import type { WorkMap } from "../../../wiki/work-map/schema.ts";

function page(over: Partial<WikiListing> & { relPath: string }): WikiListing {
  return {
    name: over.relPath.slice(over.relPath.lastIndexOf("/") + 1).replace(/\.mdx?$/, ""),
    title: over.relPath,
    type: "note",
    domain: "ai",
    tags: [],
    aliases: [],
    linkCount: 0,
    backlinkCount: 0,
    ...over,
  } as WikiListing;
}

const INERT: WikiFilters = {
  q: "", domain: "", folder: "", type: "", tag: "", status: "", followups: "", waiting: "", project: "", jira: "",
} as WikiFilters;

const HOUR = 3_600_000;
const act = (p: WikiListing, score: number, ageH: number): ActivityRow => ({ page: p, kind: "changed", score, why: "changed", ageMs: ageH * HOUR });
const eff = (id: string): RailEffort => ({ id, name: `Effort ${id}`, state: "active" });

const A1 = page({ relPath: "plans/a1.mdx", plan_status: "in-flight" });
const A2 = page({ relPath: "plans/a2.mdx", plan_status: "shipped" });
const B1 = page({ relPath: "plans/b1.mdx" });
const B2 = page({ relPath: "plans/b2.mdx" });
const C1 = page({ relPath: "plans/c1.mdx" });
const D1 = page({ relPath: "plans/d1.mdx" });
const P1 = page({ relPath: "notes/p1.md" });
const OLD = page({ relPath: "notes/old.md" });
const ALL = [A1, A2, B1, B2, C1, D1, P1, OLD];

const EFFORTS = new Map<string, RailEffort>([
  ["plans/a1.mdx", eff("a")],
  ["plans/a2.mdx", eff("a")],
  ["plans/b1.mdx", eff("b")],
  ["plans/b2.mdx", eff("b")],
  ["plans/c1.mdx", eff("c")],
  ["plans/d1.mdx", eff("d")],
]);
/** Rank order: a1, p1, b1, c1, d1, a2, b2 — d1 the OLDEST effort by age. */
const ACTIVITY = [act(A1, 9, 1), act(P1, 8, 1.5), act(B1, 7, 2), act(C1, 6, 3), act(D1, 5, 4), act(A2, 4, 5), act(B2, 3, 6)];

const build = (over: Partial<Parameters<typeof buildRail>[0]> = {}) =>
  buildRail({ filtered: ALL, facetOnly: ALL, filters: INERT, pins: [], activity: ACTIVITY, efforts: EFFORTS, ...over });
const rows = (es: RailEntry[]) => es.filter((e) => e.kind === "row") as Extract<RailEntry, { kind: "row" }>[];
const efforts = (es: RailEntry[]) => es.filter((e) => e.kind === "effort") as Extract<RailEntry, { kind: "effort" }>[];
/** The Activity section as a flat sequence: `effort:<id>` or a row's relPath. */
const activitySeq = (es: RailEntry[]) =>
  es.filter((e) => e.section === "activity" && (e.kind === "effort" || e.kind === "row")).map((e) => (e.kind === "effort" ? e.foldKey : (e as { page: WikiListing }).page.relPath));
/** One-row invariant: no relPath is a row twice. */
function expectOneRowPerPage(es: RailEntry[]): void {
  const seen = rows(es).map((r) => r.page.relPath);
  expect(seen.length).toBe(new Set(seen).size);
}

describe("effortsOn / the mode key", () => {
  test("on by default where a map exists; the stored exception turns it off; no map ⇒ off whatever is stored", () => {
    expect(effortsOn([], true)).toBe(true);
    expect(effortsOn([EFFORTS_OFF_TOGGLE_KEY], true)).toBe(false);
    expect(effortsOn([" Toggle:No-Efforts "], true)).toBe(false);
    expect(effortsOn([], false)).toBe(false);
    expect(effortsOn([EFFORTS_OFF_TOGGLE_KEY], false)).toBe(false);
  });

  test("the key is a MODE key: exempt from the fold cap and hoisted, and a toggle flips it in and out", () => {
    expect(isModeFoldKey(EFFORTS_OFF_TOGGLE_KEY)).toBe(true);
    const many = Array.from({ length: 300 }, (_, i) => `plans/p${i}.md`);
    expect(capFolds([...many, EFFORTS_OFF_TOGGLE_KEY])[0]).toBe(EFFORTS_OFF_TOGGLE_KEY);
    const off = toggleFold([], EFFORTS_OFF_TOGGLE_KEY);
    expect(off).toEqual([EFFORTS_OFF_TOGGLE_KEY]);
    expect(toggleFold(off, EFFORTS_OFF_TOGGLE_KEY)).toEqual([]);
  });
});

describe("railEffortIndex", () => {
  const map = (efforts: { id: string; parent?: string; pages: string[] }[]): WorkMap =>
    ({
      version: 1, wiki: "w", runAtMs: 1, model: "m",
      coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 0, threads: 0, logEntries: 0, digestChars: 0, warnings: [] },
      summary: "", needsYou: [], themes: [], loose: [],
      efforts: efforts.map((e) => ({
        id: e.id, name: `N ${e.id}`, aliases: [], oneLine: "", state: "active", ...(e.parent ? { parent: e.parent } : {}),
        pages: e.pages.map((id) => ({ id, role: "plan" })), why: "", confidence: 1, next: "", related: [], daily: [],
      })),
    }) as unknown as WorkMap;

  test("joins by relPath to the live listing; a sub-effort is its own flat entry; a page two efforts list goes to the first", () => {
    const idx = railEffortIndex(
      map([
        { id: "a", pages: ["plans/a1.mdx", "plans/gone.mdx", "PLANS/B1.mdx"] },
        { id: "a-ui", parent: "a", pages: ["plans/a2.mdx"] },
        { id: "b", pages: ["plans/b1.mdx"] },
      ]),
      ALL,
      2,
    );
    expect([...idx].map(([k, e]) => [k, e.id])).toEqual([
      ["plans/a1.mdx", "a"],
      ["plans/b1.mdx", "a"],
      ["plans/a2.mdx", "a-ui"],
    ]);
  });
});

describe("buildRail — effort folds (P4)", () => {
  test("no efforts handed in ⇒ Activity is plain rows in rank order", () => {
    const m = build({ efforts: undefined });
    expect(efforts(m.entries)).toEqual([]);
    expect(activitySeq(m.entries)).toEqual(ACTIVITY.map((r) => r.page.relPath));
  });

  test("each effort is one fold at its newest page's slot; pages in no effort stay ordinary rows", () => {
    const m = build();
    expect(activitySeq(m.entries)).toEqual([
      "effort:a", "plans/a1.mdx", "plans/a2.mdx",
      "notes/p1.md",
      "effort:b", "plans/b1.mdx", "plans/b2.mdx",
      "effort:c", "plans/c1.mdx",
      "effort:d",
    ]);
    const a = efforts(m.entries)[0]!;
    expect(a.members.map((p) => p.relPath)).toEqual(["plans/a1.mdx", "plans/a2.mdx"]);
    expect(a.ageMs).toBe(1 * HOUR);
    expect(rows(m.entries).find((r) => r.page.relPath === "plans/a1.mdx")!.member).toEqual({ label: "Effort a", kind: "effort" });
    expect(rows(m.entries).find((r) => r.page.relPath === "notes/p1.md")!.member).toBeUndefined();
    expectOneRowPerPage(m.entries);
    expect(m.shown).toBe(new Set(rows(m.entries).map((r) => r.page.relPath)).size);
  });

  test(`the ${EFFORTS_OPEN_DEFAULT} most recently active start open and offer the closed: spelling; the rest closed, absent from the remainder`, () => {
    const m = build();
    const es = efforts(m.entries);
    expect(es.map((e) => [e.effort.id, e.folded])).toEqual([["a", false], ["b", false], ["c", false], ["d", true]]);
    expect(es.map((e) => e.toggleKey)).toEqual([closedFoldKey("effort:a"), closedFoldKey("effort:b"), closedFoldKey("effort:c"), "effort:d"]);
    // The closed fold's page is held, not dropped into Other pages.
    expect(rows(m.entries).some((r) => r.page.relPath === "plans/d1.mdx")).toBe(false);
    expect(rows(m.entries).filter((r) => r.section === "all").map((r) => r.page.relPath)).toEqual(["notes/old.md"]);
  });

  test("recency, not rank, picks the default three", () => {
    // d1 ranks last but is the newest effort page.
    const m = build({ activity: [act(A1, 9, 5), act(B1, 8, 6), act(C1, 7, 7), act(D1, 1, 0.5)] });
    expect(efforts(m.entries).map((e) => [e.effort.id, e.folded])).toEqual([["a", false], ["b", false], ["c", true], ["d", false]]);
  });

  test("stored exceptions win over the default, both spellings; a click's toggle round-trips", () => {
    const m = build({ openFolds: [closedFoldKey("effort:a"), "effort:d"] });
    expect(efforts(m.entries).map((e) => [e.effort.id, e.folded])).toEqual([["a", true], ["b", false], ["c", false], ["d", false]]);
    const closeA = toggleFold([], closedFoldKey("effort:a"));
    expect(efforts(build({ openFolds: closeA }).entries)[0]!.folded).toBe(true);
    expect(efforts(build({ openFolds: toggleFold(closeA, closedFoldKey("effort:a")) }).entries)[0]!.folded).toBe(false);
  });

  test("the open page forces its closed fold open with forcedOpen; a Jira filter opens every fold", () => {
    const m = build({ openRelPath: "plans/d1.mdx" });
    const d = efforts(m.entries).find((e) => e.effort.id === "d")!;
    expect([d.folded, d.forcedOpen]).toEqual([false, true]);
    const all = build({ expandAll: true });
    expect(efforts(all.entries).every((e) => !e.folded && e.forcedOpen)).toBe(true);
  });

  test("a query flattens: no effort folds", () => {
    const q = { ...INERT, q: "a1" };
    const m = build({ filters: q, filtered: [A1], facetOnly: [A1] });
    expect(efforts(m.entries)).toEqual([]);
  });

  test("the invariant across Pick up, Work threads and effort folds: an open card claims first, a fold holds only what is left", () => {
    const card: RailThreadCard = {
      key: "plans/b2.mdx", foldKey: "thread:plans/b2.mdx", toggleKey: "thread:plans/b2.mdx", name: "B two", open: true, pinned: false,
      pinAnchor: "plans/b2.mdx", focus: [B2, A2], created: [], touched: [], sessions: [], movesYou: 0, score: 1,
    } as unknown as RailThreadCard;
    const pickUp: PickUpRow[] = [
      { page: B2, atMs: 1, edits: 1, sessions: 1, low: false, source: "rows", target: { kind: "card", foldKey: card.foldKey } as never },
      { page: P1, atMs: 1, edits: 1, sessions: 1, low: false, source: "page", target: null },
    ];
    const m = build({ threads: [card], pickUp, pins: ["plans/a1.mdx", "notes/old.md"] });
    // Section order: Pick up, Work threads, Activity, Pinned.
    const heads = m.entries.filter((e) => e.kind === "header").map((e) => (e as { label: string }).label);
    expect(heads.slice(0, 4)).toEqual(["Pick up", "Work threads", "Activity", "Pinned"]);
    // Pick up stays pointers: no page row in its section.
    expect(rows(m.entries).filter((r) => r.section === "pickup")).toEqual([]);
    // The card drew b2 and a2; the folds hold only the Activity rows left.
    const sec = (rel: string) => rows(m.entries).filter((r) => r.page.relPath === rel).map((r) => r.section);
    expect(sec("plans/b2.mdx")).toEqual(["threads"]);
    expect(sec("plans/a2.mdx")).toEqual(["threads"]);
    const es = efforts(m.entries);
    expect(es.find((e) => e.effort.id === "a")!.members.map((p) => p.relPath)).toEqual([]);
    expect(es.find((e) => e.effort.id === "b")!.members.map((p) => p.relPath)).toEqual(["plans/b1.mdx"]);
    // A pinned page an effort fold holds goes under Pinned and the fold names
    // it as a ghost (the series rule); so does a pinned page Activity did not rank.
    expect(sec("plans/a1.mdx")).toEqual(["pinned"]);
    expect(es.find((e) => e.effort.id === "a")!.ghosts!.map((p) => p.relPath)).toEqual(["plans/a1.mdx"]);
    expect(sec("notes/old.md")).toEqual(["pinned"]);
    expectOneRowPerPage(m.entries);
    // Every page of the listing is accounted for exactly once: a row, or held
    // by a closed fold.
    const held = es.filter((e) => e.folded).flatMap((e) => e.members.map((p) => p.relPath));
    const drawn = rows(m.entries).map((r) => r.page.relPath);
    expect([...drawn, ...held].sort()).toEqual(ALL.map((p) => p.relPath).sort());
  });

  test("a series member Activity ranked keeps its series fold; the effort fold does not nest it", () => {
    const S1 = page({ relPath: "plans/s1.mdx", series: "s" });
    const pages = [...ALL, S1];
    const series = { kind: "series" as const, key: "series:s", label: "S", members: [S1], supersededChildren: [], total: 1 };
    const m = buildRail({
      filtered: pages, facetOnly: pages, filters: INERT, pins: [],
      activity: [act(S1, 10, 0.2), ...ACTIVITY],
      efforts: new Map([...EFFORTS, ["plans/s1.mdx", eff("a")]]),
      seriesGroups: [series],
    });
    expect(m.entries.some((e) => e.kind === "group" && e.group.kind === "series" && e.section === "activity")).toBe(true);
    expect(efforts(m.entries).find((e) => e.effort.id === "a")!.members.map((p) => p.relPath)).toEqual(["plans/a1.mdx", "plans/a2.mdx"]);
    expectOneRowPerPage(m.entries);
  });

  test("fix A: a pinned page in a CLOSED effort fold goes under Pinned, and the fold names it as a ghost (the series rule)", () => {
    // d is the 4th most recent effort, so it starts closed.
    const m = build({ pins: ["plans/d1.mdx"] });
    const d = efforts(m.entries).find((e) => e.effort.id === "d")!;
    expect(d.folded).toBe(true);
    const sec = (rel: string) => rows(m.entries).filter((r) => r.page.relPath === rel).map((r) => r.section);
    expect(sec("plans/d1.mdx")).toEqual(["pinned"]);
    expect(d.ghosts?.map((p) => p.relPath)).toEqual(["plans/d1.mdx"]);
    // Opened, the fold draws the ghost row, never a second real row.
    const open = build({ pins: ["plans/d1.mdx"], openFolds: ["effort:d"] });
    expect(open.entries.filter((e) => e.kind === "ghost").map((e) => [e.section, (e as { page: WikiListing }).page.relPath, (e as { reason: string }).reason])).toEqual([
      ["activity", "plans/d1.mdx", "pinned"],
    ]);
    expect(rows(open.entries).filter((r) => r.page.relPath === "plans/d1.mdx").map((r) => r.section)).toEqual(["pinned"]);
    expectOneRowPerPage(open.entries);
  });

  test("fix B: a fold takes the Activity slot of its NEWEST page, not its best-ranked one", () => {
    // a2 ranks first but is 40h old; a1, the newest page of a, ranks below p1.
    const m = build({ activity: [act(A2, 9, 40), act(P1, 8, 1.5), act(A1, 7, 1), act(B1, 6, 2)] });
    expect(activitySeq(m.entries)).toEqual(["notes/p1.md", "effort:a", "plans/a2.mdx", "plans/a1.mdx", "effort:b", "plans/b1.mdx"]);
  });

  test("fix C: the open page's own fold is forced open, not its parent's", () => {
    const PAR = page({ relPath: "plans/par.mdx" });
    const KID = page({ relPath: "plans/kid.mdx", parent: "plans/par.mdx" });
    const pages = [...ALL, PAR, KID];
    const m = buildRail({
      filtered: pages, facetOnly: pages, filters: INERT, pins: [],
      // a, b, c are newer, so neither k nor p is in the default-open three.
      activity: [...ACTIVITY, act(KID, 2, 10), act(PAR, 1, 11)],
      efforts: new Map([...EFFORTS, ["plans/kid.mdx", eff("k")], ["plans/par.mdx", eff("p")]]),
      openRelPath: "plans/kid.mdx",
    });
    const es = efforts(m.entries);
    expect(es.find((e) => e.effort.id === "k")!.forcedOpen).toBe(true);
    expect(es.find((e) => e.effort.id === "p")!.forcedOpen).toBeUndefined();
    expect(rows(m.entries).filter((r) => r.page.relPath === "plans/kid.mdx").map((r) => r.section)).toEqual(["activity"]);
  });

  test("fix D: a fold whose every page is pinned draws only ghosts, so it takes no default-open slot", () => {
    // a holds a1 + a2, both pinned: a renders, ghost-only, and d (the 4th
    // newest effort) inherits the third open slot.
    const m = build({ pins: ["plans/a1.mdx", "plans/a2.mdx"] });
    const es = efforts(m.entries);
    expect(es.map((e) => [e.effort.id, e.folded])).toEqual([["a", true], ["b", false], ["c", false], ["d", false]]);
    const a = es.find((e) => e.effort.id === "a")!;
    expect(a.members).toEqual([]);
    expect(a.ghosts!.map((p) => p.relPath)).toEqual(["plans/a1.mdx", "plans/a2.mdx"]);
    // A ghost-only fold still carries a finite age: its pages' own.
    expect(a.ageMs).toBe(1 * HOUR);
    expect(a.toggleKey).toBe("effort:a");
  });

  test("fix D: recency is measured over the rows the fold DRAWS — a pinned newest page does not count", () => {
    // a1 (1h) is pinned, so fold a draws only a2 (5h): b, c, d are newer.
    const m = build({ pins: ["plans/a1.mdx"] });
    const es = efforts(m.entries);
    expect(es.map((e) => [e.effort.id, e.folded])).toEqual([["a", true], ["b", false], ["c", false], ["d", false]]);
    expect(es.find((e) => e.effort.id === "a")!.ageMs).toBe(5 * HOUR);
  });

  test("fix D: a parent row emitted earlier in Activity does not take an effort fold's attachment child (one row)", () => {
    // PAR is a plain Activity row ranked first; its attachment KID sits in
    // effort k. KID is lifted, so PAR's group does not claim it and the fold
    // draws it exactly once.
    const PAR = page({ relPath: "plans/par.mdx" });
    const KID = page({ relPath: "plans/par.html", parent: "plans/par.mdx" });
    const pages = [...ALL, PAR, KID];
    const m = buildRail({
      filtered: pages, facetOnly: pages, filters: INERT, pins: [],
      activity: [act(PAR, 20, 0.1), act(KID, 1, 0.2), ...ACTIVITY],
      efforts: new Map([...EFFORTS, ["plans/par.html", eff("k")]]),
      openFolds: ["plans/par.mdx"],
    });
    const k = efforts(m.entries).find((e) => e.effort.id === "k")!;
    expect([k.folded, k.members.map((p) => p.relPath)]).toEqual([false, ["plans/par.html"]]);
    expect(rows(m.entries).filter((r) => r.page.relPath === "plans/par.html").map((r) => r.member?.kind)).toEqual(["effort"]);
    expectOneRowPerPage(m.entries);
  });

  test("fix E: a row inside an effort fold hovers as the effort, not as a family", () => {
    expect(railMemberWhy({ label: "Wiki drift", kind: "effort" })).toBe("In the Wiki drift effort");
    expect(railMemberWhy({ label: "S", kind: "series" })).toBe("In the S series");
    expect(railMemberWhy({ label: "F", kind: "family" })).toBe("In the F family");
    expect(railMemberWhy({ label: "October 2026", kind: "month" })).toBe("In October 2026");
    expect(railMemberWhy(undefined)).toBe("");
  });

  test("effortFoldKey", () => {
    expect(effortFoldKey("drift")).toBe("effort:drift");
  });
});
