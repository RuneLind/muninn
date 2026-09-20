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

  test("the other statuses keep their own tone, and an unknown one falls back", () => {
    expect(groupChipTone(["rejected", "rejected"])).toBe("rejected");
    expect(groupChipTone(["approved", "applied"])).toBe("approved");
    expect(groupChipTone(["error", "applied"])).toBe("error");
    expect(groupChipTone(["something-new"])).toBe("something-new");
    expect(groupChipTone([])).toBe("draft");
  });
});
