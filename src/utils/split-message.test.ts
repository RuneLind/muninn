import { test, expect } from "bun:test";
import { splitMessage } from "./split-message.ts";

// The hard cut's whole state space (class check on #902): the cap (< 1, 1, >= 2)
// times the code unit at the cut (high surrogate or not). Every cell must end;
// a cap of 2 or more never leaves half an emoji.
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const inputs = ["abc", "😀", "a😀", "😀😀😀", "a😀b😀c", "x".repeat(10)];

for (const max of [1, 2, 3, 4096]) {
  test(`splitMessage at cap ${max}: non-empty chunks within the cap that join back to the input`, () => {
    for (const text of inputs) {
      const chunks = splitMessage(text, max);
      expect(chunks.join("")).toBe(text);
      for (const c of chunks) {
        expect(c.length).toBeGreaterThan(0);
        expect(c.length).toBeLessThanOrEqual(max);
        if (max >= 2) expect(c).not.toMatch(lone);
      }
    }
  });
}

test("splitMessage refuses a cap below 1 instead of looping forever", () => {
  for (const max of [0, -1, Number.NaN]) expect(() => splitMessage("abc", max)).toThrow(RangeError);
});
