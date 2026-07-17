import { test, expect } from "bun:test";
import { renderResearchPage } from "./research-page.ts";

// The /research client is an inline-script string (no DOM harness), so we pin the
// `answer_html` listener's behaviour at the source level: it must be wired, swap
// the answer body from the server-rendered HTML, and re-linkify [n] citations —
// without closing the stream (it closes on the 'end' sentinel). See PR
// "answer-blocks": the server emits `answer_html` between `done` and `end`.

let cachedHtml: string | undefined;
async function pageHtml(): Promise<string> {
  if (!cachedHtml) cachedHtml = await renderResearchPage();
  return cachedHtml;
}

test("research page wires an answer_html SSE handler", async () => {
  const html = await pageHtml();
  expect(html).toContain("answer_html: function(e)");
});

test("answer_html handler swaps the body from d.html and re-linkifies citations", async () => {
  const html = await pageHtml();
  const start = html.indexOf("answer_html: function(e)");
  expect(start).toBeGreaterThan(-1);
  // Isolate the handler body up to the next handler ('app_error:').
  const segment = html.slice(start, html.indexOf("app_error: function(e)", start));
  expect(segment).toContain("d.html");
  expect(segment).toContain("a.bodyEl.innerHTML = d.html");
  expect(segment).toContain("linkifyCitations(a.bodyEl, a.citations)");
  // It must NOT close the stream — that stays on the 'end' sentinel.
  expect(segment).not.toContain("currentSource.close()");
  expect(segment).not.toContain("conn.close()");
});

test("done fallback renders the answer body through the component-aware formatter", async () => {
  const html = await pageHtml();
  const start = html.indexOf("done: function(e)");
  expect(start).toBeGreaterThan(-1);
  // Isolate the 'done' handler body up to the next handler ('answer_html:').
  const segment = html.slice(start, html.indexOf("answer_html: function(e)", start));
  // The fallback (when the trailing answer_html never arrives) must render via the
  // component-aware formatWebHtml — the same pipeline the server's answer_html uses
  // — so block components (Callout, Verdict, …) render as styled HTML, NOT via the
  // marked.js renderMarkdown whose sanitizing renderer escapes raw component tags.
  expect(segment).toContain("a.bodyEl.innerHTML = formatWebHtml(a.buffer)");
  expect(segment).not.toContain("renderMarkdown(");
  // Single linkify pass over the freshly-reset innerHTML (no double-linkify).
  expect(segment).toContain("linkifyCitations(a.bodyEl, a.citations)");
});

test("answer-body scope carries the component block CSS", async () => {
  const html = await pageHtml();
  // componentBlockCss(".answer-body") injects the callout rule under that scope.
  expect(html).toContain(".answer-body .callout");
  expect(html).toContain(".answer-body .verdict");
});
