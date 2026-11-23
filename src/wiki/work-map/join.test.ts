import { describe, expect, test } from "bun:test";
import { declarationKey, joinWorkMap, type JoinablePage, type JoinedWorkMap } from "./join.ts";
import { WORK_MAP_VERSION, type WorkMap } from "./schema.ts";
import { readMapFile } from "./map-file.ts";
import { fixtureTheme, fixtureThemeMap, fixtureThemePages, THEME_RUN_AT } from "../../test/theme-map-fixture.ts";

/** Every prose field the map carries cites `m` once. */
function mapCiting(m: string, pages: string[]): WorkMap {
  return {
    version: WORK_MAP_VERSION,
    wiki: "w",
    runAtMs: 1,
    model: "m",
    coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 1, threads: 0, logEntries: 0, digestChars: 0, warnings: [] },
    summary: `s ${m}`,
    needsYou: [{ title: `t ${m}`, kind: "decision", why: `w ${m}`, action: `a ${m}`, pages, effort: "e" }],
    themes: [],
    efforts: [
      {
        id: "e",
        name: "E",
        aliases: [],
        oneLine: `o ${m}`,
        state: "active",
        pages: pages.map((id) => ({ id, role: "plan" as const })),
        why: `y ${m}`,
        confidence: 1,
        next: `n ${m}`,
        related: [{ id: "f", why: `r ${m}` }],
        daily: [],
      },
    ],
    loose: [],
  };
}

function prose(j: JoinedWorkMap<JoinablePage>): string[] {
  const e = j.efforts[0]!;
  const n = j.needsYou[0]!;
  return [j.summary, n.title, n.why, n.action, e.oneLine, e.why, e.next, e.related[0]!.why];
}

describe("joinWorkMap prose markers", () => {
  test("an unchanged page keeps its marker, in the listing's spelling", () => {
    const j = joinWorkMap(mapCiting("⟦Plans/Alpha.mdx⟧", ["plans/alpha.mdx"]), [{ relPath: "plans/alpha.mdx" }]);
    expect(prose(j).map((s) => s.slice(2))).toEqual(Array(8).fill("⟦plans/alpha.mdx⟧"));
    expect(j.efforts[0]!.pages.map((p) => p.id)).toEqual(["plans/alpha.mdx"]);
  });

  test("a renamed page's marker becomes its old stem, in every prose field", () => {
    const j = joinWorkMap(mapCiting("⟦plans/alpha.mdx⟧", ["plans/alpha.mdx"]), [{ relPath: "plans/alpha-v2.mdx" }]);
    expect(prose(j).map((s) => s.slice(2))).toEqual(Array(8).fill("alpha"));
    expect(j.efforts[0]!.pages).toEqual([]);
  });

  test("a deleted page's marker becomes plain text; a live one beside it stays", () => {
    const j = joinWorkMap(mapCiting("⟦archive/gone.md⟧ after ⟦notes/kept.md⟧", ["notes/kept.md"]), [{ relPath: "notes/kept.md" }]);
    expect(prose(j).map((s) => s.slice(2))).toEqual(Array(8).fill("gone after ⟦notes/kept.md⟧"));
  });

  test("every gone marker is rewritten: two in a row, and one after a live marker", () => {
    const j = joinWorkMap(mapCiting("⟦archive/a.md⟧ ⟦archive/b.md⟧ ⟦notes/kept.md⟧ ⟦archive/c.md⟧", ["notes/kept.md"]), [{ relPath: "notes/kept.md" }]);
    expect(prose(j).map((s) => s.slice(2))).toEqual(Array(8).fill("a b ⟦notes/kept.md⟧ c"));
  });
});

