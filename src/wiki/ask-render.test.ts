import { test, expect } from "bun:test";
import { renderAskAnswerHtml, renderResearchAnswerHtml } from "./ask-render.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
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

// --- block components in Ask/Explain answers -------------------------------

// An answer that leans on the whitelisted component vocabulary, with a citation
// inside a component body ([1]) and one in plain prose ([2]).
const COMPONENT_ANSWER = [
  '<Callout tone="warn" title="Caveat">',
  "Cold starts are slow [1].",
  "</Callout>",
  "",
  "Overall it works well [2].",
  "",
  '<Verdict value="yes">Recommended</Verdict>',
].join("\n");

test("Ask: component-bearing answer renders styled HTML, citation inside a component still linkified", () => {
  const citations = [cite(1, { pageName: "perf", title: "Perf" }), cite(2)];
  const html = renderAskAnswerHtml(COMPONENT_ANSWER, citations);
  // Components render as their styled markup, not escaped tags.
  expect(html).toContain('class="callout callout-warn"');
  expect(html).toContain('<span class="verdict verdict-yes">Recommended</span>');
  expect(html).not.toContain("&lt;Callout");
  expect(html).not.toContain("&lt;Verdict");
  // [1] lives inside the Callout body and still becomes a wiki-page cite.
  expect(html).toContain('class="wiki-ask-cite" data-page="perf"');
  // [2] has no matched page → stays literal text.
  expect((html.match(/wiki-ask-cite/g) || []).length).toBe(1);
  expect(html).toContain("[2]");
});

test("/research: renderResearchAnswerHtml renders components but leaves [n] literal (client linkifies)", () => {
  const html = renderResearchAnswerHtml(COMPONENT_ANSWER);
  expect(html).toContain('class="callout callout-warn"');
  expect(html).toContain('<span class="verdict verdict-yes">Recommended</span>');
  // No server-side cite linkify — markers stay literal for the client TreeWalker.
  expect(html).not.toContain("wiki-ask-cite");
  expect(html).toContain("[1]");
  expect(html).toContain("[2]");
});

test("/research: empty answer renders empty without throwing", () => {
  expect(renderResearchAnswerHtml("")).toBe("");
});

// Platform-safety: the SAME component-bearing answer must degrade to legible
// fallbacks on Telegram + Slack — never leak raw `<Callout …>` / `<Verdict …>`
// tags to the user (pins the goal at the answer level, not just the formatter).
test("platform fallback: component answer stays legible on Telegram", () => {
  const out = formatTelegramHtml(COMPONENT_ANSWER);
  expect(out).toContain("Caveat"); // Callout title survives as bold prefix
  expect(out).toContain("✅ Recommended"); // Verdict → check + label
  expect(out).not.toContain("<Callout");
  expect(out).not.toContain("<Verdict");
});

test("platform fallback: component answer stays legible on Slack", () => {
  const out = formatSlackMrkdwn(COMPONENT_ANSWER);
  expect(out).toContain("*Caveat*"); // Callout title → bold
  expect(out).toContain("✅ Recommended"); // Verdict → check + label
  expect(out).not.toContain("<Callout");
  expect(out).not.toContain("<Verdict");
});
