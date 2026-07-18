import { test, expect, describe } from "bun:test";
import { escapeHtml, Placeholders } from "./markdown-core.ts";

describe("escapeHtml", () => {
  test("escapes &", () => {
    expect(escapeHtml("AT&T")).toBe("AT&amp;T");
  });

  test("escapes <", () => {
    expect(escapeHtml("a < b")).toBe("a &lt; b");
  });

  test("escapes >", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b");
  });

  test('escapes "', () => {
    expect(escapeHtml('say "hi"')).toBe("say &quot;hi&quot;");
  });

  test("escapes all four together", () => {
    expect(escapeHtml('<a href="x">A&B</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;A&amp;B&lt;/a&gt;",
    );
  });

  test("ampersand escape happens first (does not double-escape its own output)", () => {
    expect(escapeHtml("<")).toBe("&lt;");
  });

  test("plain text passthrough", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  test("empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("Placeholders", () => {
  test("returns sentinel containing marker and index", () => {
    const p = new Placeholders();
    expect(p.add("CODE", "<pre>x</pre>")).toBe("\x00CODE0\x00");
    expect(p.add("CODE", "<pre>y</pre>")).toBe("\x00CODE1\x00");
  });

  test("restores stored values in place", () => {
    const p = new Placeholders();
    const a = p.add("CODE", "<pre>1</pre>");
    const b = p.add("CODE", "<pre>2</pre>");
    expect(p.restore(`before ${a} mid ${b} end`)).toBe(
      "before <pre>1</pre> mid <pre>2</pre> end",
    );
  });

  test("supports independent markers in the same store", () => {
    const p = new Placeholders();
    const code = p.add("CODE", "C");
    const link = p.add("LINK", "L");
    const code2 = p.add("CODE", "C2");
    expect(p.restore(`${code} ${link} ${code2}`)).toBe("C L C2");
  });

  test("restore with no sentinels returns text unchanged", () => {
    const p = new Placeholders();
    p.add("CODE", "X");
    expect(p.restore("plain text")).toBe("plain text");
  });

  test("missing index restores to empty string", () => {
    const p = new Placeholders();
    p.add("CODE", "X");
    // Manually-crafted sentinel pointing at a slot that does not exist
    expect(p.restore("a \x00CODE5\x00 b")).toBe("a  b");
  });

  test("restores to a fixed point when a value re-introduces an earlier marker", () => {
    // Nested parking: INNER is stored first, then OUTER's value embeds INNER's
    // sentinel. A single pass (INNER visited before OUTER re-introduced it) would
    // leak a raw NUL; the fixed-point loop must resolve it.
    const p = new Placeholders();
    const inner = p.add("INNER", "<code>x</code>");
    const outer = p.add("OUTER", `<span>${inner}</span>`);
    const restored = p.restore(outer);
    expect(restored).toBe("<span><code>x</code></span>");
    expect(restored).not.toContain("\x00");
  });
});
