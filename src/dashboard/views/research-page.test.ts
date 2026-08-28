import { test, expect } from "bun:test";
import { renderResearchPage } from "./research-page.ts";
import { DECLINE_REASONS } from "../../wiki/ask-chat.ts";

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
test("every function injected into the page can actually run there, on EVERY arm", async () => {
  const html = await pageHtml();
  // Bounded by the markers the page emits, not by "the next unrelated var": a
  // positional window silently stops guarding whatever is added below it.
  const start = html.indexOf("// --- injected-fns:start ---");
  const end = html.indexOf("// --- injected-fns:end ---");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const injected = html.slice(start, end);

  // Discovery only sees `var NAME = function`, so the block's own DECLARATIONS
  // are held to that grammar — otherwise the guard silently stops covering an
  // arrow- or const-form injection while the page comment promises it does. A
  // future author gets a red test here, not a ReferenceError in someone's
  // browser. Anchored to the injection indent so a `const` or `=>` INSIDE a
  // transpiled function body (which is ordinary and fine) is not caught.
  const declarations = injected.split("\n").filter((l) => /^\s{4}(?:var|const|let)\s/.test(l));
  expect(declarations.length).toBeGreaterThan(0);
  for (const line of declarations) {
    expect(line).toMatch(/^\s{4}var \w+ = (?:function\b|\[|\{|")/);
  }

  // Discovered, not listed: a fifth injection is covered the day it lands.
  // Derived from the DECLARATION lines, never from the raw block — the block
  // carries prose, and a comment quoting the grammar (this page's does) otherwise
  // yields a phantom name whose only symptom is a confusing ReferenceError from
  // the return-object composition below.
  const names = declarations
    .map((l) => l.match(/^\s{4}var (\w+) = function/)?.[1])
    .filter((n): n is string => Boolean(n));
  expect(names).toContain("askDeclineReason");
  expect(names).toContain("askStatusText");

  const api = new Function(
    injected + "\nreturn {" + names.map((n) => n + ": " + n).join(",") + "};",
  )() as Record<string, (...args: unknown[]) => unknown>;

  // `new Function` resolves a free identifier only when its BRANCH runs, so
  // calling one arm proves nothing about the others. Round 4's bug happened to
  // sit on the first line; a dependency added to the `low_confidence` arm would
  // have shipped green. Drive every reason through every injected function.
  const reasons = [...DECLINE_REASONS, undefined, "from_the_future"];
  for (const [name, fn] of Object.entries(api)) {
    for (const reason of reasons) {
      for (const args of [[reason, 0], [{ declineReason: reason, noHits: true }], [{ noHits: true, lowConfidence: reason === "low_confidence" }]]) {
        try {
          fn(...args);
        } catch (err) {
          // A wrong-shaped argument throwing a TypeError is fine — these are two
          // different signatures. A ReferenceError is the bug: an identifier the
          // page never injected.
          if (err instanceof ReferenceError) {
            throw new Error(`injected ${name} references an identifier the page does not define (reason=${String(reason)}): ${(err as Error).message}`);
          }
        }
      }
    }
  }

  // …and the values are right, for the payload shapes src/research/ask.ts emits.
  const decline = api.askDeclineReason as (p: Record<string, unknown>) => string | undefined;
  const status = api.askStatusText as (d: string | undefined, n: number) => string;
  expect(decline({ noHits: true, lowConfidence: false, unreachable: true, declineReason: "unreachable" })).toBe("unreachable");
  expect(decline({ noHits: true, lowConfidence: true })).toBe("low_confidence");
  expect(decline({ noHits: true })).toBe("no_hits");
  expect(decline({ noHits: false, lowConfidence: false })).toBeUndefined();
  expect(status(undefined, 2)).toBe("Answered from 2 sources");
  expect(status("unreachable", 0)).toMatch(/Search unavailable/);
});
