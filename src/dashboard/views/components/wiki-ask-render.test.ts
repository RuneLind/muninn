import { test, expect } from "bun:test";
import { renderStreamingBody, askAnswerBodyHtml } from "./wiki-ask-render.ts";

test("renderStreamingBody formats a partial markdown buffer into HTML", () => {
  const html = renderStreamingBody("## Heading\n\n- one\n- two\n\n`code`");
  expect(html).toContain("<h3>Heading</h3>"); // formatWebHtml bumps h2 → h3
  expect(html).toContain("<li>one</li>");
  expect(html).toContain("<li>two</li>");
  expect(html).toContain("<code>code</code>");
  // Not the old plain-text wall.
  expect(html).not.toContain("## Heading");
});

test("renderStreamingBody tolerates an unclosed code fence mid-stream", () => {
  // The formatter must not throw on a half-finished construct — the stream feeds
  // it incomplete markdown every frame.
  const html = renderStreamingBody("Intro\n\n```ts\nconst x = 1;");
  expect(typeof html).toBe("string");
  expect(html).toContain("Intro");
});

test("askAnswerBodyHtml returns the final article HTML unchanged once it arrives", () => {
  const finalArticle = '<h3>Answer</h3><p>Body with <a class="wiki-ask-cite">[1]</a></p>';
  // Even with a stale streaming buffer present, the final render wins verbatim.
  const body = askAnswerBodyHtml(finalArticle, "## stale buffer", "stale answer");
  expect(body).toBe(finalArticle);
});

test("askAnswerBodyHtml progressively formats the buffer while html is null", () => {
  const body = askAnswerBodyHtml(null, "## Streaming", "");
  expect(body).toBe(renderStreamingBody("## Streaming"));
  expect(body).toContain("<h3>Streaming</h3>");
});

test("askAnswerBodyHtml falls back to the stored answer on a history re-show", () => {
  // History re-shows pass an empty buffer; a turn that never got answer_html still
  // renders its stored plain answer as formatted markdown.
  const body = askAnswerBodyHtml(null, "", "**Stored** answer");
  expect(body).toContain("<strong>Stored</strong>");
});
