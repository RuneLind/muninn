/**
 * The work-thread grouping model (`wiki-work-groups.ts`) and its preference
 * parser (`wiki-work-group-prefs.ts`), over synthetic threads and evidence.
 */

import { describe, expect, test } from "bun:test";
import {
  groupWorkThreads,
  orderWorkUnits,
  projectSessionCards,
  projectWorkGroups,
  readWorkEvidence,
  workGroupingInstant,
  workSessionCards,
  workUnitsFromThreads,
  type WorkGrouping,
  type WorkGroupingInput,
} from "./wiki-work-groups.ts";
import {
  parseWorkGroupPrefs,
  resolveWorkGroupPrefs,
  WORK_GROUP_KEPT_APART_MAX,
  WORK_GROUP_SPLITS_MAX,
  type WorkGroupEvidenceToggles,
} from "./wiki-work-group-prefs.ts";
import { openThreadCards } from "./wiki-rail-input.ts";
import type { WikiFilters, WikiListing } from "./wiki-filter.ts";
import { WORK_EVIDENCE_VERSION, type IndexWork, type WorkContribution, type WorkEvidence, type WorkThread } from "../../../wiki/work-focus.ts";

const NOW = Date.UTC(2026, 9, 17, 20, 0);
const HOUR = 3_600_000;
const ALL: WorkGroupEvidenceToggles = { series: true, related: true, issue: true };
const NONE: WorkGroupEvidenceToggles = { series: false, related: false, issue: false };
const INERT: WikiFilters = { q: "", domain: "", folder: "", type: "", tag: "", status: "", followups: "", waiting: "", project: "", jira: "" };

interface PageSpec {
  /** Focus edits of the page's one event: the knob for a thread's score. */
  edits?: number;
  series?: string;
  seriesLabel?: string;
  project?: string;
  backlinkCount?: number;
  movesYou?: number;
  title?: string;
}

function page(relPath: string, s: PageSpec = {}): WikiListing {
  const edits = s.edits ?? 3;
  return {
    relPath,
    name: relPath.slice(relPath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""),
    title: s.title ?? relPath,
    type: "plan",
    domain: "ai",
    tags: [],
    aliases: [],
    linkCount: 0,
    backlinkCount: s.backlinkCount ?? 0,
    gitCreatedMs: NOW - 40 * 24 * HOUR,
    ...(s.series ? { series: s.series } : {}),
    ...(s.seriesLabel ? { seriesLabel: s.seriesLabel } : {}),
    ...(s.project ? { project: s.project } : {}),
    ...(s.movesYou ? { movesYou: s.movesYou } : {}),
    work: { sinceMs: NOW - 8 * 24 * HOUR, state: "F", focusMs: NOW - 2 * HOUR, events: [[NOW - 2 * HOUR, edits, "focus"]] },
  } as WikiListing;
}

let sessionSeq = 0;
function thread(key: string, pages: string[], over: Partial<WorkThread> = {}): WorkThread {
  sessionSeq++;
  return {
    key,
    pages,
    touched: [],
    sessions: [{ id: `s${sessionSeq}`, provider: "claude", first: NOW - 5 * HOUR, last: NOW - 2 * HOUR, title: `session ${sessionSeq}` }],
    ...over,
  };
}

interface EvidenceSpec {
  related?: [string, string][];
  issues?: [string, string, string][];
  relationsReasons?: WorkEvidence["relations"]["reasons"];
  contributionsReasons?: WorkEvidence["contributions"]["reasons"];
  cut?: string[];
  rows?: WorkContribution[];
}

/** Evidence the way `buildWorkEvidence` derives it: series and projects off
 *  the focus pages' listing fields. */
function evidenceFor(pages: readonly WikiListing[], threads: readonly WorkThread[], spec: EvidenceSpec = {}): WorkEvidence {
  const focus = new Set(threads.flatMap((t) => t.pages));
  const series: Record<string, string> = {};
  const projects: Record<string, string> = {};
  for (const p of pages) {
    if (!focus.has(p.relPath)) continue;
    if (p.series) series[p.relPath] = p.series.trim().toLowerCase();
    if (p.project) projects[p.relPath] = p.project;
  }
  const relReasons = spec.relationsReasons ?? [];
  const conReasons = spec.contributionsReasons ?? [];
  return {
    version: WORK_EVIDENCE_VERSION,
    threads: { candidates: threads.length, shipped: threads.length },
    relations: {
      complete: relReasons.length === 0,
      reasons: relReasons,
      series,
      projects,
      related: spec.related ?? [],
      issues: spec.issues ?? [],
      ambiguousIssues: [],
      relatedSkipped: { skipped: 0, ambiguous: 0 },
    },
    contributions: { complete: conReasons.length === 0, reasons: conReasons, cut: spec.cut ?? [], rows: spec.rows ?? [] },
  };
}

