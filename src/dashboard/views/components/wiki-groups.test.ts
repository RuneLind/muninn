/**
 * The family and month rules, as an ENUMERATION of the rule's state space
 * rather than as samples — every clause of the family rule has a case, and the
 * cases that MUST NOT form have one too, because "no family here" is the half a
 * rule this permissive gets wrong.
 *
 * Every name is SYNTHETIC. This is a public repo and a private wiki's file names
 * are a disclosure; the live 18-family table is checked once, in the acceptance
 * run against the real wiki, and recorded in the PR body.
 */
import { describe, expect, test } from "bun:test";
import {
  FAMILY_MAX,
  FAMILY_MIN,
  GROUP_FAMILIES_TOGGLE_KEY,
  NO_STATUS_WORD,
  closedFoldKey,
  defaultOpenGroupKey,
  familyFoldKey,
  groupFamilies,
  groupMonths,
  groupRollup,
  groupSeries,
  isMonthGrouping,
  monthFoldKey,
  newestSeriesPlan,
  orderPagesForGroups,
  railGroups,
  seriesClaimedKeys,
  seriesDateMs,
  seriesFoldKey,
  seriesHead,
  withoutSeriesMembers,
} from "./wiki-groups.ts";
import { pageDateSignal, type WikiListing } from "./wiki-filter.ts";

function page(over: Partial<WikiListing> & { relPath: string }): WikiListing {
  return {
    name: over.relPath.slice(over.relPath.lastIndexOf("/") + 1).replace(/\.(mdx?|html)$/, ""),
    title: "Untitled",
    type: "note",
    domain: "ai",
    tags: [],
    aliases: [],
    linkCount: 0,
    backlinkCount: 0,
    ...over,
  } as WikiListing;
}

/** `n` plain markdown pages in `notes/`, named `<prefix>-<i>`. */
function slate(prefix: string, n: number, over: Partial<WikiListing> = {}): WikiListing[] {
  return Array.from({ length: n }, (_, i) =>
    page({ relPath: `notes/${prefix}-${i + 1}.mdx`, ...over }),
  );
}

const PROJECTS = { acme: 3, "acme-tools": 41 };

const labels = (pages: WikiListing[], projects: Record<string, number> = PROJECTS): string[] =>
  groupFamilies(pages, projects)
    .map((g) => g.label)
    .sort();

/** Three unrelated parents in `notes/`, so a case about the PREFIX threshold is
 *  decided by the prefix rule and not by the folder simply holding too few rows.
 *  Their own stems share no two-segment prefix with each other. */
const FILLER = [
  page({ relPath: "notes/kappa-one.mdx" }),
  page({ relPath: "notes/lambda-two.mdx" }),
  page({ relPath: "notes/sigma-three.mdx" }),
];

describe("groupFamilies — how many members it takes", () => {
  test("three parents on a two-segment prefix is a family", () => {
    expect(labels([...FILLER, ...slate("beta-flow", FAMILY_MIN)])).toEqual(["beta-flow-*"]);
  });

  test("two is not: a pair sharing a name is a coincidence, not a slate", () => {
    // …in a folder that has plenty of other parents, so what refuses the family
    // is the two-member prefix and nothing else.
    expect(labels([...FILLER, ...slate("beta-flow", 2)])).toEqual([]);
  });

  test("twelve is a family and thirteen is a folder", () => {
    expect(labels(slate("beta-flow", FAMILY_MAX))).toEqual(["beta-flow-*"]);
    expect(labels(slate("beta-flow", FAMILY_MAX + 1))).toEqual([]);
  });

  test("a one-segment prefix never forms, whatever it holds", () => {
    // `solo-1`…`solo-5` share the prefix `solo`, which is one segment.
    expect(labels(slate("solo", 5).map((p) => page({ relPath: p.relPath })))).toEqual([]);
  });
});

describe("groupFamilies — the shortest prefix wins", () => {
  test("a nested prefix does not form a second family", () => {
    const pages = [...slate("beta-flow", 3), ...slate("beta-flow-north", 3)];
    // `beta-flow` holds six, `beta-flow-north` three — only the shorter forms,
    // and the longer one's pages are inside it.
    const fams = groupFamilies(pages, PROJECTS);
    expect(fams.map((f) => f.label)).toEqual(["beta-flow-*"]);
    expect(fams[0]!.members).toHaveLength(6);
  });

  test("a longer prefix forms only where the shorter is not a CANDIDATE", () => {
    // Every member of a longer prefix carries the shorter one too, so the
    // shorter can never be short of members: the only way a longer prefix wins
    // is the shorter being a project name (the case below) or over the cap
    // (which bans both). Here `beta-flow` qualifies, so `beta-flow-north` does
    // not — and its three pages are inside the shorter family.
    const pages = [page({ relPath: "notes/beta-one.mdx" }), ...slate("beta-flow-north", 3)];
    const fams = groupFamilies(pages, PROJECTS);
    expect(fams.map((f) => f.label)).toEqual(["beta-flow-*"]);
    expect(fams[0]!.members.map((m) => m.relPath)).not.toContain("notes/beta-one.mdx");
  });
});

describe("groupFamilies — project names and the over-cap ban", () => {
  test("a prefix equal to a project name never forms", () => {
    // `acme-tools` is a project (41 pages on the wiki this rule was measured
    // against): folding it would reproduce the folder select.
    expect(labels(slate("acme-tools", 5))).toEqual([]);
  });

  test("a sub-prefix under an over-cap PROJECT name forms", () => {
    const pages = [...slate("acme-tools-other", 13), ...slate("acme-tools-live", 3)];
    // `acme-tools` holds 16 and is over the cap — but it is a project name, so
    // it is not a candidate and bans nothing under it.
    expect(labels(pages)).toEqual(["acme-tools-live-*"]);
  });

  test("…and the over-cap sub-prefix itself still does not", () => {
    const pages = [...slate("acme-tools-other", 13), ...slate("acme-tools-live", 3)];
    expect(labels(pages)).not.toContain("acme-tools-other-*");
  });

  test("a sub-prefix under an over-cap NON-project prefix does NOT form", () => {
    // `zeta-core` holds 13 + 3 = 16, is two segments and is not a project: it is
    // a subsystem, and nothing under it folds.
    const pages = [...slate("zeta-core-old", 13), ...slate("zeta-core-sync", 3)];
    expect(labels(pages)).toEqual([]);
  });

  test("the ban is the ANCESTOR's total, not the candidate's own", () => {
    // Same shape, one page fewer: `zeta-core` holds 12 + 3 = 15 … still over.
    // At 9 + 3 = 12 it is AT the cap, so `zeta-core` itself forms and its
    // sub-prefix is nested inside it rather than banned.
    const pages = [...slate("zeta-core-old", 9), ...slate("zeta-core-sync", 3)];
    expect(labels(pages)).toEqual(["zeta-core-*"]);
  });
});

