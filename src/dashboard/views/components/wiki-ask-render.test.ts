import { test, expect } from "bun:test";
import { renderStreamingBody, askAnswerBodyHtml, enhanceConfidenceHtml } from "./wiki-ask-render.ts";

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

// ── FIX 1 empirical proof: the confidence chip must render on the REAL
// formatWebHtml output. formatWebHtml emits paragraphs as bare text nodes (no
// <p>/<li>), so the pre-fix DOM enhancer (querySelectorAll("p, li")) was a silent
// no-op on every render path. These pipe realistic verify blocks through the same
// formatter the reader paints and assert the chip markup lands. ─────────────────

// A realistic single-claim verify block (heading + reasoning + standalone
// Confidence line + Sources), exactly the shape buildClaimVerifyPrompt asks for.
const VERIFY_BLOCK = [
  "### ✅ Claim 1/2 — Rayleigh scattering makes the daytime sky blue",
  "",
  "Multiple physics references confirm shorter (blue) wavelengths scatter more.",
  "",
  "Confidence: 85/100",
  "",
  "Sources: https://example.com/rayleigh",
].join("\n");

test("renderStreamingBody injects the confidence chip on real formatWebHtml output", () => {
  const html = renderStreamingBody(VERIFY_BLOCK);
  // The chip span with the correct band + score is present…
  expect(html).toContain('<span class="wiki-fc-conf-chip hi">85/100</span>');
  expect(html).toContain('<span class="wiki-fc-conf-line">');
  expect(html).toContain('<span class="wiki-fc-conf-key">Confidence</span>');
  // …and the bare "Confidence: 85/100" text line is gone (was replaced, not left).
  expect(html).not.toContain("Confidence: 85/100");
});

test("confidence chip bands: hi ≥80, mid 50–79, lo <50", () => {
  const chip = (n: number) =>
    renderStreamingBody(`### ✅ Claim 1/1 — a\n\nReasoning.\n\nConfidence: ${n}/100`);
  expect(chip(80)).toContain('wiki-fc-conf-chip hi">80/100');
  expect(chip(79)).toContain('wiki-fc-conf-chip mid">79/100');
  expect(chip(50)).toContain('wiki-fc-conf-chip mid">50/100');
  expect(chip(49)).toContain('wiki-fc-conf-chip lo">49/100');
});

test("multiple verify blocks each get their own chip", () => {
  const answer = [
    "Fact-check results: mixed.",
    "",
    "### ✅ Claim 1/2 — The sky is blue",
    "",
    "Rayleigh scattering.",
    "",
    "Confidence: 85/100",
    "",
    "### ❌ Claim 2/2 — The moon is cheese",
    "",
    "No evidence.",
    "",
    "Confidence: 12/100",
  ].join("\n");
  const html = renderStreamingBody(answer);
  expect(html).toContain('wiki-fc-conf-chip hi">85/100');
  expect(html).toContain('wiki-fc-conf-chip lo">12/100');
  expect((html.match(/wiki-fc-conf-chip/g) || []).length).toBe(2);
});

test("enhanceConfidenceHtml is case-insensitive and clamps out-of-range scores", () => {
  const html = renderStreamingBody("### ✅ Claim 1/1 — a\n\nReasoning.\n\nconfidence: 150/100");
  expect(html).toContain('wiki-fc-conf-chip hi">100/100');
});

test("enhanceConfidenceHtml is idempotent (re-run does not double-inject)", () => {
  const once = renderStreamingBody(VERIFY_BLOCK);
  const twice = enhanceConfidenceHtml(once);
  expect(twice).toBe(once);
  expect((twice.match(/wiki-fc-conf-chip/g) || []).length).toBe(1);
});

test("enhanceConfidenceHtml is a no-op on an Ask/Explain answer (no Confidence line)", () => {
  const askHtml = renderStreamingBody("## Overview\n\nSome cited answer with no confidence score.");
  expect(askHtml).not.toContain("wiki-fc-conf-chip");
});

test("askAnswerBodyHtml enhances a server-rendered answer_html carrying a confidence line", () => {
  // A rehydrated / answer_html turn passes final HTML through the html branch —
  // it must still get the chip (server renders the same bare-text confidence line).
  const serverHtml = "<h4>✅ Claim 1/1 — a</h4>\nReasoning.\n\nConfidence: 73/100";
  const body = askAnswerBodyHtml(serverHtml, "", "");
  expect(body).toContain('wiki-fc-conf-chip mid">73/100');
});