function work(pages: readonly WikiListing[], threads: WorkThread[], spec?: EvidenceSpec): IndexWork {
  return { asOfMs: NOW - HOUR, sinceMs: NOW - 8 * 24 * HOUR, threads, evidence: evidenceFor(pages, threads, spec) };
}

function run(w: IndexWork | null, allPages: WikiListing[], over: Partial<WorkGroupingInput> = {}): WorkGrouping {
  return groupWorkThreads({ work: w, allPages, now: NOW, stop: "related", toggles: ALL, ...over });
}

/** The cards as `[foldKey, child keys]` — the membership a test compares. */
const shape = (g: WorkGrouping) => g.groups.map((x) => [x.foldKey, x.children.map((c) => c.key)]);
const childKeys = (g: WorkGrouping) => g.groups.map((x) => x.children.map((c) => c.key));

// ── A fixture with one witness per kind ─────────────────────────────────────
//
// Scores descend a > b > c > d > e (edits 40, 30, 20, 10, 5). `a` anchors.
//  - b shares series `alpha` with a
//  - c has a related: entry to a
//  - d names an issue a owns
//  - e shares only a project with a

function kinds() {
  const pages = [
    page("plans/a.md", { edits: 40, series: "alpha", seriesLabel: "Alpha work", project: "muninn", title: "A plan — long" }),
    page("plans/b.md", { edits: 30, series: "Alpha", project: "other" }),
    page("plans/c.md", { edits: 20, project: "other" }),
    page("plans/d.md", { edits: 10 }),
    page("plans/e.md", { edits: 5, project: "muninn" }),
  ];
  const threads = ["a", "b", "c", "d", "e"].map((k) => thread(`plans/${k}.md`, [`plans/${k}.md`]));
  const w = work(pages, threads, {
    related: [["plans/c.md", "plans/a.md"]],
    issues: [["KEY-1", "plans/a.md", "plans/d.md"]],
  });
  return { pages, threads, w };
}

describe("evidence kinds", () => {
  test("each kind joins alone, and only while its box is checked", () => {
    const { pages, w } = kinds();
    expect(childKeys(run(w, pages, { toggles: { ...NONE, series: true } }))[0]).toEqual(["plans/a.md", "plans/b.md"]);
    expect(childKeys(run(w, pages, { toggles: { ...NONE, related: true } }))[0]).toEqual(["plans/a.md", "plans/c.md"]);
    expect(childKeys(run(w, pages, { toggles: { ...NONE, issue: true } }))[0]).toEqual(["plans/a.md", "plans/d.md"]);
    const joined = run(w, pages, { toggles: { ...NONE, issue: true } }).groups[0]!.children[1]!;
    expect(joined.joinedBy).toEqual(["issue"]);
    expect(joined.witnesses).toEqual([{ kind: "issue", key: "KEY-1", owner: "plans/a.md", referrer: "plans/d.md" }]);
  });

  test("the checked kinds are OR'd", () => {
    const { pages, w } = kinds();
    const g = run(w, pages);
    expect(childKeys(g)).toEqual([["plans/a.md", "plans/b.md", "plans/c.md", "plans/d.md"], ["plans/e.md"]]);
    expect(g.groups[0]!.children.map((c) => c.joinedBy)).toEqual([[], ["series"], ["related"], ["issue"]]);
    expect(g.groups[0]!.witnesses.map((x) => x.kind)).toEqual(["series", "related", "issue"]);
  });

  test("a related: entry counts in either direction", () => {
    const { pages, threads } = kinds();
    const w = work(pages, threads, { related: [["plans/a.md", "plans/c.md"]] });
    expect(childKeys(run(w, pages, { toggles: { ...NONE, related: true } }))[0]).toEqual(["plans/a.md", "plans/c.md"]);
  });

  test("project joins at Areas only, and Areas still joins on it with every box cleared", () => {
    const { pages, w } = kinds();
    expect(childKeys(run(w, pages, { toggles: NONE }))).toEqual(["a", "b", "c", "d", "e"].map((k) => [`plans/${k}.md`]));
    const areas = run(w, pages, { stop: "areas", toggles: NONE });
    expect(childKeys(areas)[0]).toEqual(["plans/a.md", "plans/e.md"]);
    expect(areas.groups[0]!.children[1]!.joinedBy).toEqual(["project"]);
  });

  test("with every box cleared, Related draws the Threads cards", () => {
    const { pages, w } = kinds();
    expect(shape(run(w, pages, { toggles: NONE }))).toEqual(shape(run(w, pages, { stop: "threads" })));
  });

  test("touched pages never connect threads", () => {
    const pages = [page("p/a.md", { edits: 9 }), page("p/b.md", { edits: 5 })];
    const threads = [thread("p/a.md", ["p/a.md"], { touched: ["p/b.md"] }), thread("p/b.md", ["p/b.md"], { touched: ["p/a.md"] })];
    expect(childKeys(run(work(pages, threads), pages))).toEqual([["p/a.md"], ["p/b.md"]]);
  });
});

