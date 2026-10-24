/**
 * `buildWorkEvidence` over synthetic pages (plan
 * `muninn-wiki-work-thread-grouping`, «Evidence and payload»): the witnesses
 * per kind, the owner rule (D4, D13) and the bounds.
 */

import { describe, expect, test } from "bun:test";
import { buildWorkEvidence, WORK_EVIDENCE_CONTRIBUTIONS_MAX, WORK_EVIDENCE_RELATIONS_MAX } from "./work-evidence.ts";
import type { WikiPageMeta } from "./store.ts";
import { computeWorkFocus, type WorkContribution, type WorkThread } from "./work-focus.ts";

function meta(relPath: string, over: Partial<WikiPageMeta> = {}): WikiPageMeta {
  const name = relPath.split("/").pop()!.replace(/\.[^.]+$/, "");
  return { name, title: name, type: "plan", domain: "ai", tags: [], aliases: [], relPath, ...over } as WikiPageMeta;
}
const thread = (key: string, pages: string[]): WorkThread => ({ key, pages, touched: [], sessions: [] });

function build(pages: WikiPageMeta[], threads: WorkThread[], over: { contributions?: WorkContribution[]; ledgerTruncated?: boolean; candidates?: number } = {}) {
  return buildWorkEvidence({
    threads,
    candidates: over.candidates ?? threads.length,
    contributions: over.contributions ?? [],
    ledgerTruncated: over.ledgerTruncated ?? false,
    pages,
  });
}

