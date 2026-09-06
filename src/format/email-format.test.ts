import { test, expect } from "bun:test";
import { formatEmailHtml } from "./email-format.ts";

test("Embed fallback line echoes only a gated src", () => {
  expect(formatEmailHtml('<Embed src="./arch.html" />')).toContain("Embedded page: ./arch.html");
  const bad = formatEmailHtml('<Embed src="javascript:alert(1)" />');
  expect(bad).toContain("Embedded page: invalid src");
  expect(bad).not.toContain("javascript:");
});