describe("joinWorkMap effort ids", () => {
  test("a duplicate effort id keeps the first effort only", () => {
    const base = mapCiting("x", []);
    const e = base.efforts[0]!;
    const m = { ...base, efforts: [{ ...e, id: "a", name: "A1", parent: "b" }, { ...e, id: "a", name: "A2" }, { ...e, id: "b", name: "B1", parent: "a" }, { ...e, id: "b", name: "B2" }] };
    expect(joinWorkMap(m, []).efforts.map((x) => x.name)).toEqual(["A1", "B1"]);
  });
});

describe("declared pages join at once (P6)", () => {
  const RUN = Date.parse("2026-10-29T05:00:00Z");
  const HOUR = 3_600_000;
  const base = mapCiting("x", ["plans/a.mdx", "plans/b.mdx"]);
  const m: WorkMap = {
    ...base,
    runAtMs: RUN,
    efforts: [
      { ...base.efforts[0]!, pages: [{ id: "plans/a.mdx", role: "plan" }, { id: "plans/b.mdx", role: "report", derivedFrom: "plans/a.mdx" }] },
      { ...base.efforts[0]!, id: "f", name: "F", pages: [{ id: "plans/c.mdx", role: "plan" }] },
    ],
    retired: [{ id: "gone", name: "Gone", lastActive: 1 }],
    loose: ["blogs/loose.mdx"],
  };
  const old = { gitCreatedMs: RUN - 900 * HOUR, gitTouchedMs: RUN - 800 * HOUR };
  const listed = [{ relPath: "plans/a.mdx", ...old }, { relPath: "plans/b.mdx", ...old }, { relPath: "plans/c.mdx", ...old }, { relPath: "blogs/loose.mdx", ...old }];
  const ids = (j: ReturnType<typeof joinWorkMap>) => j.efforts.map((e) => e.pages.map((p) => p.id));

  test("a page declared after the run joins its effort first, with its folder's role and no derivedFrom", () => {
    const j = joinWorkMap(m, [
      ...listed,
      { relPath: "plans/new.mdx", effort: "f", gitDirty: true, mtimeMs: RUN + HOUR },
      { relPath: "archive/new-report.mdx", effort: "f", gitCreatedMs: RUN + 2 * HOUR, gitTouchedMs: RUN + 2 * HOUR },
    ]);
    // Newest first: the report (created run + 2 h) before the dirty plan (mtime run + 1 h).
    expect(j.efforts[1]!.pages.map((p) => [p.id, p.role, p.derivedFrom, p.joined])).toEqual([
      ["archive/new-report.mdx", "report", undefined, true],
      ["plans/new.mdx", "plan", undefined, true],
      ["plans/c.mdx", "plan", undefined, undefined],
    ]);
  });

  test("a declared page the map does not hold and older than the run is NOT joined", () => {
    const j = joinWorkMap(m, [...listed, { relPath: "plans/older.mdx", effort: "f", ...old, workedMs: RUN - HOUR }]);
    expect(ids(j)).toEqual([["plans/a.mdx", "plans/b.mdx"], ["plans/c.mdx"]]);
  });

  test("worked on after the run counts as newer; so does an untracked page's birthtime", () => {
    const j = joinWorkMap(m, [
      ...listed,
      { relPath: "plans/worked.mdx", effort: "f", ...old, workedMs: RUN + HOUR },
      { relPath: "notes/no-git.md", effort: "f", gitDirty: true, birthtimeMs: RUN + 3 * HOUR, mtimeMs: RUN + 3 * HOUR },
    ]);
    expect(ids(j)[1]).toEqual(["notes/no-git.md", "plans/worked.mdx", "plans/c.mdx"]);
  });

  test("a degraded git walk (no git dates on any page) never joins a clean page on its checkout mtime", () => {
    const pulled = { mtimeMs: RUN + HOUR, birthtimeMs: RUN + HOUR, gitDirty: false };
    const j = joinWorkMap(
      m,
      [
        ...listed.map((p) => ({ relPath: p.relPath, ...pulled })),
        { relPath: "plans/declared-1.mdx", effort: "f", ...pulled },
        { relPath: "notes/declared-2.md", effort: "e", mtimeMs: RUN + HOUR },
        { relPath: "notes/untracked.md", effort: "f", gitDirty: true, mtimeMs: RUN - HOUR },
      ],
      RUN + 2 * HOUR,
    );
    expect(ids(j)).toEqual([["plans/a.mdx", "plans/b.mdx"], ["notes/untracked.md", "plans/c.mdx"]]);
  });

  test("a declared page whose commit is dated in the future does not join", () => {
    const j = joinWorkMap(m, [...listed, { relPath: "plans/skewed.mdx", effort: "f", gitCreatedMs: RUN - 900 * HOUR, gitTouchedMs: RUN + 9000 * HOUR }], RUN + 2 * HOUR);
    expect(ids(j)[1]).toEqual(["plans/c.mdx"]);
  });

  test("newest first counts an uncommitted edit's time: a dirty old page edited at run + 5 h sorts before one committed at run + 1 h", () => {
    const j = joinWorkMap(
      m,
      [
        ...listed,
        { relPath: "plans/committed.mdx", effort: "f", gitCreatedMs: RUN + HOUR, gitTouchedMs: RUN + HOUR },
        { relPath: "plans/dirty-old.mdx", effort: "f", ...old, gitDirty: true, mtimeMs: RUN + 5 * HOUR },
      ],
      RUN + 6 * HOUR,
    );
    expect(ids(j)[1]).toEqual(["plans/dirty-old.mdx", "plans/committed.mdx", "plans/c.mdx"]);
  });

  test("newest first reads its future-date guard off `now`, anchored to the run", () => {
    const pair = (run: number) => [
      { relPath: "plans/one-hour.mdx", effort: "f", gitCreatedMs: run + HOUR, gitTouchedMs: run + HOUR },
      { relPath: "plans/three-hours.mdx", effort: "f", gitCreatedMs: run + 3 * HOUR, gitTouchedMs: run + 3 * HOUR },
    ];
    // A viewer clock 10 days behind the run still sorts post-run commits.
    expect(ids(joinWorkMap(m, [...listed, ...pair(RUN)], RUN - 240 * HOUR))[1]).toEqual(["plans/three-hours.mdx", "plans/one-hour.mdx", "plans/c.mdx"]);
  });

  test("a mapped page re-declared elsewhere moves, keeping its role, and is recorded as moved out; a loose one leaves loose", () => {
    const j = joinWorkMap(m, [
      { relPath: "plans/a.mdx", ...old },
      { relPath: "plans/b.mdx", effort: "f", ...old },
      { relPath: "plans/c.mdx", ...old },
      { relPath: "blogs/loose.mdx", effort: "e", ...old },
    ]);
    expect(j.efforts[0]!.pages.map((p) => p.id)).toEqual(["blogs/loose.mdx", "plans/a.mdx"]);
    expect(j.efforts[0]!.movedOut).toEqual([{ id: "plans/b.mdx", to: "f" }]);
    expect(j.efforts[1]!.pages.map((p) => [p.id, p.role, p.derivedFrom])).toEqual([
      ["plans/b.mdx", "report", undefined],
      ["plans/c.mdx", "plan", undefined],
    ]);
    expect(j.loose).toEqual([]);
  });

  test("a mapped page declaring a retired id leaves its effort and joins none; an unknown or invalid id moves nothing", () => {
    const j = joinWorkMap(m, [
      { relPath: "plans/a.mdx", effort: "gone", ...old },
      { relPath: "plans/b.mdx", effort: "nope", ...old },
      { relPath: "plans/c.mdx", effort: "Bad Id", ...old },
      { relPath: "blogs/loose.mdx", effort: "nope", ...old },
    ]);
    expect(ids(j)).toEqual([["plans/b.mdx"], ["plans/c.mdx"]]);
    expect(j.efforts[0]!.movedOut).toEqual([{ id: "plans/a.mdx", to: "gone" }]);
    expect(j.loose.map((p) => p.relPath)).toEqual(["blogs/loose.mdx"]);
  });

  test("a page declaring the effort it already sits in stays in place", () => {
    const j = joinWorkMap(m, [{ relPath: "plans/a.mdx", effort: "e", ...old }, { relPath: "plans/b.mdx", effort: "e", ...old }, { relPath: "plans/c.mdx", ...old }]);
    expect(j.efforts[0]!.pages.map((p) => [p.id, p.joined])).toEqual([["plans/a.mdx", undefined], ["plans/b.mdx", undefined]]);
    expect(j.efforts[0]!.pages[1]!.derivedFrom).toBe("plans/a.mdx");
  });
});

