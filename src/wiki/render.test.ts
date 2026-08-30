import { test, expect, describe } from "bun:test";
import { renderWikiHtml, stripFrontmatter } from "./render.ts";
import type { WikiPageMeta } from "./store.ts";
import { stripTokenSpans } from "../test/highlighted-code.ts";

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
    expect(html).toContain('href="/wiki?relPath=concepts%2FClaude%20Code.md"');
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

  test("a dangling [[ never merges two lines into one missing-link span", () => {
    // The reader is where the missing `\n` exclusion was VISIBLE: an index.md
    // entry truncated mid-link paired with the NEXT entry's `]]`, so both lines
    // rendered as one `wiki-link-missing` span and the second entry's real link
    // disappeared from the page.
    const html = renderWikiHtml(
      ["- [[Claude Code]] — a summary cut at [[Some Long", "- [[Claude Code]] — the next entry."].join("\n"),
      resolve,
    );
    // The second entry still resolves to a real anchor.
    expect(html.match(/data-wiki-page="Claude Code"/g)?.length).toBe(2);
    expect(html).not.toContain("Some Long\n");
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
    expect(stripTokenSpans(html)).toContain("const drain = true;");
  });

  test("wikilinks inside a component body resolve to internal anchors", () => {
    const mdx = ['<Callout tone="info">', "Nested link to [[Claude Code]].", "</Callout>"].join("\n");
    const html = renderWikiHtml(mdx, resolve);
    expect(html).toContain('class="callout callout-info"');
    expect(html).toContain('href="/wiki?relPath=concepts%2FClaude%20Code.md"');
  });

  test("a Meter inside a native page body renders as a meter component (not escaped text)", () => {
    // Mirrors the Callout body-render pin: the shared AST renders Meter through
    // formatWebHtml, so a wiki page carries the styled bar, not escaped tags.
    const html = renderWikiHtml("Score:\n\n<Meter value=\"4\" max=\"5\" tone=\"good\">Autonomy</Meter>", resolve);
    expect(html).toContain('<div class="meter meter-good">');
    expect(html).toContain('<span class="meter-value">4/5</span>');
    expect(html).not.toContain("&lt;Meter");
  });

  test("an Obsidian [!warning] callout blockquote upgrades to a styled callout", () => {
    const md = "> [!warning] Stale timeline\n> The video's dates are wrong.\n>\n> Trust this page instead.";
    const html = renderWikiHtml(md, resolve);
    expect(html).toContain('class="callout callout-warn"');
    expect(html).toContain('<strong class="callout-title">Stale timeline</strong>');
    expect(html).toContain("The video's dates are wrong.");
    expect(html).toContain("Trust this page instead.");
    expect(html).not.toContain("[!warning]");
    expect(html).not.toContain("<blockquote>");
  });

  test("a bare [!note] with no title falls back to the type name; ordinary blockquotes untouched", () => {
    const html = renderWikiHtml("> [!note]\n> Just a note body.", resolve);
    expect(html).toContain('class="callout callout-info"');
    expect(html).toContain('<strong class="callout-title">Note</strong>');

    const plain = renderWikiHtml("> Just a regular quote.", resolve);
    expect(plain).toContain("<blockquote>Just a regular quote.</blockquote>");
  });

  test("callout bodies keep rendered inline markup — wikilinks and bold survive", () => {
    const md = "> [!danger] Broken\n> See [[Claude Code]] and **this**.";
    const html = renderWikiHtml(md, resolve);
    expect(html).toContain('class="callout callout-bad"');
    expect(html).toContain('href="/wiki?relPath=concepts%2FClaude%20Code.md"');
    expect(html).toContain("<strong>this</strong>");
  });

  test("a fact-check sentinel line is stripped; the block between them still renders", () => {
    // The sentinels are internal write markers, never content — but formatWebHtml
    // escapes what it does not recognize, so an unstripped marker showed up as a
    // literal `<!-- factcheck:start -->` line in the reader.
    const md = "Before.\n\n<!-- factcheck:start -->\nInner content.\n<!-- factcheck:end -->\n\nAfter.";
    const html = renderWikiHtml(md, resolve);
    expect(html).not.toContain("factcheck:start");
    expect(html).not.toContain("factcheck:end");
    expect(html).toContain("Inner content.");
    expect(html).toContain("Before.");
    expect(html).toContain("After.");
  });

  test("the strip is LINE-ANCHORED — a marker quoted mid-sentence survives", () => {
    // A page documenting this very feature must still be able to show the marker.
    const html = renderWikiHtml("We write a <!-- factcheck:start --> marker inline here.", resolve);
    expect(html).toContain("factcheck:start");
    expect(html).toContain("marker inline here.");
  });

  test("an indented sentinel line is still stripped (leading whitespace tolerated)", () => {
    const html = renderWikiHtml("Before.\n\n   <!-- factcheck:end -->\n\nAfter.", resolve);
    expect(html).not.toContain("factcheck:end");
    expect(html).toContain("Before.");
    expect(html).toContain("After.");
  });

  test("a marker line owning only PART of its line keeps the marker", () => {
    // Not end-anchored before this: the marker was stripped out of a line whose
    // remainder is real prose, silently editing the sentence.
    const html = renderWikiHtml("<!-- factcheck:start --> real prose follows.", resolve);
    expect(html).toContain("factcheck:start");
    expect(html).toContain("real prose follows.");
  });

  test("markers on their own line INSIDE a code fence survive (documenting the format)", () => {
    const md = [
      "Intro.",
      "",
      "```mdx",
      "<!-- factcheck:start -->",
      "> [!factcheck] Fact check (2026-07-29)",
      "<!-- factcheck:end -->",
      "```",
      "",
      "Outro.",
    ].join("\n");
    const html = renderWikiHtml(md, resolve);
    expect(html).toContain("factcheck:start");
    expect(html).toContain("factcheck:end");
    expect(html).toContain("[!factcheck] Fact check (2026-07-29)");
    expect(html).toContain("Intro.");
    expect(html).toContain("Outro.");
  });

  test("a ```mermaid fence renders as a plain code block (muninn has no mermaid renderer)", () => {
    const html = renderWikiHtml("```mermaid\ngraph TD; A-->B;\n```", resolve);
    // v1: no diagram rendering — the fence degrades to a labeled code block.
    expect(html).toContain('<pre><code class="language-mermaid">');
    expect(html).toContain("graph TD; A--&gt;B;");
  });
});

