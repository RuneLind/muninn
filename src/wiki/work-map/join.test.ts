import { describe, expect, test } from "bun:test";
import { joinWorkMap } from "./join.ts";
import { WORK_MAP_VERSION, type WorkMap } from "./schema.ts";

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

function prose(j: ReturnType<typeof joinWorkMap>): string[] {
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
