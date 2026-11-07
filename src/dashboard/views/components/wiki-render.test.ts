import { test, expect } from "bun:test";
import { renderWikiPage } from "../wiki-page.ts";
import ts from "typescript";
import { wikiClientScript } from "./wiki-client.ts";

/**
 * Guards the PR-5 refactor: the /wiki page's client logic moved from a
 * hand-written inline IIFE to a real bundled TS entrypoint. If the Bun.build of
 * `wiki-shell-client.ts` (and the `wiki-browser.ts` it imports) regresses
 * (syntax error, bad import), `renderWikiPage()`
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
// 2026-11-07: wrapping the load-time code in `boot()` (wiki-browser split C1) took
// it from 1,423,508 to 1,426,483 bytes (357,829 → 358,552 gzipped); the readable
// decision inbox then took it to 1,428,716.
// 2026-11-07: the left pane in its own module behind a port (wiki-browser split C2)
// took it from 1,428,731 to 1,433,009 bytes (359,172 → 360,612 gzipped).
const WIKI_CLIENT_MAX_BYTES = 1_434_000;

test("wikiClientScript stays under its size pin", async () => {
  const js = await wikiClientScript();
  expect(Buffer.byteLength(js)).toBeLessThan(WIKI_CLIENT_MAX_BYTES);
});

// Ratchets on the reader shell while it is split into controllers (mimir plan
// muninn-wiki-browser-split): each number may only FALL. Raise one only in the
// PR that needs it, with a dated line saying why, like the size pin above.
// Lines: the line breaks TypeScript sees (its 0-based index of the last line),
// which for a file ending in a newline is every physical line, comments and
// blanks included, so adding any line moves it.
// Lets: `let` statements directly at the top level of the module.
// Vars: any `var` whose function scope is the module fails outright, however
// deeply it sits in top-level blocks (if, try, for, plain braces), because it
// hoists to module scope and would otherwise dodge the `let` count. A `var`
// inside a function, method, arrow, class body or namespace is not module state.
// 2026-11-07, C1 baseline: 10,703 lines; 119 module-level `let`s (104 before C1,
// plus the 14 effectful consts that became `let x!: T` and `booted`).
// 2026-11-07, C2 (the left pane to `wiki-rail-controller.ts`, shared state to
// `wiki-shell-state.ts`): 8,850 lines; 103 module-level `let`s. Its fix round
// (the Group menu's focus helpers to the rail, the shared pills to a leaf): 8,773.
const WIKI_BROWSER_MAX_LINES = 8_773;
const WIKI_BROWSER_MAX_MODULE_LETS = 103;

function moduleScopeDeclarations(src: string): { lines: number; lets: number; vars: string[] } {
  const sf = ts.createSourceFile("module.ts", src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  let lets = 0;
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.Let) lets += st.declarationList.declarations.length;
  }
  const vars: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isModuleDeclaration(node)) return;
    // BlockScoped is Let | Const | Using (AwaitUsing is Const | Using), so `using` is not a var.
    if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)) {
      vars.push(...node.declarations.map((d) => d.name.getText(sf)));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { lines: sf.getLineAndCharacterOfPosition(sf.getEnd()).line, lets, vars };
}

test("moduleScopeDeclarations flags every module-scoped var and nothing else", () => {
  expect(moduleScopeDeclarations("var a = 1;\n").vars).toEqual(["a"]);
  expect(moduleScopeDeclarations("if (true) { var b = 1; }\n").vars).toEqual(["b"]);
  expect(moduleScopeDeclarations("try { var c = 1; } catch {}\n").vars).toEqual(["c"]);
  expect(moduleScopeDeclarations("for (var i = 0; i < 1; i++) {}\n").vars).toEqual(["i"]);
  expect(moduleScopeDeclarations("function f() { var d = 1; }\nconst g = () => { var e = 1; };\nclass K { m() { var h = 1; } static { var k = 1; } }\n").vars).toEqual([]);
  expect(moduleScopeDeclarations("let x = 1;\nconst y = 2;\n")).toEqual({ lines: 2, lets: 1, vars: [] });
  expect(moduleScopeDeclarations("using u = null;\nawait using w = null;\n").vars).toEqual([]);
  expect(moduleScopeDeclarations("if (true) { let z = 1; }\n").lets).toBe(0);
});

test("wiki-browser.ts does not grow: line count and module-level lets", async () => {
  const src = await Bun.file(new URL("./wiki-browser.ts", import.meta.url)).text();
  const { lines, lets, vars } = moduleScopeDeclarations(src);
  expect(lines).toBeLessThanOrEqual(WIKI_BROWSER_MAX_LINES);
  expect(lets).toBeLessThanOrEqual(WIKI_BROWSER_MAX_MODULE_LETS);
  expect(vars).toEqual([]);
});

// The same ratchet on the modules the split creates; each number may only fall.
// 2026-11-07, C2 fix round: the baselines as C2 left them.
const SPLIT_MODULE_CEILINGS: [file: string, maxLines: number, maxLets: number][] = [
  ["wiki-rail-controller.ts", 2_107, 13],
  ["wiki-shell-state.ts", 57, 4],
  ["wiki-status-pills.ts", 29, 0],
];

for (const [file, maxLines, maxLets] of SPLIT_MODULE_CEILINGS) {
  test(`${file} does not grow: line count and module-level lets`, async () => {
    const { lines, lets, vars } = moduleScopeDeclarations(await Bun.file(new URL(`./${file}`, import.meta.url)).text());
    expect(lines).toBeLessThanOrEqual(maxLines);
    expect(lets).toBeLessThanOrEqual(maxLets);
    expect(vars).toEqual([]);
  });
}
