import { describe, expect, test } from "bun:test";
import { parseStatePhrases } from "./state-phrases.ts";

describe("parseStatePhrases", () => {
  test("absent or null is off with no warning; a good block parses, trimmed and deduplicated", () => {
    expect(parseStatePhrases(undefined)).toEqual({ config: null, warnings: [] });
    expect(parseStatePhrases(null)).toEqual({ config: null, warnings: [] });
    const r = parseStatePhrases({ phrases: [" merged ", "Merged", "in prod"], taskWords: ["PR"] });
    expect(r.config).toEqual({ phrases: ["merged", "in prod"], taskWords: ["PR"] });
    expect(r.warnings).toEqual([]);
  });

  test("a malformed block is off with a warning; a bad entry or taskWords drops alone", () => {
    for (const bad of [[], "merged", { phrases: "merged" }, { phrases: [] }, { phrases: [3, ""] }]) {
      const r = parseStatePhrases(bad);
      expect(r.config).toBeNull();
      expect(r.warnings.length).toBeGreaterThan(0);
    }
    const r = parseStatePhrases({ phrases: ["merged", 7], taskWords: "PR", extra: 1 });
    expect(r.config).toEqual({ phrases: ["merged"], taskWords: [] });
    expect(r.warnings).toHaveLength(3);
  });
});
