import { test, expect } from "bun:test";
import vm from "node:vm";
import { escHtml } from "./escape.ts";
import { sumCandidatesScript } from "./sum-candidates.ts";

/**
 * A capture candidate's url is not http-gated upstream (the anthropic watcher's
 * url, x.ts's `articleUrl ?? url` fallback), so the title anchor gates its scheme
 * like the other summaries sinks. Runs the page's own renderCandidateRow in a vm.
 */
function renderRow(c: Record<string, unknown>): string {
  const ctx: Record<string, unknown> = { esc: escHtml, AUTHOR_TIERS: null, console };
  vm.createContext(ctx);
  vm.runInContext(sumCandidatesScript(), ctx);
  return (ctx.renderCandidateRow as (c: unknown) => string)(c);
}

const base = { id: "c1", title: "A title", score: 0.8, status: "new", source: "anthropic", kind: "release" };

test("a javascript: url renders no link", () => {
  const html = renderRow({ ...base, url: "javascript:alert(1)" });
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain('<div class="candidate-title">A title</div>');
});

test("an https url still links", () => {
  const html = renderRow({ ...base, url: "https://example.com/post" });
  expect(html).toContain('<a href="https://example.com/post" target="_blank" rel="noopener">A title</a>');
});
