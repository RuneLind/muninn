/**
 * The reader's boundaries applied to the server's threads
 * (`wiki-work-boundaries.ts`; plan `muninn-wiki-work-thread-grouping`, D5,
 * D15): exact session attribution from the contribution rows, the remainder
 * recomputed (key, sessions, a bridge, a hub), kept-apart anchors over the
 * threads after the splits, and every way a stored definition can fail to
 * apply. Synthetic threads only.
 */

import { describe, expect, test } from "bun:test";
import { applyWorkBoundaries, rowBoundaryAction } from "./wiki-work-boundaries.ts";
import type { WikiListing } from "./wiki-filter.ts";
import { WORK_EVIDENCE_VERSION, type IndexWork, type WorkContribution, type WorkThread } from "../../../wiki/work-focus.ts";

const NOW = Date.UTC(2026, 9, 17, 20, 0);
const H = 3_600_000;

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
const ref = (id: string) => `claude-code:${id}`;
/** A focus (or touch) row: session, page, thread, first. */
const row = (id: string, p: string, thread: string, first: number, kind: "focus" | "touch" = "focus"): WorkContribution => [ref(id), p, thread, kind, 2, first, first + H];

function work(threads: WorkThread[], rows: WorkContribution[], o: { cut?: string[]; reasons?: ("contributions-cap" | "ledger-truncated")[] } = {}): IndexWork {
  const reasons = o.reasons ?? [];
  return {
    asOfMs: NOW,
    sinceMs: NOW - 8 * 24 * H,
    threads,
    evidence: {
      version: WORK_EVIDENCE_VERSION,
      threads: { candidates: threads.length, shipped: threads.length },
      relations: { complete: true, reasons: [], series: {}, projects: {}, related: [], issues: [], ambiguousIssues: [], relatedSkipped: { skipped: 0, ambiguous: 0 } },
      contributions: { complete: !reasons.length, reasons, cut: o.cut ?? [], rows },
    },
  };
}

/**
 * T: k.md (key, s1 first at t-9h), p.md (s1, s2), q.md (s3), touched ctx.md
 * (by s2) and other.md (by s3). U: u.md (s4). s1 focused k and p, so it
 * belongs to both halves of a split of p.
 */
function fixture() {
  const pages = [page("k.md", { focusMs: NOW - 8 * H }), page("p.md", { focusMs: NOW - 1 * H }), page("q.md", { focusMs: NOW - 5 * H }), page("u.md"), page("ctx.md"), page("other.md")];
  const T: WorkThread = { key: "k.md", pages: ["p.md", "k.md", "q.md"], touched: ["ctx.md", "other.md"], sessions: [sess("s2", NOW - H), sess("s1", NOW - 3 * H), sess("s3", NOW - 5 * H)] };
  const U: WorkThread = { key: "u.md", pages: ["u.md"], touched: [], sessions: [sess("s4", NOW - 2 * H)] };
  const rows = [
    row("s1", "k.md", "k.md", NOW - 9 * H),
    row("s1", "p.md", "k.md", NOW - 4 * H),
    row("s2", "p.md", "k.md", NOW - 2 * H),
    row("s2", "ctx.md", "k.md", NOW - 2 * H, "touch"),
    row("s3", "q.md", "k.md", NOW - 6 * H),
    row("s3", "other.md", "k.md", NOW - 6 * H, "touch"),
    row("s4", "u.md", "u.md", NOW - 3 * H),
  ];
  return { pages, T, U, rows, work: work([T, U], rows) };
}

const ids = (t: WorkThread) => t.sessions.map((s) => s.id);