describe("groupFamilies — which rows count", () => {
  test("an .html page never counts, child or not", () => {
    const pages = [
      ...slate("beta-flow", 2),
      page({ relPath: "notes/beta-flow-3.html" }),
      page({ relPath: "notes/beta-flow-4.html", parent: "notes/beta-flow-1.mdx", pairedBy: "stem" }),
    ];
    expect(labels(pages)).toEqual([]);
  });

  test("an attachment child is not a member, and does not count", () => {
    const pages = [
      ...slate("beta-flow", 2),
      page({
        relPath: "notes/beta-flow-3.mdx",
        parent: "notes/beta-flow-1.mdx",
        pairedBy: "link",
      }),
    ];
    expect(labels(pages)).toEqual([]);
  });

  test("a rule-4 child counts toward the cap and the roll-up but not the threshold", () => {
    // Two parents + one superseded child is not a slate: the threshold is on
    // PARENT rows, and a page plus its predecessor is what the attachment layer
    // already folds.
    // FILLER keeps the folder well above three parents, so the answer comes from
    // the threshold being judged on PARENTS rather than on the prefix's total.
    const twoPlusOne = [
      ...FILLER,
      ...slate("beta-flow", 2),
      page({
        relPath: "notes/beta-flow-old.mdx",
        parent: "notes/beta-flow-1.mdx",
        pairedBy: "superseded",
        plan_status: "superseded",
      }),
    ];
    expect(labels(twoPlusOne)).toEqual([]);

    // Ten parents + two superseded children is twelve members: AT the cap.
    const tenPlusTwo = [
      ...slate("beta-flow", 10, { plan_status: "shipped" }),
      ...[1, 2].map((i) =>
        page({
          relPath: `notes/beta-flow-old-${i}.mdx`,
          parent: "notes/beta-flow-1.mdx",
          pairedBy: "superseded",
          plan_status: "superseded",
        }),
      ),
    ];
    const fam = groupFamilies(tenPlusTwo, PROJECTS);
    expect(fam.map((f) => f.label)).toEqual(["beta-flow-*"]);
    expect(fam[0]!.members).toHaveLength(10);
    expect(fam[0]!.supersededChildren).toHaveLength(2);
    expect(groupRollup("family", fam[0]!.members, fam[0]!.supersededChildren).label).toBe(
      "10 shipped · 2 superseded",
    );

    // Twelve parents + the same two children is fourteen: OVER the cap, so the
    // slate does not start folding because part of it was retired.
    const twelvePlusTwo = [
      ...slate("beta-flow", 12, { plan_status: "shipped" }),
      ...[1, 2].map((i) =>
        page({
          relPath: `notes/beta-flow-old-${i}.mdx`,
          parent: "notes/beta-flow-1.mdx",
          pairedBy: "superseded",
          plan_status: "superseded",
        }),
      ),
    ];
    expect(labels(twelvePlusTwo)).toEqual([]);
  });

  test("a fix-round report is never a member and never a family", () => {
    const reports = Array.from({ length: 4 }, (_, i) =>
      page({ relPath: `notes/2026-01-0${i + 1}-three-fix-rounds-${100 + i}.mdx` }),
    );
    // They share the two-segment prefix `2026-01`, and none of them counts.
    expect(labels(reports)).toEqual([]);
    // …and one of them cannot complete somebody else's slate either.
    const pages = [...slate("beta-flow", 2), page({ relPath: "notes/2026-01-05-two-fix-rounds-104.mdx" })];
    expect(labels(pages)).toEqual([]);
    // The shape is anchored at the START of the stem, which is where the
    // convention puts the date: an ordinary page whose title happens to carry
    // those words is a page like any other.
    expect(labels([...slate("beta-flow", 2), page({ relPath: "notes/beta-flow-fix-rounds-notes.mdx" })])).toEqual([
      "beta-flow-*",
    ]);
  });

});

describe("groupFamilies — scope and shape", () => {
  test("the same prefix in two folders is two families, keyed apart", () => {
    const pages = [
      ...slate("beta-flow", 3),
      ...Array.from({ length: 3 }, (_, i) => page({ relPath: `other/beta-flow-${i + 1}.mdx` })),
    ];
    const fams = groupFamilies(pages, PROJECTS);
    // Literal, not `familyFoldKey(...)`: computing the expectation from the
    // builder under test made this case pass for any key shape it might emit.
    expect(fams.map((f) => f.key).sort()).toEqual([
      "family:notes/beta-flow",
      "family:other/beta-flow",
    ]);
    expect(familyFoldKey("notes", "beta-flow")).toBe("family:notes/beta-flow");
    // …and neither folder's three pages complete the other's count.
    const split = [
      ...slate("gamma-flow", 2),
      ...Array.from({ length: 2 }, (_, i) => page({ relPath: `other/gamma-flow-${i + 1}.mdx` })),
    ];
    expect(groupFamilies(split, PROJECTS)).toHaveLength(0);
  });

  test("a page whose stem IS the prefix is a member of it", () => {
    const pages = [
      page({ relPath: "notes/beta-flow.mdx" }),
      page({ relPath: "notes/beta-flow-north.mdx" }),
      page({ relPath: "notes/beta-flow-south.mdx" }),
    ];
    const fam = groupFamilies(pages, PROJECTS);
    expect(fam.map((f) => f.label)).toEqual(["beta-flow-*"]);
    expect(fam[0]!.members).toHaveLength(3);
  });

  test("prefixes are matched case-insensitively and members keep the input order", () => {
    const pages = [
      page({ relPath: "notes/Beta-flow-north.mdx" }),
      page({ relPath: "notes/beta-flow-south.mdx" }),
      page({ relPath: "notes/BETA-FLOW-east.mdx" }),
    ];
    const fam = groupFamilies(pages, PROJECTS);
    expect(fam.map((f) => f.label)).toEqual(["beta-flow-*"]);
    expect(fam[0]!.members.map((m) => m.relPath)).toEqual(pages.map((p) => p.relPath));
  });

  test("a wiki that declares no projects still groups, it just loses the exclusion", () => {
    expect(labels(slate("acme-tools", 5), {})).toEqual(["acme-tools-*"]);
  });
});