describe("declarationKey", () => {
  test("changes when a declaration appears, changes or becomes newer; not for undeclared pages", () => {
    const a = declarationKey([{ relPath: "x.md" }, { relPath: "y.md", effort: "e", gitTouchedMs: 1 }], 10);
    expect(declarationKey([{ relPath: "x.md", gitTouchedMs: 99 }, { relPath: "y.md", effort: "e", gitTouchedMs: 1 }], 10)).toBe(a);
    expect(declarationKey([{ relPath: "x.md", effort: "e" }, { relPath: "y.md", effort: "e", gitTouchedMs: 1 }], 10)).not.toBe(a);
    expect(declarationKey([{ relPath: "y.md", effort: "f", gitTouchedMs: 1 }], 10)).not.toBe(a);
    expect(declarationKey([{ relPath: "y.md", effort: "e", gitTouchedMs: 1, gitDirty: true }], 10)).not.toBe(a);
  });
});

describe("joinWorkMap on a themes map (theme map P2)", () => {
  const map = fixtureThemeMap();
  const pages = fixtureThemePages();

  test("the stored fixture parses as a themes map", () => {
    expect(readMapFile(JSON.stringify(map))?.kind).toBe("themes");
  });

  test("joins without why/next and keeps every theme field", () => {
    const j = joinWorkMap(map, pages);
    const a = j.efforts.find((e) => e.id === "alpha")!;
    expect("why" in a || "next" in a).toBe(false);
    expect(a.hubs).toEqual(["concepts/Hub X.md"]);
    expect(a.weekly).toEqual(map.efforts[0]!.weekly);
    expect(a.readFirst).toEqual(["sources/alpha-1.mdx"]);
    expect(a.domain).toBe("ai");
    expect(a.trend).toEqual({ recent: 4, earlier: 2 });
    expect(a.pages.map((p) => [p.id, p.role])).toEqual([["sources/alpha-1.mdx", "source"], ["sources/alpha-2.mdx", "source"]]);
    expect(j.needsYou[0]).toMatchObject({ kind: "drift", count: 12, hubs: ["concepts/Hub X.md"] });
    expect(j.coverage.activeSources).toBe(9);
    expect(j.kind).toBe("themes");
  });

  test("takeaway and disagreement get the marker rewrite: a page gone from the listing reads as its stem", () => {
    const j = joinWorkMap(fixtureThemeMap({ efforts: [fixtureTheme("t", { disagreement: "⟦sources/Gone.mdx⟧ disagrees" })] }), [{ relPath: "sources/t-1.mdx" }]);
    expect(j.efforts[0]!.takeaway).toBe("Takeaway for t, see ⟦sources/t-1.mdx⟧.");
    expect(j.efforts[0]!.disagreement).toBe("Gone disagrees");
  });

  test("a page declaring a theme joins it as a source", () => {
    const j = joinWorkMap(map, [...pages, { relPath: "plans/new.md", effort: "gamma", gitTouchedMs: THEME_RUN_AT + 60_000 }], THEME_RUN_AT + 120_000);
    expect(j.efforts.find((e) => e.id === "gamma")!.pages[0]).toMatchObject({ id: "plans/new.md", role: "source", joined: true });
  });
});
