import { describe, expect, test } from "bun:test";
import { articleHeadHtml } from "./wiki-browser.ts";
import type { WikiListing } from "../../../wiki/core/wiki-filter.ts";

function page(url: string | undefined): WikiListing {
  return {
    name: "p",
    title: "Title",
    type: "concept",
    domain: "ai",
    tags: [],
    aliases: [],
    relPath: "p.md",
    linkCount: 0,
    backlinkCount: 0,
    url,
  } as WikiListing;
}

// Frontmatter `url:` is any scheme an author or drafter wrote; the head's
// "Open source" link is gated by isSafeLinkHref (arch review 2026-11-16, F70).
describe("articleHeadHtml: the frontmatter url link", () => {
  test("an http(s) url still links", () => {
    expect(articleHeadHtml(page("https://example.com/a"))).toContain(
      '<a class="wiki-source-url" href="https://example.com/a"',
    );
  });

  test.each(["javascript:window.__pwn=1", "JavaScript:alert(1)", "data:text/html,x", "java\tscript:alert(1)", "//evil.example/p"])(
    "%p renders no source link",
    (url) => {
      const html = articleHeadHtml(page(url));
      expect(html).not.toContain("wiki-source-url");
      expect(html.toLowerCase()).not.toContain("javascript:");
    },
  );

  test("no url, no link", () => {
    expect(articleHeadHtml(page(undefined))).not.toContain("wiki-source-url");
  });
});