describe("relations", () => {
  test("series and projects: focus pages only, the series by its census key and membership", () => {
    const pages = [
      meta("p/a.mdx", { series: "Alpha ", project: "muninn" }),
      meta("p/b.mdx", { series: "alpha", project: "huginn" }),
      meta("p/a-prototype.html", { series: "zeta", parent: "p/a.mdx", pairedBy: "suffix" }),
      meta("p/c.mdx", { series: "alpha" }),
    ];
    const e = build(pages, [thread("p/a.mdx", ["p/a.mdx", "p/a-prototype.html"]), thread("p/b.mdx", ["p/b.mdx"])]);
    // An attachment child counts in its parent's series, never its own key;
    // p/c is no focus page.
    expect(e.relations.series).toEqual({ "p/a.mdx": "alpha", "p/a-prototype.html": "alpha", "p/b.mdx": "alpha" });
    expect(e.relations.projects).toEqual({ "p/a.mdx": "muninn", "p/b.mdx": "huginn" });
  });

  test("an attachment focus page counts as a member of its markdown parent's series (Save as series writes the parent); its own key does not, and a retired child's parent is no stand-in", () => {
    const pages = [
      meta("p/a.md", { series: "Alpha" }),
      meta("p/a.html", { parent: "p/a.md", pairedBy: "stem" }),
      meta("p/b.md"),
      meta("p/b-prototype.html", { series: "beta", parent: "p/b.md", pairedBy: "suffix" }),
      meta("p/c.md", { series: "gamma" }),
      meta("p/old.md", { parent: "p/c.md", pairedBy: "superseded" }),
    ];
    const e = build(pages, [thread("p/a.html", ["p/a.html"]), thread("p/b-prototype.html", ["p/b-prototype.html"]), thread("p/old.md", ["p/old.md"])]);
    expect(e.relations.series).toEqual({ "p/a.html": "alpha" });
  });

  test("related: authored pairs between focus pages, either thread, hubs included; skips are summed", () => {
    const pages = [
      meta("p/a.mdx", { related: ["p/b.mdx", "p/out.mdx", "p/hub.mdx"], relatedSkipped: 2 }),
      meta("p/b.mdx", { related: ["p/a.mdx"], relatedAmbiguous: 1 }),
      meta("p/hub.mdx"),
      meta("p/out.mdx", { related: ["p/a.mdx"], relatedSkipped: 5 }),
    ];
    const e = build(pages, [thread("p/a.mdx", ["p/a.mdx"]), thread("p/b.mdx", ["p/b.mdx", "p/hub.mdx"])]);
    expect(e.relations.related).toEqual([
      ["p/a.mdx", "p/b.mdx"],
      ["p/a.mdx", "p/hub.mdx"],
      ["p/b.mdx", "p/a.mdx"],
    ]);
    expect(e.relations.relatedSkipped).toEqual({ skipped: 2, ambiguous: 1 });
  });

  test("related: a target that is a rail attachment counts as its parent's edge (focus holds only the parent); once per pair, never a self-edge, a retired child stays its own page", () => {
    const pages = [
      meta("p/a.mdx", { related: ["p/b-prototype.html", "p/b.mdx", "p/a.html", "p/c.html", "p/d-notes.mdx", "p/old.md"] }),
      meta("p/a.html", { parent: "p/a.mdx", pairedBy: "stem" }),
      meta("p/b.mdx"),
      meta("p/b-prototype.html", { parent: "p/b.mdx", pairedBy: "suffix" }),
      meta("p/c.mdx"),
      meta("p/c.html", { parent: "p/c.mdx", pairedBy: "stem" }),
      meta("p/d.mdx"),
      meta("p/d-notes.mdx", { parent: "p/d.mdx", pairedBy: "link" }),
      meta("p/e.mdx"),
      meta("p/old.md", { parent: "p/e.mdx", pairedBy: "superseded" }),
    ];
    const e = build(pages, [thread("p/a.mdx", ["p/a.mdx"]), thread("p/b.mdx", ["p/b.mdx", "p/d.mdx", "p/e.mdx"])]);
    // b-prototype → b (and the direct b entry adds nothing); a.html → a is a
    // self-edge; c is no focus page; d-notes (link) → d; old.md (superseded)
    // is its own page and no focus page, so no edge to e.
    expect(e.relations.related).toEqual([
      ["p/a.mdx", "p/b.mdx"],
      ["p/a.mdx", "p/d.mdx"],
    ]);
  });

  test("related: a focus page naming ONLY a stem child, or ONLY a suffix child, of another focus page gets the edge to that parent", () => {
    const pages = [
      meta("p/a.mdx", { related: ["p/b.html"] }),
      meta("p/b.mdx"),
      meta("p/b.html", { parent: "p/b.mdx", pairedBy: "stem" }),
      meta("p/c.mdx", { related: ["p/d-prototype.html"] }),
      meta("p/d.mdx"),
      meta("p/d-prototype.html", { parent: "p/d.mdx", pairedBy: "suffix" }),
    ];
    const e = build(pages, [thread("p/a.mdx", ["p/a.mdx", "p/c.mdx"]), thread("p/b.mdx", ["p/b.mdx", "p/d.mdx"])]);
    expect(e.relations.related).toEqual([
      ["p/a.mdx", "p/b.mdx"],
      ["p/c.mdx", "p/d.mdx"],
    ]);
  });

  test("related: a child `computeWorkFocus` keeps as its own page (parent meta, missing or itself a child) keeps the edge to itself, never its parent", () => {
    const fam = [
      { relPath: "p/x.mdx", related: ["p/m.html", "p/orph.html", "p/gc.html"] },
      { relPath: "p/index.mdx" },
      { relPath: "p/m.html", parent: "p/index.mdx", pairedBy: "link" as const },
      { relPath: "p/orph.html", parent: "p/gone.mdx", pairedBy: "stem" as const },
      { relPath: "p/top.mdx" },
      { relPath: "p/mid.html", parent: "p/top.mdx", pairedBy: "stem" as const },
      { relPath: "p/gc.html", parent: "p/mid.html", pairedBy: "link" as const },
    ];
    const AS_OF = Date.UTC(2026, 9, 15, 8, 0);
    const worked = ["p/x.mdx", "p/m.html", "p/orph.html", "p/gc.html", "p/index.mdx", "p/mid.html"];
    const r = computeWorkFocus({
      sessions: worked.map((p, i) => {
        const at = AS_OF - (i + 1) * 3_600_000;
        return { id: `s${i}`, provider: "claude", title: `s${i}`, first: at, last: at + 60_000, bulk: false, text: { from: "prompt", paths: [], links: [], files: [] }, files: [{ p, edits: 5, firstMs: at, lastMs: at + 60_000 }] };
      }),
      pre: new Map(),
      sinceMs: AS_OF - 8 * 24 * 3_600_000,
      asOfMs: AS_OF,
      pages: fam.map(({ relPath, parent, pairedBy }) => ({ relPath, backlinks: 0, ...(parent ? { parent, pairedBy } : {}) })),
      identity: { roots: ["/w/kode"], names: ["kode"] },
      otherRoots: [],
    });
    // The three children are focus pages of their own; mid.html folds into top.
    expect(r.threads.map((t) => t.key).sort()).toEqual(["p/gc.html", "p/m.html", "p/orph.html", "p/top.mdx", "p/x.mdx"]);
    const e = build(
      fam.map(({ relPath, ...over }) => meta(relPath, over as Partial<WikiPageMeta>)),
      r.threads,
    );
    expect(e.relations.related).toEqual([
      ["p/x.mdx", "p/m.html"],
      ["p/x.mdx", "p/orph.html"],
      ["p/x.mdx", "p/gc.html"],
    ]);
  });

  test("owned issue: the unique owner and every focus page naming the key by a ref that counts", () => {
    const pages = [
      meta("p/owner.mdx", { owns: ["ABC-1"] }),
      meta("p/stamped.mdx", { jira: ["ABC-1"] }),
      meta("p/inferred.mdx", { issues: [{ tracker: "jira", key: "ABC-1", relations: ["title"] }] }),
      meta("p/linked.mdx", { issues: [{ tracker: "jira", key: "ABC-1", relations: ["link", "mention"] }] }),
    ];
    const focus = ["p/owner.mdx", "p/stamped.mdx", "p/inferred.mdx", "p/linked.mdx"];
    const e = build(pages, focus.map((p) => thread(p, [p])));
    expect(e.relations.issues).toEqual([
      ["ABC-1", "p/owner.mdx", "p/stamped.mdx"],
      ["ABC-1", "p/owner.mdx", "p/inferred.mdx"],
    ]);
    expect(e.relations.ambiguousIssues).toEqual([]);
  });

  test("two owners: no edge, reported as ambiguous; no owner: nothing", () => {
    const pages = [
      meta("p/o1.mdx", { owns: ["ABC-1"] }),
      meta("archive/o2.mdx", { owns: ["ABC-1"] }),
      meta("p/ref.mdx", { jira: ["ABC-1", "ABC-9"] }),
    ];
    const e = build(pages, [thread("p/o1.mdx", ["p/o1.mdx"]), thread("p/ref.mdx", ["p/ref.mdx"])]);
    expect(e.relations.issues).toEqual([]);
    expect(e.relations.ambiguousIssues).toEqual([{ key: "ABC-1", owners: ["archive/o2.mdx", "p/o1.mdx"] }]);
  });

  test("reserved and culled pages own nothing; an owner outside the focus set gives no edge", () => {
    const pages = [
      meta("plans/index.md", { name: "index", owns: ["ABC-1"] }),
      meta("p/retired.mdx", { owns: ["ABC-2"], culled: true }),
      meta("p/elsewhere.mdx", { owns: ["ABC-3"] }),
      meta("p/real.mdx", { owns: ["ABC-1", "ABC-2"] }),
      meta("p/ref.mdx", { jira: ["ABC-1", "ABC-2", "ABC-3"] }),
    ];
    const e = build(pages, [thread("p/real.mdx", ["p/real.mdx", "plans/index.md"]), thread("p/ref.mdx", ["p/ref.mdx"])]);
    expect(e.relations.issues).toEqual([
      ["ABC-1", "p/real.mdx", "p/ref.mdx"],
      ["ABC-2", "p/real.mdx", "p/ref.mdx"],
    ]);
    expect(e.relations.ambiguousIssues).toEqual([]);
  });
});

