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
