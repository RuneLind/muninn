import { describe, expect, test } from "bun:test";
import { lensCss, newestFirstOrder } from "./wiki-lens.ts";

/** The rules of `lensCss()` that carry `needle`, one per line. */
function rulesWith(needle: string): string[] {
  return lensCss()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes(needle));
}

const LENSED = ".wiki-article:is(.lens-overview, .lens-all, .lens-agent)";

describe("newestFirstOrder", () => {
  test("reverses the decisions in their own slots and keeps every other item in place", () => {
    // d1 d2 d3 s0 d4 s1 → d4 d3 d2 s0 d1 s1
    expect(newestFirstOrder([true, true, true, false, true, false])).toEqual([4, 2, 1, 3, 0, 5]);
  });

  test("a list without decisions, or with one, keeps its order", () => {
    expect(newestFirstOrder([false, false])).toEqual([0, 1]);
    expect(newestFirstOrder([false, true, false])).toEqual([0, 1, 2]);
    expect(newestFirstOrder([])).toEqual([]);
  });
});

describe("lensCss: the compact lists are the same in every lens (D45)", () => {
  test("the five-cap, the date cell and the case line apply to an article in any lens", () => {
    expect(rulesWith(".dl-older").some((r) => r.startsWith(`${LENSED} .decision-log:not(.lens-show-all)`))).toBe(true);
    expect(rulesWith("> .dl-when {").some((r) => r.startsWith(`${LENSED} .dl-item.dl-decision`))).toBe(true);
    expect(rulesWith("> .cb-line").some((r) => r.startsWith(`${LENSED} .caseboard .cb-row > .cb-line`))).toBe(true);
    expect(rulesWith('data-status="ok"').some((r) => r.startsWith(LENSED))).toBe(true);
  });

  test("a decision's rest folds behind «mer» in any lens", () => {
    expect(rulesWith(".dl-rest").some((r) => r.startsWith(`${LENSED} .dl-item:not(.dl-expanded)`))).toBe(true);
  });

  test("no rule hides the reader's toggles outside Overview", () => {
    expect(rulesWith(":not(.lens-overview)").filter((r) => /dl-more|dl-all|cb-more|cb-okmore|dl-qstate/.test(r))).toEqual([]);
  });

  test("the compact parts stay scoped to an article the lens set up", () => {
    const art = rulesWith(".dl-when").concat(rulesWith(".cb-line"));
    expect(art.filter((r) => r.startsWith(".wiki-article ") && /display: (block|inline)/.test(r))).toEqual([]);
  });

  test("Overview alone hides the none rows and shows their count line", () => {
    expect(rulesWith('.cb-group[data-status="none"]').every((r) => r.startsWith(".wiki-article.lens-overview"))).toBe(true);
    expect(rulesWith(".cb-lens-note { display: none; }")).toEqual([".wiki-article:not(.lens-overview) .cb-lens-note { display: none; }"]);
  });
});