describe("applyWorkBoundaries: splits (D5, D15)", () => {
  test("no definition: the server's threads, untouched", () => {
    const f = fixture();
    const b = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: [], keptApart: [] });
    expect(b.derived).toEqual([f.T, f.U]);
    expect(b.units.every((u) => !u.isolated && u.sub === 0)).toBe(true);
    expect(b.definitions).toEqual([]);
  });

  test("a split page has exactly the sessions that focused it there; a session that focused both pages is in both", () => {
    const f = fixture();
    const b = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: [{ id: "a1", page: "p.md" }], keptApart: [] });
    const [rem, split, u] = b.threads;
    expect(split!.split).toEqual({ id: "a1", page: "p.md" });
    expect(split!.thread).toEqual({ key: "p.md", pages: ["p.md"], touched: ["ctx.md"], sessions: [sess("s2", NOW - H), sess("s1", NOW - 3 * H)] });
    // The remainder: recomputed from the rows on the pages left.
    expect(rem!.remainder).toBe(true);
    expect(rem!.thread.key).toBe("k.md");
    expect(rem!.thread.pages).toEqual(["k.md", "q.md"]);
    expect(ids(rem!.thread)).toEqual(["s1", "s3"]);
    expect(rem!.thread.touched).toEqual(["other.md"]);
    // The split follows its source: same rank thread, sub 1; U is untouched.
    expect(b.units.map((x) => [x.key, x.index, x.sub, x.isolated, x.rank.key === "k.md"])).toEqual([
      ["k.md", 0, 0, false, true],
      ["p.md", 0, 1, true, true],
      ["u.md", 1, 0, false, false],
    ]);
    expect(u!.thread).toEqual(f.U);
    expect(b.definitions).toEqual([{ kind: "split", id: "a1", stored: "p.md", page: "p.md", state: "active" }]);
  });

  test("the remainder's key follows the server's rule when the split page was the key: the earliest focus left", () => {
    const f = fixture();
    const b = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: [{ id: "a1", page: "k.md" }], keptApart: [] });
    // q.md's earliest focus (t-6h) is before p.md's (t-4h).
    expect(b.threads[0]!.thread.key).toBe("q.md");
    expect(b.threads[1]!.thread).toMatchObject({ key: "k.md", pages: ["k.md"] });
    expect(ids(b.threads[1]!.thread)).toEqual(["s1"]);
  });

  test("a remainder whose bridge left stays ONE thread", () => {
    // s1 focused a and bridge, s2 focused bridge and c: the server joined them through `bridge`.
    const pages = [page("a.md"), page("bridge.md"), page("c.md")];
    const T: WorkThread = { key: "a.md", pages: ["bridge.md", "a.md", "c.md"], touched: [], sessions: [sess("s2", NOW - H), sess("s1", NOW - 2 * H)] };
    const rows = [row("s1", "a.md", "a.md", NOW - 5 * H), row("s1", "bridge.md", "a.md", NOW - 4 * H), row("s2", "bridge.md", "a.md", NOW - 3 * H), row("s2", "c.md", "a.md", NOW - 2 * H)];
    const b = applyWorkBoundaries({ work: work([T], rows), allPages: pages, splits: [{ id: "b1", page: "bridge.md" }], keptApart: [] });
    expect(b.threads.map((x) => x.thread.pages)).toEqual([["a.md", "c.md"], ["bridge.md"]]);
    expect(ids(b.threads[0]!.thread)).toEqual(["s2", "s1"]);
  });

  test("a hub splits off with only the sessions whose focus on it this thread kept (a demoted focus is a touch row)", () => {
    const pages = [page("a.md"), page("hub.md", { backlinks: 40 }), page("z.md")];
    const T: WorkThread = { key: "a.md", pages: ["a.md", "hub.md"], touched: [], sessions: [sess("s1", NOW - H), sess("s2", NOW - 2 * H)] };
    const Z: WorkThread = { key: "z.md", pages: ["z.md"], touched: ["hub.md"], sessions: [sess("s9", NOW - H)] };
    const rows = [
      row("s1", "a.md", "a.md", NOW - 5 * H),
      row("s1", "hub.md", "a.md", NOW - 5 * H),
      row("s2", "a.md", "a.md", NOW - 4 * H),
      row("s9", "z.md", "z.md", NOW - 4 * H),
      row("s9", "hub.md", "z.md", NOW - 4 * H, "touch"),
    ];
    const b = applyWorkBoundaries({ work: work([T, Z], rows), allPages: pages, splits: [{ id: "h", page: "hub.md" }], keptApart: [] });
    expect(ids(b.threads[1]!.thread)).toEqual(["s1"]);
    expect(b.threads[1]!.thread.pages).toEqual(["hub.md"]);
    // The thread that only touched it is untouched.
    expect(b.threads[2]!.thread).toEqual(Z);
  });

  test("splitting the last page: the emptied source disappears and the page keeps the source's sessions that focused it", () => {
    const f = fixture();
    const b = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: [{ id: "u", page: "u.md" }], keptApart: [] });
    expect(b.threads.map((x) => [x.thread.key, x.sub, !!x.remainder, !!x.split])).toEqual([
      ["k.md", 0, false, false],
      ["u.md", 1, false, true],
    ]);
    expect(ids(b.threads[1]!.thread)).toEqual(["s4"]);
  });

  test("two splits of one thread: each its own thread, in the source's page order; the remainder keeps the rest", () => {
    const f = fixture();
    const b = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: [{ id: "q", page: "q.md" }, { id: "p", page: "p.md" }], keptApart: [] });
    expect(b.threads.slice(0, 3).map((x) => [x.thread.key, x.sub])).toEqual([["k.md", 0], ["p.md", 1], ["q.md", 2]]);
    expect(ids(b.threads[0]!.thread)).toEqual(["s1"]);
  });
});

