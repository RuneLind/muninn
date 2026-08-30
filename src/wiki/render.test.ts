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
 * `formatWebHtml` and restores it over the rendered HTML. It used to do so
 * INSIDE fences too — the bug the sibling describe-block below now pins as
 * fixed — and the highlighter's C-family capitalized-identifier rule matched
 * `WIKIPAGELINK0` and SPLIT the sentinel, so the restore missed and a raw U+0000
 * was SERVED.
 *
 * The assertion is PARITY between a highlighted fence and an unhighlighted one,
 * which is the property that has to hold whatever the parking pass decides: the
 * tokenizer must be transparent to the sentinel machinery. It deliberately does
 * not assert WHAT the fence contains — that is the sibling block's job.
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
  // …and the fence is the source, byte for byte, on both.
  expect(stripTokenSpans(highlighted)).toContain(body);
});

describe("renderWikiHtml: a wikilink inside code is CODE", () => {
  // The acceptance for the whole guard, stated once: a fence's text must equal
  // the bytes on disk. Both halves are asserted, because only the RESOLVABLE one
  // distinguishes a real fix from "the dead wiki-link-missing span went away".
  //
  // Why it matters beyond looks: `code.textContent` is what #494's Copy button
  // hands the reader, what `wiki-mermaid.ts` reads to build a diagram, and what
  // the fact-check evidence card clones. A substituted link there is silently
  // altered source, one click from someone's editor.
  const fenceText = (html: string) =>
    stripTokenSpans(html).replace(/^[\s\S]*?<code[^>]*>/, "").replace(/<\/code>[\s\S]*$/, "");

  test("a RESOLVABLE target stays literal — no anchor, brackets intact", () => {
    const source = "// see [[Claude Code]]";
    const html = renderWikiHtml("```ts\n" + source + "\n```", resolve);
    expect(html).not.toContain("wiki-link");
    expect(fenceText(html)).toBe(source);
  });

  test("an UNRESOLVABLE target stays literal too — an array literal is not a dead link", () => {
    const source = "const m = [[1,2,3]];";
    const html = renderWikiHtml("```ts\n" + source + "\n```", resolve);
    expect(html).not.toContain("wiki-link-missing");
    expect(fenceText(html)).toBe(source);
  });

  test("an INLINE code span is protected too — the majority of real cases", () => {
    // Measured over mimir + the jarvis wiki: 522 of the 1495 wikilinks inside
    // code are in inline spans, and in the jarvis wiki they are 99% of them.
    const html = renderWikiHtml("Write `[[Claude Code]]` to link it.", resolve);
    expect(html).toContain("<code>[[Claude Code]]</code>");
    expect(html).not.toContain("wiki-link");
  });

  test("prose on the same page is UNAFFECTED — the guard is not a kill switch", () => {
    const html = renderWikiHtml(
      "See [[Claude Code]].\n\n```ts\n// [[Claude Code]]\n```\n\nAnd [[Claude Code]] again.",
      resolve,
    );
    expect(html.match(/class="wiki-link"/g)?.length).toBe(2);
    expect(stripTokenSpans(html)).toContain("// [[Claude Code]]");
  });

  test("a ~~~ block is prose here, so a link inside it still resolves", () => {
    // The reason the code regions are derived from THIS renderer's regexes and
    // not from a CommonMark walk: formatWebHtml does not treat ~~~ as a fence,
    // so skipping it would delete a link the reader can see working today.
    const html = renderWikiHtml("~~~\n[[Claude Code]]\n~~~", resolve);
    expect(html).toContain('class="wiki-link"');
  });

  test("a fence inside a component is still code", () => {
    const html = renderWikiHtml(
      '<Callout tone="info" title="t">\n\n```ts\n// [[Claude Code]]\n```\n\n</Callout>',
      resolve,
    );
    expect(html).toContain('class="callout callout-info"');
    expect(html).not.toContain("wiki-link");
    expect(stripTokenSpans(html)).toContain("// [[Claude Code]]");
  });

  /**
   * The four inputs a markdown-side fence scanner got wrong, kept as regression
   * tests because they are what moved this decision onto the RENDERED HTML.
   * Each one was measured against the shipped renderer before the rework.
   */
  describe("inputs a markdown-side scanner could not get right", () => {
    test("CRLF: `parseBlocks` normalizes \\r\\n, so a raw-body scan finds no fence at all", () => {
      const html = renderWikiHtml("t\r\n\r\n```ts\r\n// [[Claude Code]]\r\n```\r\n", resolve);
      expect(html).not.toContain("wiki-link");
      expect(stripTokenSpans(html)).toContain("// [[Claude Code]]");
    });

    test("a backtick inside a wikilink TARGET shifts inline-code parity", () => {
      // Parking `[[x`y]]` REMOVES a backtick, so every later backtick on the line
      // re-pairs one position over and an inline span appears that a scan of the
      // unparked body never saw — with a sentinel inside it.
      const html = renderWikiHtml("[[x`y]] `A [[Claude Code]] B` end", resolve);
      expect(html).toContain("<code>A [[Claude Code]] B</code>");
      expect(html).not.toContain('<code>A <a');
    });

    test("…and inside a LABEL, which the same parking removes", () => {
      const html = renderWikiHtml("[[a|b`c]] `A [[Claude Code]] B` end", resolve);
      expect(html).toContain("<code>A [[Claude Code]] B</code>");
    });

    test("the same parity shift read backwards must NOT de-link prose", () => {
      // The over-skip direction: a scanner that thought the later link was inside
      // code stopped parking it, and a working prose link rendered as brackets.
      const html = renderWikiHtml("[[a`b]] X [[Claude Code]] Y `d`", resolve);
      expect(html).toContain('class="wiki-link"');
      expect(html).toContain("<code>d</code>");
    });

    test("a mid-line fence delimiter: the renderer joins the two sides onto ONE line", () => {
      // `parseBlocks` swaps the fence for a placeholder, so the text before the
      // opener and after the closer end up on one line where two lone backticks
      // pair — a line-wise scan of the body sees neither.
      const html = renderWikiHtml("a ` ```\ncode\n``` [[Claude Code]] ` b", resolve);
      expect(html).not.toContain("wiki-link");
      expect(html).toContain("[[Claude Code]]");
    });
  });

  test("nothing leaks: no sentinel and no raw NUL reach the page", () => {
    const html = renderWikiHtml(
      "[[Claude Code]]\n\n```ts\nconst m = [[1,2,3]];\n```\n\n`[[Claude Code]]`",
      resolve,
    );
    expect(html).not.toContain("\u0000");
    expect(html).not.toContain("WIKIPAGELINK");
  });
});
