import { describe, expect, test } from "bun:test";
import { Marked } from "marked";
import {
  dropFactcheckSentinelLines,
  factcheckCalloutScript,
  styleFactcheckCallouts,
} from "./factcheck-callout.ts";
import { buildSummaryFactcheckBlock, insertSummaryFactcheckBlock } from "./factcheck-block.ts";
import { renderExportMarkdown } from "./export.ts";

/** The article view's renderer: marked with raw HTML escaped. */
const pageMarked = new Marked({
  renderer: { html: (t) => t.raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") },
});
const render = (md: string) => styleFactcheckCallouts(pageMarked.parse(dropFactcheckSentinelLines(md), { async: false }) as string);

const BODY = insertSummaryFactcheckBlock(
  "Summary.",
  buildSummaryFactcheckBlock("Lede.\n\n### ❌ Claim 1/1 — x\n\nSources: [a.org](https://a.org)", "2026-10-06"),
);

describe("the summary fact-check block, rendered", () => {
  test("no literal sentinel text, one styled callout with its title", () => {
    const html = render(BODY);
    expect(html).not.toContain("&lt;!--");
    expect(html).not.toContain("factcheck:start");
    expect(html).toContain('<blockquote class="sum-fc-callout" data-callout="factcheck">');
    expect(html).toContain('<p class="sum-fc-callout-title">✓ Claims checked against the web</p>');
    expect(html).not.toContain("[!factcheck]");
    expect(html).toContain("<h2>Fact check (2026-10-06)</h2>");
  });

  test("a fenced example of the sentinels is shown as code", () => {
    const md = "```\n<!-- factcheck:start -->\n```";
    expect(dropFactcheckSentinelLines(md)).toBe(md);
  });

  test("an ordinary blockquote is left alone", () => {
    expect(render("> quoted")).toBe("<blockquote>\n<p>quoted</p>\n</blockquote>\n");
  });

  test("the export renders the same way", () => {
    const html = renderExportMarkdown(BODY);
    expect(html).not.toContain("&lt;!--");
    expect(html).toContain('class="sum-fc-callout"');
  });

  test("the injected page copies run standalone and agree with the module", () => {
    const script = factcheckCalloutScript();
    // Inlined into a <script>: no literal comment opener.
    expect(script).not.toContain("<!--");
    const api = new Function(`${script}\nreturn { dropFactcheckSentinelLines, styleFactcheckCallouts };`)() as {
      dropFactcheckSentinelLines: typeof dropFactcheckSentinelLines;
      styleFactcheckCallouts: typeof styleFactcheckCallouts;
    };
    expect(api.dropFactcheckSentinelLines(BODY)).toBe(dropFactcheckSentinelLines(BODY));
    const html = pageMarked.parse(dropFactcheckSentinelLines(BODY), { async: false }) as string;
    expect(api.styleFactcheckCallouts(html)).toBe(styleFactcheckCallouts(html));
  });
});

describe("fix round 1", () => {
  test("a fence line with an info string does not close a fence (CommonMark)", () => {
    const md = "```\n```js\n<!-- factcheck:end -->\n```\nafter";
    expect(dropFactcheckSentinelLines(md)).toBe(md);
    const tilde = "~~~\n~~~ts\n<!-- factcheck:start -->\n~~~";
    expect(dropFactcheckSentinelLines(tilde)).toBe(tilde);
  });

  test("a closing fence may carry trailing spaces", () => {
    expect(dropFactcheckSentinelLines("```\ncode\n```   \n<!-- factcheck:end -->\nx")).toBe("```\ncode\n```   \nx");
  });

  test("plainFactcheckText: a chunk preview loses the sentinels and the callout marker", async () => {
    const { plainFactcheckText } = await import("./factcheck-callout.ts");
    const chunk = "Lede line.\n<!-- factcheck:start -->\n## Fact check (2026-10-06)\n\n> [!factcheck] Claims checked against the web\n>\n> **❌ Claim 1/1 — x**\n<!-- factcheck:end -->";
    const out = plainFactcheckText(chunk);
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("factcheck:");
    expect(out).not.toContain("[!factcheck]");
    expect(out).toContain("✓ Claims checked against the web");
    expect(out).toContain("**❌ Claim 1/1 — x**");
    // Whitespace-collapsed (the wiki's Similar snippet) works the same.
    expect(plainFactcheckText(chunk.replace(/\s+/g, " "))).not.toContain("factcheck:");
  });

  test("the /search page and the /summaries similar list run chunk text through it", async () => {
    const { searchResultsScript } = await import("../dashboard/views/components/search-results.ts");
    const script = searchResultsScript();
    expect(script).toContain("var plainFactcheckText = function");
    expect(script).toContain("plainFactcheckText(stripBreadcrumb(c.content))");
    expect(script).toContain("plainFactcheckText(stripBreadcrumb(chunks[0].content))");
  });
});