describe("groupMonths", () => {
  const dated = (day: string, over: Partial<WikiListing> = {}) =>
    page({ relPath: `archive/${day}-topic.mdx`, ...over });

  test("the key comes from the FILENAME's date prefix", () => {
    const months = groupMonths([dated("2026-09-02"), dated("2026-08-30"), dated("2026-09-18")], "updated");
    expect(months.map((m) => m.key)).toEqual([monthFoldKey("2026-09"), monthFoldKey("2026-08")]);
    expect(months[0]!.members).toHaveLength(2);
  });

  test("…and from the SORT date when the name carries none", () => {
    const months = groupMonths(
      [page({ relPath: "archive/undated-note.mdx", updated: "2026-07-14" })],
      "updated",
    );
    expect(months.map((m) => m.label)).toEqual(["2026-07"]);
  });

  test("the filename beats the stamp — a typo fix must not move a page's month", () => {
    const months = groupMonths([dated("2026-08-30", { updated: "2026-09-18" })], "updated");
    expect(months.map((m) => m.label)).toEqual(["2026-08"]);
  });

  test("a page with no date at all joins no month and stays an ordinary row", () => {
    expect(groupMonths([page({ relPath: "archive/undated-note.mdx" })], "updated")).toEqual([]);
  });

  test("the NEWEST month is the one that defaults open, whatever the input order", () => {
    for (const order of [
      [dated("2026-08-30"), dated("2026-09-02")],
      [dated("2026-09-02"), dated("2026-08-30")],
    ]) {
      expect(defaultOpenGroupKey(groupMonths(order, "updated"))).toBe(monthFoldKey("2026-09"));
    }
  });

  test("months come back NEWEST FIRST, whatever the rows' own order was", () => {
    const months = groupMonths(
      [dated("2026-05-01"), dated("2026-09-02"), dated("2026-07-11"), dated("2026-06-30")],
      "updated",
    );
    expect(months.map((m) => m.label)).toEqual(["2026-09", "2026-07", "2026-06", "2026-05"]);
  });

  test("children and meta pages are not month members", () => {
    // ⚠️ The meta page carries a REAL date signal (`mtimeMs`, a month of its
    // own). Without one it has no month to join and drops out whatever the guard
    // does — which is what made the earlier version of this case unable to fail.
    const meta = page({ relPath: "archive/index.md", mtimeMs: Date.parse("2026-07-04T00:00:00Z") });
    expect(pageDateSignal(meta, "updated")?.label?.slice(0, 7)).toBe("2026-07");
    const months = groupMonths(
      [
        dated("2026-09-02"),
        page({ relPath: "archive/2026-09-03-child.html", parent: "archive/2026-09-02-topic.mdx", pairedBy: "suffix" }),
        meta,
      ],
      "updated",
    );
    expect(months.map((m) => m.label)).toEqual(["2026-09"]);
    expect(months[0]!.members.map((m) => m.relPath)).toEqual(["archive/2026-09-02-topic.mdx"]);
  });
});

describe("orderPagesForGroups", () => {
  const dated = (day: string) => page({ relPath: `archive/${day}-topic.mdx` });
  test("re-orders the rows into the groups' own order, keeping each group's order", () => {
    // The row order a date sort produced: an OLD page edited recently sits on
    // top, which is what pulls its whole month up under the rail's own
    // first-member placement rule.
    const rows = [dated("2026-05-04"), dated("2026-09-02"), dated("2026-05-01"), dated("2026-09-11")];
    const months = groupMonths(rows, "updated");
    expect(orderPagesForGroups(rows, months).map((p) => p.relPath)).toEqual([
      "archive/2026-09-02-topic.mdx",
      "archive/2026-09-11-topic.mdx",
      "archive/2026-05-04-topic.mdx",
      "archive/2026-05-01-topic.mdx",
    ]);
  });
  test("an ungrouped row goes last, and no groups is a no-op copy", () => {
    const rows = [page({ relPath: "archive/undated.mdx" }), dated("2026-09-02")];
    const months = groupMonths(rows, "updated");
    expect(orderPagesForGroups(rows, months).map((p) => p.relPath)).toEqual([
      "archive/2026-09-02-topic.mdx",
      "archive/undated.mdx",
    ]);
    const copy = orderPagesForGroups(rows, []);
    expect(copy.map((p) => p.relPath)).toEqual(rows.map((p) => p.relPath));
    expect(copy).not.toBe(rows);
  });
});

