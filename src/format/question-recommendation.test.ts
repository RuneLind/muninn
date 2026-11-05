import { describe, expect, test } from "bun:test";
import { parseRecommendation } from "./question.ts";

describe("parseRecommendation", () => {
  const choices = ["A", "B", "Not now"];
  test.each([
    ["**Recommendation: A.** Because.", "A"],
    ["**Recommendation:** B, since it is cheap.", "B"],
    ["**Recommendation**: A", "A"],
    ["**Anbefaling: B** fordi.", "B"],
    ["**Anbefaling:** A — billigst.", "A"],
    ["**Anbefaling**: b", "B"],
    ["Text first.\n\n**Recommendation:** `A` as written.", "A"],
    ["**Recommendation:** **B**", "B"],
    ["**Recommendation: not now**, wake on load.", "Not now"],
  ])("%s", (body, want) => {
    expect(parseRecommendation(body, choices)).toBe(want);
  });

  test.each([
    ["no marker", "Which one? A or B."],
    ["a marker with no colon", "**Anbefaling fra arkitekten:** A"],
    ["a longer word", "**Anbefalt:** A"],
    ["prose before the choice", "**Recommendation:** take A"],
    ["a choice as a word's start", "**Recommendation:** Always"],
    ["a marker in a code span", "`**Recommendation: A`"],
  ])("null: %s", (_why, body) => {
    expect(parseRecommendation(body, choices)).toBeNull();
  });

  test("no choices, no recommendation; the longest choice wins", () => {
    expect(parseRecommendation("**Recommendation: A**", [])).toBeNull();
    expect(parseRecommendation("**Recommendation: Not now**", ["Not", "Not now"])).toBe("Not now");
  });
});