describe("applyWorkBoundaries: definitions that do not apply", () => {
  test("dormant (no thread holds the page), missing, an alias that names one page, an ambiguous alias", () => {
    const f = fixture();
    const pages = [...f.pages, page("old.md"), page("plans/renamed.md", { aliases: ["plans/gone"] }), page("x1.md", { aliases: ["twice"] }), page("x2.md", { aliases: ["Twice"] })];
    const b = applyWorkBoundaries({
      work: f.work,
      allPages: pages,
      splits: [
        { id: "d", page: "old.md" },
        { id: "m", page: "nowhere.md" },
        { id: "r", page: "plans/gone.md" },
        { id: "a", page: "twice.md" },
      ],
      keptApart: ["nowhere-else.md"],
    });
    expect(b.definitions.map((d) => [d.id ?? d.stored, d.state, d.page])).toEqual([
      ["d", "dormant", "old.md"],
      ["m", "missing", undefined],
      // The alias resolves; the renamed page is in no thread, so it is dormant there.
      ["r", "dormant", "plans/renamed.md"],
      ["a", "ambiguous", undefined],
      ["nowhere-else.md", "missing", undefined],
    ]);
    expect(b.derived).toEqual([f.T, f.U]);
  });

  test("an alias that names a page a thread holds applies the split there", () => {
    const f = fixture();
    const pages = f.pages.map((p) => (p.relPath === "p.md" ? { ...p, aliases: ["was-p"] } : p));
    const b = applyWorkBoundaries({ work: f.work, allPages: pages, splits: [{ id: "a1", page: "was-p.md" }], keptApart: [] });
    expect(b.threads[1]!.split).toEqual({ id: "a1", page: "p.md" });
  });

  test("two definitions that land on one page are a conflict: neither applies, both are reported", () => {
    const f = fixture();
    const pages = f.pages.map((p) => (p.relPath === "p.md" ? { ...p, aliases: ["was-p"] } : p));
    const b = applyWorkBoundaries({ work: f.work, allPages: pages, splits: [{ id: "a1", page: "p.md" }, { id: "a2", page: "was-p.md" }], keptApart: [] });
    expect(b.definitions.map((d) => d.state)).toEqual(["conflict", "conflict"]);
    expect(b.derived).toEqual([f.T, f.U]);
  });

  test("contributions incomplete for the thread (or a ledger cut) holds the split; no focus row on the page leaves it unattributed", () => {
    const f = fixture();
    const cut = applyWorkBoundaries({ work: work([f.T, f.U], f.rows.filter((r) => r[2] !== "k.md"), { cut: ["k.md"], reasons: ["contributions-cap"] }), allPages: f.pages, splits: [{ id: "a1", page: "p.md" }], keptApart: [] });
    expect(cut.definitions[0]).toMatchObject({ state: "incomplete", reasons: ["contributions-cap"] });
    const trunc = applyWorkBoundaries({ work: work([f.T, f.U], f.rows, { reasons: ["ledger-truncated"] }), allPages: f.pages, splits: [{ id: "a1", page: "u.md" }], keptApart: [] });
    expect(trunc.definitions[0]).toMatchObject({ state: "incomplete", reasons: ["ledger-truncated"] });
    const none = applyWorkBoundaries({ work: work([f.T, f.U], f.rows.filter((r) => r[1] !== "q.md")), allPages: f.pages, splits: [{ id: "a1", page: "q.md" }], keptApart: [] });
    expect(none.definitions[0]!.state).toBe("unattributed");
    expect(none.derived).toEqual([f.T, f.U]);
  });
});

