/**
 * `railInputFor` must hand `buildRail` exactly what `renderList` assembled
 * inline before the move (plan D20). `legacyRailInput` below is that inline
 * code, copied verbatim apart from the module state it read, and every case
 * compares the two rails' JSON over one fixture listing.
 */

import { describe, expect, test } from "bun:test";
import { openThreadCards, railInputFor, threadPinAnchor, usableThreads, type RailViewer, type RailWikiFacts } from "./wiki-rail-input.ts";
import { threadCardHeaderHtml } from "./wiki-thread-view.ts";
import { buildRail, railSectionsVisible, THREAD_CARDS_MAX, type RailInput, type RailThreadCard } from "./wiki-recents.ts";
import { computeWorkFocus, threadScore, WORK_HUB_BACKLINKS, type WorkSession, type WorkThread } from "../../../wiki/work-focus.ts";
import {
  GROUP_FAMILIES_TOGGLE_KEY,
  groupSeries,
  isMonthGrouping,
  orderPagesForGroups,
  orderSeriesGroups,
  railGroups,
  withoutSeriesMembers,
} from "./wiki-groups.ts";
import { filterPages, isRecencySort, sortPages, type WikiFilters, type WikiListing, type WikiSortMode } from "./wiki-filter.ts";
import { DEFAULT_ACTIVITY_WEIGHTS, rankActivity, workedGateFor } from "./wiki-activity-rank.ts";
import { railPool } from "./wiki-cull-view.ts";

const NOW = Date.UTC(2026, 9, 15, 8, 0);
const DAY = 86_400_000;

