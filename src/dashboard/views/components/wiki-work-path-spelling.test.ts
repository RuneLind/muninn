/**
 * Class check on the work-thread path spelling (PR 727, round 3): every site on
 * the Work threads surface that stores a page path or compares two answers the
 * same for every spelling of one page as for its canonical spelling.
 *
 * Spellings × sites. The page is `plans/sjö.md`; the listing and the server's
 * threads carry it the way macOS's filesystem does (NFD), and each cell feeds
 * one other spelling into one site. Every cell computes the site's answer for
 * the canonical spelling too and asserts both are the meaningful answer, so a
 * site broken for every spelling cannot pass by agreeing with itself.
 */

import { describe, expect, test } from "bun:test";
import type { WikiListing } from "./wiki-filter.ts";
import { normalizeRel } from "./wiki-nav.ts";
import { claimOwnedFocus, newestFocusPage, threadHoldsPin, threadPinAnchor, threadRankScore, workTermOrder } from "./wiki-thread-core.ts";
import { applyWorkBoundaries } from "./wiki-work-boundaries.ts";
import { parseWorkGroupPrefs, workGroupPagePath } from "./wiki-work-group-prefs.ts";
import { openPageChanged, openPageRefusal, seriesConflictCopy } from "./wiki-series-write.ts";
import * as seriesWrite from "./wiki-series-write.ts";
import { threadCardPieces } from "./wiki-rail-input.ts";
import { groupWorkThreads, type WorkGroupChild } from "./wiki-work-groups.ts";
import { saveAsSeriesPlan } from "./wiki-work-series.ts";
import { isFoldOpen, isPinnedRelPath } from "./wiki-recents.ts";
import type { WikiFilters } from "./wiki-filter.ts";
import { aliasTopDirs, aliasWorkedPaths } from "../../../wiki/alias-ref.ts";
import { normalizeWorkedPath } from "../../../wiki/rel-path.ts";
import { WORK_EVIDENCE_VERSION, workSessionRef, type IndexWork, type WorkContribution, type WorkThread } from "../../../wiki/work-focus.ts";

const NOW = Date.UTC(2026, 9, 20, 12, 0);
const H = 3_600_000;

const NFC = "plans/sj\u00f6.md";
const NFD = "plans/sjo\u0308.md";
/** The one spelling every site must land on. */
const CANON = NFC;

const SPELLINGS: Record<string, string> = {
  NFC,
  NFD,
  "double slash": "plans//sj\u00f6.md",
  "dot segment": "./plans/sj\u00f6.md",
  "x/..": "x/../plans/sj\u00f6.md",
  "leading slash": "/plans/sj\u00f6.md",
  "case variant": "Plans/SJ\u00d6.md",
};

function page(relPath: string, o: { focusMs?: number; backlinks?: number; aliases?: string[] } = {}): WikiListing {
  const at = o.focusMs ?? NOW - 2 * H;
  return {
    relPath,
    name: relPath,
    title: relPath,
    type: "plan",
    domain: "ai",
    tags: [],
    aliases: o.aliases ?? [],
    linkCount: 0,
    backlinkCount: o.backlinks ?? 0,
    work: { sinceMs: NOW - 8 * 24 * H, state: "F", focusMs: at, events: [[at, 3, "focus"]] },
  } as WikiListing;
}

const sess = (id: string, last: number) => ({ id, provider: "claude", first: last - H, last, title: `title ${id}` });
const row = (id: string, p: string, thread: string, first: number): WorkContribution => [workSessionRef(sess(id, 0)), p, thread, "focus", 2, first, first + H];

function work(threads: WorkThread[], rows: WorkContribution[]): IndexWork {
  return {
    asOfMs: NOW,
    sinceMs: NOW - 8 * 24 * H,
    threads,
    evidence: {
      version: WORK_EVIDENCE_VERSION,
      threads: { candidates: threads.length, shipped: threads.length },
      relations: { complete: true, reasons: [], series: {}, projects: {}, related: [], issues: [], ambiguousIssues: [], relatedSkipped: { skipped: 0, ambiguous: 0 } },
      contributions: { complete: true, reasons: [], cut: [], rows },
    },
  };
}

