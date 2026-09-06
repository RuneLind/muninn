import { test, expect } from "bun:test";
import { renderWikiPage } from "../wiki-page.ts";
import { wikiClientScript } from "./wiki-client.ts";

/**
 * Guards the PR-5 refactor: the /wiki page's client logic moved from a
 * hand-written inline IIFE to a real bundled TS entrypoint. If the Bun.build of
 * `wiki-browser.ts` regresses (syntax error, bad import), `renderWikiPage()`
 * rejects and this fails at render time — which is exactly when the route
 * would 500 in prod.
 */

test("wikiClientScript bundles to a non-empty IIFE", async () => {
  const js = await wikiClientScript();
  expect(js.length).toBeGreaterThan(1000);
  // Bundled function names survive (minify: false) — a cheap sanity check that
  // the real entrypoint, not an empty stub, got bundled.
  expect(js).toContain("/api/wiki/pages");
  expect(js).toContain("/api/wiki/page?name=");
});

test("wikiClientScript bundles the client-side mermaid enhancer", async () => {
  const js = await wikiClientScript();
  // The enhance logic and the pinned CDN URL are reachable in the wiki client
  // bundle (so a headless-Chromium harness can exercise the render path).
  expect(js).toContain("code.language-mermaid");
  expect(js).toContain("https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js");
});

test("renderWikiPage embeds the bundled script and the pane skeleton", async () => {
  const html = await renderWikiPage();
  expect(html).toContain("<!DOCTYPE html>");
  // Skeleton DOM ids the client script wires against.
  for (const id of ["wikiSearch", "wikiList", "wikiCount", "articleWrap", "connBody", "wikiSort"]) {
    expect(html).toContain(`id="${id}"`);
  }
  // The bundle is inlined, not left as an empty <script>.
  expect(html).toContain("/api/wiki/pages");
  // The old local esc() helper is gone (replaced by the shared escHtml).
  expect(html).not.toContain("function esc(s)");
  // No askBot ⇒ no "Answered by" line in the Ask tab.
  expect(html).not.toContain("Answered by");
});

/**
 * The reader is an INLINED bundle: whatever the entrypoint transitively imports
 * lands inside the page's own <script> tag, and a string literal containing
 * `</script>` closes that tag mid-bundle — the browser then runs a truncated
 * script ("Unexpected end of input") and the reader is blank. Measured when
 * `wiki-embed.ts` imported `EXPLAINER_SANDBOX` from `explainer-bridge.ts`,
 * whose `EXPLAINER_BRIDGE_SCRIPT` is exactly such a string: every e2e spec
 * red. The constant lives in `explainer-sandbox.ts` for that reason, and this
 * pins the property on the page as served rather than on any one import.
 */
test("the inlined reader bundle never carries a literal </script>", async () => {
  const js = await wikiClientScript();
  expect(js).not.toContain("</script>");
  // …and the page as served keeps the entrypoint's LAST statement inside the
  // tag that the bundle opened — the property the browser actually depends on.
  const html = await renderWikiPage();
  const tail = js.slice(-60);
  const at = html.indexOf(tail);
  expect(at).toBeGreaterThan(0);
  expect(html.slice(html.lastIndexOf("<script", at), at)).not.toContain("</script>");
});

test("renderWikiPage shows the Ask tab's resolved synthesis bot", async () => {
  const owner = await renderWikiPage({
    selected: "jarvis",
    askBot: { bot: "jarvis", connector: "claude-sdk", model: "claude-sonnet-5", origin: "owner" },
  });
  expect(owner).toContain("Answered by <strong>jarvis</strong>");
  expect(owner).toContain("claude-sdk · claude-sonnet-5");
  expect(owner).toContain("this wiki's owner");

  const fallback = await renderWikiPage({
    selected: "mimir",
    askBot: { bot: "melosys", connector: "copilot-sdk", model: "claude-sonnet", origin: "fallback" },
  });
  expect(fallback).toContain("Answered by <strong>melosys</strong>");
  expect(fallback).toContain("research-bot fallback");
});