function page(over: Partial<WikiListing> & { relPath: string }): WikiListing {
  return {
    name: over.relPath.slice(over.relPath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""),
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

const INERT: WikiFilters = { q: "", domain: "", folder: "", type: "", tag: "", status: "", followups: "", waiting: "", project: "", jira: "" };

const PAGES: WikiListing[] = [
  page({ relPath: "plans/alpha-wiki-a.mdx", gitCreatedMs: NOW - 2 * DAY, gitTouchedMs: NOW - DAY, plan_status: "in-flight", series: "alpha", seriesLabel: "Alpha work" }),
  page({ relPath: "plans/alpha-wiki-b.mdx", gitCreatedMs: NOW - 9 * DAY, gitTouchedMs: NOW - 3 * DAY, plan_status: "shipped", series: "alpha", workedMs: NOW - 5 * 3_600_000 }),
  page({ relPath: "plans/alpha-wiki-b-prototype.html", type: "explainer", parent: "plans/alpha-wiki-b.mdx", pairedBy: "suffix", gitCreatedMs: NOW - 9 * DAY }),
  page({ relPath: "plans/beta-tool-x.mdx", gitCreatedMs: NOW - 40 * DAY, gitTouchedMs: NOW - 4 * DAY, plan_status: "proposed" }),
  page({ relPath: "plans/beta-tool-y.mdx", gitCreatedMs: NOW - 41 * DAY, gitTouchedMs: NOW - 20 * DAY }),
  page({ relPath: "plans/beta-tool-z.mdx", gitCreatedMs: NOW - 42 * DAY, gitTouchedMs: NOW - 30 * DAY, culled: true }),
  page({ relPath: "plans/beta-tool-w.mdx", gitCreatedMs: NOW - 43 * DAY, gitTouchedMs: NOW - 31 * DAY }),
  page({ relPath: "archive/2026-08-01-old.mdx", gitCreatedMs: NOW - 75 * DAY, gitTouchedMs: NOW - 70 * DAY }),
  page({ relPath: "archive/2026-09-20-mid.mdx", gitCreatedMs: NOW - 25 * DAY, gitTouchedMs: NOW - 25 * DAY, jira: ["MELO-12"] }),
  page({ relPath: "archive/2026-10-10-new.mdx", gitCreatedMs: NOW - 5 * DAY, gitTouchedMs: NOW - 5 * DAY, tags: ["x"] }),
  page({ relPath: "concepts/hub.md", backlinkCount: 30, gitCreatedMs: NOW - 300 * DAY, gitTouchedMs: NOW - 2 * DAY, workedMs: NOW - DAY }),
  page({ relPath: "log.md", gitCreatedMs: NOW - 300 * DAY, gitTouchedMs: NOW - 3_600_000 }),
  page({ relPath: "index.md", gitCreatedMs: NOW - 300 * DAY, gitTouchedMs: NOW - 2 * 3_600_000 }),
];

/** The pre-move body of `renderList`, with its module state as parameters. */
function legacyRailInput(w: RailWikiFacts, v: RailViewer): RailInput {
  const { allPages, projects, activityWeights, workedGate } = w;
  const { mode, now, filters, pins, openFolds } = v;
  const pool = railPool(allPages, v.showRetired, filters.q);
  const filtered = sortPages(filterPages(pool, filters), mode, now);
  const facetOnly = /[0-9]/.test(filters.q) ? sortPages(filterPages(pool, { ...filters, q: "" }), mode, now) : filtered;
  const seriesGroups = railSectionsVisible(filters) ? orderSeriesGroups(groupSeries(filtered, allPages, now), { sort: mode, now }) : [];
  const groups =
    v.familiesOn && railSectionsVisible(filters)
      ? railGroups(withoutSeriesMembers(filtered, seriesGroups), { folder: filters.folder, sort: mode, projects, now })
      : [];
  const rows = isMonthGrouping(groups) ? orderPagesForGroups(filtered, groups) : filtered;
  return {
    filtered: rows,
    facetOnly,
    filters,
    pins,
    metaTail: isRecencySort(mode),
    activity: railSectionsVisible(filters) ? rankActivity(rows, activityWeights, now, workedGate) : [],
    groups,
    seriesGroups,
    openFolds,
    openRelPath: v.openRelPath || undefined,
    expandAll: !!filters.jira,
  };
}

const WIKI: RailWikiFacts = {
  allPages: PAGES,
  projects: {},
  activityWeights: DEFAULT_ACTIVITY_WEIGHTS,
  workedGate: workedGateFor(PAGES, DEFAULT_ACTIVITY_WEIGHTS, NOW, NOW),
};

const VIEWERS: [string, RailViewer][] = [];
for (const mode of ["updated", "created", "worked", "title", "backlinks"] as WikiSortMode[]) {
  VIEWERS.push([`defaults, ${mode}`, { mode, now: NOW, filters: INERT, showRetired: false, familiesOn: false, pins: [], openFolds: [] }]);
}
VIEWERS.push(
  ["families on, archive folder", { mode: "updated", now: NOW, filters: { ...INERT, folder: "archive" }, showRetired: false, familiesOn: true, pins: [], openFolds: [GROUP_FAMILIES_TOGGLE_KEY] }],
  ["families on, retired shown, pinned + open page", { mode: "created", now: NOW, filters: INERT, showRetired: true, familiesOn: true, pins: ["plans/beta-tool-y.mdx"], openFolds: [GROUP_FAMILIES_TOGGLE_KEY, "series:alpha"], openRelPath: "plans/beta-tool-x.mdx" }],
  ["a query naming a number", { mode: "updated", now: NOW, filters: { ...INERT, q: "2026" }, showRetired: false, familiesOn: true, pins: [], openFolds: [] }],
  ["a Jira filter", { mode: "updated", now: NOW, filters: { ...INERT, jira: "MELO-12" }, showRetired: false, familiesOn: false, pins: [], openFolds: [] }],
  ["a tag filter, no gate", { mode: "worked", now: NOW, filters: { ...INERT, tag: "x" }, showRetired: false, familiesOn: false, pins: [], openFolds: [] }],
);

describe("railInputFor", () => {
  for (const [name, viewer] of VIEWERS) {
    test(`rail output is byte-identical to the pre-move assembly — ${name}`, () => {
      const facts = name.includes("no gate") ? { ...WIKI, workedGate: null } : WIKI;
      const before = JSON.stringify(buildRail(legacyRailInput(facts, viewer)));
      const after = JSON.stringify(buildRail(railInputFor(facts, viewer)));
      expect(after).toBe(before);
      expect(JSON.parse(after).entries.length).toBeGreaterThan(0);
    });
  }
});

// A second listing whose cases each turn on one input `railInputFor` wires
// through: an OPEN worked gate, project names, a key jump over `facetOnly`, a
// Jira filter and an open page inside a closed series. Each case also asserts
// that its input changes the rail, so a wiring mistake cannot pass by accident.
const WIRED_PAGES: WikiListing[] = [
  page({ relPath: "notes/a.mdx", gitCreatedMs: NOW - 3 * DAY, gitTouchedMs: NOW - DAY, workedMs: NOW - DAY + 3_600_000 }),
  page({ relPath: "notes/b.mdx", gitCreatedMs: NOW - 4 * DAY, gitTouchedMs: NOW - 2 * DAY, workedMs: NOW - 2 * DAY }),
  page({ relPath: "notes/revived.mdx", gitCreatedMs: NOW - 200 * DAY, gitTouchedMs: NOW - 60 * DAY, workedMs: NOW - 2 * 3_600_000 }),
  page({ relPath: "plans/proj-x-a.mdx", gitCreatedMs: NOW - 300 * DAY, gitTouchedMs: NOW - 250 * DAY, project: "proj-x", plan_status: "in-flight" }),
  page({ relPath: "plans/proj-x-b.mdx", gitCreatedMs: NOW - 301 * DAY, gitTouchedMs: NOW - 251 * DAY, project: "proj-x" }),
  page({ relPath: "plans/proj-x-c.mdx", gitCreatedMs: NOW - 302 * DAY, gitTouchedMs: NOW - 252 * DAY, project: "proj-x" }),
  page({ relPath: "archive/gamma-one.mdx", gitCreatedMs: NOW - 310 * DAY, gitTouchedMs: NOW - 260 * DAY, series: "gamma", seriesLabel: "Gamma" }),
  page({ relPath: "archive/gamma-two.mdx", gitCreatedMs: NOW - 311 * DAY, gitTouchedMs: NOW - 261 * DAY, series: "gamma", jira: ["MELO-77"] }),
  // The key is only in the path, which the text filter does not read for a
  // query without a "/": the jump finds it over `facetOnly` alone.
  page({ relPath: "notes/fix-melo-7588.mdx", name: "fix", title: "Fix", gitCreatedMs: NOW - 320 * DAY, gitTouchedMs: NOW - 270 * DAY }),
];
const WIRED: RailWikiFacts = {
  allPages: WIRED_PAGES,
  projects: { "proj-x": 3 },
  activityWeights: DEFAULT_ACTIVITY_WEIGHTS,
  workedGate: workedGateFor(WIRED_PAGES, DEFAULT_ACTIVITY_WEIGHTS, NOW, NOW),
};
const base = (over: Partial<RailViewer> = {}): RailViewer => ({
  mode: "updated",
  now: NOW,
  filters: INERT,
  showRetired: false,
  familiesOn: false,
  pins: [],
  openFolds: [],
  ...over,
});
const railJson = (facts: RailWikiFacts, viewer: RailViewer) => JSON.stringify(buildRail(railInputFor(facts, viewer)));
const sameAsLegacy = (facts: RailWikiFacts, viewer: RailViewer) => {
  const after = railJson(facts, viewer);
  expect(after).toBe(JSON.stringify(buildRail(legacyRailInput(facts, viewer))));
  return after;
};

describe("railInputFor wiring", () => {
  test("an OPEN worked gate reaches the Activity ranking", () => {
    expect(WIRED.workedGate?.open).toBe(true);
    const viewer = base({ mode: "worked" });
    const open = sameAsLegacy(WIRED, viewer);
    expect(open).not.toBe(railJson({ ...WIRED, workedGate: null }, viewer));
  });
  test("the wiki's project names reach the family rule", () => {
    const viewer = base({ familiesOn: true, openFolds: [GROUP_FAMILIES_TOGGLE_KEY] });
    const withProjects = sameAsLegacy(WIRED, viewer);
    expect(withProjects).not.toBe(railJson({ ...WIRED, projects: {} }, viewer));
  });
  test("a status facet and a project facet", () => {
    for (const filters of [{ ...INERT, status: "in-flight" }, { ...INERT, project: "proj-x" }]) {
      const out = sameAsLegacy(WIRED, base({ filters }));
      expect(JSON.parse(out).entries.length).toBeGreaterThan(0);
    }
  });
  test("a query without a digit", () => {
    const out = sameAsLegacy(WIRED, base({ filters: { ...INERT, q: "gamma" } }));
    expect(out).toContain("archive/gamma-one.mdx");
  });
  test("a key jump resolves over the facets without the query", () => {
    const out = sameAsLegacy(WIRED, base({ filters: { ...INERT, q: "MELO-7588" } }));
    expect(out).toContain('"section":"jump"');
    expect(out).toContain("notes/fix-melo-7588.mdx");
  });
  test("a Jira filter opens the closed series holding its page", () => {
    const out = sameAsLegacy(WIRED, base({ filters: { ...INERT, jira: "MELO-77" } }));
    expect(out).toContain("archive/gamma-two.mdx");
    expect(out).toContain('"forcedOpen":true');
  });
  test("the open page forces its closed series open", () => {
    const viewer = base({ openRelPath: "archive/gamma-two.mdx" });
    const out = sameAsLegacy(WIRED, viewer);
    expect(out).toContain('"forcedOpen":true');
    expect(railJson(WIRED, base())).not.toContain('"forcedOpen":true');
  });
});

// ── Work-thread cards (plan `muninn-wiki-work-threads`, PR 5, D6/D7/D19) ────
const H = 3_600_000;
/** A page with focus events `[hours ago, edits]`. */
const wpage = (rel: string, focus: Array<[number, number]>, over: Partial<WikiListing> = {}): WikiListing =>
  page({
    relPath: rel,
    gitCreatedMs: NOW - 30 * DAY,
    gitTouchedMs: NOW - 20 * DAY,
    work: {
      sinceMs: NOW - 8 * DAY,
      state: "F",
      focusMs: NOW - focus[0]![0] * H,
      events: focus.map(([h, e]) => [NOW - h * H, e, "focus"] as [number, number, "focus"]),
    },
    ...over,
  });
const thread = (key: string, pages: string[], touched: string[] = [], sessions = 1): WorkThread => ({
  key,
  pages,
  touched,
  sessions: Array.from({ length: sessions }, (_, i) => ({ id: `${key}#${i}`, provider: "claude", first: NOW - (i + 2) * H, last: NOW - (i + 1) * H, title: `s${i}` })),
});
const T_PAGES: WikiListing[] = [
  wpage("plans/heavy.mdx", [[1, 40]], { title: "Heavy plan — the long tail" }),
  wpage("plans/heavy-2.mdx", [[2, 3]]),
  wpage("plans/recent.mdx", [[0.5, 2]], { gitCreatedMs: NOW - 2 * DAY }),
  wpage("notes/mid.md", [[3, 10]]),
  wpage("notes/x1.md", [[5, 1]]),
  wpage("notes/x2.md", [[6, 1]]),
  wpage("notes/x3.md", [[7, 1]]),
  page({ relPath: "notes/touched.md", gitCreatedMs: NOW - 90 * DAY }),
  page({ relPath: "notes/quiet.md", gitCreatedMs: NOW - DAY / 2 }),
];
const T_THREADS: WorkThread[] = [
  thread("plans/recent.mdx", ["plans/recent.mdx"]),
  thread("plans/heavy.mdx", ["plans/heavy.mdx", "plans/heavy-2.mdx"], ["notes/touched.md"], 3),
  thread("notes/mid.md", ["notes/mid.md"]),
  thread("notes/x1.md", ["notes/x1.md"]),
  thread("notes/x2.md", ["notes/x2.md"]),
  thread("notes/x3.md", ["notes/x3.md"]),
];
const cardsOf = (over: { filters?: WikiFilters; folds?: string[]; pin?: string | null; pages?: WikiListing[]; threads?: unknown } = {}) =>
  openThreadCards((over.threads ?? T_THREADS) as WorkThread[], over.pages ?? T_PAGES, over.filters ?? INERT, over.folds ?? [], over.pin ?? null, NOW);

describe("openThreadCards", () => {
  test("D6 order at the anchored now (top raw + 0.3 × rest), at most five cards, the first open with the closed: spelling", () => {
    const cards = cardsOf();
    expect(cards.map((c) => c.key)).toEqual(["plans/heavy.mdx", "notes/mid.md", "plans/recent.mdx", "notes/x1.md", "notes/x2.md"]);
    expect(cards.length).toBe(THREAD_CARDS_MAX);
    expect(cards.map((c) => c.open)).toEqual([true, false, false, false, false]);
    expect(cards[0]!.foldKey).toBe("thread:plans/heavy.mdx");
    expect(cards[0]!.toggleKey).toBe("closed:thread:plans/heavy.mdx");
    expect(cards[1]!.toggleKey).toBe("thread:notes/mid.md");
    // The score is the shared `threadScore`, so the server's order and this one agree at asOf.
    const byRel = (rel: string) => T_PAGES.find((p) => p.relPath === rel)?.work;
    expect(cards[0]!.score).toBe(threadScore(T_THREADS[1]!, byRel, NOW));
  });

  test("the card: name cut at ' — ', focus by work term, touched as links, sessions, NEW inside the window", () => {
    const [heavy] = cardsOf();
    expect(heavy!.name).toBe("Heavy plan");
    expect(heavy!.focus.map((p) => p.relPath)).toEqual(["plans/heavy.mdx", "plans/heavy-2.mdx"]);
    expect(heavy!.touched.map((p) => p.relPath)).toEqual(["notes/touched.md"]);
    expect(heavy!.sessions.length).toBe(3);
    expect(heavy!.created).toEqual([]);
    const recent = cardsOf().find((c) => c.key === "plans/recent.mdx")!;
    expect(recent.created).toEqual(["plans/recent.mdx"]);
  });

  test("the pinned thread renders first and marked (D7); a pin on a page no thread focuses pins nothing", () => {
    const pinned = cardsOf({ pin: "NOTES/X2.md" });
    expect(pinned[0]!.key).toBe("notes/x2.md");
    expect(pinned.map((c) => c.pinned)).toEqual([true, false, false, false, false]);
    // First, so it is the default-open card now.
    expect(pinned[0]!.open).toBe(true);
    expect(pinned[0]!.toggleKey).toBe("closed:thread:notes/x2.md");
    // Holding a page counts any focus page, not only the key.
    expect(cardsOf({ pin: "plans/heavy-2.mdx" })[0]!.key).toBe("plans/heavy.mdx");
    const none = cardsOf({ pin: "notes/touched.md" });
    expect(none.map((c) => c.key)).toEqual(cardsOf().map((c) => c.key));
    expect(none.some((c) => c.pinned)).toBe(false);
  });

  test("the fold store decides: a stored close on the first, a stored open on another", () => {
    const cards = cardsOf({ folds: ["closed:thread:plans/heavy.mdx", "thread:notes/mid.md"] });
    expect(cards.map((c) => c.open)).toEqual([false, true, false, false, false]);
  });

  test("a facet filters each card's rows and drops a card left empty; a query renders none", () => {
    const notes = cardsOf({ filters: { ...INERT, folder: "notes" } });
    expect(notes.map((c) => c.key)).toEqual(["notes/mid.md", "notes/x1.md", "notes/x2.md", "notes/x3.md"]);
    const plans = cardsOf({ filters: { ...INERT, folder: "plans" } });
    expect(plans[0]!.focus.map((p) => p.relPath)).toEqual(["plans/heavy.mdx", "plans/heavy-2.mdx"]);
    expect(plans[0]!.touched).toEqual([]);
    expect(cardsOf({ filters: { ...INERT, q: "heavy" } })).toEqual([]);
  });

  test("no threads, or a malformed payload, is no section (D11)", () => {
    expect(cardsOf({ threads: [] })).toEqual([]);
    expect(openThreadCards(null, T_PAGES, INERT, [], null, NOW)).toEqual([]);
    expect(openThreadCards(undefined, T_PAGES, INERT, [], null, NOW)).toEqual([]);
    const ok = { id: "s", provider: "claude", first: 1, last: 2, title: "t" };
    expect(usableThreads([{ key: "x" }, { key: "y", pages: ["y"], touched: [], sessions: [{ id: "s" }, ok] }, 3])).toEqual([
      { key: "y", pages: ["y"], touched: [], sessions: [ok] },
    ]);
  });
});

describe("railInputFor — the work-thread lift and Activity agree (D19)", () => {
  const WORK_WIKI: RailWikiFacts = {
    allPages: T_PAGES,
    projects: {},
    activityWeights: { ...DEFAULT_ACTIVITY_WEIGHTS, rows: 4 },
    workedGate: { open: true, candidates: 1, covered: 1, coverage: 1 },
    work: { threads: T_THREADS },
  };
  const activityOf = (input: RailInput) => (input.activity ?? []).map((r) => r.page.relPath);

  test("the open card's focus pages are out of the ranking before the cut, so Activity still holds its rows", () => {
    const input = railInputFor(WORK_WIKI, base());
    const open = (input.threads as RailThreadCard[]).filter((c) => c.open).flatMap((c) => c.focus.map((p) => p.relPath));
    expect(open).toEqual(["plans/heavy.mdx", "plans/heavy-2.mdx"]);
    expect(activityOf(input).some((rel) => open.includes(rel))).toBe(false);
    expect(activityOf(input).length).toBe(4);
    const rail = buildRail(input);
    expect(rail.entries.filter((e) => e.kind === "row" && open.includes(e.page.relPath)).map((e) => e.section)).toEqual(["threads", "threads"]);
  });

  test("closing the card hands its pages back to Activity", () => {
    const input = railInputFor(WORK_WIKI, base({ openFolds: ["closed:thread:plans/heavy.mdx"] }));
    expect(input.threads!.every((c) => !c.open)).toBe(true);
    expect(activityOf(input)).toContain("plans/heavy.mdx");
  });

  test("without work facts the input carries no threads and the rail is today's", () => {
    const { work: _work, ...without } = WORK_WIKI;
    const input = railInputFor(without, base());
    expect(input.threads).toBeUndefined();
    expect(JSON.stringify(buildRail(input))).toBe(JSON.stringify(buildRail(legacyRailInput(without, base()))));
  });
});

// ── PR 700 fix round 1 batch 1 ──────────────────────────────────────────────
describe("the thread pin follows the thread as its oldest pages age out (D7)", () => {
  // Day 0: the thread's key `a` is its EARLIEST focus page, `b` its newest.
  // Later the server drops `a` (its last focus left the window) and the thread
  // gains `c`; its key becomes `b`.
  const P_A = wpage("notes/a.md", [[150, 5]]);
  const P_B = wpage("notes/b.md", [[2, 9]]);
  const P_C = wpage("notes/c.md", [[1, 3]]);
  const PAGES = [P_A, P_B, P_C, wpage("notes/other.md", [[3, 20]])];
  const DAY0 = [thread("notes/a.md", ["notes/b.md", "notes/a.md"]), thread("notes/other.md", ["notes/other.md"])];
  const LATER = [thread("notes/b.md", ["notes/b.md", "notes/c.md"]), thread("notes/other.md", ["notes/other.md"])];
  const pinOf = (cards: ReturnType<typeof cardsOf>, key: string) => {
    const html = threadCardHeaderHtml(cards.find((c) => c.key === key)!, false, NOW, false);
    return /data-thread-pin="([^"]+)"/.exec(html)![1]!;
  };

  test("the 📌 stores a page the thread still holds after its earliest page ages out", () => {
    const stored = pinOf(cardsOf({ threads: DAY0, pages: PAGES }), "notes/a.md");
    const later = cardsOf({ threads: LATER, pages: PAGES, pin: stored });
    expect(later.find((c) => c.key === "notes/b.md")!.pinned).toBe(true);
    expect(later[0]!.key).toBe("notes/b.md");
  });

  test("a pin on the thread's oldest page is re-anchored to its newest focus page while the thread is alive", () => {
    expect(threadPinAnchor(DAY0, PAGES, "notes/a.md")).toBe("notes/b.md");
    const later = cardsOf({ threads: LATER, pages: PAGES, pin: threadPinAnchor(DAY0, PAGES, "notes/a.md") });
    expect(later[0]!.pinned).toBe(true);
    expect(later[0]!.key).toBe("notes/b.md");
    // Growing: the next render moves the pin to the new newest page.
    expect(threadPinAnchor(LATER, PAGES, "notes/b.md")).toBe("notes/c.md");
    // No thread holds the pin ⇒ nothing to re-anchor.
    expect(threadPinAnchor(LATER, PAGES, "notes/gone.md")).toBeNull();
    expect(threadPinAnchor(null, PAGES, "notes/b.md")).toBeNull();
  });
});