/** The listing as the filesystem spells it (NFD, `listed`), two threads: T holds
 *  the page (newest focus) and `plans/a.md`, U holds `plans/b.md`. */
function fixture(listed = NFD) {
  const pages = [page(listed, { focusMs: NOW - 1 * H }), page("plans/a.md", { focusMs: NOW - 5 * H }), page("plans/b.md")];
  const T: WorkThread = { key: "plans/a.md", pages: [listed, "plans/a.md"], touched: [], sessions: [sess("s1", NOW - H)] };
  const U: WorkThread = { key: "plans/b.md", pages: ["plans/b.md"], touched: [], sessions: [sess("s2", NOW - 2 * H)] };
  const rows = [row("s1", "plans/a.md", "plans/a.md", NOW - 6 * H), row("s1", listed, "plans/a.md", NOW - 2 * H), row("s2", "plans/b.md", "plans/b.md", NOW - 3 * H)];
  return { pages, T, U, work: work([T, U], rows) };
}

const byRelOf = (pages: readonly WikiListing[]) => new Map(pages.map((p) => [normalizeRel(p.relPath), p] as const));

describe("the canonical spelling", () => {
  test("every spelling folds onto it, and the empty path stays empty", () => {
    for (const s of Object.values(SPELLINGS)) expect(normalizeRel(s)).toBe(normalizeWorkedPath(CANON));
    expect(normalizeRel("")).toBe("");
    expect(normalizeWorkedPath("")).toBe("");
  });
});

