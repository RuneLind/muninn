/**
 * `relatedSectionHtml` — the block's empty guard and the row markup the panel's
 * delegated handler keys on.
 *
 * The guard is the shape a Playwright spec cannot reach: an omitted block has
 * no element to assert on, so "the section is absent" and "the page has no
 * related work" are the same DOM either way. Pinned here instead.
 */

import { describe, expect, test } from "bun:test";
import {
  relatedSectionHtml,
  type RelatedListing,
} from "./wiki-related-view.ts";

function row(over: Partial<RelatedListing> = {}): RelatedListing {
  return {
    name: "citer",
    relPath: "plans/citer.md",
    title: "Citing plan",
    type: "plan",
    why: "cites this page",
    ...over,
  } as RelatedListing;
}

describe("relatedSectionHtml", () => {
  test("NO block at all for an empty list — not a row saying nothing", () => {
    expect(relatedSectionHtml([])).toBe("");
  });

  test("a row carries both open keys and the count in the title", () => {
    const html = relatedSectionHtml([row()]);
    expect(html).toContain('class="wiki-conn-title">Related work (1)<');
    expect(html).toContain('data-page="citer"');
    expect(html).toContain('data-relpath="plans/citer.md"');
    expect(html).toContain("Citing plan");
  });

  test("each reason is its own `<em>` and the separators sit outside them", () => {
    const html = relatedSectionHtml([
      row({ why: "cites this page · shares RuneLind/muninn#549, RuneLind/muninn#550" }),
    ]);
    expect(html).toContain(
      "<em>cites this page</em> · <em>shares RuneLind/muninn#549, RuneLind/muninn#550</em>",
    );
  });

  test("the why line and the title are escaped", () => {
    const html = relatedSectionHtml([row({ title: "<script>", why: "<b>why</b>" })]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>why</b>");
    expect(html).toContain("&lt;b&gt;why&lt;/b&gt;");
  });
});