describe("a thread's name and order do not move with Show retired", () => {
  const RETIRED = wpage("plans/retired-top.mdx", [[1, 50]], { title: "Retired top — detail", culled: true });
  const LIVE = wpage("plans/live.mdx", [[2, 2]], { title: "Live second" });
  const MID = wpage("notes/mid-live.md", [[3, 10]], { title: "Middle thread" });
  const WIKI: RailWikiFacts = {
    allPages: [RETIRED, LIVE, MID],
    projects: {},
    activityWeights: DEFAULT_ACTIVITY_WEIGHTS,
    workedGate: { open: true, candidates: 1, covered: 1, coverage: 1 },
    work: { threads: [thread("plans/retired-top.mdx", ["plans/retired-top.mdx", "plans/live.mdx"]), thread("notes/mid-live.md", ["notes/mid-live.md"])] },
  };
  const view = (showRetired: boolean) =>
    railInputFor(WIKI, base({ showRetired })).threads!.map((c) => ({ key: c.key, name: c.name, open: c.open, score: c.score }));

  test("toggling show-retired leaves card order, names and the open card unchanged", () => {
    expect(view(false)).toEqual(view(true));
    expect(view(false).map((c) => c.name)).toEqual(["Retired top", "Middle thread"]);
  });

  test("a later card is not named from a page an earlier card owns (D16)", () => {
    const cards = cardsOf({
      threads: [thread("plans/heavy.mdx", ["plans/heavy.mdx"]), thread("notes/x1.md", ["notes/x1.md", "plans/heavy.mdx"])],
    });
    const later = cards.find((c) => c.key === "notes/x1.md")!;
    expect(later.focus.map((p) => p.relPath)).toEqual(["notes/x1.md"]);
    expect(later.name).toBe("notes/x1.md");
  });
});