describe("defaultOpenGroupKey", () => {
  const dated = (day: string) => page({ relPath: `archive/${day}-topic.mdx` });

  test("the newest month among the groups it is HANDED, not among all of them", () => {
    const all = groupMonths([dated("2026-09-02"), dated("2026-08-30"), dated("2026-07-11")], "updated");
    expect(defaultOpenGroupKey(all)).toBe(monthFoldKey("2026-09"));
    // The rail hands it the months that really render. With September's pages
    // lifted into Activity, the default is August — the whole reason this is a
    // function of the rendered set.
    expect(defaultOpenGroupKey(all.filter((m) => m.label !== "2026-09"))).toBe(
      monthFoldKey("2026-08"),
    );
  });

  test("input order does not decide it", () => {
    const months = groupMonths([dated("2026-08-30"), dated("2026-09-02")], "updated");
    expect(defaultOpenGroupKey([...months].reverse())).toBe(monthFoldKey("2026-09"));
  });

  test("families never default open, and an empty render has no default", () => {
    expect(defaultOpenGroupKey(groupFamilies(slate("beta-flow", 3), PROJECTS))).toBeNull();
    expect(defaultOpenGroupKey([])).toBeNull();
  });

  test("the CLOSED spelling is the key with one fixed prefix", () => {
    expect(closedFoldKey(monthFoldKey("2026-09"))).toBe("closed:month:2026-09");
  });
});

describe("railGroups — which grouping a render gets", () => {
  const archive = [
    page({ relPath: "archive/2026-09-02-topic.mdx" }),
    page({ relPath: "archive/2026-08-30-topic.mdx" }),
  ];
  test("the archive folder under a date sort folds by month", () => {
    for (const sort of ["updated", "created"] as const) {
      const groups = railGroups(archive, { folder: "archive", sort, projects: PROJECTS });
      expect(groups.map((g) => g.kind)).toEqual(["month", "month"]);
    }
  });
  test("…and under any other sort, or in any other folder, it is families", () => {
    expect(railGroups(archive, { folder: "archive", sort: "title", projects: PROJECTS })).toEqual([]);
    const notes = slate("beta-flow", 3);
    expect(
      railGroups(notes, { folder: "notes", sort: "updated", projects: PROJECTS }).map((g) => g.kind),
    ).toEqual(["family"]);
  });
});

describe("groupRollup", () => {
  const withStatus = (status: string | undefined, n: number) =>
    Array.from({ length: n }, (_, i) =>
      page({ relPath: `notes/p-${status ?? "none"}-${i}.mdx`, ...(status ? { plan_status: status } : {}) }),
    );

  test("a family counts statuses in the facet's order, superseded children included", () => {
    const members = [...withStatus("shipped", 9), ...withStatus("ready", 1)];
    const children = withStatus("superseded", 1);
    expect(groupRollup("family", members, children)).toEqual({
      label: "1 ready · 9 shipped · 1 superseded",
      compact: "1 · 9 · 1",
      wide: true,
    });
  });

  test("the acceptance shape reads exactly as the plan wrote it", () => {
    expect(groupRollup("family", withStatus("shipped", 9), withStatus("superseded", 1)).label).toBe(
      "9 shipped · 1 superseded",
    );
  });

  test("a page declaring no status counts under one neutral word, last", () => {
    expect(groupRollup("family", [...withStatus(undefined, 2), ...withStatus("shipped", 1)])).toEqual({
      label: `1 shipped · 2 ${NO_STATUS_WORD}`,
      compact: "1 · 2",
      wide: true,
    });
  });

  test("one kind is not `wide` — the chip's breakpoint class is about the LABEL", () => {
    expect(groupRollup("family", withStatus("shipped", 3))).toEqual({
      label: "3 shipped",
      compact: "3",
      wide: false,
    });
  });

  test("a month counts pages, singular and plural", () => {
    expect(groupRollup("month", withStatus(undefined, 1)).label).toBe("1 page");
    expect(groupRollup("month", withStatus(undefined, 4))).toEqual({
      label: "4 pages",
      compact: "4",
      wide: false,
    });
  });
});

describe("the toggle's own key", () => {
  test("is a sentinel in the folds namespace, like the section key", () => {
    expect(GROUP_FAMILIES_TOGGLE_KEY).toBe("toggle:families");
    // Lowercase and separator-free, so `normalizeRel` leaves it alone.
    expect(GROUP_FAMILIES_TOGGLE_KEY).toBe(GROUP_FAMILIES_TOGGLE_KEY.toLowerCase());
    expect(GROUP_FAMILIES_TOGGLE_KEY).not.toContain("\\");
  });
});

describe("groupFamilies — a date is never a family (fix round 1)", () => {
  test("a folder of dated names forms no family", () => {
    // Four pages sharing `2026-07`, which the rule used to mint as an ordinary
    // two-segment prefix: on the live wiki that produced the same label TWICE
    // (two subfolders of one month) and said nothing a date sort does not.
    const dated = ["alpha", "beta", "gamma", "delta"].map((t, i) =>
      page({ relPath: `archive/2026-07-0${i + 1}-${t}.mdx` }),
    );
    expect(labels(dated)).toEqual([]);
    // The DAY shape is excluded too — three pages written on one day.
    const oneDay = ["alpha", "beta", "gamma"].map((t) =>
      page({ relPath: `archive/2026-07-04-${t}.mdx` }),
    );
    expect(labels(oneDay)).toEqual([]);
  });

  test("a real dash slate nested under a dated month still forms", () => {
    // 13 pages of July plus a 3-page slate inside it. `2026-07` is over the cap,
    // and as a CANDIDATE it banned everything under it; as a date it bans
    // nothing and the slate the reader filed is what folds.
    const month = Array.from({ length: 13 }, (_, i) =>
      page({ relPath: `archive/2026-07-${String(i + 1).padStart(2, "0")}-note.mdx` }),
    );
    const nested = [1, 2, 3].map((i) =>
      page({ relPath: `archive/2026-07-15-beta-flow-${i}.mdx` }),
    );
    // `2026-07` and `2026-07-15` are both dates and neither is a candidate, so
    // the shortest prefix that IS one wins.
    expect(labels([...month, ...nested])).toEqual(["2026-07-15-beta-*"]);
  });

  test("a prefix that only STARTS with a date is an ordinary candidate", () => {
    const pages = [1, 2, 3].map((i) => page({ relPath: `notes/2026-07-04-beta-${i}.mdx` }));
    expect(labels(pages)).toEqual(["2026-07-04-beta-*"]);
  });
});