describe("the direct-anchor rule (D3)", () => {
  test("A–B and B–C do not join A and C", () => {
    const pages = ["a", "b", "c"].map((k, i) => page(`p/${k}.md`, { edits: 30 - i * 10 }));
    const threads = ["a", "b", "c"].map((k) => thread(`p/${k}.md`, [`p/${k}.md`]));
    const w = work(pages, threads, { related: [["p/a.md", "p/b.md"], ["p/b.md", "p/c.md"]] });
    expect(childKeys(run(w, pages))).toEqual([["p/a.md", "p/b.md"], ["p/c.md"]]);
  });

  test("a unit joins the FIRST anchor it connects to", () => {
    // a and b do not connect, so both anchor; c connects to both.
    const pages = ["a", "b", "c"].map((k, i) => page(`p/${k}.md`, { edits: 30 - i * 10 }));
    const threads = ["a", "b", "c"].map((k) => thread(`p/${k}.md`, [`p/${k}.md`]));
    const w = work(pages, threads, { related: [["p/c.md", "p/b.md"], ["p/c.md", "p/a.md"]] });
    expect(childKeys(run(w, pages))).toEqual([["p/a.md", "p/c.md"], ["p/b.md"]]);
  });

  test("an isolated unit neither joins nor is joined", () => {
    const { pages, w } = kinds();
    const units = workUnitsFromThreads(w.threads).map((u) => (u.key === "plans/b.md" ? { ...u, isolated: true } : u));
    expect(childKeys(run(w, pages, { units }))).toEqual([["plans/a.md", "plans/c.md", "plans/d.md"], ["plans/b.md"], ["plans/e.md"]]);
  });
});

describe("order (D16)", () => {
  test("score first, then the server's index, then key — never key before index", () => {
    // Equal scores; the server shipped z before a.
    const pages = [page("p/z.md"), page("p/a.md")];
    const threads = [thread("p/z.md", ["p/z.md"]), thread("p/a.md", ["p/a.md"])];
    expect(childKeys(run(work(pages, threads), pages, { stop: "threads" }))).toEqual([["p/z.md"], ["p/a.md"]]);
    const byRel = new Map(pages.map((p) => [p.relPath, p]));
    expect(orderWorkUnits(workUnitsFromThreads(threads), byRel, NOW).map((x) => x.unit.key)).toEqual(["p/z.md", "p/a.md"]);
  });

  test("a higher score wins over the index", () => {
    const pages = [page("p/z.md", { edits: 1 }), page("p/a.md", { edits: 9 })];
    const threads = [thread("p/z.md", ["p/z.md"]), thread("p/a.md", ["p/a.md"])];
    expect(childKeys(run(work(pages, threads), pages, { stop: "threads" }))).toEqual([["p/a.md"], ["p/z.md"]]);
  });

  test("the same listing at two instants after asOfMs groups the same", () => {
    const { pages, w } = kinds();
    const a = run(w, pages, { now: NOW });
    const b = run(w, pages, { now: NOW + 3 * 24 * HOUR });
    expect(shape(b)).toEqual(shape(a));
    expect(b.groups.map((x) => x.name)).toEqual(a.groups.map((x) => x.name));
  });

  test("an instant before asOfMs scores at asOfMs", () => {
    expect(workGroupingInstant(NOW - 5 * HOUR, NOW - HOUR)).toBe(NOW - HOUR);
    expect(workGroupingInstant(NOW, NOW - HOUR)).toBe(NOW);
    expect(workGroupingInstant(NOW, undefined)).toBe(NOW);
  });

  test("Threads keeps openThreadCards' order and pin", () => {
    const { pages, w } = kinds();
    const today = openThreadCards(w.threads, pages, INERT, [], "plans/d.md", NOW).map((c) => c.key);
    const g = run(w, pages, { stop: "threads", pin: "plans/d.md" });
    expect(g.groups.map((x) => x.anchorKey)).toEqual(today);
  });
});

