import { describe, expect, test } from "bun:test";
import { stripTokenSpans } from "./highlighted-code.ts";
import { highlightCode } from "../format/highlight.ts";

/**
 * This helper backs structural assertions in four test files, including the two
 * component-fuzz injection canaries. A helper that quietly RELOCATES markup
 * turns those into green-and-meaningless, so its own behaviour is pinned here.
 */
describe("stripTokenSpans", () => {
  test("removes only the emitter's own spans", () => {
    const html = highlightCode("SELECT 1;", "sql");
    expect(html).toContain('<span class="tok-kw">');
    expect(stripTokenSpans(html)).toBe("SELECT 1;");
  });

  test("a foreign span NESTED inside a token span keeps its tags and its place", () => {
    // The regression a depth COUNTER has: it removes the first `</span>` after a
    // token open — the inner, foreign one — and re-emits the outer, so `c` and
    // `y` end up inside one another's element. Byte-identical output for two
    // structurally different inputs is exactly how a strip-based assertion goes
    // vacuous without anyone noticing.
    const nested = 'A<span class="tok-com">x<span class="fc-chip">c</span>y</span>B';
    expect(stripTokenSpans(nested)).toBe('Ax<span class="fc-chip">c</span>yB');
  });

  test("a token span nested inside a foreign span leaves the foreign one intact", () => {
    const outer = '<span class="wiki-link-missing">a<span class="tok-kw">b</span>c</span>';
    expect(stripTokenSpans(outer)).toBe('<span class="wiki-link-missing">abc</span>');
  });

  test("foreign spans alone are untouched, and an unbalanced close survives", () => {
    expect(stripTokenSpans('<span class="fc-mark">a</span>')).toBe('<span class="fc-mark">a</span>');
    expect(stripTokenSpans("a</span>b")).toBe("a</span>b");
  });

  test("escaped markup from fence CONTENT cannot be laundered into a live tag", () => {
    const html = highlightCode('<span class="tok-kw">x</span>', "sql");
    const stripped = stripTokenSpans(html);
    expect(stripped).not.toContain("<span");
    expect(stripped).toContain("&lt;span");
  });
});