describe("a thread with no usable session is dropped whole", () => {
  test("usableThreads and openThreadCards drop it", () => {
    const bad = { key: "notes/mid.md", pages: ["notes/mid.md"], touched: [], sessions: [{ id: "s" }, null] };
    expect(usableThreads([bad])).toEqual([]);
    expect(cardsOf({ threads: [bad, ...T_THREADS.slice(0, 1)] }).map((c) => c.key)).toEqual(["plans/recent.mdx"]);
  });
});

// ── PR 700 fix round 1 batch 5: pins on existing behaviour ──────────────────
describe("a hub has one owner, and a later card never takes it (D16)", () => {
  const HUB = wpage("plans/hub.mdx", [[1, 40]], { title: "Hub page" });
  const A = wpage("plans/a.mdx", [[2, 20]], { title: "A page" });
  const B = wpage("notes/b.md", [[3, 2]], { title: "B page" });
  // Card 1 (a + hub) outranks card 2 (b + hub): both share the hub's top term.
  const THREADS = [thread("plans/a.mdx", ["plans/a.mdx", "plans/hub.mdx"]), thread("notes/b.md", ["notes/b.md", "plans/hub.mdx"])];
  const HUB_WIKI: RailWikiFacts = {
    allPages: [HUB, A, B],
    projects: {},
    activityWeights: DEFAULT_ACTIVITY_WEIGHTS,
    workedGate: { open: true, candidates: 1, covered: 1, coverage: 1 },
    work: { threads: THREADS },
  };

  test("closed card 1 owns the hub: open card 2 neither rows it nor lifts it out of Activity", () => {
    const viewer = base({ openFolds: ["closed:thread:plans/a.mdx", "thread:notes/b.md"] });
    const input = railInputFor(HUB_WIKI, viewer);
    expect(input.threads!.map((c) => [c.key, c.open])).toEqual([
      ["plans/a.mdx", false],
      ["notes/b.md", true],
    ]);
    expect((input.threads as RailThreadCard[])[1]!.focus.map((p) => p.relPath)).toEqual(["notes/b.md"]);
    // Not in the exclude set: Activity still ranks the hub.
    expect((input.activity ?? []).map((r) => r.page.relPath)).toContain("plans/hub.mdx");
    const rail = buildRail(input);
    const threadRows = rail.entries.filter((e) => e.kind === "row" && e.section === "threads").map((e) => (e.kind === "row" ? e.page.relPath : ""));
    expect(threadRows).toEqual(["notes/b.md"]);
  });

  test("a card a facet empties still owns its hub: the later card is not named after it", () => {
    const filtered = cardsOf({ threads: THREADS, pages: [HUB, A, B], filters: { ...INERT, folder: "notes" } });
    expect(filtered.map((c) => c.key)).toEqual(["notes/b.md"]);
    expect(filtered[0]!.focus.map((p) => p.relPath)).toEqual(["notes/b.md"]);
    expect(filtered[0]!.name).toBe("B page");
  });
});

