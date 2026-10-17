/**
 * The work-thread grouping preference parser (`wiki-work-group-prefs.ts`).
 */

import { describe, expect, test } from "bun:test";
import {
  parseWorkGroupPrefs,
  resolveWorkGroupPrefs,
  WORK_GROUP_KEPT_APART_MAX,
  WORK_GROUP_SPLITS_MAX,
  type WorkGroupEvidenceToggles,
} from "./wiki-work-group-prefs.ts";

const ALL: WorkGroupEvidenceToggles = { series: true, related: true, issue: true };
const NONE: WorkGroupEvidenceToggles = { series: false, related: false, issue: false };
const D1 = { stop: "related", evidence: ALL, splits: [], keptApart: [] };

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

  test("no record of a supported version means D1: Related with every box checked", () => {
    for (const raw of [null, undefined, "", "{", 42, [], { ...valid, version: 2 }, { ...valid, version: "1" }]) {
      expect(parseWorkGroupPrefs(raw)).toBeNull();
      expect(resolveWorkGroupPrefs(parseWorkGroupPrefs(raw))).toEqual(D1 as never);
    }
  });

  test("an invalid field falls back to its own default and keeps the valid ones, false included", () => {
    const saved = { version: 1, stop: "sessions", evidence: NONE, splits: [{ id: "a", page: "a.md" }], keptApart: ["k.md"] };
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ ...saved, splits: "x" }, { splits: [] }],
      [{ ...saved, splits: null }, { splits: [] }],
      [{ ...saved, keptApart: { a: 1 } }, { keptApart: [] }],
      [{ ...saved, keptApart: null }, { keptApart: [] }],
      [{ ...saved, stop: "everything" }, { stop: "related" }],
      [{ ...saved, stop: undefined }, { stop: "related" }],
      [{ ...saved, evidence: { series: false, related: false } }, { evidence: { ...NONE, issue: true } }],
      [{ ...saved, evidence: { ...NONE, related: "no" } }, { evidence: { ...NONE, related: true } }],
      [{ ...saved, evidence: "none" }, { evidence: ALL }],
      [{ version: 1 }, { stop: "related", evidence: ALL, splits: [], keptApart: [] }],
    ];
    for (const [raw, changed] of cases) {
      const want = { stop: "sessions", evidence: NONE, splits: [{ id: "a", page: "a.md" }], keptApart: ["k.md"], ...changed };
      expect(resolveWorkGroupPrefs(parseWorkGroupPrefs(raw))).toEqual(want as never);
    }
  });

  test("an empty selection is a valid record, not a reason for defaults", () => {
    const p = parseWorkGroupPrefs({ version: 1, stop: "related", evidence: NONE })!;
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