describe("completeness and bounds", () => {
  test("complete by default; the thread cut is reported apart, not as incompleteness", () => {
    const e = build([meta("p/a.mdx")], [thread("p/a.mdx", ["p/a.mdx"])], { candidates: 25 });
    expect(e.version).toBe(1);
    expect(e.threads).toEqual({ candidates: 25, shipped: 1 });
    expect(e.relations).toMatchObject({ complete: true, reasons: [] });
    expect(e.contributions).toMatchObject({ complete: true, reasons: [] });
  });

  test("a clipped ledger makes the contributions incomplete, not the relations", () => {
    const e = build([meta("p/a.mdx")], [thread("p/a.mdx", ["p/a.mdx"])], { ledgerTruncated: true });
    expect(e.contributions).toMatchObject({ complete: false, reasons: ["ledger-truncated"] });
    expect(e.relations.complete).toBe(true);
  });

  test("each bound cuts its list and says so", () => {
    const n = WORK_EVIDENCE_RELATIONS_MAX + 1;
    const focus = Array.from({ length: n + 1 }, (_, i) => `p/x${i}.mdx`);
    const pages = focus.map((p, i) => meta(p, i === 0 ? { related: focus.slice(1) } : {}));
    const rows: WorkContribution[] = Array.from({ length: WORK_EVIDENCE_CONTRIBUTIONS_MAX + 1 }, (_, i) => [
      `claude:s${i}`,
      "p/x0.mdx",
      "p/x0.mdx",
      "focus",
      1,
      i,
      i,
    ]);
    const e = build(pages, [thread("p/x0.mdx", focus)], { contributions: rows });
    expect(e.relations.related).toHaveLength(WORK_EVIDENCE_RELATIONS_MAX);
    expect(e.relations).toMatchObject({ complete: false, reasons: ["relations-cap"] });
    // One thread over the cap ships no row at all: a thread is never cut inside.
    expect(e.contributions.rows).toEqual([]);
    expect(e.contributions).toMatchObject({ complete: false, reasons: ["contributions-cap"], cut: ["p/x0.mdx"] });
  });
});