describe("a card's name and pin anchor are stable", () => {
  test("a facet that hides the top page does not rename the card", () => {
    const TOP = wpage("plans/top.mdx", [[1, 30]], { title: "Top page — detail" });
    const LOW = wpage("notes/low.md", [[2, 2]], { title: "Low page" });
    const T = [thread("plans/top.mdx", ["plans/top.mdx", "notes/low.md"])];
    const [all] = cardsOf({ threads: T, pages: [TOP, LOW] });
    const [notes] = cardsOf({ threads: T, pages: [TOP, LOW], filters: { ...INERT, folder: "notes" } });
    expect(all!.name).toBe("Top page");
    expect(notes!.focus.map((p) => p.relPath)).toEqual(["notes/low.md"]);
    expect(notes!.name).toBe("Top page");
  });

  test("equal focus times anchor the pin on the smaller relPath, whatever the thread's page order", () => {
    const B = wpage("notes/b.md", [[2, 1]]);
    const A = wpage("notes/a.md", [[2, 9]]);
    const T = [thread("notes/b.md", ["notes/b.md", "notes/a.md"])];
    expect(threadPinAnchor(T, [B, A], "notes/b.md")).toBe("notes/a.md");
    expect(cardsOf({ threads: T, pages: [B, A] })[0]!.pinAnchor).toBe("notes/a.md");
    // Neither page carries work: both rank -Infinity, and the tie-break still decides.
    const Z = page({ relPath: "notes/z.md" });
    const Y = page({ relPath: "notes/y.md" });
    expect(threadPinAnchor([thread("notes/z.md", ["notes/z.md", "notes/y.md"])], [Z, Y], "notes/z.md")).toBe("notes/y.md");
  });
});

