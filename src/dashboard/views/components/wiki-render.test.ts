import { test, expect } from "bun:test";
import { renderWikiPage, getWikiAssets } from "../wiki-page.ts";
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
  // String literals survive minification — a cheap sanity check that the real
  // entrypoint, not an empty stub, got bundled.
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

test("renderWikiPage links the hashed script and stylesheet and carries the pane skeleton", async () => {
  const html = await renderWikiPage();
  const { js, css } = await getWikiAssets();
  expect(html).toContain("<!DOCTYPE html>");
  // Skeleton DOM ids the client script wires against.
  for (const id of ["wikiSearch", "wikiList", "wikiCount", "articleWrap", "connBody", "wikiSort"]) {
    expect(html).toContain(`id="${id}"`);
  }
  // Both assets are linked at their content-hashed URLs, and neither is inlined.
  expect(js.path).toMatch(/^\/wiki\/assets\/wiki\.[0-9a-f]{16}\.js$/);
  expect(css.path).toMatch(/^\/wiki\/assets\/wiki\.[0-9a-f]{16}\.css$/);
  expect(html).toContain(`<script src="${js.path}"></script>`);
  expect(html).toContain(`<link rel="stylesheet" href="${css.path}">`);
  expect(html).not.toContain(js.body.slice(0, 2000));
  expect(html).not.toContain(js.body.slice(-2000));
  expect(html).not.toContain(css.body.slice(0, 2000));
  // The hash is of the served bytes, and the script is the memoized bundle.
  expect(js.body).toBe(await wikiClientScript());
  expect(js.path).toContain(new Bun.CryptoHasher("sha256").update(js.body).digest("hex").slice(0, 16));
  expect(css.path).toContain(new Bun.CryptoHasher("sha256").update(css.body).digest("hex").slice(0, 16));
  // The stylesheet is the reader's (spot-check two of its rules).
  expect(css.body).toContain(".wiki-layout {");
  expect(css.body).toContain("--wiki-rail-w");
  // A plain script tag after the inline globals: no defer/async, so it runs
  // where the inline bundle did — after `window.__WIKI_*__` is set, before the
  // presence script.
  const at = html.indexOf(`<script src="${js.path}">`);
  expect(html.lastIndexOf("window.__WIKI_FIND_ROWS__", at)).toBeGreaterThan(0);
  expect(html.indexOf("wikiPresence", at)).toBeGreaterThan(at);
  // The old local esc() helper is gone (replaced by the shared escHtml).
  expect(html).not.toContain("function esc(s)");
  // No askBot => no "Answered by" line in the Ask tab.
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

// A size pin, so growth of the bundle every /wiki load fetches is a decision
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
// took it from 1,428,731 to 1,433,009 bytes (359,172 → 360,612 gzipped); the triage
// status line and its Details table (visibility PR 2) took it to 1,436,421.
// 2026-11-07: Run now on that line (visibility PR 3) took it to 1,438,444 bytes (361,992 gzipped).
// 2026-11-07: the STALE tab, the effort page and the ⋯ menus behind ports (wiki-browser
// split C3), merged onto that, took it to 1,440,459 bytes (363,876 gzipped).
// 2026-11-07: served as a hashed asset and built with `minify: true` (arch review
// 2026-11 B3): 1,436,421 -> 806,603 bytes (361,526 -> 271,805 gzipped). Every
// line above counts the unminified bundle; this pin and later ones the minified.
// 2026-11-08: merged with Run now, B2's moves and C3 (above): 809,410 bytes (273,708 gzipped).
// C4 (Ask to wiki-ask-controller.ts): 809,714 bytes, under the same pin.
// 2026-11-08, C5 (the article tools, right pane and series editor behind
// ports): 811,207 bytes (275,384 gzipped); the port reads (`deps.x()`) cost the bytes.
// 2026-11-08, render-richer PR 2 (reader shapes: number columns, verdict cells, the
// label grid, in the bundled formatWebHtml): 814,851 bytes (276,668 gzipped); its
// fix round 1 (id and date headers, traffic lights, the nowrap number span): 816,448 (277,205).
// 2026-11-08: mermaid in the reader's palette, readable size and the ⤢ view
// (wiki-mermaid.ts + mermaid-theme.ts): 819,709 bytes (278,693 gzipped); its fix
// round's categorical colours for every other diagram type: 824,039 (280,294 gzipped);
// its batch 2 (measured smallest text, the gantt redraw, the header search): 825,630;
// its batch 3 (dialog sizing, DOM id rescope, redrawn peek and card copies): 829,016 (281,928 gzipped).
// Merged with render-richer PR 2 (both sides above): 834,461 bytes (283,849 gzipped).
// Its fix round 2 (quadrant colours, the `;` classDef scanner, four dead theme
// variables removed): 835,319 bytes (284,202 gzipped).
// 2026-11-08, render-richer PR 3 (before → after chips in the bundled
// formatWebHtml, the section bar controller): 823,635 bytes (279,617 gzipped);
// its fix round 1 batch 2 (chip rules, quoted-title unchip): 825,675 (280,463);
// batch 3 (sliding reading line, reveal pin, title rule): 826,252 (280,699).
// Merged with the mermaid PR (#833, both sides above): 844,882 bytes (287,616 gzipped).
// PR 3's fix round 1 batch 4 (the chip's punctuation class): 845,061 (287,697).
// Fix round 2 batch 2 (opening-bracket class, day.month, unchip scope): 845,569.
// 2026-11-09, issue #623 (the Pages button and the rail panel's open, close and
// Escape in wiki-pane-toggle.ts): 846,217 bytes (288,039 gzipped).
// Its fix round 1 batch 1 (focus into and out of the panel, the menu's Escape): 846,591 (288,093).
// Batch 2 (closing on Back, on an effort link and on leaving the narrow width): 846,727 (288,154).
const WIKI_CLIENT_MAX_BYTES = 847_000;

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
// 2026-11-07, C3 (the STALE tab, the effort page and the ⋯ menus to their own
// controllers, the toolbar's boot code to the rail): 7,384 lines; 71 lets.
// 2026-11-08, C4 (the Ask tab to `wiki-ask-controller.ts`): 4,994 lines; 62 lets.
// 2026-11-08, C5 (the article tools and right pane to `wiki-article-controller.ts`,
// the series editor to `wiki-series-controller.ts`): 3,458 lines; 51 lets.
// 2026-11-08, follow-up (the work-map cache to `wiki-work-map-cache.ts`, four
// `RailDeps` relays gone): 3,450 lines; 51 lets.
// 2026-11-08, render-richer PR 3: the section bar's import and its one mount
// call after each page render (the bar lives in `wiki-section-bar.ts`): 3,452.
// 2026-11-09, issue #623: `closeRailPanel()` in `loadPageByRelPath`, where a
// rail row's click lands: 3,453.
const WIKI_BROWSER_MAX_LINES = 3_453;
const WIKI_BROWSER_MAX_MODULE_LETS = 51;

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
// 2026-11-07, C3: three new controllers at their counts. The rail RAISED from
// 2,107 / 13 to 2,309 / 21: it took the toolbar's boot code and its 9 lets (the
// View options checkboxes, Filters, the options pane, the wiki picker,
// `sortTouched`) and `railControlSelector`/`editWorkGroup`, and gave
// `revealOnRender` to the shared state. The shared state went from 57 / 4 to
// 50 / 3: `workMapThemes` and `workFacts` have one writer (the shell) and moved
// back to it, `revealOnRender` (written by the shell and the rail) moved in.
// C3 fix round: the rail 2,301 / 16. Five of those lets (`effortsBox`,
// `retiredBox`, `filtersDetails`, `filtersBtn`, `wikiSel`) were read only in
// `registerRailOptions` and are now its locals.
// 2026-11-08, C4: the Ask controller at its count (the shell's 9 Ask lets and `deps`).
// 2026-11-08, C5: the article and series controllers at their counts (the
// shell's 9 article lets and 2 series lets, plus each one's `deps`).
// 2026-11-08, follow-up: the work-map cache's 5 lets out of the effort
// controller (333 / 8 → 235 / 3) into `wiki-work-map-cache.ts`; the rail 2,298.
const SPLIT_MODULE_CEILINGS: [file: string, maxLines: number, maxLets: number][] = [
  ["wiki-rail-controller.ts", 2_298, 16],
  ["wiki-shell-state.ts", 50, 3],
  ["wiki-status-pills.ts", 29, 0],
  ["wiki-stale-controller.ts", 509, 18],
  ["wiki-effort-controller.ts", 235, 3],
  ["wiki-work-map-cache.ts", 124, 5],
  ["wiki-menus-controller.ts", 638, 2],
  ["wiki-ask-controller.ts", 2_503, 10],
  ["wiki-article-controller.ts", 1_182, 10],
  ["wiki-series-controller.ts", 548, 3],
];

for (const [file, maxLines, maxLets] of SPLIT_MODULE_CEILINGS) {
  test(`${file} does not grow: line count and module-level lets`, async () => {
    const { lines, lets, vars } = moduleScopeDeclarations(await Bun.file(new URL(`./${file}`, import.meta.url)).text());
    expect(lines).toBeLessThanOrEqual(maxLines);
    expect(lets).toBeLessThanOrEqual(maxLets);
    expect(vars).toEqual([]);
  });
}