describe("groupFamilies — empty dash segments (fix round 1)", () => {
  test("a doubled dash mints no `a-` family", () => {
    const pages = [1, 2, 3].map((i) => page({ relPath: `notes/alfa--beta-${i}.mdx` }));
    expect(labels(pages)).toEqual([]);
  });

  test("a leading dash mints no `-x` family", () => {
    const pages = [1, 2, 3].map((i) => page({ relPath: `notes/-beta-${i}.mdx` }));
    expect(labels(pages)).toEqual([]);
  });

  test("…and the segments BEFORE an empty one are still a prefix", () => {
    const pages = [1, 2, 3].map((i) => page({ relPath: `notes/beta-flow--${i}.mdx` }));
    expect(labels(pages)).toEqual(["beta-flow-*"]);
  });
});

describe("groupFamilies — one prefix, two folders, two labels (fix round 1)", () => {
  const twoFolders = () => [
    ...slate("beta-flow", 3),
    ...[1, 2, 3].map((i) => page({ relPath: `other/beta-flow-${i}.mdx` })),
  ];

  test("a prefix used in two folders takes the folder into its label", () => {
    const fams = groupFamilies(twoFolders(), PROJECTS);
    expect(fams.map((f) => f.label).sort()).toEqual(["notes/beta-flow-*", "other/beta-flow-*"]);
    // …and the keys stay what they were, so no stored fold moves.
    expect(fams.map((f) => f.key).sort()).toEqual([
      "family:notes/beta-flow",
      "family:other/beta-flow",
    ]);
  });

  test("a prefix used in one folder is unchanged", () => {
    expect(labels(slate("beta-flow", 3))).toEqual(["beta-flow-*"]);
  });

  test("a wiki-ROOT family in a collision reads `/prefix-*`", () => {
    const pages = [
      ...[1, 2, 3].map((i) => page({ relPath: `beta-flow-${i}.mdx` })),
      ...slate("beta-flow", 3),
    ];
    expect(labels(pages)).toEqual(["/beta-flow-*", "notes/beta-flow-*"]);
  });
});

describe("groupFamilies — a rule-4 child belongs to its SUCCESSOR's family (fix round 1)", () => {
  const retired = (over: Partial<WikiListing> & { relPath: string; parent: string }) =>
    page({ pairedBy: "superseded", plan_status: "superseded", ...over });

  test("a child whose successor is a member counts, and is in the family", () => {
    const pages = [
      ...slate("beta-flow", 3, { plan_status: "shipped" }),
      retired({ relPath: "notes/beta-flow-old.mdx", parent: "notes/beta-flow-1.mdx" }),
    ];
    const fam = groupFamilies(pages, PROJECTS);
    expect(fam[0]!.supersededChildren.map((c) => c.relPath)).toEqual(["notes/beta-flow-old.mdx"]);
    expect(groupRollup("family", fam[0]!.members, fam[0]!.supersededChildren).label).toBe(
      "3 shipped · 1 superseded",
    );
  });

  test("a child whose SUCCESSOR is outside the family is not in it and never counts", () => {
    // Its own name carries the prefix; its successor is the loner. Counting it
    // here would put one page in a slate it is no part of — and it renders under
    // that loner, never in this family's body.
    const pages = [
      ...slate("beta-flow", 3, { plan_status: "shipped" }),
      page({ relPath: "notes/zeta.mdx" }),
      retired({ relPath: "notes/beta-flow-old.mdx", parent: "notes/zeta.mdx" }),
    ];
    const fam = groupFamilies(pages, PROJECTS);
    expect(fam.map((f) => f.label)).toEqual(["beta-flow-*"]);
    expect(fam[0]!.supersededChildren).toEqual([]);
    expect(groupRollup("family", fam[0]!.members, fam[0]!.supersededChildren).label).toBe(
      "3 shipped",
    );
  });

  test("a successor in ANOTHER FOLDER is outside every family here", () => {
    const pages = [
      ...slate("beta-flow", 3, { plan_status: "shipped" }),
      page({ relPath: "other/beta-flow-next.mdx" }),
      retired({ relPath: "notes/beta-flow-old.mdx", parent: "other/beta-flow-next.mdx" }),
    ];
    const fam = groupFamilies(pages, PROJECTS);
    expect(fam.map((f) => f.label)).toEqual(["beta-flow-*"]);
    expect(fam[0]!.supersededChildren).toEqual([]);
  });

  test("a child whose successor is in ANOTHER family belongs to that one", () => {
    const pages = [
      ...slate("beta-flow", 3, { plan_status: "shipped" }),
      ...slate("gamma-flow", 3, { plan_status: "ready" }),
      // Named for beta, superseded by a gamma page.
      retired({ relPath: "notes/beta-flow-old.mdx", parent: "notes/gamma-flow-1.mdx" }),
    ];
    const fams = groupFamilies(pages, PROJECTS);
    const beta = fams.find((f) => f.label === "beta-flow-*")!;
    const gamma = fams.find((f) => f.label === "gamma-flow-*")!;
    expect(beta.supersededChildren).toEqual([]);
    expect(gamma.supersededChildren.map((c) => c.relPath)).toEqual(["notes/beta-flow-old.mdx"]);
    expect(groupRollup("family", gamma.members, gamma.supersededChildren).label).toBe(
      "3 ready · 1 superseded",
    );
  });

  test("the CAP counts a child under its successor's prefix, not its own", () => {
    // Twelve `beta-flow` parents is AT the cap. A retired page NAMED
    // `beta-flow-old` whose successor is the loner must not be the thirteenth
    // member that dissolves the family.
    const pages = [
      ...slate("beta-flow", FAMILY_MAX, { plan_status: "shipped" }),
      page({ relPath: "notes/zeta.mdx" }),
      retired({ relPath: "notes/beta-flow-old.mdx", parent: "notes/zeta.mdx" }),
    ];
    expect(labels(pages)).toEqual(["beta-flow-*"]);
  });
});

