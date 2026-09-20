import { test, expect, describe } from "bun:test";
import { groupStatusSummary, groupChipTone } from "./wiki-gardener-group.ts";

describe("groupStatusSummary", () => {
  test("counts each status once, in the rows' own order of first appearance", () => {
    expect(groupStatusSummary(["applied", "stale", "draft"])).toBe("1 applied · 1 stale · 1 draft");
    expect(groupStatusSummary(["applied", "applied", "stale"])).toBe("2 applied · 1 stale");
    expect(groupStatusSummary(["draft"])).toBe("1 draft");
  });
});

describe("groupChipTone", () => {
  // The chip renders a status SET, so its colour has to be a function of the set.
  // Read off `rows[0]` it said `applied` over a card that still held a draft and
  // a stale row — the exact claim the summary text exists to deny.
  test("a group still holding a draft reads as a DRAFT, whatever else it holds", () => {
    expect(groupChipTone(["draft", "draft"])).toBe("draft");
    expect(groupChipTone(["applied", "stale", "draft"])).toBe("draft");
    expect(groupChipTone(["applied", "draft"])).toBe("draft");
  });

  test("no draft left and a stale row reads as STALE — the card is not done", () => {
    expect(groupChipTone(["applied", "stale"])).toBe("stale");
    expect(groupChipTone(["stale", "applied", "applied"])).toBe("stale");
  });

  test("only `applied` reads as applied", () => {
    expect(groupChipTone(["applied", "applied", "applied"])).toBe("applied");
  });

  /**
   * The WHOLE order, both directions, over every one of the 15 pairs.
   *
   * The three cases above pin the two ends and `stale` over `applied`, which
   * leaves the six pairs among `approved`/`error`/`stale`/`rejected` free: a
   * mutation survey swapped two of them and every test stayed green. The order
   * is spelled HERE as a literal on purpose — importing `CHIP_TONE_ORDER` would
   * permute the expectation with the source and pin nothing.
   */
  const ORDER = ["draft", "approved", "error", "stale", "rejected", "applied"] as const;

  test("every pair of statuses resolves to the earlier one, in both input orders", () => {
    const outcomes: string[] = [];
    for (let hi = 0; hi < ORDER.length; hi += 1) {
      for (let lo = hi + 1; lo < ORDER.length; lo += 1) {
        const [a, b] = [ORDER[hi]!, ORDER[lo]!];
        outcomes.push(`${a}+${b}=${groupChipTone([a, b])}`, `${b}+${a}=${groupChipTone([b, a])}`);
      }
    }
    // Asserted as ONE list so a failure names the pair that moved.
    expect(outcomes).toEqual([
      "draft+approved=draft", "approved+draft=draft",
      "draft+error=draft", "error+draft=draft",
      "draft+stale=draft", "stale+draft=draft",
      "draft+rejected=draft", "rejected+draft=draft",
      "draft+applied=draft", "applied+draft=draft",
      "approved+error=approved", "error+approved=approved",
      "approved+stale=approved", "stale+approved=approved",
      "approved+rejected=approved", "rejected+approved=approved",
      "approved+applied=approved", "applied+approved=approved",
      "error+stale=error", "stale+error=error",
      "error+rejected=error", "rejected+error=error",
      "error+applied=error", "applied+error=error",
      "stale+rejected=stale", "rejected+stale=stale",
      "stale+applied=stale", "applied+stale=stale",
      "rejected+applied=rejected", "applied+rejected=rejected",
    ]);
  });

  test("the other statuses keep their own tone, and an unknown one falls back", () => {
    expect(groupChipTone(["rejected", "rejected"])).toBe("rejected");
    expect(groupChipTone(["approved", "applied"])).toBe("approved");
    expect(groupChipTone(["error", "applied"])).toBe("error");
    expect(groupChipTone(["something-new"])).toBe("something-new");
    expect(groupChipTone([])).toBe("draft");
  });
});
