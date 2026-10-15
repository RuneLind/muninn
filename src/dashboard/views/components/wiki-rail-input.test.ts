/**
 * `railInputFor` must hand `buildRail` exactly what `renderList` assembled
 * inline before the move (plan D20). `legacyRailInput` below is that inline
 * code, copied verbatim apart from the module state it read, and every case
 * compares the two rails' JSON over one fixture listing.
 */

import { describe, expect, test } from "bun:test";
import { railInputFor, type RailViewer, type RailWikiFacts } from "./wiki-rail-input.ts";
import { buildRail, railSectionsVisible, type RailInput } from "./wiki-recents.ts";
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
