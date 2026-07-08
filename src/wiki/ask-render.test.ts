import { test, expect } from "bun:test";
import { renderAskAnswerHtml } from "./ask-render.ts";
import type { Citation } from "../research/answer.ts";

function cite(n: number, extra: Partial<Citation> = {}): Citation {
  return {
    n,
    collection: "mimir-knowledge",
    docId: `doc-${n}`,
    title: `Doc ${n}`,
    badge: "Wiki",
    relevance: 0.7,
    ...extra,
  };
}

test("renders markdown headings and bold as HTML, not literal syntax", () => {
  const html = renderAskAnswerHtml("## ATDD Work\n\nThe **spec loop** landed.", []);
  expect(html).toContain("<h3>ATDD Work</h3>");
  expect(html).toContain("<strong>spec loop</strong>");
  // No raw markdown syntax leaks through.
  expect(html).not.toContain("## ATDD");
  expect(html).not.toContain("**spec loop**");
});

test("linkifies [n] markers whose citation matched a wiki page", () => {
  const citations = [cite(1, { pageName: "atdd-loop", title: "ATDD Loop" })];
  const html = renderAskAnswerHtml("The loop is documented [1].", citations);
  expect(html).toContain('data-page="atdd-loop"');
  expect(html).toContain('class="wiki-ask-cite"');
  expect(html).toContain("[1]</sup>");
  expect(html).toContain('title="ATDD Loop"');
});

test("leaves markers with no matched page as literal text", () => {
  // Citation exists but never resolved to a wiki page (no pageName).
  const html = renderAskAnswerHtml("Off-wiki source [1].", [cite(1)]);
  expect(html).not.toContain("wiki-ask-cite");
  expect(html).toContain("[1]");
});

test("leaves out-of-range markers literal", () => {
  const citations = [cite(1, { pageName: "only-one" })];
  const html = renderAskAnswerHtml("See [1] and [5].", citations);
  // [1] linkified, [5] out of range → literal
  expect(html).toContain('data-page="only-one"');
  expect(html).toContain("[5]");
  expect((html.match(/wiki-ask-cite/g) || []).length).toBe(1);
});

test("escapes page names and titles in the linkified marker", () => {
  const citations = [cite(1, { pageName: 'a"b', title: "<x>" })];
  const html = renderAskAnswerHtml("Ref [1].", citations);
  expect(html).toContain("&quot;");
  expect(html).not.toContain('data-page="a"b"');
  expect(html).toContain("&lt;x&gt;");
});

test("handles an empty answer without throwing", () => {
  expect(renderAskAnswerHtml("", [])).toBe("");
});

test("linkifies the same marker used twice", () => {
  const citations = [cite(1, { pageName: "p1" })];
  const html = renderAskAnswerHtml("First [1], then again [1].", citations);
  expect((html.match(/wiki-ask-cite/g) || []).length).toBe(2);
});