describe("pin", () => {
  test("the pinned child's group moves first, marked; names and fold keys stay", () => {
    const { pages, w } = kinds();
    const plain = run(w, pages);
    const pinned = run(w, pages, { pin: "plans/E.md" });
    expect(childKeys(pinned)).toEqual([["plans/e.md"], ["plans/a.md", "plans/b.md", "plans/c.md", "plans/d.md"]]);
    expect(pinned.groups[0]!.pinned).toBe(true);
    expect(pinned.groups[0]!.children[0]!.pinned).toBe(true);
    expect(new Set(pinned.groups.map((x) => x.foldKey))).toEqual(new Set(plain.groups.map((x) => x.foldKey)));
  });

  test("a pin on a child moves its whole group first and marks the child", () => {
    const pages = ["a", "b", "c"].map((k, i) => page(`p/${k}.md`, { edits: 30 - i * 10 }));
    const threads = ["a", "b", "c"].map((k) => thread(`p/${k}.md`, [`p/${k}.md`]));
    const w = work(pages, threads, { related: [["p/c.md", "p/b.md"]] });
    const g = run(w, pages, { pin: "p/c.md" });
    expect(childKeys(g)).toEqual([["p/b.md", "p/c.md"], ["p/a.md"]]);
    expect(g.groups[0]!.children.map((c) => c.pinned)).toEqual([false, true]);
  });
});

