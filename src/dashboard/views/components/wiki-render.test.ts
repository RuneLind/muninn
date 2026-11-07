import { test, expect } from "bun:test";
import { renderWikiPage } from "../wiki-page.ts";
import ts from "typescript";
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

// A size pin, so growth of the bundle every /wiki load inlines is a decision
// rather than drift. Measured 1,089,983 bytes (272,938 gzipped) on 2026-10-20;
// raise the bound in the PR that needs it. 2026-10-30: the effort page (work map
// P3) took it from 1,281,098 to 1,301,295 bytes (322,578 → 327,890 gzipped).
// 2026-10-31: the theme page (theme map P3) took it from 1,342,993 to
// 1,356,382 bytes (337,896 → 339,876 gzipped). 2026-11-03: the GitHub check's
// re-ask and «not refreshed» (your-work board P2) took it to 1,400,548 bytes.
// 2026-11-03: the board (your-work board P3) took it to 1,404,017 bytes.
// 2026-11-04: the card waiting on a selection (O5 gap 1) took it to 1,405,468 bytes.
// 2026-11-04: a Settled block on a page with no lane took it to 1,406,807 bytes.
// 2026-11-06: the decision inbox on the Your work card took it to 1,417,581 bytes,
// and its load-failure line and per-card sending state to 1,418,173, and its held repaints to 1,418,858.
// 2026-11-07: closing a card from the inbox (P3b: preview, Close, Still open) took it to 1,422,452,
// and its fix round (ruling hash, preview warnings, a validated kept-open store) to 1,423,473.
// 2026-11-07: moving the load-time code into `boot()` (wiki-browser split C1: two
// spaces of indentation on ~1,300 moved lines, the `wiki-shell-client.ts` entry)
// took it from 1,423,508 to 1,426,483 bytes (357,829 → 358,552 gzipped).
const WIKI_CLIENT_MAX_BYTES = 1_427_000;

test("wikiClientScript stays under its size pin", async () => {
  const js = await wikiClientScript();
  expect(Buffer.byteLength(js)).toBeLessThan(WIKI_CLIENT_MAX_BYTES);
});

// Ratchets on the reader shell while it is split into controllers (mimir plan
// muninn-wiki-browser-split): each number may only FALL. Raise one only in the
// PR that needs it, with a dated line saying why, like the size pin above.
// Counted from the TypeScript AST, so a comment or a string cannot move them.
// 2026-11-07, C1 baseline: 10,703 lines; 119 module-level `let`s (104 before C1,
// plus the 14 effectful consts that became `let x!: T` and `booted`).
const WIKI_BROWSER_MAX_LINES = 10_703;
const WIKI_BROWSER_MAX_MODULE_LETS = 119;

test("wiki-browser.ts does not grow: line count and module-level lets", async () => {
  const src = await Bun.file(new URL("./wiki-browser.ts", import.meta.url)).text();
  const sf = ts.createSourceFile("wiki-browser.ts", src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const lines = sf.getLineAndCharacterOfPosition(sf.getEnd()).line;
  let lets = 0;
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.Let) lets += st.declarationList.declarations.length;
  }
  expect(lines).toBeLessThanOrEqual(WIKI_BROWSER_MAX_LINES);
  expect(lets).toBeLessThanOrEqual(WIKI_BROWSER_MAX_MODULE_LETS);
});
