import { test, expect } from "bun:test";
import { formatEmailHtml } from "./email-format.ts";

test("Embed fallback line echoes only a gated src", () => {
  expect(formatEmailHtml('<Embed src="./arch.html" />')).toContain("Embedded page: ./arch.html");
  const bad = formatEmailHtml('<Embed src="javascript:alert(1)" />');
  expect(bad).toContain("Embedded page: invalid embed");
  expect(bad).not.toContain("javascript:");
});

test("a bad height is reported as an invalid embed, not blamed on the src", () => {
  const out = formatEmailHtml('<Embed src="./arch.html" height="640px" />');
  expect(out).toContain("Embedded page: invalid embed");
  expect(out).not.toContain("invalid src");
});