describe.each(Object.entries(SPELLINGS))("spelling: %s", (_name, spelled) => {
  test("alias resolution: the server's fold and the resolver both name the moved page", () => {
    // `plans/new.md` carries the page's old path as an alias, itself spelled
    // off-canonical (NFD, upper case) as a hand-written frontmatter can be,
    // once without an extension and once with; the page itself is gone.
    for (const alias of ["Plans/sjo\u0308", "Plans/SJO\u0308.md"]) {
      const pages = [page("plans/new.md", { aliases: [alias] }), page("plans/b.md")];
      const topDirs = aliasTopDirs(["plans"]);
      const server = (p: string) => aliasWorkedPaths(alias, topDirs).includes(normalizeWorkedPath(p));
      const resolver = (p: string) =>
        applyWorkBoundaries({ work: null, allPages: pages, splits: [{ id: "s", page: p }], keptApart: [] }).definitions[0]!.page;
      expect(server(CANON)).toBe(true);
      expect(resolver(CANON)).toBe("plans/new.md");
      expect(server(spelled)).toBe(server(CANON));
      expect(resolver(spelled)).toBe(resolver(CANON));
    }
  });

  test("byRel lookup: a thread page in this spelling finds the listed page, and the reverse", () => {
    const f = fixture();
    const own = (pages: readonly WikiListing[], threadPage: string) =>
      claimOwnedFocus([threadPage], byRelOf(pages), new Set(), workTermOrder(NOW)).map((p) => p.relPath);
    expect(own(f.pages, CANON)).toEqual([NFD]);
    expect(own(f.pages, spelled)).toEqual(own(f.pages, CANON));
    // The listing in this spelling, the thread in the canonical one.
    const g = fixture(spelled);
    expect(own(g.pages, CANON)).toEqual([spelled]);
    const score = (t: WorkThread, pages: readonly WikiListing[]) => threadRankScore(t, byRelOf(pages), NOW);
    expect(score({ ...f.T, pages: [spelled] }, f.pages)).toBeGreaterThan(0);
    expect(score({ ...f.T, pages: [spelled] }, f.pages)).toBe(score({ ...f.T, pages: [CANON] }, f.pages));
  });

  test("threadHoldsPin: a pin in this spelling is held by the thread holding the page", () => {
    const f = fixture();
    const holds = (pin: string) => threadHoldsPin(f.T, byRelOf(f.pages), normalizeRel(pin));
    expect(holds(CANON)).toBe(true);
    expect(holds(spelled)).toBe(holds(CANON));
    // And the thread spelling the page this way holds a canonical pin.
    expect(threadHoldsPin({ ...f.T, pages: [spelled, "plans/a.md"] }, byRelOf(f.pages), normalizeRel(CANON))).toBe(true);
    expect(threadPinAnchor([f.T, f.U], f.pages, spelled)).toBe(threadPinAnchor([f.T, f.U], f.pages, CANON));
    expect(threadPinAnchor([f.T, f.U], f.pages, CANON)).toBe(normalizeRel(CANON));
  });

  test("newestFocusPage: the page in this spelling is the anchor, spelled canonically", () => {
    const f = fixture();
    const anchor = (threadPage: string) => newestFocusPage({ ...f.T, pages: [threadPage, "plans/a.md"] }, byRelOf(f.pages));
    expect(anchor(CANON)).toBe(normalizeRel(CANON));
    expect(anchor(spelled)).toBe(anchor(CANON));
  });

  test("workGroupPagePath: a stored boundary in this spelling reads back canonical", () => {
    expect(workGroupPagePath(CANON)).toBe(normalizeRel(CANON));
    expect(workGroupPagePath(spelled)).toBe(workGroupPagePath(CANON));
    const prefs = parseWorkGroupPrefs({ version: 1, stop: "related", splits: [{ id: "a", page: spelled }], keptApart: [spelled] })!;
    expect(prefs.splits).toEqual([{ id: "a", page: workGroupPagePath(CANON)! }]);
    expect(prefs.keptApart).toEqual([workGroupPagePath(CANON)!]);
  });

  test("keep apart end to end: an anchor stored in this spelling isolates the page's thread", () => {
    const f = fixture();
    const kept = (stored: string) => {
      const anchor = workGroupPagePath(stored)!;
      const b = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: [], keptApart: [anchor] });
      const d = b.definitions[0]!;
      return { state: d.state, page: d.page, isolated: b.units.filter((u) => u.isolated).map((u) => u.key) };
    };
    expect(kept(CANON)).toEqual({ state: "active", page: normalizeRel(CANON), isolated: ["plans/a.md"] });
    expect(kept(spelled)).toEqual(kept(CANON));
  });

  test("openPageChanged: the open page in this spelling is the page the bases name", () => {
    const changed = (openRel: string, baseKey: string) =>
      openPageChanged({ relPath: openRel, loadedHash: "loaded" }, new Map([[baseKey, "fresh"]]));
    expect(changed(CANON, NFD)).toBe(NFD);
    expect(changed(spelled, NFD)).toBe(changed(CANON, NFD));
    expect(changed(NFD, spelled)).toBe(spelled);
  });
});

describe("the reproduced case (round 3)", () => {
  test("an NFD page kept apart under the old lower-case-only record spelling stays active, not dormant", () => {
    const f = fixture();
    // What `workGroupPagePath` stored before this round: lower case, NFD kept.
    const oldStored = NFD.toLowerCase();
    const prefs = parseWorkGroupPrefs({ version: 1, stop: "related", keptApart: [oldStored] })!;
    const b = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: [], keptApart: prefs.keptApart });
    expect(b.definitions).toEqual([{ kind: "keptApart", stored: normalizeRel(CANON), page: normalizeRel(CANON), state: "active" }]);
    expect(b.units.find((u) => u.isolated)?.keptApart).toEqual([normalizeRel(CANON)]);
    // The anchor is already the thread's newest page, so nothing re-anchors.
    expect(b.reanchor).toEqual([]);
  });
});

