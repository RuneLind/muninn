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

test("the done handler orders the decline reasons through the SHARED helper", async () => {
  const html = await pageHtml();
  // The real `askDeclineReason` is injected as source (this page's client is an
  // inline script with no bundler), so the lowConfidence-before-noHits order — the
  // server sets `noHits` on BOTH decline branches — lives in exactly one place.
  expect(html).toContain("var askDeclineReason = function askDeclineReason(payload)");
  const start = html.indexOf("done: function(e)");
  const segment = html.slice(start, html.indexOf("answer_html: function(e)", start));
  expect(segment).toContain("askDeclineReason(d)");
  // The per-reason chain that used to live here is gone: BOTH pages now derive
  // the status through the shared `askStatusText`, whose truthiness guard is what
  // stops an unrecognised verdict rendering as "Answered from N sources".
  expect(segment).toContain("askStatusText(declined, a.citations.length)");
  expect(segment).not.toContain("declined === 'low_confidence'");
  // No second, hand-rolled ordering of the raw flags.
  expect(segment).not.toContain("d.lowConfidence");
  expect(segment).not.toContain("d.noHits");
});

test("answer-body scope carries the component block CSS", async () => {
  const html = await pageHtml();
  // componentBlockCss(".answer-body") injects the callout rule under that scope.
  expect(html).toContain(".answer-body .callout");
  expect(html).toContain(".answer-body .verdict");
});

/**
 * The inlined-function guard.
 *
 * `.toString()` serializes a body, NOT its dependencies. Round 4 of PR #485 added
 * a `toDeclineReason` call inside `askDeclineReason`, which is injected into this
 * page as source — the definition was never emitted, so the `done` handler threw
 * `ReferenceError` on EVERY ask (decline or not), in a handler with no try/catch:
 * the status line never left its streaming state, history stopped accumulating,
 * and the next ask deleted the previous card. It typechecked clean and no unit
 * test saw it. This EXECUTES what the page actually ships.
 */
test("every function injected into the page can actually run there", async () => {
  const html = await pageHtml();
  // Pull the injected declarations out of the rendered page and evaluate them in
  // one scope, exactly as the browser would.
  const names = ["DECLINE_REASONS", "toDeclineReason", "askDeclineReason", "askStatusText"];
  for (const n of names) {
    expect(html).toContain("var " + n + " = ");
  }
  const start = html.indexOf("var DECLINE_REASONS = ");
  const end = html.indexOf("var CORPUS = ");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const injected = html.slice(start, end);

  const run = new Function(
    injected + "\nreturn { askDeclineReason: askDeclineReason, askStatusText: askStatusText };",
  ) as () => {
    askDeclineReason: (p: Record<string, unknown>) => string | undefined;
    askStatusText: (d: string | undefined, n: number) => string;
  };
  const api = run();

  // The payload shapes src/research/ask.ts actually emits.
  expect(api.askDeclineReason({ noHits: true, lowConfidence: false, unreachable: true, declineReason: "unreachable" })).toBe("unreachable");
  expect(api.askDeclineReason({ noHits: true, lowConfidence: true })).toBe("low_confidence");
  expect(api.askDeclineReason({ noHits: true })).toBe("no_hits");
  // A successful answer — the case the ReferenceError also broke.
  expect(api.askDeclineReason({ noHits: false, lowConfidence: false })).toBeUndefined();
  expect(api.askStatusText(undefined, 2)).toBe("Answered from 2 sources");
  expect(api.askStatusText("unreachable", 0)).toMatch(/Search unavailable/);
});