describe("wikilink href", () => {
  const meta = (name: string, relPath: string) =>
    ({ name, title: name, relPath, type: "concept", domain: "ai", tags: [], aliases: [] }) as never;

  test("with a wiki name, the href is the collision-proof relPath URL", () => {
    // A middle-click / "open in new tab" is the ONE path that uses the href, and
    // it used to drop the `?wiki=` param entirely AND re-resolve the stem — so on
    // a non-default wiki it opened jarvis, and on a wiki with same-stem pages it
    // opened the wrong page there.
    const html = renderWikiHtml(
      "See [[architecture]].",
      () => meta("architecture", "projects/yggdrasil/architecture.md"),
      { wiki: "mimir" },
    );
    expect(html).toContain(
      'href="/wiki?wiki=mimir&relPath=projects%2Fyggdrasil%2Farchitecture.md"',
    );
    // The data attrs the in-page delegate reads are untouched.
    expect(html).toContain('data-wiki-page="architecture"');
    expect(html).toContain('data-relpath="projects/yggdrasil/architecture.md"');
  });

  test("with no wiki name, the href still carries the relPath (default wiki)", () => {
    const html = renderWikiHtml("See [[architecture]].", () =>
      meta("architecture", "projects/yggdrasil/architecture.md"),
    );
    expect(html).toContain('href="/wiki?relPath=projects%2Fyggdrasil%2Farchitecture.md"');
  });
});


/**
 * Same regression as `ask-render.test.ts`'s, through the wikilink sentinel.
 *
 * `renderWikiHtml` parks a `[[wikilink]]` as a \u0000-delimited sentinel BEFORE
 * `formatWebHtml` and restores it over the rendered HTML — and it does so
 * INSIDE fences too, which is pre-existing behaviour (an `html` fence, or one
 * with no language at all, resolves `[[1,2,3]]` to a `wiki-link-missing` span
 * exactly the same way; measured 2026-08-30). Highlighting must not change that
 * either way: the C-family capitalized-identifier rule matched `WIKIPAGELINK0`
 * and split the sentinel, so the restore missed and a raw U+0000 was SERVED.
 *
 * The assertion is therefore PARITY between a highlighted fence and an
 * unhighlighted one, which pins the fix without freezing the wikilink-in-fence
 * behaviour this test does not own.
 */
test("a wikilink-shaped literal in a fence renders the same highlighted or not", () => {
  const body = "const m = [[1,2,3]];";
  const highlighted = renderWikiHtml("```ts" + "\n" + body + "\n```", () => undefined);
  const plain = renderWikiHtml("```html" + "\n" + body + "\n```", () => undefined);

  // No raw \u0000 and no leaked sentinel word ever reaches the served HTML.
  for (const html of [highlighted, plain]) {
    expect(html).not.toContain("\u0000");
    expect(html).not.toContain("WIKIPAGELINK");
  }

  // Strip the token spans and the two are the same document apart from the
  // language class — i.e. the tokenizer is transparent to the sentinel machinery.
  expect(stripTokenSpans(highlighted).replace('language-ts', "LANG")).toBe(
    plain.replace('language-html', "LANG"),
  );
  expect(stripTokenSpans(highlighted)).toContain("wiki-link-missing");
});
