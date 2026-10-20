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
import { aliasWorkedPaths } from "../../../wiki/store.ts";
import { aliasTopDirs, classifyAliasRef } from "../../../wiki/alias-ref.ts";
import { normalizeWorkedPath } from "../../../wiki/rel-path.ts";

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

  test("a session that only TOUCHED the split page is not the split's; the remainder keeps it by its focus elsewhere (fix round 1, batch 6)", () => {
    // s3 focused q.md and touched p.md: the server emits a touch row on T's focus page p.md.
    const f = fixture();
    const rows = [...f.rows, row("s3", "p.md", "k.md", NOW - 6 * H, "touch")];
    const b = applyWorkBoundaries({ work: work([f.T, f.U], rows), allPages: f.pages, splits: [{ id: "a1", page: "p.md" }], keptApart: [] });
    expect(ids(b.threads[1]!.thread)).toEqual(["s2", "s1"]);
    expect(ids(b.threads[0]!.thread)).toEqual(["s1", "s3"]);
  });

  test("a piece's touched pages are the source's pages its sessions touched, minus its own focus pages, both ways (fix round 1, batch 6)", () => {
    // s3 (remainder only) touched the split page p.md; s2 (split only) touched q.md, a page left;
    // s1 (both) touched q.md, the remainder's own page, which stays a focus page there.
    const f = fixture();
    const rows = [
      ...f.rows,
      row("s3", "p.md", "k.md", NOW - 6 * H, "touch"),
      row("s2", "q.md", "k.md", NOW - 2 * H, "touch"),
      row("s1", "q.md", "k.md", NOW - 4 * H, "touch"),
    ];
    const b = applyWorkBoundaries({ work: work([f.T, f.U], rows), allPages: f.pages, splits: [{ id: "a1", page: "p.md" }], keptApart: [] });
    const [rem, split] = b.threads;
    // Source order: its focus pages, then its touched pages.
    expect(rem!.thread.touched).toEqual(["p.md", "other.md"]);
    expect(split!.thread.touched).toEqual(["q.md", "ctx.md"]);
    // A touch on a page outside the source's pages is not the piece's.
    const stray = applyWorkBoundaries({
      work: work([f.T, f.U], [...f.rows, row("s2", "u.md", "k.md", NOW - 2 * H, "touch")]),
      allPages: f.pages,
      splits: [{ id: "a1", page: "p.md" }],
      keptApart: [],
    });
    expect(stray.threads[1]!.thread.touched).toEqual(["ctx.md"]);
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

  // Arch review 2026-10, findings 74 and 85.
  test("a wikilink-form alias resolves as the path it wraps (85)", () => {
    const f = fixture();
    const pages = [
      ...f.pages,
      page("plans/retry-plan-v2.md", { aliases: ["[[plans/retry-plan]]"] }),
      page("plans/b-v2.md", { aliases: ["[[plans/b|The B plan]]"] }),
      page("plans/c-v2.md", { aliases: [" [[plans/c#history]] "] }),
    ];
    const b = applyWorkBoundaries({
      work: f.work,
      allPages: pages,
      splits: [
        { id: "r", page: "plans/retry-plan.md" },
        { id: "b", page: "plans/b.md" },
        { id: "c", page: "plans/c.mdx" },
      ],
      keptApart: [],
    });
    expect(b.definitions.map((d) => [d.id, d.state, d.page])).toEqual([
      ["r", "dormant", "plans/retry-plan-v2.md"],
      ["b", "dormant", "plans/b-v2.md"],
      ["c", "dormant", "plans/c-v2.md"],
    ]);
  });

  test("a bare-stem alias matches only in the stored path's folder (74)", () => {
    const f = fixture();
    const elsewhere = [...f.pages, page("entities/andrej karpathy.md", { aliases: ["vibe coding"] })];
    const gone = applyWorkBoundaries({ work: f.work, allPages: elsewhere, splits: [{ id: "v", page: "concepts/vibe coding.md" }], keptApart: ["concepts/vibe coding.md"] });
    expect(gone.definitions.map((d) => [d.id ?? d.stored, d.state, d.page])).toEqual([
      ["v", "missing", undefined],
      ["concepts/vibe coding.md", "missing", undefined],
    ]);
    // Scope guard: an unambiguous rename in the same folder is still followed.
    const sameFolder = [...elsewhere, page("concepts/vibe-coding.md", { aliases: ["Vibe coding"] })];
    const renamed = applyWorkBoundaries({ work: f.work, allPages: sameFolder, splits: [{ id: "v", page: "concepts/vibe coding.md" }], keptApart: [] });
    expect(renamed.definitions.map((d) => [d.state, d.page])).toEqual([["dormant", "concepts/vibe-coding.md"]]);
  });

  test("a path-shaped alias match wins over a stem match (85)", () => {
    const f = fixture();
    const pages = [...f.pages, page("plans/b.md", { aliases: ["plans/a"] }), page("plans/c.md", { aliases: ["a"] })];
    const b = applyWorkBoundaries({ work: f.work, allPages: pages, splits: [{ id: "a", page: "plans/a.md" }], keptApart: [] });
    expect(b.definitions.map((d) => [d.state, d.page])).toEqual([["dormant", "plans/b.md"]]);
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

// Arch review 2026-10, batch K fix round 1: findings A, F and G. The server
// (`aliasWorkedPaths`) and this resolver read an alias through one classifier.
describe("applyWorkBoundaries: an alias is read as the server reads it", () => {
  const resolveAll = (pages: WikiListing[], stored: string[]) =>
    applyWorkBoundaries({ work: fixture().work, allPages: pages, splits: stored.map((page, i) => ({ id: `s${i}`, page })), keptApart: [] })
      .definitions.map((d) => [d.page ?? d.state]);

  test("a root-level move spelled with its extension resolves, plain or wikilink (A)", () => {
    const f = fixture();
    for (const alias of ["old-plan.md", "[[old-plan.md]]"]) {
      const pages = [...f.pages, page("plans/new.md", { aliases: [alias] })];
      expect(resolveAll(pages, ["old-plan.md"])).toEqual([["plans/new.md"]]);
    }
  });

  test("a plain title alias keeps its # and |: its first word names nothing (F)", () => {
    const f = fixture();
    const pages = [...f.pages, page("sources/the single instruction method.md", { aliases: ["The #1 Mistake That Makes Children Disrespectful", "A | B"] })];
    expect(resolveAll(pages, ["sources/The.md", "sources/A .md", "sources/The #1 Mistake That Makes Children Disrespectful.md"])).toEqual([
      ["missing"],
      ["missing"],
      ["sources/the single instruction method.md"],
    ]);
  });

  test("a / title whose first segment is no folder of the listing names nothing, as a path or a stem (G)", () => {
    const f = fixture();
    const pages = [...f.pages, page("concepts/x.md", { aliases: ["/goal", "openai/math Repository", "ω ≤ 9/4", "/ultrareview"] })];
    expect(resolveAll(pages, ["/goal.md", "openai/math Repository.md", "ω ≤ 9/4.md", "concepts/goal.md", "concepts/4.md", "/ultrareview.md"])).toEqual(
      Array.from({ length: 6 }, () => ["missing"]),
    );
  });

  test("the server and the resolver agree on every alias and spelling: a stored path resolves to the alias's page iff the server folds it, or the same-folder stem rule names it", () => {
    const NFD = "cafe\u0301";
    const aliases = [
      "old-plan.md", "[[old-plan.md]]", "Old.MDX", "x.html", "plans/old", "[[plans/old|label]]", "[[plans/c#history]]",
      "Plans/Mixed", "plans/a#b", "plans/a|b", "archive/z.md", "/goal", "openai/math Repository", "ω ≤ 9/4",
      "The #1 Mistake", "claude.ai/design", "openai/x.md",
      // Path spellings `normalizeWorkedPath` folds and a bare lower-case fold does not (fix round 2, finding 1).
      "plans//old", "plans/./old", "plans/x/../old", "x/../plans/old", "plans/old/..", `plans/${NFD}`, "plans/café", "Plans\\Old",
      `${NFD}s/old`, "cafés/old", NFD, "café", "owner-was", "entities/./gone",
    ];
    const f = fixture();
    const base = [...f.pages, page("plans/live.md"), page("archive/live.md"), page(`${NFD}s/live.md`)];
    const pages0 = [...base, page("entities/owner.md")];
    // Derived as production derives it: the resolver's own folders, which on
    // the server are `aliasTopDirs` over a root holding exactly these pages.
    const topDirs = aliasTopDirs(pages0.map((p) => p.relPath).filter((r) => r.includes("/")).map((r) => r.slice(0, r.indexOf("/"))));
    const live = new Set(pages0.map((p) => normalizeWorkedPath(p.relPath)));
    const spellings = (v: string) => {
      const out = [v, v.normalize("NFC"), v.normalize("NFD"), v.toUpperCase(), `/${v}`, v.replace(/\//g, "//"), v.replace(/\//, "/./"), v.replace(/\//, "/x/../")];
      return out.filter((c) => c && !c.startsWith("[["));
    };
    let checked = 0;
    for (const alias of aliases) {
      const pages = [...base, page("entities/owner.md", { aliases: [alias] })];
      const folded = new Set(aliasWorkedPaths(alias, topDirs));
      const ref = classifyAliasRef(alias, topDirs);
      const plain = alias.replace(/^\[\[|\]\]$/g, "");
      const cut = plain.split("|")[0]!.split("#")[0]!;
      const roots = new Set<string>();
      for (const v of [alias, plain, cut, ...folded]) for (const ext of ["", ".md", ".mdx", ".html"]) roots.add(`${v}${ext}`);
      // Same-folder candidates: the owner's folder, where a bare stem names it.
      if (ref.kind === "stem") for (const ext of ["", ".md", ".mdx"]) roots.add(`entities/${ref.stem}${ext}`);
      const candidates = new Set([...roots].flatMap(spellings));
      for (const c of candidates) {
        const n = normalizeWorkedPath(c);
        if (!n || live.has(n)) continue;
        const stemNamed = ref.kind === "stem" && n.replace(/\.mdx?$/, "") === normalizeWorkedPath(`entities/${ref.stem}`);
        const d = applyWorkBoundaries({ work: f.work, allPages: pages, splits: [{ id: "x", page: c }], keptApart: [] }).definitions[0]!;
        expect([alias, c, d.page === "entities/owner.md"]).toEqual([alias, c, folded.has(n) || stemNamed]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
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