describe("names and fold keys", () => {
  test("Related names a group by its shared series; a lone thread keeps thread:<key>", () => {
    const { pages, w } = kinds();
    const g = run(w, pages, { toggles: { ...NONE, series: true } });
    expect(g.groups[0]).toMatchObject({ kind: "group", label: "series", name: "Alpha work", nameKey: "alpha", foldKey: "group:series:alpha" });
    expect(g.groups[1]).toMatchObject({ kind: "thread", label: "thread", foldKey: "thread:plans/c.md", name: "plans/c.md" });
  });

  test("Related never names by project; without a shared series it is RELATED under the anchor's title", () => {
    const { pages, w } = kinds();
    const g = run(w, pages, { toggles: { ...NONE, issue: true } });
    expect(g.groups[0]).toMatchObject({ label: "related", name: "A plan", foldKey: "group:anchor:plans/a.md" });
  });

  test("Areas names by the shared project before the series", () => {
    const pages = [page("p/a.md", { edits: 9, series: "s", project: "proj" }), page("p/b.md", { edits: 5, series: "s", project: "proj" })];
    const threads = [thread("p/a.md", ["p/a.md"]), thread("p/b.md", ["p/b.md"])];
    const w = work(pages, threads);
    expect(run(w, pages, { stop: "areas" }).groups[0]).toMatchObject({ label: "project", name: "proj", foldKey: "group:project:proj" });
    expect(run(w, pages).groups[0]).toMatchObject({ label: "series", foldKey: "group:series:s" });
  });

  test("Areas falls back to the series when no project is shared", () => {
    const pages = [page("p/a.md", { edits: 9, series: "s", project: "x" }), page("p/b.md", { edits: 5, series: "s", project: "y" })];
    const threads = [thread("p/a.md", ["p/a.md"]), thread("p/b.md", ["p/b.md"])];
    expect(run(work(pages, threads), pages, { stop: "areas" }).groups[0]).toMatchObject({ label: "series", nameKey: "s" });
  });

  // Both children have pages in series «zeta» and «Beta» and «alpha».
  function twoSeries(anchorTop: string) {
    const pages = [
      page("p/a1.md", { edits: 20, series: anchorTop }),
      page("p/a2.md", { edits: 2, series: anchorTop === "zeta" ? "Beta" : "zeta" }),
      page("p/a3.md", { edits: 1, series: "alpha" }),
      page("p/b1.md", { edits: 9, series: "zeta" }),
      page("p/b2.md", { edits: 2, series: "Beta" }),
      page("p/b3.md", { edits: 1, series: "alpha" }),
    ];
    const threads = [thread("p/a1.md", ["p/a1.md", "p/a2.md", "p/a3.md"]), thread("p/b1.md", ["p/b1.md", "p/b2.md", "p/b3.md"])];
    return run(work(pages, threads), pages);
  }

  test("several qualifying series: the anchor's top page's series wins", () => {
    expect(twoSeries("zeta").groups[0]!.nameKey).toBe("zeta");
  });

  test("…else the smallest label in code-unit order", () => {
    // The anchor's top page is in no shared series; «Beta» < «alpha» < «zeta» by code unit.
    const pages = [
      page("p/a1.md", { edits: 20, series: "own" }),
      page("p/a2.md", { edits: 2, series: "zeta" }),
      page("p/a3.md", { edits: 2, series: "alpha" }),
      page("p/a4.md", { edits: 1, series: "Beta" }),
      page("p/b1.md", { edits: 9, series: "zeta" }),
      page("p/b2.md", { edits: 2, series: "Beta" }),
      page("p/b3.md", { edits: 1, series: "alpha" }),
    ];
    const threads = [thread("p/a1.md", ["p/a1.md", "p/a2.md", "p/a3.md", "p/a4.md"]), thread("p/b1.md", ["p/b1.md", "p/b2.md", "p/b3.md"])];
    const g = run(work(pages, threads), pages);
    expect(g.groups[0]).toMatchObject({ name: "Beta", nameKey: "beta", foldKey: "group:series:beta" });
  });

  test("two groups named by one series with Same series cleared: the first keeps the name key", () => {
    // a–b and c–d are joined by related: only; all four are in series «s».
    const pages = ["a", "b", "c", "d"].map((k, i) => page(`p/${k}.md`, { edits: 40 - i * 10, series: "s" }));
    const threads = ["a", "b", "c", "d"].map((k) => thread(`p/${k}.md`, [`p/${k}.md`]));
    const w = work(pages, threads, { related: [["p/a.md", "p/b.md"], ["p/c.md", "p/d.md"]] });
    const g = run(w, pages, { toggles: { ...ALL, series: false } });
    expect(g.groups.map((x) => [x.name, x.foldKey])).toEqual([
      ["s", "group:series:s"],
      ["s", "group:anchor:p/c.md"],
    ]);
    // A pin on the second group moves it first but not the name key.
    const pinned = run(w, pages, { toggles: { ...ALL, series: false }, pin: "p/d.md" });
    expect(pinned.groups.map((x) => x.foldKey)).toEqual(["group:anchor:p/c.md", "group:series:s"]);
  });
});

describe("also chips (D9)", () => {
  test("a child with pages in another series shows it", () => {
    const pages = [
      page("p/a.md", { edits: 20, series: "main", seriesLabel: "Main" }),
      page("p/b1.md", { edits: 9, series: "main" }),
      page("p/b2.md", { edits: 5, series: "side", seriesLabel: "Side work" }),
    ];
    const threads = [thread("p/a.md", ["p/a.md"]), thread("p/b1.md", ["p/b1.md", "p/b2.md"])];
    const g = run(work(pages, threads), pages);
    expect(g.groups[0]!.name).toBe("Main");
    expect(g.groups[0]!.children.map((c) => c.also)).toEqual([[], [{ key: "side", label: "Side work" }]]);
  });

  test("under a RELATED name every series of a child is an also chip; a lone thread has none", () => {
    const pages = [page("p/a.md", { edits: 20, series: "x" }), page("p/b.md", { edits: 9, series: "y" }), page("p/c.md", { edits: 1, series: "z" })];
    const threads = ["a", "b", "c"].map((k) => thread(`p/${k}.md`, [`p/${k}.md`]));
    const g = run(work(pages, threads, { related: [["p/a.md", "p/b.md"]] }), pages);
    expect(g.groups[0]!.children.map((c) => c.also.map((a) => a.key))).toEqual([["x"], ["y"]]);
    expect(g.groups[1]!.children[0]!.also).toEqual([]);
  });
});

