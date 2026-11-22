import { test, expect } from "bun:test";
import { isSafeLinkHref } from "./safe-link-href.ts";

/** Callers pass stored JSON fields straight in; a non-string must answer false,
 *  not throw inside a client render loop (one throw left /research Browse and the
 *  /summaries library unrendered). */
test("a non-string href is refused without throwing", () => {
  for (const v of [123, ["javascript:x"], {}, null, undefined, true]) {
    expect(() => isSafeLinkHref(v)).not.toThrow();
    expect(isSafeLinkHref(v)).toBe(false);
  }
  // Non-vacuous: the same check still passes a real string.
  expect(isSafeLinkHref("https://example.com/a")).toBe(true);
});

test("the injected .toString() copy carries the non-string refusal too", () => {
  const copy = new Function(`return (${isSafeLinkHref.toString()});`)() as (h: unknown) => boolean;
  expect(() => copy(123)).not.toThrow();
  expect(copy(123)).toBe(false);
  expect(copy({})).toBe(false);
  expect(copy("https://example.com/a")).toBe(true);
});
