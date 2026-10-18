/**
 * The grouped Work threads rail (plan `muninn-wiki-work-thread-grouping`,
 * PR 3): `openWorkCards` and `railInputFor` with the Group control, and what
 * `buildRail` draws from them. Synthetic threads and evidence only.
 */

import { describe, expect, test } from "bun:test";
import { openThreadCards, openWorkCards, railInputFor, type RailWikiFacts, type RailViewer } from "./wiki-rail-input.ts";
import {
  buildRail,
  capFolds,
  GROUP_FOLDS_MAX,
  isRailGroupCard,
  openWorkThreadCards,
  THREAD_FOLDS_MAX,
  type RailGroupCard,
  type RailThreadCard,
  type RailWorkCard,
} from "./wiki-recents.ts";
import { DEFAULT_ACTIVITY_WEIGHTS } from "./wiki-activity-rank.ts";
import type { WikiFilters, WikiListing } from "./wiki-filter.ts";
import type { WorkGroupEvidenceToggles } from "./wiki-work-group-prefs.ts";
import { WORK_EVIDENCE_VERSION, WORK_WINDOW_MS, type IndexWork, type WorkEvidence, type WorkThread } from "../../../wiki/work-focus.ts";

const NOW = Date.UTC(2026, 9, 17, 20, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ALL: WorkGroupEvidenceToggles = { series: true, related: true, issue: true };
const NONE: WorkGroupEvidenceToggles = { series: false, related: false, issue: false };
const INERT: WikiFilters = { q: "", domain: "", folder: "", type: "", tag: "", status: "", followups: "", waiting: "", project: "", jira: "" };

interface PageSpec {
  edits?: number;
  series?: string;
  seriesLabel?: string;
  project?: string;
  type?: string;
  title?: string;
  movesYou?: number;
  createdMs?: number;
}

function page(relPath: string, s: PageSpec = {}): WikiListing {
  const at = NOW - 2 * HOUR;
  return {
    relPath,
    name: relPath.slice(relPath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""),
    title: s.title ?? relPath,
    type: s.type ?? "plan",
    domain: "ai",
    tags: [],
    aliases: [],
    linkCount: 0,
    backlinkCount: 0,
    gitCreatedMs: s.createdMs ?? NOW - 40 * DAY,
    ...(s.series ? { series: s.series } : {}),
    ...(s.seriesLabel ? { seriesLabel: s.seriesLabel } : {}),
    ...(s.project ? { project: s.project } : {}),
    ...(s.movesYou ? { movesYou: s.movesYou } : {}),
    work: { sinceMs: NOW - 8 * DAY, state: "F", focusMs: at, events: [[at, s.edits ?? 3, "focus"]] },
  } as WikiListing;
}

let seq = 0;
function thread(key: string, pages: string[], touched: string[] = []): WorkThread {
  seq++;
  return {
    key,
    pages,
    touched,
    sessions: [{ id: `s${seq}`, provider: "claude", first: NOW - 5 * HOUR, last: NOW - 2 * HOUR, title: `session ${seq}` }],
  };
}

function evidence(pages: readonly WikiListing[], threads: readonly WorkThread[], o: { related?: [string, string][]; issues?: [string, string, string][]; reasons?: WorkEvidence["relations"]["reasons"] } = {}): WorkEvidence {
  const focus = new Set(threads.flatMap((t) => t.pages));
  const series: Record<string, string> = {};
  const projects: Record<string, string> = {};
  for (const p of pages) {
    if (!focus.has(p.relPath)) continue;
    if (p.series) series[p.relPath] = p.series.trim().toLowerCase();
    if (p.project) projects[p.relPath] = p.project;
  }
  const reasons = o.reasons ?? [];
  return {
    version: WORK_EVIDENCE_VERSION,
    threads: { candidates: threads.length, shipped: threads.length },
    relations: {
      complete: !reasons.length,
      reasons,
      series,
      projects,
      related: o.related ?? [],
      issues: o.issues ?? [],
      ambiguousIssues: [],
      relatedSkipped: { skipped: 0, ambiguous: 0 },
    },
    contributions: { complete: true, reasons: [], cut: [], rows: [] },
  };
}

/**
 * The fixture, by score (edits) a > b > c > d > e > f > g > h:
 *  - a (a.md + a-two.md), b and c share series `alpha` → one SERIES group;
 *    c also has a related: entry to a; a touched `ctx.md`, b
 *    touched a-two.md (owned by a, so never shared context) and ctx.md.
 *  - d, e, f, g, h are lone threads (d in folder `notes`).
 */
function fixture(o: { reasons?: WorkEvidence["relations"]["reasons"]; noEvidence?: boolean; asOfMs?: number } = {}) {
  const pages = [
    page("plans/a.md", { edits: 80, series: "alpha", seriesLabel: "Alpha series", title: "A plan — long", movesYou: 2 }),
    page("plans/a-two.md", { edits: 70, series: "alpha" }),
    page("plans/b.md", { edits: 60, series: "alpha", movesYou: 3 }),
    page("plans/c.md", { edits: 50, series: "alpha" }),
    page("notes/d.md", { edits: 40, type: "note" }),
    page("plans/e.md", { edits: 30 }),
    page("plans/f.md", { edits: 20 }),
    page("plans/g.md", { edits: 10 }),
    page("plans/h.md", { edits: 5 }),
    page("plans/ctx.md", { edits: 0 }),
  ];
  delete (pages[9] as { work?: unknown }).work;
  const threads = [
    thread("plans/a.md", ["plans/a.md", "plans/a-two.md"], ["plans/ctx.md"]),
    thread("plans/b.md", ["plans/b.md"], ["plans/a-two.md", "plans/ctx.md"]),
    thread("plans/c.md", ["plans/c.md"]),
    thread("notes/d.md", ["notes/d.md"]),
    thread("plans/e.md", ["plans/e.md"]),
    thread("plans/f.md", ["plans/f.md"]),
    thread("plans/g.md", ["plans/g.md"]),
    thread("plans/h.md", ["plans/h.md"]),
  ];
  const work: IndexWork = {
    asOfMs: o.asOfMs ?? NOW - HOUR,
    sinceMs: NOW - 8 * DAY,
    threads,
    ...(o.noEvidence ? {} : { evidence: evidence(pages, threads, { related: [["plans/c.md", "plans/a.md"]], reasons: o.reasons }) }),
  };
  return { pages, threads, work };
}

const facts = (pages: WikiListing[], work: IndexWork): RailWikiFacts => ({
  allPages: pages,
  projects: {},
  activityWeights: DEFAULT_ACTIVITY_WEIGHTS,
  workedGate: { open: true, why: "" } as never,
  work,
});
const viewer = (over: Partial<RailViewer> = {}): RailViewer => ({
  mode: "updated",
  now: NOW,
  filters: INERT,
  showRetired: false,
  familiesOn: false,
  pins: [],
  openFolds: [],
  workGroup: { stop: "related", evidence: ALL },
  ...over,
});

const cardsAt = (stop: "threads" | "related" | "areas", over: { filters?: WikiFilters; folds?: string[]; pin?: string | null; more?: string[]; evidence?: WorkGroupEvidenceToggles } = {}, fx = fixture()) =>
  openWorkCards(fx.work, fx.pages, over.filters ?? INERT, over.folds ?? [], over.pin ?? null, NOW, fx.pages, {
    stop,
    evidence: over.evidence ?? ALL,
    moreOpen: over.more,
  });
const keysOf = (cards: readonly RailWorkCard[]) =>
  cards.map((c) => (isRailGroupCard(c) ? [c.foldKey, c.children.map((x) => x.key)] : c.foldKey));
const groupAt = (cards: readonly RailWorkCard[], i: number) => cards[i] as RailGroupCard;

describe("openWorkCards: the Threads stop is today's rail", () => {
  test("Threads draws exactly openThreadCards' cards", () => {
    const fx = fixture();
    const today = openThreadCards(fx.work.threads, fx.pages, INERT, [], null, NOW, fx.pages, fx.work.asOfMs);
    expect(cardsAt("threads", {}, fx).cards).toEqual(today);
  });

  test("with the control at Threads, buildRail draws today's entries plus the control on the header", () => {
    const fx = fixture();
    const without = buildRail(railInputFor(facts(fx.pages, fx.work), viewer({ workGroup: undefined })));
    const at = buildRail(railInputFor(facts(fx.pages, fx.work), viewer({ workGroup: { stop: "threads", evidence: ALL } })));
    const strip = (es: typeof at.entries) => es.map((e) => (e.kind === "header" ? { ...e, control: undefined } : e));
    expect(JSON.stringify(strip(at.entries))).toBe(JSON.stringify(strip(without.entries)));
    expect(at.entries.find((e) => e.kind === "header" && e.section === "threads")).toMatchObject({ control: { stop: "threads", requested: "threads" } });
    expect(without.entries.find((e) => e.kind === "header" && e.section === "threads")).not.toHaveProperty("control");
  });
});

describe("openWorkCards: Related", () => {
  test("a series group first, then lone thread cards, five cards in all, holding 7 of 8 threads", () => {
    const { cards } = cardsAt("related");
    expect(keysOf(cards)).toEqual([
      ["group:series:alpha", ["plans/a.md", "plans/b.md", "plans/c.md"]],
      "thread:notes/d.md",
      "thread:plans/e.md",
      "thread:plans/f.md",
      "thread:plans/g.md",
    ]);
    const g = groupAt(cards, 0);
    expect(g).toMatchObject({ label: "series", name: "Alpha series", threads: 3, movesYou: 5, hidden: 0, anchorVisible: true });
    expect(g.sessions).toHaveLength(3);
  });

  test("the first card opens by default with its first child; both offer the closed: spelling", () => {
    const g = groupAt(cardsAt("related").cards, 0);
    expect([g.open, g.toggleKey]).toEqual([true, "closed:group:series:alpha"]);
    expect(g.children.map((c) => [c.open, c.toggleKey])).toEqual([
      [true, "closed:thread:plans/a.md"],
      [false, "thread:plans/b.md"],
      [false, "thread:plans/c.md"],
    ]);
  });

  test("each child says why it joined; the anchor says anchor", () => {
    const g = groupAt(cardsAt("related").cards, 0);
    expect(g.children.map((c) => c.child?.why)).toEqual(["anchor", "↔ series", "↔ 1 link · series"]);
    expect(g.children[2]!.child!.witnesses).toEqual(["series Alpha series", "plans/c.md ↔ A plan — long (related:)"]);
  });

  test("the group's witnesses are deduplicated across children (one series line for two children)", () => {
    const g = groupAt(cardsAt("related").cards, 0);
    expect(g.witnesses).toEqual(["series Alpha series", "plans/c.md ↔ A plan — long (related:)"]);
  });

  test("shared context: a touched page listed once for the group, never a page a child owns; children list none", () => {
    const g = groupAt(cardsAt("related").cards, 0);
    expect(g.context.map((p) => p.relPath)).toEqual(["plans/ctx.md"]);
    expect(g.children.every((c) => c.touched.length === 0)).toBe(true);
  });

  test("with every box cleared, Related matches Threads", () => {
    expect(keysOf(cardsAt("related", { evidence: NONE }).cards)).toEqual(keysOf(cardsAt("threads").cards));
  });

  test("Areas: the control reports each stop and its uncapped card count", () => {
    const { control } = cardsAt("areas");
    expect(control).toMatchObject({ requested: "areas", stop: "areas", evidenceApplies: true });
    expect(control.stops.map((x) => [x.stop, x.available, x.cards])).toEqual([
      ["threads", true, 8],
      ["related", true, 6],
      ["areas", true, 6],
    ]);
    expect(cardsAt("threads").control.evidenceApplies).toBe(false);
  });
});

describe("openWorkCards: facets, the cap and names", () => {
  test("facets apply before the cap: a facet that empties a card lets the next one in", () => {
    const notesOnly = { ...INERT, folder: "plans" };
    const { cards } = cardsAt("related", { filters: notesOnly });
    expect(keysOf(cards)).toEqual([
      ["group:series:alpha", ["plans/a.md", "plans/b.md", "plans/c.md"]],
      "thread:plans/e.md",
      "thread:plans/f.md",
      "thread:plans/g.md",
      "thread:plans/h.md",
    ]);
  });

  test("a facet that hides the anchor keeps the group's name and says the anchor is outside the filters", () => {
    const fx = fixture();
    // Retire-free way to hide a: a type facet the anchor's pages do not carry.
    (fx.pages[0] as { type: string }).type = "note";
    (fx.pages[1] as { type: string }).type = "note";
    const { cards } = cardsAt("related", { filters: { ...INERT, type: "plan" } }, fx);
    const g = groupAt(cards, 0);
    expect(g.name).toBe("Alpha series");
    expect(g.foldKey).toBe("group:series:alpha");
    expect(g.anchorVisible).toBe(false);
    expect(g.children.map((c) => c.key)).toEqual(["plans/b.md", "plans/c.md"]);
    // The anchor's 📌 target is still the anchor's page.
    expect(g.pinAnchor).toBe("plans/a-two.md");
  });

  test("a query draws no section", () => {
    expect(cardsAt("related", { filters: { ...INERT, q: "x" } }).cards).toEqual([]);
  });
});

describe("openWorkCards: a broad group", () => {
  function broad() {
    const pages = ["a", "b", "c", "d", "e"].map((k, i) => page(`plans/${k}.md`, { edits: 50 - i * 5, series: "big" }));
    const threads = pages.map((p) => thread(p.relPath, [p.relPath]));
    const work: IndexWork = { asOfMs: NOW - HOUR, sinceMs: NOW - 8 * DAY, threads, evidence: evidence(pages, threads) };
    return { pages, threads, work };
  }

  test("three children show and `+ N more threads` counts the rest", () => {
    const g = groupAt(cardsAt("related", {}, broad()).cards, 0);
    expect(g.children.map((c) => c.key)).toEqual(["plans/a.md", "plans/b.md", "plans/c.md"]);
    expect([g.threads, g.hidden]).toEqual([5, 2]);
  });

  test("after `+ N more threads`, every child shows", () => {
    const g = groupAt(cardsAt("related", { more: ["group:series:big"] }, broad()).cards, 0);
    expect(g.children).toHaveLength(5);
    expect(g.hidden).toBe(0);
  });

  test("a pinned child past the first three shows, and stays marked", () => {
    const g = groupAt(cardsAt("related", { pin: "plans/e.md" }, broad()).cards, 0);
    expect(g.children.map((c) => [c.key, c.pinned])).toEqual([
      ["plans/a.md", false],
      ["plans/b.md", false],
      ["plans/c.md", false],
      ["plans/e.md", true],
    ]);
    expect([g.pinned, g.hidden]).toEqual([true, 1]);
  });
});

describe("openWorkCards: the pin", () => {
  test("a pin on a later group's child moves the group first; the child is the pinned one", () => {
    const fx = fixture();
    const pages = [...fx.pages, page("plans/z1.md", { edits: 1, series: "zed" }), page("plans/z2.md", { edits: 1, series: "zed" })];
    const threads = [...fx.threads, thread("plans/z1.md", ["plans/z1.md"]), thread("plans/z2.md", ["plans/z2.md"])];
    const work: IndexWork = { ...fx.work, threads, evidence: evidence(pages, threads, { related: [["plans/c.md", "plans/a.md"]] }) };
    const { cards } = cardsAt("related", { pin: "plans/z2.md" }, { pages, threads, work });
    const g = groupAt(cards, 0);
    expect(g.foldKey).toBe("group:series:zed");
    expect(g.pinned).toBe(true);
    expect(g.children.map((c) => [c.key, c.pinned])).toEqual([
      ["plans/z1.md", false],
      ["plans/z2.md", true],
    ]);
    // The group's 📌 pins the anchor child.
    expect(g.pinAnchor).toBe("plans/z1.md");
    // The pinned group is first, so it is the one that defaults open.
    expect(g.open).toBe(true);
  });

  test("G5: the pinned child's rows all filtered — the child drops, the group keeps first place and its pinned look", () => {
    const fx = fixture();
    const pages = [...fx.pages, page("plans/z1.md", { edits: 1, series: "zed" }), page("notes/z2.md", { edits: 1, series: "zed", type: "note" })];
    const threads = [...fx.threads, thread("plans/z1.md", ["plans/z1.md"]), thread("notes/z2.md", ["notes/z2.md"])];
    const work: IndexWork = { ...fx.work, threads, evidence: evidence(pages, threads, { related: [["plans/c.md", "plans/a.md"]] }) };
    const g = groupAt(cardsAt("related", { pin: "notes/z2.md", filters: { ...INERT, type: "plan" } }, { pages, threads, work }).cards, 0);
    expect(g.foldKey).toBe("group:series:zed");
    expect(g.pinned).toBe(true);
    expect(g.children.map((c) => c.key)).toEqual(["plans/z1.md"]);
  });

  test("G8: the pin follows its page at every stop", () => {
    const fx = fixture();
    expect(keysOf(cardsAt("threads", { pin: "plans/f.md" }, fx).cards)[0]).toBe("thread:plans/f.md");
    expect(keysOf(cardsAt("related", { pin: "plans/f.md" }, fx).cards)[0]).toBe("thread:plans/f.md");
    expect(keysOf(cardsAt("areas", { pin: "plans/b.md" }, fx).cards)[0]).toEqual(["group:series:alpha", ["plans/a.md", "plans/b.md", "plans/c.md"]]);
  });

  test("a pin that matches no thread keeps the order (the held pin stays, nothing marked)", () => {
    expect(keysOf(cardsAt("related", { pin: "plans/nowhere.md" }).cards)).toEqual(keysOf(cardsAt("related").cards));
  });
});

describe("availability: Threads with a reason", () => {
  test("relations incomplete: Related draws today's Threads cards and keeps the choice", () => {
    const fx = fixture({ reasons: ["relations-cap"] });
    const { cards, control } = cardsAt("related", {}, fx);
    expect(cards).toEqual(openThreadCards(fx.work.threads, fx.pages, INERT, [], null, NOW, fx.pages, fx.work.asOfMs));
    expect(control).toMatchObject({ requested: "related", stop: "threads", evidenceApplies: false });
    expect(control.stops.find((x) => x.stop === "related")).toMatchObject({ available: false, reasons: ["relations-cap"] });
  });

  test("an older server with no evidence: Threads, reason evidence-absent", () => {
    const { control } = cardsAt("related", {}, fixture({ noEvidence: true }));
    expect(control.stop).toBe("threads");
    expect(control.stops.find((x) => x.stop === "areas")!.reasons).toEqual(["evidence-absent"]);
  });
});

describe("railInputFor: the lift is the open child of an open group", () => {
  const activityRels = (fx: ReturnType<typeof fixture>, over: Partial<RailViewer>) =>
    (railInputFor(facts(fx.pages, fx.work), viewer(over)).activity ?? []).map((r) => r.page.relPath);

  test("only the open child's pages leave Activity; a closed sibling's stay", () => {
    const fx = fixture();
    const act = activityRels(fx, {});
    expect(act).not.toContain("plans/a.md");
    expect(act).not.toContain("plans/a-two.md");
    expect(act).toContain("plans/b.md");
  });

  test("closing the child or the group returns its rows to Activity", () => {
    const fx = fixture();
    expect(activityRels(fx, { openFolds: ["closed:thread:plans/a.md"] })).toContain("plans/a.md");
    expect(activityRels(fx, { openFolds: ["closed:group:series:alpha"] })).toContain("plans/a.md");
  });

  test("openWorkThreadCards is the set buildRail lifts", () => {
    const fx = fixture();
    const input = railInputFor(facts(fx.pages, fx.work), viewer({ openFolds: ["thread:plans/b.md"] }));
    expect(openWorkThreadCards(input.threads!).map((c) => c.key)).toEqual(["plans/a.md", "plans/b.md"]);
  });
});

describe("buildRail: the group's entries", () => {
  test("header with control, the group, its open child's rows, a closed child, the end with shared context", () => {
    const fx = fixture();
    const rail = buildRail(railInputFor(facts(fx.pages, fx.work), viewer()));
    const threads = rail.entries.filter((e) => e.section === "threads");
    expect(
      threads.map((e) =>
        e.kind === "row" ? `row ${e.page.relPath}` : e.kind === "thread" ? `thread ${e.foldKey}${e.folded ? " closed" : ""}` : e.kind === "thread-group" ? `group ${e.foldKey}` : e.kind === "thread-group-end" ? `end ${e.context.map((p) => p.relPath).join(",")}` : e.kind,
      ),
    ).toEqual([
      "header",
      "group group:series:alpha",
      "thread thread:plans/a.md",
      "row plans/a.md",
      "row plans/a-two.md",
      "thread thread:plans/b.md closed",
      "thread thread:plans/c.md closed",
      "end plans/ctx.md",
      "thread thread:notes/d.md closed",
      "thread thread:plans/e.md closed",
      "thread thread:plans/f.md closed",
      "thread thread:plans/g.md closed",
    ]);
  });

  test("a closed group draws no child and lifts nothing", () => {
    const fx = fixture();
    const rail = buildRail(railInputFor(facts(fx.pages, fx.work), viewer({ openFolds: ["closed:group:series:alpha"] })));
    expect(rail.entries.filter((e) => e.section === "threads" && e.kind === "row")).toEqual([]);
    expect(rail.entries.some((e) => e.kind === "thread-group-end")).toBe(false);
  });

  test("no focus row twice across groups, Activity and Pinned, with every child open and pins on the rows", () => {
    const fx = fixture();
    const rail = buildRail(
      railInputFor(
        facts(fx.pages, fx.work),
        viewer({ openFolds: ["thread:plans/b.md", "thread:plans/c.md", "thread:notes/d.md"], pins: ["plans/a.md", "plans/b.md", "plans/h.md"] }),
      ),
    );
    const rows = rail.entries.filter((e) => e.kind === "row").map((e) => (e as { page: WikiListing }).page.relPath);
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows.filter((r) => r === "plans/b.md")).toHaveLength(1);
  });

  test("a focus row drawn by an open child is left out of the shared context", () => {
    const fx = fixture();
    // ctx.md becomes d's focus page: d is a lone thread with ctx.md as focus.
    const pages = fx.pages.map((p) => (p.relPath === "plans/ctx.md" ? page("plans/ctx.md", { edits: 1 }) : p));
    const threads = fx.threads.map((t) => (t.key === "notes/d.md" ? { ...t, pages: ["notes/d.md", "plans/ctx.md"] } : t));
    const work: IndexWork = { ...fx.work, threads, evidence: evidence(pages, threads, { related: [["plans/c.md", "plans/a.md"]] }) };
    const shown = buildRail(railInputFor(facts(pages, work), viewer({ openFolds: ["thread:notes/d.md"] })));
    const end = shown.entries.find((e) => e.kind === "thread-group-end");
    expect(end && end.kind === "thread-group-end" ? end.context.map((p) => p.relPath) : null).toEqual([]);
  });
});