describe("fix round 1 batch 2 — lint check 14's reserved-page rule", () => {
  test("G: a reserved basename owns nothing, whatever its case or its folder", () => {
    const pages = [
      meta("projects/x/claude.md", { owns: ["ABC-1"] }),
      meta("p/Index.MDX", { owns: ["ABC-3"] }),
      meta("p/claude.md", { owns: ["K-2"] }),
      meta("p/c.md", { owns: ["K-2"] }),
      meta("p/ref.mdx", { jira: ["ABC-1", "ABC-3", "K-2"] }),
    ];
    const focus = ["projects/x/claude.md", "p/Index.MDX", "p/claude.md", "p/c.md", "p/ref.mdx"];
    const e = build(pages, focus.map((p) => thread(p, [p])));
    expect(e.relations.issues).toEqual([["K-2", "p/c.md", "p/ref.mdx"]]);
    expect(e.relations.ambiguousIssues).toEqual([]);
  });
});

describe("fix round 1 batch 3 — H: the contribution cap never cuts inside a thread", () => {
  const rowsFor = (key: string, sessions: number, pagesPer: number, at: number): WorkContribution[] =>
    Array.from({ length: sessions * pagesPer }, (_, i) => [
      `claude-code:${key}-s${Math.floor(i / pagesPer)}`,
      `${key}/p${i % pagesPer}.mdx`,
      `${key}/p0.mdx`,
      i % pagesPer === 0 ? "focus" : "touch",
      1,
      at - Math.floor(i / pagesPer),
      at - Math.floor(i / pagesPer),
    ]);

  test("a thread ships all of its rows or none, in thread order, and the cut threads are named", () => {
    // a: 995 rows; b: 10 (two sessions × 5 pages) does not fit after a; c: 3 does.
    const a = rowsFor("a", 199, 5, 3_000);
    const b = rowsFor("b", 2, 5, 2_000);
    const c = rowsFor("c", 1, 3, 1_000);
    const threads = [thread("a/p0.mdx", ["a/p0.mdx"]), thread("b/p0.mdx", ["b/p0.mdx"]), thread("c/p0.mdx", ["c/p0.mdx"])];
    const e = build(threads.map((t) => meta(t.key)), threads, { contributions: [...a, ...b, ...c] });
    expect(e.contributions.rows.length).toBeLessThanOrEqual(WORK_EVIDENCE_CONTRIBUTIONS_MAX);
    for (const [t, all] of [[threads[0]!, a], [threads[1]!, b], [threads[2]!, c]] as const) {
      const mine = e.contributions.rows.filter((r) => r[2] === t.key);
      expect(mine.length === 0 || mine.length === all.length).toBe(true);
    }
    expect(e.contributions.rows).toEqual([...a, ...c]);
    expect(e.contributions.cut).toEqual(["b/p0.mdx"]);
    expect(e.contributions).toMatchObject({ complete: false, reasons: ["contributions-cap"] });
  });

  test("a thread that lands exactly on the cap still ships", () => {
    const a = rowsFor("a", 199, 5, 3_000);
    const c = rowsFor("c", 1, 5, 1_000);
    const threads = [thread("a/p0.mdx", ["a/p0.mdx"]), thread("c/p0.mdx", ["c/p0.mdx"])];
    const e = build(threads.map((t) => meta(t.key)), threads, { contributions: [...a, ...c] });
    expect(e.contributions.rows.length).toBe(WORK_EVIDENCE_CONTRIBUTIONS_MAX);
    expect(e.contributions).toMatchObject({ complete: true, reasons: [], cut: [] });
  });

  test("under the cap nothing is cut", () => {
    const rows = rowsFor("a", 2, 2, 100);
    const e = build([meta("a/p0.mdx")], [thread("a/p0.mdx", ["a/p0.mdx"])], { contributions: rows });
    expect(e.contributions).toMatchObject({ complete: true, reasons: [], cut: [] });
    expect(e.contributions.rows).toEqual(rows);
  });
});