describe("a card's touched line never repeats one of its focus rows", () => {
  test("a page both focused and touched by the thread is a row, not also a link", () => {
    const F = wpage("notes/f.md", [[1, 5]]);
    const T = page({ relPath: "notes/t.md" });
    const [card] = cardsOf({ threads: [thread("notes/f.md", ["notes/f.md"], ["notes/f.md", "notes/t.md"])], pages: [F, T] });
    expect(card!.focus.map((p) => p.relPath)).toEqual(["notes/f.md"]);
    expect(card!.touched.map((p) => p.relPath)).toEqual(["notes/t.md"]);
  });
});

describe("the pin anchor is never a hub page (D7 × D16)", () => {
  // Built through `computeWorkFocus`, so the threads and each page's `work` are
  // what the server ships. Day 1: one session focuses the hub and `p/a.mdx`,
  // the hub last. Day 2: a second session works the hub hard; D16 hands the
  // hub's focus row to that session's thread while thread `p/a.mdx` lives on.
  const HUB = "flows/hub.mdx";
  const A = "p/a.mdx";
  const T1 = NOW;
  const T2 = NOW + DAY;
  const at = (t: number, h: number) => t - h * H;
  const sess = (id: string, named: string[], files: Array<[string, number, number]>): WorkSession => ({
    id,
    provider: "claude",
    title: `session ${id}`,
    first: Math.min(...files.map((f) => f[2])) - 60_000,
    last: Math.max(...files.map((f) => f[2])),
    bulk: false,
    text: { from: "prompt", paths: named, links: [], files: [] },
    files: files.map(([p, edits, lastMs]) => ({ p, edits, firstMs: lastMs - 60_000, lastMs })),
  });
  const S1 = sess("s1", [HUB, A], [[A, 5, at(T1, 3)], [HUB, 5, at(T1, 1)]]);
  const S2 = sess("s2", [HUB], [[HUB, 60, at(T2, 1)]]);
  const BACKLINKS: Record<string, number> = { [HUB]: WORK_HUB_BACKLINKS + 5, [A]: 0 };
  const world = (asOf: number, sessions: WorkSession[]) => {
    const r = computeWorkFocus({
      sessions,
      pre: new Map(),
      sinceMs: asOf - 8 * DAY,
      asOfMs: asOf,
      pages: [HUB, A].map((relPath) => ({ relPath, backlinks: BACKLINKS[relPath]!, gitCreatedMs: asOf - 40 * DAY })),
      identity: { roots: ["/w/x"], names: ["x"] },
      otherRoots: [],
    });
    const pages = [HUB, A].map((rel) => {
      const work = r.pages.get(rel);
      return page({ relPath: rel, backlinkCount: BACKLINKS[rel]!, gitCreatedMs: asOf - 40 * DAY, ...(work ? { work } : {}) });
    });
    return { threads: r.threads, pages };
  };

  test("the 📌 stores the thread's newest NON-hub focus page, so the pin stays when the hub moves to another thread", () => {
    const day1 = world(T1, [S1]);
    expect(day1.threads.map((t) => [t.key, [...t.pages].sort()])).toEqual([[A, [HUB, A].sort()]]);
    const [card] = openThreadCards(day1.threads, day1.pages, INERT, [], null, T1);
    expect(card!.pinAnchor).toBe(A);
    // The renderer's re-anchor does not move a non-hub pin onto the hub either.
    expect(threadPinAnchor(day1.threads, day1.pages, A)).toBe(A);

    const day2 = world(T2, [S1, S2]);
    // The scenario holds: the hub now has its own thread, and `p/a.mdx` lives on.
    expect(day2.threads.map((t) => [t.key, t.pages]).sort()).toEqual([[HUB, [HUB]], [A, [A]]].sort());
    const cards = openThreadCards(day2.threads, day2.pages, INERT, [], card!.pinAnchor, T2);
    expect(cards.find((c) => c.pinned)?.key).toBe(A);
    expect(threadPinAnchor(day2.threads, day2.pages, card!.pinAnchor)).toBe(A);
  });

  test("a thread holding hubs only anchors on its newest hub", () => {
    const day2 = world(T2, [S1, S2]);
    expect(threadPinAnchor(day2.threads, day2.pages, HUB)).toBe(HUB);
  });
});