describe("groupMonths — the filename's date is validated (fix round 1)", () => {
  test("an impossible month or day is not a date prefix", () => {
    // `2026-13` is not a month: the page falls back to the date the rail sorts
    // on rather than being filed under a bucket nothing else can join.
    const months = groupMonths(
      [page({ relPath: "archive/2026-13-02-topic.mdx", updated: "2026-05-04" })],
      "updated",
    );
    expect(months.map((m) => m.label)).toEqual(["2026-05"]);
    const day = groupMonths(
      [page({ relPath: "archive/2026-02-32-topic.mdx", updated: "2026-05-04" })],
      "updated",
    );
    expect(day.map((m) => m.label)).toEqual(["2026-05"]);
  });

  test("a page whose whole name IS the day buckets by its filename", () => {
    // No trailing dash. Its stamp says another month, and the filename wins.
    const months = groupMonths(
      [page({ relPath: "archive/2026-09-02.mdx", updated: "2026-05-04" })],
      "updated",
    );
    expect(months.map((m) => m.label)).toEqual(["2026-09"]);
  });
});

describe("railGroups — the folder compare (fix round 1)", () => {
  test("the archive folder matches whatever case the facet holds", () => {
    const archive = [
      page({ relPath: "Archive/2026-09-02-topic.mdx" }),
      page({ relPath: "Archive/2026-08-30-topic.mdx" }),
    ];
    for (const folder of ["archive", "Archive", "ARCHIVE"]) {
      expect(
        railGroups(archive, { folder, sort: "updated", projects: PROJECTS }).map((g) => g.kind),
      ).toEqual(["month", "month"]);
    }
  });
});

describe("isMonthGrouping", () => {
  test("says which grouping a render got, wherever the month sits in the array", () => {
    const months = groupMonths([page({ relPath: "archive/2026-09-02-topic.mdx" })], "updated");
    expect(isMonthGrouping(months)).toBe(true);
    expect(isMonthGrouping([...groupFamilies(slate("beta-flow", 3), PROJECTS), ...months])).toBe(
      true,
    );
    expect(isMonthGrouping(groupFamilies(slate("beta-flow", 3), PROJECTS))).toBe(false);
    expect(isMonthGrouping([])).toBe(false);
  });
});

// ── Series ────────────────────────────────────────────────────────────────
// The third grouping layer, and the only AUTHORED one. Its cases are written the
// same way as the family rule's: every clause gets one, and the two knock-on
// effects on the family rule get one each, because "the family dissolved" is a
// consequence this PR accepted rather than a bug it would fix.

const D = (day: string): string => day;

/** A series member. `s` is the key, `sl` the label a HEAD carries. */
function member(
  relPath: string,
  over: Partial<WikiListing> & { series: string } = { series: "alpha" },
): WikiListing {
  return page({ relPath, ...over });
}