describe("applyWorkBoundaries: kept apart, after the splits", () => {
  test("an anchor isolates the thread holding it and re-anchors on its newest focus page", () => {
    const f = fixture();
    const b = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: [], keptApart: ["k.md"] });
    expect(b.threads[0]!.keptApart).toEqual(["k.md"]);
    expect(b.units[0]!.isolated).toBe(true);
    // p.md is T's newest focus page.
    expect(b.reanchor).toEqual([["k.md", "p.md"]]);
  });

  test("a split that takes the kept-apart anchor: the split page is isolated, the remainder groups again, the anchor stays", () => {
    const f = fixture();
    const b = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: [{ id: "a1", page: "p.md" }], keptApart: ["p.md"] });
    expect(b.threads[1]!.keptApart).toEqual(["p.md"]);
    expect(b.threads[0]!.keptApart).toBeUndefined();
    expect(b.units[0]!.isolated).toBe(false);
    expect(b.reanchor).toEqual([]);
  });

  test("a split page that becomes its source's newest never pulls the remainder's anchor onto it", () => {
    const f = fixture();
    // p.md is newest; split it, keep the remainder apart by q.md: the remainder's newest is k? no — q (t-5h) vs k (t-8h).
    const b = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: [{ id: "a1", page: "p.md" }], keptApart: ["k.md"] });
    expect(b.threads[0]!.keptApart).toEqual(["k.md"]);
    expect(b.reanchor).toEqual([["k.md", "q.md"]]);
  });

  test("two anchors on one thread keep it apart once and both move to its newest page", () => {
    const f = fixture();
    const b = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: [], keptApart: ["k.md", "q.md"] });
    expect(b.units.filter((u) => u.isolated).map((u) => u.key)).toEqual(["k.md"]);
    expect(b.reanchor).toEqual([["k.md", "p.md"], ["q.md", "p.md"]]);
    expect(b.definitions.map((d) => d.state)).toEqual(["active", "active"]);
  });
});

describe("rowBoundaryAction", () => {
  test("Make own thread, Return to its thread, and why not", () => {
    const f = fixture();
    const none = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: [], keptApart: [] });
    expect(rowBoundaryAction(none, f.work, "q.md")).toEqual({ kind: "split", available: true });
    expect(rowBoundaryAction(none, f.work, "ctx.md")).toBeNull();
    const split = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: [{ id: "a1", page: "p.md" }], keptApart: [] });
    expect(rowBoundaryAction(split, f.work, "P.md")).toEqual({ kind: "return", id: "a1" });
    const cutWork = work([f.T, f.U], f.rows.filter((r) => r[2] !== "k.md"), { cut: ["k.md"], reasons: ["contributions-cap"] });
    const cut = applyWorkBoundaries({ work: cutWork, allPages: f.pages, splits: [], keptApart: [] });
    expect(rowBoundaryAction(cut, cutWork, "q.md")).toEqual({ kind: "split", available: false, reason: "contributions-cap" });
    expect(rowBoundaryAction(cut, cutWork, "u.md")).toEqual({ kind: "split", available: true });
    const noRow = work([f.T, f.U], f.rows.filter((r) => r[1] !== "q.md"));
    expect(rowBoundaryAction(applyWorkBoundaries({ work: noRow, allPages: f.pages, splits: [], keptApart: [] }), noRow, "q.md")).toEqual({
      kind: "split",
      available: false,
      reason: "unattributed",
    });
  });

  test("at 100 splits Make own thread is disabled with the full reason (fix round 1, batch 3)", () => {
    const f = fixture();
    const gone = Array.from({ length: 100 }, (_, i) => ({ id: `g${i}`, page: `gone/${i}.md` }));
    const full = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: gone, keptApart: [] });
    expect(rowBoundaryAction(full, f.work, "q.md")).toEqual({ kind: "split", available: false, reason: "full" });
    // A split page still offers Return, and one split fewer offers Make own thread again.
    const split = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: [...gone.slice(0, 99), { id: "a1", page: "p.md" }], keptApart: [] });
    expect(rowBoundaryAction(split, f.work, "p.md")).toEqual({ kind: "return", id: "a1" });
    const room = applyWorkBoundaries({ work: f.work, allPages: f.pages, splits: gone.slice(0, 99), keptApart: [] });
    expect(rowBoundaryAction(room, f.work, "q.md")).toEqual({ kind: "split", available: true });
  });

  test("a page two split definitions land on (a conflict) offers Make own thread disabled, pointing at the repair area", () => {
    // The click would send `addSplit` for a page the record already holds: nothing would change.
    const f = fixture();
    const pages = f.pages.map((p) => (p.relPath === "p.md" ? { ...p, aliases: ["was-p"] } : p));
    const b = applyWorkBoundaries({ work: f.work, allPages: pages, splits: [{ id: "x", page: "was-p.md" }, { id: "y", page: "p.md" }], keptApart: [] });
    expect(b.definitions.map((d) => d.state)).toEqual(["conflict", "conflict"]);
    expect(rowBoundaryAction(b, f.work, "p.md")).toEqual({ kind: "split", available: false, reason: "conflict" });
    // The thread's other pages are not in the conflict.
    expect(rowBoundaryAction(b, f.work, "q.md")).toEqual({ kind: "split", available: true });
  });
});
