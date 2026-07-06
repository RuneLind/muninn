import { test, expect, describe } from "bun:test";
import { renderWikiHtml, stripFrontmatter } from "./render.ts";
import type { WikiPageMeta } from "./store.ts";

const page = (name: string): WikiPageMeta => ({
  name,
  title: name,
  type: "concept",
  domain: "ai",
  tags: [],
  aliases: [],
  relPath: `concepts/${name}.md`,
});

const resolve = (target: string) =>
  target.toLowerCase() === "claude code" ? page("Claude Code") : undefined;

describe("stripFrontmatter", () => {
  test("removes the leading fence block only", () => {
    expect(stripFrontmatter("---\ntype: x\n---\n\n# Hi\n---\nrule")).toBe("\n# Hi\n---\nrule");
    expect(stripFrontmatter("# No fence")).toBe("# No fence");
  });
});

describe("renderWikiHtml", () => {
  test("resolved wikilinks become internal anchors", () => {
    const html = renderWikiHtml("See [[Claude Code]] for details.", resolve);
    expect(html).toContain('href="/wiki?page=Claude%20Code"');
    expect(html).toContain('data-wiki-page="Claude Code"');
    expect(html).toContain(">Claude Code</a>");
  });

  test("labeled wikilinks use the label as anchor text", () => {
    const html = renderWikiHtml("Per [[Claude Code|CC]].", resolve);
    expect(html).toContain(">CC</a>");
  });

  test("unresolved wikilinks render as muted spans, not anchors", () => {
    const html = renderWikiHtml("See [[Nonexistent Page]].", resolve);
    expect(html).toContain('class="wiki-link-missing"');
    expect(html).not.toContain("Nonexistent Page</a>");
  });

  test("wikilinks survive inside headings, lists, and bold text", () => {
    const html = renderWikiHtml(
      "## About [[Claude Code]]\n\n- item with [[Claude Code|CC]]\n\n**bold [[Claude Code]]**",
      resolve,
    );
    const matches = html.match(/class="wiki-link"/g) ?? [];
    expect(matches.length).toBe(3);
  });

  test("stripTitle drops a leading H1 matching the title, keeps others", () => {
    const stripped = renderWikiHtml("# Claude Code\n\nBody text.", resolve, {
      stripTitle: "Claude Code",
    });
    expect(stripped).not.toContain("Claude Code</h2>");
    expect(stripped).toContain("Body text.");
    const kept = renderWikiHtml("# Wiki Index\n\nBody.", resolve, { stripTitle: "index" });
    expect(kept).toContain("Wiki Index</h2>");
  });

  test("html in page content is escaped, markdown is rendered", () => {
    const html = renderWikiHtml("# Title\n\n<script>alert(1)</script> and **bold**", resolve);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("<strong>bold</strong>");
  });
});
