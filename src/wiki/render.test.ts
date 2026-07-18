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

  test("native .mdx body renders: frontmatter stripped, prose + component + code fence + wikilink", () => {
    const mdx = [
      "---",
      'title: "The Drain Saga"',
      "tags: [muninn, tracing]",
      "---",
      "",
      "# The Drain Saga",
      "",
      "Intro prose about draining. See [[Claude Code]] for the harness.",
      "",
      '<Callout tone="warn" title="Heads up">',
      "A drain can stall. Watch the **heartbeat**.",
      "</Callout>",
      "",
      "```ts",
      "const drain = true;",
      "```",
    ].join("\n");
    const html = renderWikiHtml(mdx, resolve, { stripTitle: "The Drain Saga" });

    // Frontmatter fence never renders as an <hr>/text.
    expect(html).not.toContain("title: &quot;The Drain Saga");
    expect(html).not.toContain("tags: [muninn");
    // The leading H1 matching the title is stripped by stripTitle.
    expect(html).not.toContain("The Drain Saga</h2>");
    // Prose + resolved wikilink (inside prose).
    expect(html).toContain("Intro prose about draining.");
    expect(html).toContain('data-wiki-page="Claude Code"');
    // Component from the shared AST renders as a Callout (not escaped text).
    expect(html).toContain('class="callout callout-warn"');
    expect(html).toContain("Heads up");
    expect(html).toContain("<strong>heartbeat</strong>");
    // Code fence renders as a code block, unescaped tag text.
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain("const drain = true;");
  });

  test("wikilinks inside a component body resolve to internal anchors", () => {
    const mdx = ['<Callout tone="info">', "Nested link to [[Claude Code]].", "</Callout>"].join("\n");
    const html = renderWikiHtml(mdx, resolve);
    expect(html).toContain('class="callout callout-info"');
    expect(html).toContain('href="/wiki?page=Claude%20Code"');
  });

  test("a Meter inside a native page body renders as a meter component (not escaped text)", () => {
    // Mirrors the Callout body-render pin: the shared AST renders Meter through
    // formatWebHtml, so a wiki page carries the styled bar, not escaped tags.
    const html = renderWikiHtml("Score:\n\n<Meter value=\"4\" max=\"5\" tone=\"good\">Autonomy</Meter>", resolve);
    expect(html).toContain('<div class="meter meter-good">');
    expect(html).toContain('<span class="meter-value">4/5</span>');
    expect(html).not.toContain("&lt;Meter");
  });

  test("a ```mermaid fence renders as a plain code block (muninn has no mermaid renderer)", () => {
    const html = renderWikiHtml("```mermaid\ngraph TD; A-->B;\n```", resolve);
    // v1: no diagram rendering — the fence degrades to a labeled code block.
    expect(html).toContain('<pre><code class="language-mermaid">');
    expect(html).toContain("graph TD; A--&gt;B;");
  });
});
