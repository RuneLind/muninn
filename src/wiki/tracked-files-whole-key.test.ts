/**
 * The whole-key rule of `tracked-files.ts` (fix round 1 of Discuss v2 PR 6):
 * which neighbours continue a key, and `wholeKey` refused with a regex.
 * `mentions.test.ts` drives it through `buildMentions` on a real repo.
 */
import { describe, expect, test } from "bun:test";
import { grepTracked, wholeKeyCount } from "./tracked-files.ts";

describe("wholeKeyCount", () => {
  test("a Unicode letter or digit on either side continues the key; `_`, `-` and punctuation do not", () => {
    expect(wholeKeyCount("MEL-1 MEL-1,MEL-1.", "MEL-1")).toBe(3);
    expect(wholeKeyCount("MEL-1_x MEL-1-x (MEL-1)", "MEL-1")).toBe(3);
    for (const t of ["MEL-10", "XMEL-1", "MEL-1å", "æMEL-1", "MEL-1٣", "٣MEL-1"]) expect(wholeKeyCount(t, "MEL-1")).toBe(0);
    expect(wholeKeyCount("a.b(c)", "a.b(c)")).toBe(1);
  });

  test("grepTracked refuses wholeKey with a regex", async () => {
    expect(await grepTracked(import.meta.dir, "MEL-1", { regex: true, wholeKey: true })).toEqual({ ok: false, error: "wholeKey takes a fixed string, not a regex" });
  });
});
