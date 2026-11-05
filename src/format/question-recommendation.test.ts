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
    ["**Anbefaling**: B", "B"],
    ["Text first.\n\n**Recommendation:** `A` as written.", "A"],
    ["**Recommendation:** **B**", "B"],
    ["**Recommendation: Not now**, wake on load.", "Not now"],
    ["```\n**Recommendation: A**\n```\n\n**Recommendation:** B", "B"],
    ["```md\n**Anbefaling:** A\n```\n\n**Anbefaling:** B fordi.", "B"],
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
    ["a marker only in a fenced block", "```\n**Recommendation: A**\n```\n\nWhich one?"],
    ["an article is not a choice", "**Recommendation:** a small fix first"],
    ["a lower-case choice is prose", "**Anbefaling**: b"],
    ["a lower-case phrase is prose", "**Recommendation: not now**, wake on load."],
  ])("null: %s", (_why, body) => {
    expect(parseRecommendation(body, choices)).toBeNull();
  });

  test("a sentence opening on a choice's letters in another case names no choice", () => {
    expect(parseRecommendation("**Recommendation:** no reason to wait: Yes.", ["Yes", "No"])).toBeNull();
    expect(parseRecommendation("**Recommendation:** No, not yet.", ["Yes", "No"])).toBe("No");
  });

  test("an unclosed fence stays prose, as the reader shows it", () => {
    expect(parseRecommendation("```\n**Recommendation: A**", ["A", "B"])).toBe("A");
  });

  test("no choices, no recommendation; the longest choice wins", () => {
    expect(parseRecommendation("**Recommendation: A**", [])).toBeNull();
    expect(parseRecommendation("**Recommendation: Not now**", ["Not", "Not now"])).toBe("Not now");
  });
});