describe("ownership and the visible projection", () => {
  test("a page two threads hold is owned by the first, in the full listing", () => {
    const pages = [page("p/a.md", { edits: 20 }), page("p/hub.md", { edits: 9, backlinkCount: 40 }), page("p/b.md", { edits: 5 })];
    const threads = [thread("p/a.md", ["p/a.md", "p/hub.md"]), thread("p/b.md", ["p/b.md", "p/hub.md"])];
    const g = run(work(pages, threads), pages, { stop: "threads" });
    expect(g.groups.map((x) => x.children[0]!.owned.map((p) => p.relPath))).toEqual([["p/a.md", "p/hub.md"], ["p/b.md"]]);
    // A facet hiding the first thread's own page leaves the hub with it.
    const views = projectWorkGroups(g, pages.filter((p) => p.relPath !== "p/a.md"), INERT, NOW);
    expect(views.map((v) => v.children[0]!.focus.map((p) => p.relPath))).toEqual([["p/hub.md"], ["p/b.md"]]);
  });

  test("facets drop empty children and groups, keep names, flag a hidden anchor, and count visible children", () => {
    const pages = [
      page("plans/a.md", { edits: 20, series: "s", title: "Anchor" }),
      page("notes/b.md", { edits: 9, series: "s", movesYou: 2 }),
      page("notes/c.md", { edits: 5, series: "s", movesYou: 1 }),
    ];
    const shared = { id: "same", provider: "claude", first: NOW - 9 * HOUR, last: NOW - 3 * HOUR, title: "shared" };
    const threads = [
      thread("plans/a.md", ["plans/a.md"]),
      thread("notes/b.md", ["notes/b.md"], { sessions: [shared] }),
      thread("notes/c.md", ["notes/c.md"], { sessions: [shared, { ...shared, id: "other" }] }),
    ];
    const g = run(work(pages, threads), pages);
    const full = projectWorkGroups(g, pages, INERT, NOW);
    expect(full[0]!.counts).toEqual({ threads: 3, sessions: 3, movesYou: 3 });
    const notes = projectWorkGroups(g, pages, { ...INERT, folder: "notes" }, NOW);
    expect(notes[0]!.group.name).toBe("s");
    expect(notes[0]!.anchorVisible).toBe(false);
    expect(notes[0]!.children.map((c) => c.child.key)).toEqual(["notes/b.md", "notes/c.md"]);
    // `claude:same` is one session across the two children.
    expect(notes[0]!.counts).toEqual({ threads: 2, sessions: 2, movesYou: 3 });
    expect(projectWorkGroups(g, pages, { ...INERT, folder: "elsewhere" }, NOW)).toEqual([]);
    expect(projectWorkGroups(g, pages, { ...INERT, q: "x" }, NOW)).toEqual([]);
  });

  test("a checkbox change never renames a child or moves its pages", () => {
    const { pages, w } = kinds();
    const children = (g: WorkGrouping) =>
      Object.fromEntries(g.groups.flatMap((x) => x.children).map((c) => [c.key, [c.name, c.owned.map((p) => p.relPath)]]));
    const base = children(run(w, pages));
    for (const toggles of [NONE, { ...NONE, series: true }, { ...ALL, issue: false }]) expect(children(run(w, pages, { toggles }))).toEqual(base);
    expect(children(run(w, pages, { stop: "areas" }))).toEqual(base);
  });

  test("the cap applies after the drops", () => {
    const pages = Array.from({ length: 8 }, (_, i) => page(`p/${i}.md`, { edits: 20 - i }));
    const threads = pages.map((p) => thread(p.relPath, [p.relPath]));
    const g = run(work(pages, threads), pages);
    const pool = pages.filter((p) => p.relPath !== "p/0.md" && p.relPath !== "p/1.md");
    expect(projectWorkGroups(g, pool, INERT, NOW).map((v) => v.group.anchorKey)).toEqual(["p/2.md", "p/3.md", "p/4.md", "p/5.md", "p/6.md"]);
  });
});