describe("groupSeries — formation and membership", () => {
  test("pages carrying one key are ONE group, whatever folder they sit in", () => {
    const pages = [
      member("plans/one.mdx", { series: "alpha" }),
      member("blogs/two.mdx", { series: "alpha" }),
      member("archive/three.mdx", { series: "alpha" }),
      page({ relPath: "plans/unrelated.mdx" }),
    ];
    const groups = groupSeries(pages);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("series");
    expect(groups[0]!.members.map((m) => m.relPath).sort()).toEqual([
      "archive/three.mdx",
      "blogs/two.mdx",
      "plans/one.mdx",
    ]);
  });

  test("a ONE-member series still forms: it is a name someone wrote, not a slate", () => {
    // The family rule's FAMILY_MIN says three, because a prefix two pages share
    // is a coincidence. A key is never a coincidence.
    expect(groupSeries([member("plans/one.mdx", { series: "alpha" })])).toHaveLength(1);
  });

  test("there is no CAP: twenty members is twenty pages of one piece of work", () => {
    const pages = Array.from({ length: FAMILY_MAX + 8 }, (_, i) =>
      member(`plans/p-${i}.mdx`, { series: "alpha" }),
    );
    expect(groupSeries(pages)[0]!.members).toHaveLength(FAMILY_MAX + 8);
  });

  test("a blank or whitespace-only key is no key at all", () => {
    expect(groupSeries([page({ relPath: "plans/one.mdx", series: "   " })])).toEqual([]);
    expect(groupSeries([page({ relPath: "plans/one.mdx", series: "" })])).toEqual([]);
  });

  test("the key is compared VERBATIM — two spellings are two series", () => {
    const groups = groupSeries([
      member("plans/one.mdx", { series: "alpha" }),
      member("plans/two.mdx", { series: "Alpha" }),
    ]);
    expect(groups.map((g) => g.key).sort()).toEqual(["series:Alpha", "series:alpha"]);
  });

  test("the fold key is `series:<key>`", () => {
    expect(seriesFoldKey("alpha")).toBe("series:alpha");
    expect(groupSeries([member("plans/one.mdx", { series: "alpha" })])[0]!.key).toBe("series:alpha");
  });

  test("a SUPERSEDED child counts as a member of the series its SUCCESSOR is in", () => {
    const groups = groupSeries([
      member("plans/new.mdx", { series: "alpha" }),
      member("plans/old.mdx", {
        series: "alpha",
        parent: "plans/new.mdx",
        pairedBy: "superseded",
      }),
    ]);
    expect(groups[0]!.members.map((m) => m.relPath)).toEqual(["plans/new.mdx"]);
    expect(groups[0]!.supersededChildren.map((m) => m.relPath)).toEqual(["plans/old.mdx"]);
    expect(groups[0]!.total).toBe(2);
  });

  test("…and NOT when its successor is in another series: it renders in neither body", () => {
    const groups = groupSeries([
      member("plans/new.mdx", { series: "beta" }),
      member("plans/old.mdx", {
        series: "alpha",
        parent: "plans/new.mdx",
        pairedBy: "superseded",
      }),
    ]);
    // `alpha` has no parent row of its own and cannot claim this child, so it
    // draws nothing at all — the page renders under its successor in `beta`.
    expect(groups.map((g) => g.key)).toEqual(["series:beta"]);
    expect(groups[0]!.supersededChildren).toEqual([]);
  });

  test("a child of any OTHER pairing rule is an attachment, never a member", () => {
    for (const pairedBy of ["stem", "suffix", "link"] as const) {
      const groups = groupSeries([
        member("plans/one.mdx", { series: "alpha" }),
        member("plans/one-prototype.html", {
          series: "alpha",
          parent: "plans/one.mdx",
          pairedBy,
        }),
      ]);
      expect(groups[0]!.members.map((m) => m.relPath), pairedBy).toEqual(["plans/one.mdx"]);
      expect(groups[0]!.supersededChildren, pairedBy).toEqual([]);
      expect(groups[0]!.total, pairedBy).toBe(1);
    }
  });

  test("groups keep the caller's sort order — first appearance wins", () => {
    const groups = groupSeries([
      member("plans/b.mdx", { series: "beta" }),
      member("plans/a.mdx", { series: "alpha" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["series:beta", "series:alpha"]);
  });
});

describe("groupSeries — the head and the newest plan", () => {
  const withLabel = [
    member("blogs/late.mdx", { series: "alpha", seriesLabel: "Alpha work", status_date: D("2026-09-20") }),
    member("plans/early.mdx", { series: "alpha", plan_status: "shipped", status_date: D("2026-01-01") }),
  ];

  test("the HEAD is the member carrying `series_label:`, and the label is its", () => {
    expect(seriesHead(withLabel)!.relPath).toBe("blogs/late.mdx");
    expect(groupSeries(withLabel)[0]!.label).toBe("Alpha work");
  });

  test("no label anywhere ⇒ the label is the KEY, never a title", () => {
    const pages = [member("plans/one.mdx", { series: "alpha", title: "Some plan" })];
    expect(groupSeries(pages)[0]!.label).toBe("alpha");
  });

  test("no label ⇒ the head is the newest PLAN, by status_date", () => {
    const pages = [
      member("plans/old.mdx", { series: "alpha", plan_status: "shipped", status_date: D("2026-01-01") }),
      member("plans/new.mdx", { series: "alpha", plan_status: "in-flight", status_date: D("2026-09-01") }),
      member("blogs/newest.mdx", { series: "alpha", status_date: D("2026-09-30") }),
    ];
    expect(seriesHead(pages)!.relPath).toBe("plans/new.mdx");
  });

  test("…and by gitTouchedMs when no member declares a status_date", () => {
    const pages = [
      member("plans/old.mdx", { series: "alpha", plan_status: "shipped", gitTouchedMs: 1_000 }),
      member("plans/new.mdx", { series: "alpha", plan_status: "shipped", gitTouchedMs: 9_000 }),
    ];
    expect(seriesHead(pages)!.relPath).toBe("plans/new.mdx");
  });

  test("`status_date` BEATS a newer git touch — it is what the plan asserts", () => {
    const pages = [
      member("plans/asserted.mdx", {
        series: "alpha",
        plan_status: "in-flight",
        status_date: D("2026-09-01"),
        gitTouchedMs: 1,
      }),
      member("plans/typo-fixed.mdx", {
        series: "alpha",
        plan_status: "shipped",
        status_date: D("2026-01-01"),
        gitTouchedMs: Date.parse("2026-09-30T00:00:00Z"),
      }),
    ];
    expect(newestSeriesPlan(pages)!.relPath).toBe("plans/asserted.mdx");
  });

  test("the NEWEST PLAN is never a blog or an archive page, however new it is", () => {
    const pages = [
      member("blogs/newest.mdx", { series: "alpha", status_date: D("2026-09-30") }),
      member("archive/newer.mdx", { series: "alpha", status_date: D("2026-09-25") }),
      member("plans/plan.mdx", { series: "alpha", plan_status: "shipped", status_date: D("2026-01-01") }),
    ];
    expect(newestSeriesPlan(pages)!.relPath).toBe("plans/plan.mdx");
    expect(groupSeries(pages)[0]!.latestRel).toBe("plans/plan.mdx");
  });

  test("a series of blogs alone has NO latest: there is no plan to continue in", () => {
    const pages = [
      member("blogs/one.mdx", { series: "alpha", status_date: D("2026-09-30") }),
      member("blogs/two.mdx", { series: "alpha", status_date: D("2026-08-30") }),
    ];
    expect(newestSeriesPlan(pages)).toBeUndefined();
    expect(groupSeries(pages)[0]!.latestRel).toBeUndefined();
    // …and the head falls through to the newest member, so the fold still has a
    // page to read a label off once someone writes one.
    expect(seriesHead(pages)!.relPath).toBe("blogs/one.mdx");
  });

  test("a plan_status outside `plans/` still counts as the latest", () => {
    const pages = [
      member("notes/plan.mdx", { series: "alpha", plan_status: "in-flight", status_date: D("2026-02-01") }),
      member("plans/blog.mdx", { series: "alpha", status_date: D("2026-09-01") }),
    ];
    expect(newestSeriesPlan(pages)!.relPath).toBe("notes/plan.mdx");
  });

  test("members come back NEWEST first, ties broken by relPath", () => {
    const pages = [
      member("plans/b.mdx", { series: "alpha", status_date: D("2026-01-01") }),
      member("plans/a.mdx", { series: "alpha", status_date: D("2026-01-01") }),
      member("plans/c.mdx", { series: "alpha", status_date: D("2026-09-01") }),
    ];
    expect(groupSeries(pages)[0]!.members.map((m) => m.relPath)).toEqual([
      "plans/c.mdx",
      "plans/a.mdx",
      "plans/b.mdx",
    ]);
  });

  test("seriesDateMs falls through status_date → gitTouchedMs → mtimeMs → 0", () => {
    expect(seriesDateMs(page({ relPath: "x.mdx", status_date: "2026-09-01", gitTouchedMs: 1, mtimeMs: 2 })))
      .toBe(Date.parse("2026-09-01T00:00:00Z"));
    expect(seriesDateMs(page({ relPath: "x.mdx", gitTouchedMs: 7, mtimeMs: 2 }))).toBe(7);
    expect(seriesDateMs(page({ relPath: "x.mdx", mtimeMs: 2 }))).toBe(2);
    expect(seriesDateMs(page({ relPath: "x.mdx" }))).toBe(0);
    // A malformed day is not a date — it falls through rather than becoming NaN.
    expect(seriesDateMs(page({ relPath: "x.mdx", status_date: "whenever", mtimeMs: 5 }))).toBe(5);
  });
});

describe("groupSeries — the FILTERED set and `N of M`", () => {
  const all = [
    member("plans/one.mdx", { series: "alpha", seriesLabel: "Alpha work" }),
    member("plans/two.mdx", { series: "alpha" }),
    member("blogs/three.mdx", { series: "alpha" }),
  ];

  test("members come from the filtered set, `total` from the whole listing", () => {
    const filtered = all.filter((p) => p.relPath.startsWith("plans/"));
    const g = groupSeries(filtered, all)[0]!;
    expect(g.members.map((m) => m.relPath).sort()).toEqual(["plans/one.mdx", "plans/two.mdx"]);
    expect(g.total).toBe(3);
  });

  test("the LABEL survives a facet that hid the head page", () => {
    // The head here is the only page carrying the label, and the facet drops it.
    const filtered = all.filter((p) => p.relPath !== "plans/one.mdx");
    expect(groupSeries(filtered, all)[0]!.label).toBe("Alpha work");
  });

  test("the NEWEST PLAN survives a facet that hid it", () => {
    const pages = [
      member("plans/plan.mdx", { series: "alpha", plan_status: "shipped", status_date: D("2026-09-01") }),
      member("blogs/blog.mdx", { series: "alpha", status_date: D("2026-08-01") }),
    ];
    const filtered = pages.filter((p) => p.relPath.startsWith("blogs/"));
    expect(groupSeries(filtered, pages)[0]!.latestRel).toBe("plans/plan.mdx");
  });

  test("a facet that hides EVERY member draws no group", () => {
    expect(groupSeries([], all)).toEqual([]);
  });

  test("a page whose key exists only in the filtered set is still a series", () => {
    // `all` defaults to `pages`, which is the un-faceted render.
    expect(groupSeries(all)[0]!.total).toBe(3);
  });
});

describe("groupSeries — what the claim does to families", () => {
  test("a family that drops below FAMILY_MIN DISSOLVES into plain rows", () => {
    const pages = [
      ...FILLER,
      ...slate("beta-flow", FAMILY_MIN),
    ];
    expect(labels(pages)).toEqual(["beta-flow-*"]);
    // Put one of the three in a series and the prefix is a pair again.
    const claimed = pages.map((p) =>
      p.relPath === "notes/beta-flow-1.mdx" ? page({ ...p, series: "alpha" }) : p,
    );
    const series = groupSeries(claimed);
    expect(labels(withoutSeriesMembers(claimed, series))).toEqual([]);
  });

  test("an OVER-CAP prefix that drops to the cap MAY form", () => {
    const pages = slate("beta-flow", FAMILY_MAX + 1);
    expect(labels(pages)).toEqual([]);
    const claimed = pages.map((p) =>
      p.relPath === "notes/beta-flow-1.mdx" ? page({ ...p, series: "alpha" }) : p,
    );
    const series = groupSeries(claimed);
    expect(labels(withoutSeriesMembers(claimed, series))).toEqual(["beta-flow-*"]);
  });

  test("seriesClaimedKeys covers the superseded children too", () => {
    const pages = [
      member("plans/new.mdx", { series: "alpha" }),
      member("plans/old.mdx", { series: "alpha", parent: "plans/new.mdx", pairedBy: "superseded" }),
      page({ relPath: "plans/other.mdx" }),
    ];
    const keys = seriesClaimedKeys(groupSeries(pages));
    expect([...keys].sort()).toEqual(["plans/new.mdx", "plans/old.mdx"]);
    expect(withoutSeriesMembers(pages, groupSeries(pages)).map((p) => p.relPath)).toEqual([
      "plans/other.mdx",
    ]);
  });

  test("with no series at all, `withoutSeriesMembers` is the identity", () => {
    const pages = slate("beta-flow", 3);
    expect(withoutSeriesMembers(pages, []).map((p) => p.relPath)).toEqual(
      pages.map((p) => p.relPath),
    );
  });
});

describe("groupRollup — the SERIES word", () => {
  test("a member with no plan_status counts under its FOLDER, for blogs and archive", () => {
    const members = [
      member("plans/one.mdx", { series: "alpha", plan_status: "in-flight" }),
      member("plans/two.mdx", { series: "alpha", plan_status: "shipped" }),
      member("blogs/three.mdx", { series: "alpha" }),
      member("archive/four.mdx", { series: "alpha" }),
      member("notes/five.mdx", { series: "alpha" }),
    ];
    // Known statuses in facet order first, then the unknown words alphabetically.
    expect(groupRollup("series", members).label).toBe(
      `1 in-flight · 1 shipped · 1 archive · 1 blog · 1 ${NO_STATUS_WORD}`,
    );
  });

  test("the acceptance chip: one in-flight plan, one shipped plan, one blog", () => {
    expect(
      groupRollup("series", [
        member("plans/a.mdx", { series: "alpha", plan_status: "in-flight" }),
        member("plans/b.mdx", { series: "alpha", plan_status: "shipped" }),
        member("blogs/c.mdx", { series: "alpha" }),
      ]).label,
    ).toBe("1 in-flight · 1 shipped · 1 blog");
  });

  test("a FAMILY keeps the neutral word — the folder says nothing there", () => {
    const members = [page({ relPath: "blogs/a.mdx" }), page({ relPath: "archive/b.mdx" })];
    expect(groupRollup("family", members).label).toBe(`2 ${NO_STATUS_WORD}`);
  });

  test("the folder rule is case-insensitive, like every other relPath compare", () => {
    expect(groupRollup("series", [member("Blogs/a.mdx", { series: "alpha" })]).label).toBe("1 blog");
  });
});