// ── PR 700 class check: the anchor rows of the pin's state table ─────────────
describe("the pin's anchor rows (D7 × D16): a hub pin never moves to a thread the reader did not pin", () => {
  const HUB = "flows/hub.mdx";
  const X = "p/x.mdx";
  const T1 = NOW;
  const T2 = NOW + DAY;
  const at = (t: number, h: number) => t - h * H;
  const sess = (id: string, named: string[], files: Array<[string, number, number]>): WorkSession => ({
    id,
    provider: "claude",
    title: `session ${id}`,
    first: Math.min(...files.map((f) => f[2])) - 60_000,
    last: Math.max(...files.map((f) => f[2])),
    bulk: false,
    text: { from: "prompt", paths: named, links: [], files: [] },
    files: files.map(([p, edits, lastMs]) => ({ p, edits, firstMs: lastMs - 60_000, lastMs })),
  });
  const BACKLINKS: Record<string, number> = { [HUB]: WORK_HUB_BACKLINKS + 5, [X]: 0 };
  const world = (asOf: number, sessions: WorkSession[]) => {
    const rels = [HUB, X];
    const r = computeWorkFocus({
      sessions,
      pre: new Map(),
      sinceMs: asOf - 8 * DAY,
      asOfMs: asOf,
      pages: rels.map((relPath) => ({ relPath, backlinks: BACKLINKS[relPath]!, gitCreatedMs: asOf - 40 * DAY })),
      identity: { roots: ["/w/x"], names: ["x"] },
      otherRoots: [],
    });
    const pages = rels.map((rel) => {
      const work = r.pages.get(rel);
      return page({ relPath: rel, backlinkCount: BACKLINKS[rel]!, gitCreatedMs: asOf - 40 * DAY, ...(work ? { work } : {}) });
    });
    return { threads: r.threads, pages };
  };

  test("A4/A5: a hubs-only thread's pin stays on that thread, and does not follow the hub when D16 hands it to a thread with a non-hub page", () => {
    // Day 1: s1 focuses only the hub — a thread of hubs only, pinned on the hub.
    const S1 = sess("s1", [HUB], [[HUB, 5, at(T1, 1)]]);
    const day1 = world(T1, [S1]);
    expect(day1.threads.map((t) => t.pages)).toEqual([[HUB]]);
    const [card] = openThreadCards(day1.threads, day1.pages, INERT, [], null, T1);
    expect(card!.pinAnchor).toBe(HUB);
    expect(openThreadCards(day1.threads, day1.pages, INERT, [], HUB, T1)[0]!.pinned).toBe(true);
    expect(threadPinAnchor(day1.threads, day1.pages, HUB)).toBe(HUB);
    // Day 2: s2 works the hub harder and also focuses p/x. The hub's focus row
    // moves to s2's thread and s1's thread is gone.
    const S2 = sess("s2", [HUB, X], [[HUB, 60, at(T2, 1)], [X, 5, at(T2, 2)]]);
    const day2 = world(T2, [S1, S2]);
    expect(day2.threads.map((t) => [...t.pages].sort())).toEqual([[HUB, X].sort()]);
    // The pin matches nothing: no card is pinned, and there is no anchor to write.
    expect(openThreadCards(day2.threads, day2.pages, INERT, [], HUB, T2).some((c) => c.pinned)).toBe(false);
    expect(threadPinAnchor(day2.threads, day2.pages, HUB)).toBeNull();
  });

  test("A6: a thread of several hubs anchors on its newest hub, a tie on the smaller relPath", () => {
    const hub = (rel: string, h: number) => wpage(rel, [[h, 3]], { backlinkCount: WORK_HUB_BACKLINKS + 1 });
    const T = [thread("flows/h1.mdx", ["flows/h1.mdx", "flows/h2.mdx", "flows/h3.mdx"])];
    const pages = [hub("flows/h1.mdx", 5), hub("flows/h2.mdx", 1), hub("flows/h3.mdx", 3)];
    expect(threadPinAnchor(T, pages, "flows/h1.mdx")).toBe("flows/h2.mdx");
    expect(cardsOf({ threads: T, pages })[0]!.pinAnchor).toBe("flows/h2.mdx");
    const tied = [hub("flows/h1.mdx", 2), hub("flows/h2.mdx", 2), hub("flows/h3.mdx", 2)];
    expect(threadPinAnchor(T, tied, "flows/h3.mdx")).toBe("flows/h1.mdx");
  });

  test("A2/A3: a non-hub pin re-anchors to the newest NON-hub page, past a newer hub; a pin no thread holds has no anchor", () => {
    const T = [thread("notes/a.md", ["notes/a.md", "notes/b.md", "flows/hub.mdx"])];
    const pages = [
      wpage("notes/a.md", [[5, 3]]),
      wpage("notes/b.md", [[3, 3]]),
      wpage("flows/hub.mdx", [[1, 3]], { backlinkCount: WORK_HUB_BACKLINKS + 1 }),
    ];
    expect(threadPinAnchor(T, pages, "notes/a.md")).toBe("notes/b.md");
    expect(threadPinAnchor(T, pages, "notes/gone.md")).toBeNull();
    expect(threadPinAnchor(T, pages, null)).toBeNull();
  });

  test("the hub threshold: WORK_HUB_BACKLINKS backlinks is not a hub, one more is", () => {
    // A mixed thread, the pin on the page at the boundary: at 25 it is an
    // ordinary page and the thread holds the pin; at 26 it is a hub in a
    // thread with a non-hub page, so the thread does not.
    const T = [thread("notes/a.md", ["notes/a.md", "notes/edge.md"])];
    const at = (n: number) => [wpage("notes/a.md", [[5, 3]]), wpage("notes/edge.md", [[1, 3]], { backlinkCount: n })];
    expect(threadPinAnchor(T, at(WORK_HUB_BACKLINKS), "notes/edge.md")).toBe("notes/edge.md");
    expect(cardsOf({ threads: T, pages: at(WORK_HUB_BACKLINKS), pin: "notes/edge.md" })[0]!.pinned).toBe(true);
    expect(threadPinAnchor(T, at(WORK_HUB_BACKLINKS + 1), "notes/edge.md")).toBeNull();
    expect(cardsOf({ threads: T, pages: at(WORK_HUB_BACKLINKS + 1), pin: "notes/edge.md" })[0]!.pinned).toBe(false);
    // And the anchor skips it only as a hub.
    expect(threadPinAnchor(T, at(WORK_HUB_BACKLINKS), "notes/a.md")).toBe("notes/edge.md");
    expect(threadPinAnchor(T, at(WORK_HUB_BACKLINKS + 1), "notes/a.md")).toBe("notes/a.md");
  });
});