// Fix round 3, follow-up pins: the sites the table above did not reach. Each
// computes the canonical answer too, so a site that folds case only (the old
// `normalizeRel`) fails on the NFD listing even for the canonical spelling.
const INERT: WikiFilters = { q: "", domain: "", folder: "", type: "", tag: "", status: "", followups: "", waiting: "", project: "", jira: "" };

describe.each(Object.entries(SPELLINGS))("spelling, remaining sites: %s", (_name, spelled) => {
  test("threadCardPieces (wiki-rail-input): a thread naming the page this way draws the listed page", () => {
    const f = fixture();
    const focus = (threadPage: string) =>
      threadCardPieces([{ ...f.T, pages: [threadPage, "plans/a.md"] }, f.U], f.pages, INERT, null, NOW, f.pages, NOW, 5)
        .flat()
        .flatMap((c) => c.focus.map((p) => p.relPath));
    expect(focus(CANON)).toContain(NFD);
    expect(focus(spelled)).toEqual(focus(CANON));
  });

  test("groupWorkThreads (wiki-work-groups): a series relation keyed this way joins the page's thread", () => {
    const f = fixture();
    const sizes = (key: string) => {
      const w = structuredClone(f.work);
      w.evidence!.relations.series = { [key]: "s", "plans/b.md": "s" };
      return groupWorkThreads({ work: w, allPages: f.pages, now: NOW, stop: "related", toggles: { series: true, related: true, issue: true } }).groups.map((g) => g.children.length);
    };
    expect(sizes(CANON)).toEqual([2]);
    expect(sizes(spelled)).toEqual(sizes(CANON));
  });

  test("saveAsSeriesPlan (wiki-work-series): a thread naming the page this way writes the listed page", () => {
    const f = fixture();
    const writes = (threadPage: string) => {
      const child = (key: string, pages: string[]) =>
        ({ key, name: key, unit: { key, index: 0, sub: 0, isolated: false, rank: { key, pages, touched: [], sessions: [] }, thread: { key, pages, touched: [], sessions: [] } } }) as unknown as WorkGroupChild;
      return saveAsSeriesPlan({ children: [child("t", [threadPage]), child("u", ["plans/b.md"])] }, f.pages).writes.map((w) => w.relPath);
    };
    expect(writes(CANON)).toEqual([NFD, "plans/b.md"]);
    expect(writes(spelled)).toEqual(writes(CANON));
  });

  test("openPageRefusal: the changed open page in this spelling is the page the writes name", () => {
    const refuses = (changed: string, written: string) => openPageRefusal(changed, [{ relPath: written }]) !== null;
    expect(refuses(CANON, NFD)).toBe(true);
    expect(refuses(spelled, NFD)).toBe(true);
    expect(refuses(NFD, spelled)).toBe(true);
  });

  test("seriesConflictCopy: a 409 on the open page in this spelling says reload", () => {
    const reload = "Reload the page — it has changed";
    expect(seriesConflictCopy(NFD, CANON).again).toBe(reload);
    expect(seriesConflictCopy(NFD, spelled).again).toBe(reload);
    expect(seriesConflictCopy(spelled, NFD).again).toBe(reload);
  });

  test("isPinnedRelPath, isFoldOpen (wiki-recents): a pin or fold stored in this spelling matches the listed page", () => {
    expect(isPinnedRelPath([CANON], NFD)).toBe(true);
    expect(isPinnedRelPath([spelled], NFD)).toBe(true);
    expect(isFoldOpen([spelled], NFD)).toBe(true);
  });
});

test("the write loop is not exported: both callers go through the open-page refusal", () => {
  expect(Object.keys(seriesWrite)).not.toContain("runSeriesWrites");
});

test("workGroupPagePath refuses empty, root-escaping and trailing-slash paths, and reads a folder-shaped one back as the folder", () => {
  for (const v of ["", " ", "..", "../x", "a/../..", "plans/", ".", "a/.."]) expect(workGroupPagePath(v)).toBeNull();
  expect(workGroupPagePath("plans/.")).toBe("plans");
  expect(workGroupPagePath("a/b/..")).toBe("a");
});
