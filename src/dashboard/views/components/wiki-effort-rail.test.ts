/**
 * The rail's `group by effort` mode (work map P4, D14): the effort index off
 * the map, the mode key, and `buildRail`'s effort folds — placement, the fold
 * body, the default-open three, the stored exceptions, the forced-open page,
 * and the one-row invariant across Pick up and Activity (Work threads are not
 * drawn while folds form).
 */
import { describe, expect, test } from "bun:test";
import {
  EFFORT_MOVING_STATES,
  EFFORT_ROWS_SHOWN,
  EFFORTS_OFF_TOGGLE_KEY,
  EFFORTS_OPEN_DEFAULT,
  effortAllKey,
  effortFoldKey,
  effortNeedsOpen,
  effortsOn,
  railEffortIndex,
  type RailEffort,
} from "./wiki-effort-rail.ts";
import {
  EFFORT_FOLDS_MAX,
  FOLDS_MAX,
  buildRail,
  capFolds,
  isEffortFoldKey,
  isModeFoldKey,
  railMemberWhy,
  toggleFold,
  type RailEntry,
  type RailThreadCard,
} from "./wiki-recents.ts";
import { closedFoldKey } from "./wiki-groups.ts";
import type { WikiFilters, WikiListing } from "./wiki-filter.ts";
import type { ActivityRow } from "./wiki-activity-rank.ts";
import type { PickUpRow } from "./wiki-pick-up.ts";
import type { WorkMap } from "../../../wiki/work-map/schema.ts";
import { WORK_MAP_LANES, effortNeedItems, openNeeds } from "./wiki-work-card.ts";
import { effortView } from "./wiki-effort-page.ts";

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
const EFF = new Map<string, RailEffort>();
/** One shared RailEffort per id, as `railEffortIndex` builds them. */
const eff = (id: string, over: Partial<RailEffort> = {}): RailEffort => {
  const hit = EFF.get(id);
  if (hit && !Object.keys(over).length) return hit;
  const e: RailEffort = { id, name: `Effort ${id}`, state: "active", oneLine: "", needs: [], roles: new Map(), ...over };
  if (!Object.keys(over).length) EFF.set(id, e);
  return e;
};

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

  test("each effort is one fold, the folds first in slot order; pages in no effort stay ordinary rows below them", () => {
    const m = build();
    expect(activitySeq(m.entries)).toEqual([
      "effort:a", "plans/a1.mdx", "plans/a2.mdx",
      "effort:b", "plans/b1.mdx", "plans/b2.mdx",
      "effort:c", "plans/c1.mdx",
      "effort:d",
      "notes/p1.md",
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

  test("D14: Work threads are not drawn in the mode; Pick up stays; every page once across the rail", () => {
    const card: RailThreadCard = {
      key: "plans/b2.mdx", foldKey: "thread:plans/b2.mdx", toggleKey: "thread:plans/b2.mdx", name: "B two", open: true, pinned: false,
      pinAnchor: "plans/b2.mdx", focus: [B2, A2], created: [], touched: [], sessions: [], movesYou: 0, score: 1,
    } as unknown as RailThreadCard;
    const pickUp: PickUpRow[] = [
      { page: B2, atMs: 1, edits: 1, sessions: 1, low: false, source: "rows", target: null },
      { page: P1, atMs: 1, edits: 1, sessions: 1, low: false, source: "page", target: null },
    ];
    const control = { stop: "threads", label: "Threads" } as never;
    const m = build({ threads: [card], workControl: control, pickUp, pins: ["plans/a1.mdx", "notes/old.md"] });
    // Section order: Pick up, Activity, Pinned — no Work threads section or label.
    const heads = m.entries.filter((e) => e.kind === "header").map((e) => (e as { label: string }).label);
    expect(heads).toEqual(["Pick up", "Activity", "Pinned"]);
    expect(m.entries.some((e) => e.kind === "thread" || e.section === "threads")).toBe(false);
    // Pick up stays pointers: no page row in its section.
    expect(rows(m.entries).filter((r) => r.section === "pickup")).toEqual([]);
    // The card would have claimed b2 and a2: the folds list them instead.
    const sec = (rel: string) => rows(m.entries).filter((r) => r.page.relPath === rel).map((r) => r.section);
    expect(sec("plans/b2.mdx")).toEqual(["activity"]);
    // a draws only a2 (5h; a1 is pinned), the 4th newest fold: closed, a2 held.
    expect(sec("plans/a2.mdx")).toEqual([]);
    const es = efforts(m.entries);
    expect(es.find((e) => e.effort.id === "a")!.members.map((p) => p.relPath)).toEqual(["plans/a2.mdx"]);
    expect(es.find((e) => e.effort.id === "b")!.members.map((p) => p.relPath)).toEqual(["plans/b1.mdx", "plans/b2.mdx"]);
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

  test("D14: Work threads draw only outside the mode — no efforts handed in, the card claims as before", () => {
    const card: RailThreadCard = {
      key: "plans/b2.mdx", foldKey: "thread:plans/b2.mdx", toggleKey: "thread:plans/b2.mdx", name: "B two", open: true, pinned: false,
      pinAnchor: "plans/b2.mdx", focus: [B2, A2], created: [], touched: [], sessions: [], movesYou: 0, score: 1,
    } as unknown as RailThreadCard;
    const m = build({ efforts: undefined, threads: [card] });
    const heads = m.entries.filter((e) => e.kind === "header").map((e) => (e as { label: string }).label);
    expect(heads.slice(0, 2)).toEqual(["Work threads", "Activity"]);
    expect(rows(m.entries).filter((r) => r.section === "threads").map((r) => r.page.relPath)).toEqual(["plans/b2.mdx", "plans/a2.mdx"]);
    expectOneRowPerPage(m.entries);
  });

  test("D14: an effort fold claims a series member ahead of the series; a series nothing else holds draws nowhere", () => {
    const S1 = page({ relPath: "plans/s1.mdx", series: "s" });
    const pages = [...ALL, S1];
    const series = { kind: "series" as const, key: "series:s", label: "S", members: [S1], supersededChildren: [], total: 1 };
    const m = buildRail({
      filtered: pages, facetOnly: pages, filters: INERT, pins: [],
      activity: [act(S1, 10, 0.2), ...ACTIVITY],
      efforts: new Map([...EFFORTS, ["plans/s1.mdx", eff("a")]]),
      seriesGroups: [series],
    });
    expect(m.entries.some((e) => e.kind === "group" && e.group.kind === "series")).toBe(false);
    expect(efforts(m.entries).find((e) => e.effort.id === "a")!.members.map((p) => p.relPath)).toEqual(["plans/s1.mdx", "plans/a1.mdx", "plans/a2.mdx"]);
    expectOneRowPerPage(m.entries);
  });

  test("a series Activity ranked above every effort page draws BELOW the effort folds", () => {
    const S1 = page({ relPath: "plans/s1.mdx", series: "s" });
    const pages = [...ALL, S1];
    const series = { kind: "series" as const, key: "series:s", label: "S", members: [S1], supersededChildren: [], total: 1 };
    const m = buildRail({
      filtered: pages, facetOnly: pages, filters: INERT, pins: [],
      activity: [act(S1, 10, 0.2), ...ACTIVITY],
      efforts: EFFORTS,
      seriesGroups: [series],
    });
    const seq = m.entries
      .filter((e) => e.section === "activity" && (e.kind === "effort" || (e.kind === "group" && e.group.kind === "series")))
      .map((e) => (e.kind === "effort" ? e.foldKey : "series"));
    expect(seq).toEqual(["effort:a", "effort:b", "effort:c", "effort:d", "series"]);
    // Off, the series keeps its rank slot at the top of Activity.
    const off = buildRail({ filtered: pages, facetOnly: pages, filters: INERT, pins: [], activity: [act(S1, 10, 0.2), ...ACTIVITY], seriesGroups: [series] });
    expect(off.entries.find((e) => e.section === "activity" && e.kind !== "header")).toMatchObject({ kind: "group" });
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
    // Inside the fold the pages run newest first (D14); b lists b2 too, which
    // Activity did not rank. c and d have no Activity page: no fold, plain rows.
    expect(activitySeq(m.entries)).toEqual(["effort:a", "plans/a1.mdx", "plans/a2.mdx", "effort:b", "plans/b1.mdx", "plans/b2.mdx", "notes/p1.md"]);
    expect(rows(m.entries).filter((r) => r.section === "all").map((r) => r.page.relPath)).toEqual(["plans/c1.mdx", "plans/d1.mdx", "notes/old.md"]);
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
    // a1 (1h) is pinned, so fold a draws only a2 (5h): b, c, d are newer, and
    // a sits at a2's slot, below them (R2-2).
    const m = build({ pins: ["plans/a1.mdx"] });
    const es = efforts(m.entries);
    expect(es.map((e) => [e.effort.id, e.folded])).toEqual([["b", false], ["c", false], ["d", false], ["a", true]]);
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

  test("R2-1: a pinned open page does not force its fold open — it is drawn under Pinned; same for the parent fallback", () => {
    // d (4th newest, closed by default) holds d1 and d2; d1 is pinned and open.
    const D2 = page({ relPath: "plans/d2.mdx" });
    const pages = [...ALL, D2];
    const base = {
      filtered: pages, facetOnly: pages, filters: INERT,
      activity: [...ACTIVITY, act(D2, 2, 7)],
      efforts: new Map([...EFFORTS, ["plans/d2.mdx", eff("d")]]),
    };
    const m = buildRail({ ...base, pins: ["plans/d1.mdx"], openRelPath: "plans/d1.mdx" });
    const d = efforts(m.entries).find((e) => e.effort.id === "d")!;
    expect([d.folded, d.forcedOpen]).toEqual([true, undefined]);
    expect(rows(m.entries).filter((r) => r.page.relPath === "plans/d1.mdx").map((r) => r.section)).toEqual(["pinned"]);
    // Unpinned, the same open page still forces its fold open.
    const un = buildRail({ ...base, pins: [], openRelPath: "plans/d1.mdx" });
    expect(efforts(un.entries).find((e) => e.effort.id === "d")!.forcedOpen).toBe(true);
    // Parent fallback: the open child is in no effort and its parent d1 is pinned.
    const KID = page({ relPath: "plans/d1.html", parent: "plans/d1.mdx" });
    const withKid = [...pages, KID];
    const pk = buildRail({ ...base, filtered: withKid, facetOnly: withKid, pins: ["plans/d1.mdx"], openRelPath: "plans/d1.html" });
    expect(efforts(pk.entries).find((e) => e.effort.id === "d")!.forcedOpen).toBeUndefined();
  });

  test("R2-2: the fold sits at the slot of its newest DRAWN row, not a pinned one; a ghost-only fold at its newest ghost", () => {
    // a1 (1h) is pinned, a2 (50h) is the only row fold a draws; p1 2h, b1 3h.
    const m = build({ pins: ["plans/a1.mdx"], activity: [act(A1, 9, 1), act(P1, 8, 2), act(B1, 7, 3), act(A2, 4, 50)] });
    expect(activitySeq(m.entries)).toEqual(["effort:b", "plans/b1.mdx", "plans/b2.mdx", "effort:a", "plans/a2.mdx", "notes/p1.md"]);
    expect(efforts(m.entries).find((e) => e.effort.id === "a")!.ageMs).toBe(50 * HOUR);
    // Both a1 and a2 pinned: ghost-only fold a keeps a1's slot (its newest ghost), closed.
    const g = build({ pins: ["plans/a1.mdx", "plans/a2.mdx"], activity: [act(A1, 9, 1), act(P1, 8, 2), act(B1, 7, 3), act(A2, 4, 50)] });
    expect(activitySeq(g.entries)).toEqual(["effort:a", "effort:b", "plans/b1.mdx", "plans/b2.mdx", "notes/p1.md"]);
  });

  describe("class check: which fold the open page forces open", () => {
    // Placement of the open page × where its parent is. X and Y are older
    // than a–d, so neither starts open and any `forcedOpen` is the rule's.
    type Place = "drawnX" | "ghostX" | "pinnedNoFold" | "plainRow" | "underParent" | "rankedChild" | "offRail" | "listedX" | "hiddenX" | "noFoldX";
    type Par = "none" | "drawnY" | "ghostY" | "plainRow" | "sameX" | "listedY" | "hiddenY";
    // D14 placements: listedX — in fold x, which lists it though Activity did
    // not rank it; hiddenX — listed past the first four, behind «+N more»;
    // noFoldX — in an effort with no Activity page, so no fold at all.
    // listedY / hiddenY — the parent placed the same way in fold y.
    // Dropped: underParent/rankedChild × none (a child has a parent);
    // plainRow × any parent (a ranked page with a parent IS rankedChild);
    // pinnedNoFold/underParent/rankedChild × sameX (the open page is in no
    // fold, so sameX is drawnY); offRail × any parent (parentOf is built
    // from the filtered set, so a page off the rail has no parent there).
    const CASES: [Place, Par, "x" | "y" | null, "activity" | "pinned" | "all" | null][] = [
      ["drawnX", "none", "x", "activity"],
      ["drawnX", "drawnY", "x", "activity"],
      ["drawnX", "ghostY", "x", "activity"],
      ["drawnX", "plainRow", "x", "activity"],
      ["drawnX", "sameX", "x", "activity"],
      ["ghostX", "none", null, "pinned"],
      ["ghostX", "drawnY", null, "pinned"], // reproduced: was y
      ["ghostX", "ghostY", null, "pinned"],
      ["ghostX", "plainRow", null, "pinned"],
      ["ghostX", "sameX", null, "pinned"],
      ["pinnedNoFold", "none", null, "pinned"],
      ["pinnedNoFold", "drawnY", null, "pinned"], // reproduced: was y
      ["pinnedNoFold", "ghostY", null, "pinned"],
      ["pinnedNoFold", "plainRow", null, "pinned"],
      ["plainRow", "none", null, "activity"],
      ["underParent", "drawnY", "y", "activity"],
      ["underParent", "ghostY", null, "pinned"],
      ["underParent", "plainRow", null, "activity"],
      ["rankedChild", "drawnY", null, "activity"],
      ["rankedChild", "ghostY", null, "activity"],
      ["rankedChild", "plainRow", null, "activity"],
      ["offRail", "none", null, null],
      ["listedX", "none", "x", "activity"],
      ["hiddenX", "none", "x", "activity"],
      ["noFoldX", "none", null, "all"],
      ["listedX", "listedY", "x", "activity"],
      ["hiddenX", "hiddenY", "x", "activity"],
      ["underParent", "listedY", "y", "activity"],
      ["underParent", "hiddenY", "y", "activity"],
      ["noFoldX", "listedY", "y", "activity"],
      ["rankedChild", "hiddenY", null, "activity"],
    ];
    test.each(CASES)("open page %s, parent %s ⇒ forced fold %p, row in %p", (place, par, want, section) => {
      const PAR = page({ relPath: "plans/par.mdx" });
      const OPEN = page({ relPath: "plans/open.html", ...(par !== "none" ? { parent: PAR.relPath } : {}) });
      const pages = [...ALL, ...(place === "offRail" ? [] : [OPEN]), ...(par !== "none" ? [PAR] : [])];
      const effMap = new Map(EFFORTS);
      const activity = [...ACTIVITY];
      const pins: string[] = [];
      // D14: the pages a fold lists without Activity ranking them, dated by
      // `pageAgeMs`. Each listed fold gets one ranked anchor (10.5h, older than
      // a–d, so the fold does not start open); a hidden page also gets four
      // newer unranked siblings, which push it past the first four.
      const extra: WikiListing[] = [];
      const ages = new Map<string, number>();
      const listIn = (id: "x" | "y", target: WikiListing, hidden: boolean) => {
        const anchor = page({ relPath: `plans/${id}0.mdx` });
        extra.push(anchor);
        effMap.set(anchor.relPath, eff(id));
        activity.push(act(anchor, 1, 10.5));
        effMap.set(target.relPath, eff(id));
        ages.set(target.relPath, 100 * HOUR);
        if (!hidden) return;
        for (let i = 1; i <= 4; i++) {
          const sib = page({ relPath: `plans/${id}-sib${i}.mdx` });
          extra.push(sib);
          effMap.set(sib.relPath, eff(id));
          ages.set(sib.relPath, i * HOUR);
        }
      };
      if (["drawnX", "ghostX", "plainRow", "rankedChild"].includes(place)) activity.push(act(OPEN, 2, 10));
      if (place === "drawnX" || place === "ghostX") effMap.set(OPEN.relPath, eff("x"));
      if (place === "ghostX" || place === "pinnedNoFold") pins.push(OPEN.relPath);
      if (par !== "none") activity.push(act(PAR, 1, 11));
      if (par === "drawnY" || par === "ghostY") effMap.set(PAR.relPath, eff("y"));
      if (par === "sameX") effMap.set(PAR.relPath, eff("x"));
      if (par === "ghostY") pins.push(PAR.relPath);
      if (place === "listedX" || place === "hiddenX") listIn("x", OPEN, place === "hiddenX");
      if (place === "noFoldX") effMap.set(OPEN.relPath, eff("z"));
      if (par === "listedY" || par === "hiddenY") {
        // Unranked: the fold lists the parent, Activity does not.
        activity.splice(activity.findIndex((r) => r.page === PAR), 1);
        listIn("y", PAR, par === "hiddenY");
      }
      const all = [...pages, ...extra];
      const m = buildRail({
        filtered: all, facetOnly: all, filters: INERT, pins, activity, efforts: effMap,
        pageAgeMs: (p) => ages.get(p.relPath) ?? Infinity,
        openRelPath: place === "offRail" ? "plans/nowhere.mdx" : OPEN.relPath,
      });
      const folds = efforts(m.entries);
      expect(folds.filter((e) => e.forcedOpen).map((e) => e.effort.id)).toEqual(want ? [want] : []);
      // forcedOpen disables the caret, so a forced fold is never folded.
      for (const f of folds) if (f.forcedOpen) expect(f.folded).toBe(false);
      const openRows = rows(m.entries).filter((r) => r.page.relPath === OPEN.relPath);
      expect(openRows.map((r) => r.section)).toEqual(section ? [section] : []);
      // The parent's own chip is forced exactly when the open page renders under it.
      const parRow = rows(m.entries).find((r) => r.page.relPath === PAR.relPath);
      if (parRow?.children) expect(!!parRow.forcedOpen).toBe(place === "underParent" || place === "noFoldX");
      // A forced fold shows the row it was forced for, even past the cut: the
      // «+N more» left behind counts only the pages still hidden.
      if (want && (place === "hiddenX" || par === "hiddenY")) {
        const fold = folds.find((e) => e.effort.id === want)!;
        const more = m.entries.find((e) => e.kind === "more" && e.effort?.id === want) as Extract<RailEntry, { kind: "more" }>;
        // The fold's own rows: an attachment child drawn under one of them is not one.
        const shownHere = rows(m.entries).filter((r) => r.member?.label === `Effort ${want}` && !(r.child && !r.lifted));
        expect(more.hidden).toBe(fold.members.length - shownHere.length);
        expect(shownHere.length).toBe(5);
      }
      expectOneRowPerPage(m.entries);
    });
  });

  test("effortFoldKey", () => {
    expect(effortFoldKey("drift")).toBe("effort:drift");
  });
});

describe("buildRail — the fold body (D14)", () => {
  // Effort e lists eight pages; Activity ranked only e1 (1h) and e5 (3h).
  // The rest are dated by `pageAgeMs`.
  const E = Array.from({ length: 8 }, (_, i) => page({ relPath: `plans/e${i + 1}.mdx`, plan_status: i % 2 ? "shipped" : "in-flight" }));
  const AGE: Record<string, number> = { "plans/e2.mdx": 2, "plans/e3.mdx": 2.5, "plans/e4.mdx": 4, "plans/e6.mdx": 6, "plans/e7.mdx": 7, "plans/e8.mdx": 8 };
  const roles = new Map(E.map((p, i) => [p.relPath, i === 0 ? "plan" : "report"] as const));
  const e = eff("e", { oneLine: "Ship ⟦plans/e1.mdx⟧ first", roles, needs: ["decision|Pick one", "review|Read it"] });
  const OUTSIDE = page({ relPath: "notes/outside.md" });
  const pages = [...E, OUTSIDE];
  const base = {
    filtered: pages, facetOnly: pages, filters: INERT, pins: [] as string[],
    activity: [act(E[0]!, 9, 1), act(OUTSIDE, 8, 1.5), act(E[4]!, 7, 3)],
    efforts: new Map(E.map((p) => [p.relPath, e] as const)),
    pageAgeMs: (p: WikiListing) => (AGE[p.relPath] ?? 99) * HOUR,
  };
  const body = (m: ReturnType<typeof buildRail>) =>
    m.entries
      .filter((x) => x.section === "activity" && x.kind !== "header")
      .map((x) => (x.kind === "row" ? x.page.relPath : x.kind === "more" ? `more ${x.hidden}${x.expanded ? " expanded" : ""}` : x.kind));

  test("an open fold lists every page of the effort, newest first, four shown and «+N more»; ranked or not, each with its role", () => {
    const m = buildRail(base);
    expect(body(m)).toEqual([
      "effort", "effort-intro",
      "plans/e1.mdx", "plans/e2.mdx", "plans/e3.mdx", "plans/e5.mdx",
      "more 4",
      "notes/outside.md",
    ]);
    const fold = efforts(m.entries)[0]!;
    // The fold holds all eight: the hidden four count in its roll-up.
    expect(fold.members.map((p) => p.relPath)).toEqual(["plans/e1.mdx", "plans/e2.mdx", "plans/e3.mdx", "plans/e5.mdx", "plans/e4.mdx", "plans/e6.mdx", "plans/e7.mdx", "plans/e8.mdx"]);
    expect(rows(m.entries).filter((r) => r.member?.kind === "effort").map((r) => r.role)).toEqual(["plan", "report", "report", "report"]);
    // A ranked row keeps its Activity signal; an unranked one has none.
    expect(rows(m.entries).find((r) => r.page.relPath === "plans/e1.mdx")!.activity).toBeDefined();
    expect(rows(m.entries).find((r) => r.page.relPath === "plans/e2.mdx")!.activity).toBeUndefined();
    // The hidden pages are held, never Other pages.
    expect(rows(m.entries).some((r) => r.section === "all")).toBe(false);
    expect(m.shown).toBe(5);
    const more = m.entries.find((x) => x.kind === "more") as Extract<RailEntry, { kind: "more" }>;
    expect([more.toggleKey, more.effort?.id]).toEqual([effortAllKey("e"), "e"]);
    expect(EFFORT_ROWS_SHOWN).toBe(4);
  });

  test("«+N more» pressed shows every row and stays as «Show fewer»; a toggle round-trips; a Jira filter shows all with no button", () => {
    const all = buildRail({ ...base, openFolds: toggleFold([], effortAllKey("e")) });
    expect(body(all).filter((x) => x.startsWith("plans/")).length).toBe(8);
    expect(body(all)).toContain("more 0 expanded");
    const back = buildRail({ ...base, openFolds: toggleFold(toggleFold([], effortAllKey("e")), effortAllKey("e")) });
    expect(body(back)).toContain("more 4");
    const jira = buildRail({ ...base, expandAll: true });
    expect(body(jira).filter((x) => x.startsWith("plans/")).length).toBe(8);
    expect(jira.entries.some((x) => x.kind === "more")).toBe(false);
  });

  test("a fold of four or fewer drawn rows has no «+N more»; a closed fold has no intro and no rows", () => {
    const few = buildRail({ ...base, filtered: [...E.slice(0, 4), OUTSIDE], facetOnly: [...E.slice(0, 4), OUTSIDE], activity: [act(E[0]!, 9, 1)] });
    expect(few.entries.some((x) => x.kind === "more")).toBe(false);
    const closed = buildRail({ ...base, openFolds: [`closed:${effortFoldKey("e")}`] });
    expect(body(closed)).toEqual(["effort", "notes/outside.md"]);
  });

  test("an effort page the listing does not hold (a facet, a retired page) is not in the fold", () => {
    const narrowed = pages.filter((p) => p.relPath !== "plans/e2.mdx");
    const m = buildRail({ ...base, filtered: narrowed, facetOnly: narrowed });
    expect(efforts(m.entries)[0]!.members.map((p) => p.relPath)).not.toContain("plans/e2.mdx");
    expect(efforts(m.entries)[0]!.members.length).toBe(7);
  });

  test("the fold's age is its newest page, ranked or not", () => {
    const m = buildRail({ ...base, pageAgeMs: (p) => (p.relPath === "plans/e8.mdx" ? 0.25 * HOUR : 99 * HOUR) });
    expect(efforts(m.entries)[0]!.ageMs).toBe(0.25 * HOUR);
    expect(efforts(m.entries)[0]!.members[0]!.relPath).toBe("plans/e8.mdx");
  });

  test("✋ counts the effort's Needs-you items minus the ones ✓ on the card", () => {
    expect(effortNeedsOpen(e, new Set())).toBe(2);
    expect(effortNeedsOpen(e, new Set(["review|Read it"]))).toBe(1);
  });

  test("the default-open folds: up to three, the most recent among active, blocked and proposed — never a cooling, quiet or shipped one", () => {
    const states = ["shipped", "active", "cooling", "blocked", "proposed", "active", "quiet"] as const;
    const ps = states.map((_, i) => page({ relPath: `plans/s${i}.mdx` }));
    const idx = new Map(ps.map((p, i) => [p.relPath, eff(`s${i}`, { state: states[i] })] as const));
    // s0 (shipped) is the newest; s6 (quiet) the second newest.
    const ages = [0.5, 3, 1, 4, 5, 6, 0.7];
    const m = buildRail({
      filtered: ps, facetOnly: ps, filters: INERT, pins: [],
      activity: ps.map((p, i) => act(p, 10 - i, ages[i]!)),
      efforts: idx,
    });
    expect(efforts(m.entries).filter((x) => !x.folded).map((x) => x.effort.id).sort()).toEqual(["s1", "s3", "s4"]);
    expect(efforts(m.entries).length).toBe(7);
  });

  test("an attachment child the map lists is the fold's own row, not drawn under its parent", () => {
    const KID = page({ relPath: "plans/e1.html", parent: "plans/e1.mdx" });
    const withKid = [...pages, KID];
    const m = buildRail({ ...base, filtered: withKid, facetOnly: withKid, efforts: new Map([...base.efforts, ["plans/e1.html", e]]), pageAgeMs: (p) => (p === KID ? 2.2 * HOUR : (AGE[p.relPath] ?? 99) * HOUR) });
    const kid = rows(m.entries).filter((r) => r.page.relPath === "plans/e1.html");
    expect(kid.map((r) => [r.member?.kind, r.lifted])).toEqual([["effort", true]]);
    expect(rows(m.entries).find((r) => r.page.relPath === "plans/e1.mdx")!.children).toBeUndefined();
    expectOneRowPerPage(m.entries);
  });
});

describe("railEffortIndex — what a fold reads off the map (D14)", () => {
  test("the one-line summary, the Needs-you keys and each page's role", () => {
    const map = {
      version: 1, wiki: "w", runAtMs: 1, model: "m",
      coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 0, threads: 0, logEntries: 0, digestChars: 0, warnings: [] },
      summary: "", themes: [], loose: [],
      needsYou: [
        { title: "Pick one", kind: "decision", why: "", action: "", pages: [], effort: "a" },
        { title: "Other", kind: "review", why: "", action: "", pages: [], effort: "b" },
        { title: "Loose", kind: "review", why: "", action: "", pages: [] },
      ],
      efforts: [
        {
          id: "a", name: "A", aliases: [], oneLine: "Do ⟦plans/a1.mdx⟧", state: "blocked",
          pages: [{ id: "plans/a1.mdx", role: "plan" }, { id: "plans/a2.mdx", role: "report" }], why: "", confidence: 1, next: "", related: [], daily: [],
        },
      ],
    } as unknown as WorkMap;
    const idx = railEffortIndex(map, ALL, 2);
    const a = idx.get("plans/a1.mdx")!;
    expect([a.oneLine, a.state, a.needs]).toEqual(["Do ⟦plans/a1.mdx⟧", "blocked", ["decision|Pick one"]]);
    expect([...a.roles]).toEqual([["plans/a1.mdx", "plan"], ["plans/a2.mdx", "report"]]);
    expect(idx.get("plans/a2.mdx")).toBe(a);
  });
});

describe("one source for the rail and the card or effort page (B2)", () => {
  test("the rail's moving states are the card's Moving lane, not a copy", () => {
    expect(EFFORT_MOVING_STATES).toBe(WORK_MAP_LANES.find((l) => l.id === "moving")!.states);
  });

  test("the rail's ✋ and the effort page's Needs you count the same items, a ✓-done one excluded", () => {
    const map = {
      version: 1, wiki: "w", runAtMs: 1, model: "m",
      coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 0, threads: 0, logEntries: 0, digestChars: 0, warnings: [] },
      summary: "", themes: [], loose: [],
      needsYou: [
        { title: "Pick one", kind: "decision", why: "", action: "", pages: [], effort: "a" },
        { title: "Other", kind: "review", why: "", action: "", pages: [], effort: "b" },
        { title: "Read it", kind: "review", why: "", action: "", pages: [], effort: "a" },
        { title: "Done one", kind: "verify", why: "", action: "", pages: [], effort: "a" },
      ],
      efforts: [
        { id: "a", name: "A", aliases: [], oneLine: "", state: "active", pages: [{ id: "plans/a1.mdx", role: "plan" }], why: "", confidence: 1, next: "", related: [], daily: [] },
      ],
    } as unknown as WorkMap;
    const done = new Set(["verify|Done one"]);
    expect(effortNeedItems(map.needsYou, "a").map((x) => x.i)).toEqual([0, 2, 3]);
    expect(openNeeds(effortNeedItems(map.needsYou, "a"), done).map((x) => x.key)).toEqual(["decision|Pick one", "review|Read it"]);
    const rail = effortNeedsOpen(railEffortIndex(map, ALL, 2).get("plans/a1.mdx")!, done);
    const { article } = effortView({
      map, pages: ALL, id: "a", wiki: "w", startHref: "/wiki", hrefFor: (r) => r, effortHref: (id) => id, pill: () => "", now: 2, done,
    });
    const page = (article.match(/<li class="wiki-ef-need">/g) ?? []).length;
    expect([rail, page]).toEqual([2, 2]);
  });
});

describe("capFolds — effort keys in their own class", () => {
  test("effort fold and «+N more» keys are bounded apart from the reader's folds", () => {
    expect([effortFoldKey("x"), `closed:${effortFoldKey("x")}`, effortAllKey("x")].every(isEffortFoldKey)).toBe(true);
    expect(isEffortFoldKey("plans/effort.md")).toBe(false);
    const pagesKeys = Array.from({ length: FOLDS_MAX }, (_, i) => `plans/p${i}.md`);
    const effortKeys = Array.from({ length: EFFORT_FOLDS_MAX + 5 }, (_, i) => effortFoldKey(`e${i}`));
    const out = capFolds([...effortKeys, ...pagesKeys]);
    // The reader's 200 folds all survive; the effort class keeps its newest 40.
    expect(out.filter((k) => k.startsWith("plans/")).length).toBe(FOLDS_MAX);
    expect(out.filter(isEffortFoldKey)).toEqual(effortKeys.slice(0, EFFORT_FOLDS_MAX));
  });
});