describe("availability", () => {
  test("relations incomplete: Related and Areas draw Threads with the reason, keeping the toggles", () => {
    const { pages, threads } = kinds();
    const w = work(pages, threads, { relationsReasons: ["relations-cap"], related: [["plans/c.md", "plans/a.md"]] });
    const g = run(w, pages, { toggles: { ...ALL, series: false } });
    expect(g.requested).toBe("related");
    expect(g.stop).toBe("threads");
    expect(g.togglesApply).toBe(false);
    expect(g.toggles).toEqual({ ...ALL, series: false });
    expect(g.availability.related).toEqual({ available: false, reasons: ["relations-cap"] });
    expect(g.groups.every((x) => x.kind === "thread")).toBe(true);
  });

  test("no evidence block, or another version: Threads, with the reason", () => {
    const { pages, threads } = kinds();
    const bare = { asOfMs: NOW, sinceMs: 0, threads };
    expect(run(bare, pages)).toMatchObject({ stop: "threads", availability: { related: { reasons: ["evidence-absent"] } } });
    const v2 = { ...bare, evidence: { ...evidenceFor(pages, threads), version: 2 } as unknown as WorkEvidence };
    expect(run(v2, pages)).toMatchObject({ stop: "threads", availability: { areas: { reasons: ["evidence-unreadable"] } } });
    expect(readWorkEvidence({ version: WORK_EVIDENCE_VERSION, relations: [] }).reason).toBe("evidence-unreadable");
  });

  test("no threads: no cards (today's fallback)", () => {
    expect(run(null, [])).toMatchObject({ groups: [], sessions: [], availability: { threads: { available: false, reasons: ["no-threads"] } } });
  });

  test("contributions incomplete: grouping stays, Sessions and the per-thread split are unavailable", () => {
    const { pages, threads } = kinds();
    const cut = run(work(pages, threads, { contributionsReasons: ["contributions-cap"], cut: ["plans/b.md"] }), pages);
    expect(cut.stop).toBe("related");
    expect(cut.availability.sessions).toEqual({ available: false, reasons: ["contributions-cap"] });
    const kids = Object.fromEntries(cut.groups.flatMap((x) => x.children).map((c) => [c.key, c.sessions.available]));
    expect(kids["plans/b.md"]).toBe(false);
    expect(kids["plans/a.md"]).toBe(true);
    const sessions = run(work(pages, threads, { contributionsReasons: ["ledger-truncated"] }), pages, { stop: "sessions" });
    expect(sessions.stop).toBe("threads");
    expect(sessions.groups.flatMap((x) => x.children).every((c) => !c.sessions.available)).toBe(true);
  });
});

describe("Sessions (D19)", () => {
  function sessionFixture() {
    const pages = [page("p/a.md", { edits: 20 }), page("p/b.md", { edits: 9 }), page("p/t.md", { edits: 1 })];
    const old = { id: "old", provider: "claude", first: NOW - 30 * HOUR, last: NOW - 20 * HOUR, title: "Older session" };
    const fresh = { id: "new", provider: "claude", first: NOW - 6 * HOUR, last: NOW - 2 * HOUR, title: "Newer session" };
    const tie = { id: "aaa", provider: "opencode", first: NOW - 6 * HOUR, last: NOW - 2 * HOUR, title: "Tied session" };
    const threads = [
      thread("p/a.md", ["p/a.md", "p/b.md"], { sessions: [fresh, tie, old], touched: ["p/t.md"] }),
    ];
    const rows: WorkContribution[] = [
      ["claude-code:new", "p/a.md", "p/a.md", "focus", 4, NOW - 6 * HOUR, NOW - 2 * HOUR],
      ["claude-code:new", "p/t.md", "p/a.md", "touch", 1, NOW - 6 * HOUR, NOW - 3 * HOUR],
      ["opencode:aaa", "p/b.md", "p/a.md", "focus", 4, NOW - 6 * HOUR, NOW - 2 * HOUR],
      ["claude-code:old", "p/a.md", "p/a.md", "focus", 4, NOW - 30 * HOUR, NOW - 20 * HOUR],
      ["claude-code:old", "p/b.md", "p/a.md", "focus", 4, NOW - 30 * HOUR, NOW - 21 * HOUR],
    ];
    return { pages, w: work(pages, threads, { rows }) };
  }

  test("newest session first, then ref; a page is a row of the first card holding it and an also-in link after", () => {
    const { pages, w } = sessionFixture();
    const g = run(w, pages, { stop: "sessions" });
    expect(g.stop).toBe("sessions");
    expect(g.groups).toEqual([]);
    expect(g.sessions.map((c) => [c.ref, c.title, c.rows.map((p) => p.relPath), c.alsoIn.map((p) => p.relPath), c.touched.map((p) => p.relPath)])).toEqual([
      ["claude-code:new", "Newer session", ["p/a.md"], [], ["p/t.md"]],
      ["opencode:aaa", "Tied session", ["p/b.md"], [], []],
      ["claude-code:old", "Older session", [], ["p/a.md", "p/b.md"], []],
    ]);
    expect(g.sessions[0]!.foldKey).toBe("session:claude-code:new");
  });

  test("a card holding only also-in links stays; the projection drops what the facets empty", () => {
    const { pages, w } = sessionFixture();
    const cards = workSessionCards(w, pages, NOW);
    const onlyB = projectSessionCards(cards, pages.filter((p) => p.relPath === "p/b.md"), INERT);
    expect(onlyB.map((v) => [v.card.ref, v.rows.length, v.alsoIn.length])).toEqual([
      ["opencode:aaa", 1, 0],
      ["claude-code:old", 0, 1],
    ]);
  });

  test("a thread's own split view reads only its rows", () => {
    const { pages, w } = sessionFixture();
    expect(workSessionCards(w, pages, NOW, "p/a.md")).toHaveLength(3);
    expect(workSessionCards(w, pages, NOW, "p/other.md")).toEqual([]);
  });
});