describe("the created (NEW) window stays on the reader's now (PR 2 note c)", () => {
  test("a page created just inside the window at now is NEW even when asOfMs is later than now", () => {
    const fx = fixture({ asOfMs: NOW + 2 * HOUR });
    const fresh = page("plans/a.md", { edits: 80, series: "alpha", seriesLabel: "Alpha series", title: "A plan — long", createdMs: NOW - WORK_WINDOW_MS + HOUR });
    const pages = fx.pages.map((p) => (p.relPath === "plans/a.md" ? fresh : p));
    const today = openThreadCards(fx.work.threads, pages, INERT, [], null, NOW, pages, NOW + 2 * HOUR);
    expect(today[0]!.created).toContain("plans/a.md");
    const g = groupAt(openWorkCards(fx.work, pages, INERT, [], null, NOW, pages, { stop: "related", evidence: ALL }).cards, 0);
    expect(g.children[0]!.created).toContain("plans/a.md");
  });
});

describe("capFolds: the group namespace", () => {
  test("group fold keys are bounded apart from thread folds and the reader's own", () => {
    const groups = Array.from({ length: GROUP_FOLDS_MAX + 5 }, (_, i) => `group:anchor:g${i}.md`);
    const threads = Array.from({ length: THREAD_FOLDS_MAX + 5 }, (_, i) => `thread:t${i}.md`);
    const out = capFolds(["plans/x.md", ...groups, ...threads]);
    expect(out.filter((k) => k.startsWith("group:"))).toHaveLength(GROUP_FOLDS_MAX);
    expect(out.filter((k) => k.startsWith("thread:"))).toHaveLength(THREAD_FOLDS_MAX);
    expect(out).toContain("plans/x.md");
    expect(out.filter((k) => k.startsWith("group:"))[0]).toBe("group:anchor:g0.md");
  });

  test("with no group key, capFolds is unchanged", () => {
    const list = ["toggle:families", "plans/x.md", "thread:a.md", "closed:thread:b.md"];
    expect(capFolds(list)).toEqual(list);
  });
});

// Type-level use, so an unused import cannot hide a broken export.
export type _Cards = RailThreadCard;
