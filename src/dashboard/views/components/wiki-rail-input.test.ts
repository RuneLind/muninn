/**
 * `railInputFor` must hand `buildRail` exactly what `renderList` assembled
 * inline before the move (plan D20). `legacyRailInput` below is that inline
 * code, copied verbatim apart from the module state it read, and every case
 * compares the two rails' JSON over one fixture listing.
 */

import { describe, expect, test } from "bun:test";
import { openThreadCards, railInputFor, usableThreads, type RailViewer, type RailWikiFacts } from "./wiki-rail-input.ts";
import { buildRail, railSectionsVisible, THREAD_CARDS_MAX, type RailInput } from "./wiki-recents.ts";
import { threadScore, type WorkThread } from "../../../wiki/work-focus.ts";
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
    expect(usableThreads([{ key: "x" }, { key: "y", pages: ["y"], touched: [], sessions: [{ id: "s" }] }, 3])).toEqual([
      { key: "y", pages: ["y"], touched: [], sessions: [] },
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
    const open = input.threads!.filter((c) => c.open).flatMap((c) => c.focus.map((p) => p.relPath));
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