describe("preferences", () => {
  const valid = {
    version: 1,
    stop: "areas",
    evidence: { series: false, related: true, issue: false },
    splits: [{ id: "abc-1", page: "Plans/X.md" }],
    keptApart: ["plans/y.md"],
  };

  test("a valid record keeps its false values, and resolve keeps them", () => {
    const p = parseWorkGroupPrefs(valid)!;
    expect(p).toEqual({ ...valid, version: 1, stop: "areas", splits: [{ id: "abc-1", page: "plans/x.md" }] } as never);
    expect(resolveWorkGroupPrefs(p).evidence).toEqual({ series: false, related: true, issue: false });
    expect(parseWorkGroupPrefs(JSON.stringify(valid))).toEqual(p);
  });

  test("no valid record means D1: Related with every box checked", () => {
    const d1 = { stop: "related", evidence: ALL, splits: [], keptApart: [] };
    for (const raw of [null, undefined, "", "{", 42, [], { ...valid, version: 2 }, { ...valid, version: "1" }, { ...valid, stop: "everything" }, { ...valid, evidence: { series: false, related: true } }, { ...valid, evidence: { ...valid.evidence, issue: "no" } }, { ...valid, splits: "x" }]) {
      expect(parseWorkGroupPrefs(raw)).toBeNull();
      expect(resolveWorkGroupPrefs(parseWorkGroupPrefs(raw))).toEqual(d1 as never);
    }
  });

  test("an empty selection is a valid record, not a reason for defaults", () => {
    const p = parseWorkGroupPrefs({ version: 1, stop: "related", evidence: { series: false, related: false, issue: false } })!;
    expect(resolveWorkGroupPrefs(p)).toEqual({ stop: "related", evidence: NONE, splits: [], keptApart: [] });
  });

  test("array entries are validated, deduplicated and bounded", () => {
    const p = parseWorkGroupPrefs({
      ...valid,
      splits: [
        { id: "ok", page: "a.md" },
        { id: "bad id!", page: "b.md" },
        { id: "dup-page", page: "A.md" },
        { id: "ok", page: "c.md" },
        { id: "up", page: "../x.md" },
        { id: "abs", page: "/etc/x.md" },
        { id: "nopage" },
        "nope",
        { id: "fine", page: "d/e.md" },
      ],
      keptApart: ["x.md", "X.md", 3, "", "a/../b.md", "y.md"],
    })!;
    expect(p.splits).toEqual([
      { id: "ok", page: "a.md" },
      { id: "fine", page: "d/e.md" },
    ]);
    expect(p.keptApart).toEqual(["x.md", "y.md"]);
    const many = parseWorkGroupPrefs({
      ...valid,
      splits: Array.from({ length: WORK_GROUP_SPLITS_MAX + 5 }, (_, i) => ({ id: `s${i}`, page: `p/${i}.md` })),
      keptApart: Array.from({ length: WORK_GROUP_KEPT_APART_MAX + 5 }, (_, i) => `k/${i}.md`),
    })!;
    expect(many.splits).toHaveLength(WORK_GROUP_SPLITS_MAX);
    expect(many.keptApart).toHaveLength(WORK_GROUP_KEPT_APART_MAX);
  });
});
