import { test, expect } from "bun:test";
import { movedWithSectionHtml, type MovedWithListing } from "./wiki-moved-with.ts";

const row = (relPath: string, movedN: number, title = relPath) =>
  ({ name: relPath, title, type: "plan", relPath, backlinkCount: 0, movedN }) as unknown as MovedWithListing;

test("no rows, or an older server's absent field: no section at all", () => {
  expect(movedWithSectionHtml(undefined, (p) => p.title)).toBe("");
  expect(movedWithSectionHtml([], (p) => p.title)).toBe("");
});

test("one row per page, clickable by relPath, with its commit count and escaped title", () => {
  const html = movedWithSectionHtml([row("plans/a.md", 2, "A <b>"), row("plans/b.md", 1)], (p) => p.title);
  expect(html).toContain("Moved with (2)");
  expect(html).toContain('data-relpath="plans/a.md"');
  expect(html).toContain("A &lt;b&gt;");
  expect(html).toContain(">×2<");
  expect(html).toContain('title="1 shared commit"');
  expect(html).toContain('title="2 shared commits"');
});
