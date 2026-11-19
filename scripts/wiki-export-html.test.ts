import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { SYSTEM_PALETTES } from "../src/dashboard/views/components/palettes.ts";
import { COMPACT_WORDS, DL_COMPACT_SHOWN, MORE_WORDS } from "../src/format/reader-lens.ts";
import {
  THEME_MODES,
  assembleCss,
  buildStandaloneHtml,
  cleanExport,
  exportLabels,
  exportScript,
  normalizeSelector,
  parseCliArgs,
  parseCss,
  renameSvgIds,
  restoreMermaid,
  selectorCandidates,
  selfCheck,
  sheetSources,
  stashMermaid,
  stateVariants,
  type RuleNode,
} from "./wiki-export-html-lib.ts";

// A mermaid SVG as the reader renders one: a scoped <style> with a child combinator.
// happy-dom 21.0.4 drops everything after such a <style> when it parses it in place.
const mermaid = (id: string, fill = "red") =>
  `<svg id="${id}" class="flowchart"><style>#${id} .node>rect{fill:${fill}}</style>` +
  `<marker id="${id}_flowchart-v2-pointEnd"><path d="M0,0"/></marker>` +
  `<path marker-end="url(#${id}_flowchart-v2-pointEnd)"/></svg>`;

const head =
  `<div class="wiki-article-head"><h1>T</h1><div class="wiki-meta-row">` +
  `<button type="button" class="wiki-count-pill wiki-count-pill-decisions">2 decisions</button>` +
  `<span id="wikiStalePill" class="wiki-stale-pill-slot"><button class="wiki-stale-pill">0 stale</button></span>` +
  `<div class="wiki-lens-switch"><button data-lens="overview">Overview</button><button data-lens="all" class="on">All</button><button data-lens="agent">Agent</button></div>` +
  `</div><div class="wiki-prov-strip">the 1 session that wrote this page cost $6.53</div></div>`;

const article =
  `<div class="wiki-article lens-all">` +
  `<h3 id="brief">Brief<button type="button" class="wiki-wt-btn" data-walkthrough-btn="">walk</button></h3>` +
  `<details class="fold" data-export-was-open="0" open><summary>Design</summary>` +
  `<div class="diagram"><div class="diagram-body">${mermaid("wm-1")}</div><button type="button" class="diagram-expand">⤢</button></div>` +
  `</details>` +
  `<details class="fold" data-export-was-open="1" open><summary>Open fold</summary>body</details>` +
  `<section class="vc vc-kind-range"><span class="vc-group"><button type="button" class="vc-btn" data-vc-mode="chart">Chart</button></span></section>` +
  `<section class="decision-log"><div class="dl-item"><span class="dl-text">D1 <button type="button" class="dl-more">more</button><span class="dl-rest">rest</span></span></div>` +
  `<div class="dl-item"><span class="dl-text">D2</span></div>` +
  `<button type="button" class="dl-all" aria-expanded="false">Show all 7 decisions</button></section>` +
  `<p><a href="https://docs.flowcase.com/cvs">ext</a> <a href="http://localhost:3010/wiki?x=1">local</a> ` +
  `<a href="/wiki?wiki=mimir">rel</a> <a href="#cost">hash</a></p>` +
  `<form class="q-card"><input type="radio"><textarea></textarea><button type="button" class="q-send">Send</button></form>` +
  `</div>`;

const captured = () => ({ headHtml: head, articleHtml: article, darkSvgs: [mermaid("wm-1", "blue")] });

describe("normalizeSelector", () => {
  test("drops theme and palette attributes on html and :root", () => {
    expect(normalizeSelector('html[data-theme="dark"] .tldr')).toBe("html .tldr");
    expect(normalizeSelector('html[data-palette="reading"]')).toBe("html");
    expect(normalizeSelector(':root[data-theme="light"] .x')).toBe(":root .x");
    expect(normalizeSelector("html:not([data-theme]) .x")).toBe("html .x");
  });

  test("drops dynamic pseudo-classes and pseudo-elements, keeps structural ones", () => {
    expect(normalizeSelector(".btn:hover")).toBe(".btn");
    expect(normalizeSelector(".fold > summary::before")).toBe(".fold > summary");
    expect(normalizeSelector("details summary::-webkit-details-marker")).toBe("details summary");
    expect(normalizeSelector("li:first-child:not(.x)")).toBe("li:first-child:not(.x)");
  });
});

describe("selectorCandidates and assembleCss", () => {
  const tree: RuleNode[] = [
    { k: "style", sel: ".tldr", css: ".tldr { color: red; }" },
    { k: "style", sel: ".unused", css: ".unused { color: blue; }" },
    { k: "style", sel: 'html[data-theme="dark"] .tldr', css: 'html[data-theme="dark"] .tldr { color: white; }' },
    { k: "keep", css: "@keyframes spin { to { transform: rotate(1turn); } }" },
    { k: "group", head: "@media (prefers-color-scheme: dark) ", kids: [{ k: "style", sel: ".tldr", css: ".tldr { color: pink; }" }] },
    { k: "group", head: "@media print ", kids: [{ k: "style", sel: ".unused", css: ".unused { x: y; }" }] },
  ];

  test("lists each selector and its normalized form once, inside groups too", () => {
    expect(selectorCandidates(tree).sort()).toEqual(['html[data-theme="dark"] .tldr', ".tldr", ".unused", "html .tldr"].sort());
  });

  test("keeps matched rules, theme variants of matched rules, and keep-nodes; drops a group left empty", () => {
    const css = assembleCss(tree, new Set([".tldr", "html .tldr"]));
    expect(css).toContain(".tldr { color: red; }");
    expect(css).toContain('html[data-theme="dark"] .tldr { color: white; }');
    expect(css).toContain("@keyframes spin");
    expect(css).toContain("@media (prefers-color-scheme: dark) {\n.tldr { color: pink; }\n}");
    expect(css).not.toContain(".unused");
    expect(css).not.toContain("@media print");
  });
});

describe("stashMermaid", () => {
  test("round-trips the HTML unchanged and stashes nested SVGs whole", () => {
    const html = `<p>a</p>${mermaid("wm-1")}<p>b</p><svg id="wm-2"><svg><g/></svg><style>.a>.b{}</style></svg><p>c</p>`;
    const s = stashMermaid(html);
    expect(s.svgs).toHaveLength(2);
    expect(s.html).toBe('<p>a</p><span data-export-svg="0"></span><p>b</p><span data-export-svg="1"></span><p>c</p>');
    expect(restoreMermaid(s.html, s.svgs)).toBe(html);
  });

  test("stashes chart SVGs too, since any SVG <style> trips happy-dom", () => {
    const html = '<svg class="vc-svg"><rect/></svg>';
    expect(stashMermaid(html)).toEqual({ html: '<span data-export-svg="0"></span>', svgs: [html] });
  });
});

describe("renameSvgIds", () => {
  test("renames the id and the ids it prefixes, never a longer id", () => {
    const out = renameSvgIds(`${mermaid("wm-1")}<g id="wm-10"/>`, "wm-1", "-dark");
    expect(out).toContain('id="wm-1-dark"');
    expect(out).toContain("#wm-1-dark .node>rect");
    expect(out).toContain('id="wm-1-dark_flowchart-v2-pointEnd"');
    expect(out).toContain("url(#wm-1-dark_flowchart-v2-pointEnd)");
    expect(out).toContain('id="wm-10"');
  });
});

describe("cleanExport", () => {
  test("keeps everything after a mermaid diagram (happy-dom drops it when parsing the SVG in place)", () => {
    const { articleHtml } = cleanExport(captured());
    expect(articleHtml.match(/<details/g)).toHaveLength(2);
    expect(articleHtml.match(/class="dl-item"/g)).toHaveLength(2);
    expect(articleHtml).toContain('href="https://docs.flowcase.com/cvs"');
  });

  test("pairs each diagram with its dark render, the dark copy's ids renamed", () => {
    const { articleHtml } = cleanExport(captured());
    expect(articleHtml).toContain('<div class="export-mm"><div class="export-mm-light"><svg id="wm-1"');
    expect(articleHtml).toContain('<div class="export-mm-dark"><svg id="wm-1-dark"');
    expect(articleHtml).toContain("#wm-1 .node>rect{fill:red}");
    expect(articleHtml).toContain("#wm-1-dark .node>rect{fill:blue}");
  });

  test("leaves a diagram alone when the dark pass rendered none for it", () => {
    const { articleHtml } = cleanExport({ ...captured(), darkSvgs: [] });
    expect(articleHtml).not.toContain("export-mm");
    expect(articleHtml).toContain('<svg id="wm-1"');
  });

  test("removes reader chrome: staleness pills, the provenance strip, the walkthrough button", () => {
    const { headHtml, articleHtml } = cleanExport(captured());
    expect(headHtml).not.toContain("wikiStalePill");
    expect(headHtml).not.toContain("wiki-prov-strip");
    expect(articleHtml).not.toContain("data-walkthrough-btn");
    expect(headHtml).toContain("<h1>T</h1>");
  });

  test("keeps external and in-page links, turns links into the local reader into text", () => {
    const { articleHtml } = cleanExport(captured());
    expect(articleHtml).toContain('<a href="https://docs.flowcase.com/cvs" target="_blank" rel="noopener">ext</a>');
    expect(articleHtml).toContain('<a data-export-dead="">local</a>');
    expect(articleHtml).toContain('<a data-export-dead="">rel</a>');
    expect(articleHtml).toContain('<a href="#cost">hash</a>');
  });

  test("puts folds back as authored and drops the capture marker", () => {
    const { articleHtml } = cleanExport(captured());
    expect(articleHtml).toContain('<details class="fold"><summary>Design</summary>');
    expect(articleHtml).toContain('<details class="fold" open=""><summary>Open fold</summary>');
    expect(articleHtml).not.toContain("data-export-was-open");
  });

  test("disables controls the export does not drive and leaves the wired ones alone", () => {
    const { headHtml, articleHtml } = cleanExport(captured());
    const all = headHtml + articleHtml;
    expect(all).toContain('<input type="radio" disabled="" title="Works in the muninn reader">');
    expect(all).toContain('<button type="button" class="q-send" disabled="" title="Works in the muninn reader">');
    for (const wired of ["dl-more", "diagram-expand", 'data-vc-mode="chart"', "wiki-count-pill-decisions", 'data-lens="overview"']) {
      const tag = all.slice(all.lastIndexOf("<button", all.indexOf(wired)), all.indexOf(">", all.indexOf(wired)) + 1);
      expect(tag).not.toContain("disabled");
    }
  });
});

describe("stateVariants", () => {
  test("adds the states the page's script switches to, mermaid intact", () => {
    const { articleHtml } = cleanExport(captured());
    const [states = "", overview = ""] = stateVariants(articleHtml);
    expect(states).toContain("vc-mode-table");
    expect(states).toContain('class="dl-item dl-expanded"');
    expect(states).toContain('<details class="fold" open=""><summary>Design</summary>');
    expect(states.match(/class="dl-item/g)).toHaveLength(2);
    expect(states).toContain('<svg id="wm-1-dark"');
    expect(overview).toContain('class="wiki-article lens-overview"');
  });
});

describe("buildStandaloneHtml", () => {
  const html = buildStandaloneHtml({
    title: 'A <plan> & "quotes"',
    description: "d",
    css: ".tldr{color:red}",
    headHtml: '<div class="wiki-article-head"><h1>A</h1></div>',
    articleHtml: '<div class="wiki-article lens-all">body</div>',
    source: "mimir/plans/x.mdx",
    date: "2026-11-18",
  });

  test("is one self-contained document: no stylesheet links, no external scripts", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain(".tldr{color:red}");
    expect(html).toContain('<div class="wiki-article lens-all">body</div>');
  });

  test("escapes the title and names its source", () => {
    expect(html).toContain("<title>A &lt;plan&gt; &amp; &quot;quotes&quot;</title>");
    expect(html).toContain("Exported 2026-11-18 from mimir/plans/x.mdx.");
  });

  test("cycles Auto, then light and dark with the reader's system palettes", () => {
    expect(THEME_MODES).toEqual([
      ["", "", "◐ Auto"],
      ["light", SYSTEM_PALETTES.light, "☀ Light"],
      ["dark", SYSTEM_PALETTES.dark, "☾ Dark"],
    ]);
    expect(html).toContain(JSON.stringify(THEME_MODES));
  });
});

describe("fix round 1 batch 1: CSS from source, :target, wide tables", () => {
  test("parseCss keeps each style rule's source text verbatim, a var() shorthand and its override included", () => {
    const src = ".tldr { border: 1px solid var(--line); border-left-color: var(--accent); }\n.other{color:red}";
    const tree = parseCss(src);
    expect(tree).toEqual([
      { k: "style", sel: ".tldr", css: ".tldr { border: 1px solid var(--line); border-left-color: var(--accent); }" },
      { k: "style", sel: ".other", css: ".other{color:red}" },
    ]);
    expect(assembleCss(tree, new Set([".tldr"]))).toBe(".tldr { border: 1px solid var(--line); border-left-color: var(--accent); }");
  });

  test("parseCss recurses into grouping at-rules and keeps keyframes and font-face whole", () => {
    const src =
      "@media (prefers-color-scheme: dark) { :root { --bg: #000; } .a, .b > .c { color: white; } }\n" +
      "@supports (display: grid) { @container card (min-width: 400px) { .g { display: grid; } } }\n" +
      "@keyframes spin { from { transform: none; } to { transform: rotate(1turn); } }\n" +
      "@font-face { font-family: X; src: local(X); }";
    expect(parseCss(src)).toEqual([
      { k: "group", head: "@media (prefers-color-scheme: dark) ", kids: [
        { k: "style", sel: ":root", css: ":root { --bg: #000; }" },
        { k: "style", sel: ".a, .b > .c", css: ".a, .b > .c { color: white; }" },
      ] },
      { k: "group", head: "@supports (display: grid) ", kids: [
        { k: "group", head: "@container card (min-width: 400px) ", kids: [{ k: "style", sel: ".g", css: ".g { display: grid; }" }] },
      ] },
      { k: "keep", css: "@keyframes spin { from { transform: none; } to { transform: rotate(1turn); } }" },
      { k: "keep", css: "@font-face { font-family: X; src: local(X); }" },
    ]);
  });

  test("parseCss skips comments and statement at-rules, and reads braces inside strings and comments as text", () => {
    const src = '@charset "utf-8";\n@import url("x.css");\n/* a { b } */\n.q::before { content: "}{"; }\n.r { color: red; /* } */ }';
    expect(parseCss(src)).toEqual([
      { k: "style", sel: ".q::before", css: '.q::before { content: "}{"; }' },
      { k: "style", sel: ".r", css: ".r { color: red; /* } */ }" },
    ]);
  });

  test("normalizeSelector drops :target so jump highlights survive pruning", () => {
    expect(normalizeSelector(".dl-item:target")).toBe(".dl-item");
    expect(normalizeSelector(".cb-row:target > .cb-id")).toBe(".cb-row > .cb-id");
  });

  test("the shell clips sideways overflow and gives each bare table its own scroll box (layout: browser test)", () => {
    const html = buildStandaloneHtml({ title: "t", description: "", css: "", headHtml: "", articleHtml: "", source: "w/p", date: "d" });
    const rule = /\.export-shell > \.wiki-article-wrap \{([^}]*)\}/.exec(html)?.[1] ?? "";
    expect(rule).toContain("overflow-x: clip");
    const { articleHtml } = cleanExport({
      headHtml: "",
      articleHtml: '<div class="wiki-article"><table><tr><td><table><tr><td>in</td></tr></table></td></tr></table><div class="tablewrap"><table></table></div></div>',
      darkSvgs: [],
    });
    expect(articleHtml.match(/class="export-scroll"/g)).toHaveLength(1);
    expect(articleHtml).toContain('<div class="wiki-article"><div class="export-scroll"><table>');
    expect(articleHtml).toContain('<div class="tablewrap"><table></table></div>');
  });
});

describe("fix round 1 batch 2: show all decisions, no Agent lens, more/less", () => {
  test("drops the Agent lens button, which needs the reader's agent pane, and keeps Overview and All", () => {
    const { headHtml } = cleanExport(captured());
    expect(headHtml).not.toContain('data-lens="agent"');
    expect(headHtml).toContain('data-lens="overview"');
    expect(headHtml).toContain('data-lens="all"');
  });

  test("leaves the decision log's Show all button enabled", () => {
    const { articleHtml } = cleanExport(captured());
    const tag = /<button[^>]*class="dl-all"[^>]*>/.exec(articleHtml)?.[0] ?? "";
    expect(tag).not.toBe("");
    expect(tag).not.toContain("disabled");
  });

  test("state copies include a decision log showing every decision, and no Agent-lens copy", () => {
    const { articleHtml } = cleanExport(captured());
    const variants = stateVariants(articleHtml);
    expect(variants.some((v) => v.includes('class="decision-log lens-show-all"'))).toBe(true);
    expect(variants.some((v) => v.includes("lens-agent"))).toBe(false);
  });

  test("labels come from the reader's own word tables, per language", () => {
    for (const lang of ["en", "no"] as const) {
      const l = exportLabels(lang);
      expect([l.more, l.less, l.showNewest]).toEqual([MORE_WORDS[lang].more, MORE_WORDS[lang].less, COMPACT_WORDS[lang].showNewest(DL_COMPACT_SHOWN)]);
      expect(l.showAll.join("12")).toBe(COMPACT_WORDS[lang].showAll(12));
    }
  });

  // The generated script, run for real in a happy-dom document.
  const run = (lang: "en" | "no") => {
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML =
      `<button class="export-theme">◐ Auto</button><div class="wiki-article lens-all"><section class="decision-log">` +
      `<div class="dl-item dl-decision"><span class="dl-text">D1 <button class="dl-more" aria-expanded="false">${MORE_WORDS[lang].more}</button><span class="dl-rest">r</span></span></div>` +
      `<button class="dl-all" aria-expanded="false">${COMPACT_WORDS[lang].showAll(1)}</button></section></div>`;
    new Function("document", "window", exportScript(exportLabels(lang)))(doc, win);
    return doc;
  };

  test("'more' expands a decision and reads 'less', then folds it back", () => {
    for (const lang of ["en", "no"] as const) {
      const doc = run(lang);
      const b = doc.querySelector("button.dl-more") as unknown as HTMLButtonElement;
      b.click();
      expect(doc.querySelector(".dl-item")?.classList.contains("dl-expanded")).toBe(true);
      expect(b.textContent).toBe(MORE_WORDS[lang].less);
      expect(b.getAttribute("aria-expanded")).toBe("true");
      b.click();
      expect(doc.querySelector(".dl-item")?.classList.contains("dl-expanded")).toBe(false);
      expect(b.textContent).toBe(MORE_WORDS[lang].more);
    }
  });

  test("'Show all' shows every decision and offers the newest five again", () => {
    for (const lang of ["en", "no"] as const) {
      const doc = run(lang);
      const b = doc.querySelector("button.dl-all") as unknown as HTMLButtonElement;
      b.click();
      expect(doc.querySelector("section.decision-log")?.classList.contains("lens-show-all")).toBe(true);
      expect(b.textContent).toBe(COMPACT_WORDS[lang].showNewest(DL_COMPACT_SHOWN));
      expect(b.getAttribute("aria-expanded")).toBe("true");
      b.click();
      expect(doc.querySelector("section.decision-log")?.classList.contains("lens-show-all")).toBe(false);
      expect(b.textContent).toBe(COMPACT_WORDS[lang].showAll(1));
    }
  });
});

describe("fix round 1 batch 3: any SVG style, light/dark id mismatch, light-pass inline fills", () => {
  const withArticle = (inner: string) => ({
    headHtml: head,
    articleHtml: `<div class="wiki-article lens-all">${inner}</div>`,
    darkSvgs: [] as string[],
  });

  test("keeps everything after a non-mermaid SVG that holds a <style>", () => {
    for (const svg of ['<svg class="x"><style>a{}</style><g/></svg>', "<svg><style></style></svg>", '<svg><foreignObject><svg><style>b{}</style></svg></foreignObject></svg>']) {
      const { articleHtml } = cleanExport(withArticle(`${svg}<p class="after">AFTER</p><details><summary>s</summary>x</details>`));
      expect(articleHtml).toContain('<p class="after">AFTER</p>');
      expect(articleHtml).toContain(svg);
      const variants = stateVariants(articleHtml);
      for (const v of variants) expect(v).toContain('<p class="after">AFTER</p>');
    }
  });

  test("renames the dark copy by its own id, so no two SVGs share one when the passes numbered differently", () => {
    const { articleHtml } = cleanExport({
      headHtml: head,
      articleHtml: `<div class="wiki-article lens-all">${mermaid("wm-1")}${mermaid("wm-2")}</div>`,
      darkSvgs: [mermaid("wm-2", "blue"), mermaid("wm-3", "blue")],
    });
    const ids = [...articleHtml.matchAll(/<svg id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual(["wm-1", "wm-2", "wm-2-dark", "wm-3-dark"].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(articleHtml).toContain("#wm-2-dark .node>rect{fill:blue}");
    expect(articleHtml).toContain("#wm-1 .node>rect{fill:red}");
  });

  test("pairs the k-th mermaid diagram with the k-th dark render when a chart SVG comes first", () => {
    const { articleHtml } = cleanExport({
      headHtml: head,
      articleHtml: `<div class="wiki-article lens-all"><svg class="vc-svg"><rect/></svg>${mermaid("wm-1")}</div>`,
      darkSvgs: [mermaid("wm-1", "blue")],
    });
    expect(articleHtml).toContain('<div class="wiki-article lens-all"><svg class="vc-svg"><rect/></svg><div class="export-mm">');
    expect(articleHtml).toContain('<div class="export-mm-light"><svg id="wm-1"');
    expect(articleHtml.match(/class="export-mm"/g)).toHaveLength(1);
    expect(articleHtml).toContain('<div class="export-mm-dark"><svg id="wm-1-dark"');
    expect(articleHtml).toContain("#wm-1-dark .node>rect{fill:blue}");
  });

  test("drops the Steps bar fill the reader painted for the light theme", () => {
    const { articleHtml } = cleanExport(
      withArticle('<section class="stp"><div class="stp-ctrl" style="background-color: rgb(252, 250, 246);">bar</div><div class="stp-ctrl-x" style="color: red;">k</div></section>'),
    );
    expect(articleHtml).toContain('<div class="stp-ctrl">bar</div>');
    expect(articleHtml).toContain('style="color: red;"');
  });
});

describe("fix round 1 batch 4: dead links, CLI arguments", () => {
  test("a link whose target was dropped stops looking like a link, and 'open' links to reader assets go", () => {
    const { articleHtml } = cleanExport({
      headHtml: head,
      articleHtml:
        '<div class="wiki-article lens-all"><a class="wiki-link" href="/wiki?wiki=mimir&amp;relPath=x.md" target="_blank" rel="noopener">x</a>' +
        '<a class="dgm-open" href="/wiki/asset?p=d.html" target="_blank">Open interactive ↗</a>' +
        '<a class="embed-open" href="/wiki/asset?p=e.html" target="_blank">Open ↗</a>' +
        '<a href="https://example.com/" target="_self">ext</a></div>',
      darkSvgs: [],
    });
    expect(articleHtml).toContain('<a class="wiki-link" data-export-dead="">x</a>');
    expect(articleHtml).not.toContain("dgm-open");
    expect(articleHtml).not.toContain("embed-open");
    expect(articleHtml).toContain('<a href="https://example.com/" target="_blank" rel="noopener">ext</a>');
    const html = buildStandaloneHtml({ title: "t", description: "", css: "", headHtml: "", articleHtml, source: "w/p", date: "d" });
    expect(html).toMatch(/a\[data-export-dead\][^{]*\{[^}]*color: inherit !important;[^}]*pointer-events: none;/);
  });

  test("parses wiki, relPath, out and --base anywhere; refuses a missing value", () => {
    expect(parseCliArgs(["mimir", "plans/a.mdx", "/tmp/a.html"])).toEqual({ wiki: "mimir", relPath: "plans/a.mdx", out: "/tmp/a.html", base: "http://localhost:3010" });
    expect(parseCliArgs(["--base", "http://h:1", "mimir", "plans/a.mdx", "/tmp/a.html"])).toEqual({ wiki: "mimir", relPath: "plans/a.mdx", out: "/tmp/a.html", base: "http://h:1" });
    expect(parseCliArgs(["mimir", "plans/a.mdx", "/tmp/a.html", "--base", "http://h:1/"])?.base).toBe("http://h:1");
    expect(parseCliArgs(["mimir", "plans/a.mdx", "/tmp/a.html", "--base"])).toBeNull();
    expect(parseCliArgs(["mimir", "plans/a.mdx"])).toBeNull();
    expect(parseCliArgs(["mimir", "plans/a.mdx", "/tmp/a.html", "extra"])).toBeNull();
  });
});

describe("fix round 2 batch 1: stylesheet fetch, sticky bar, dead-link border", () => {
  test("one linked sheet that fails to load costs only that sheet, not the export", async () => {
    const sheets = [
      { href: "http://a/ok.css", ownerNode: null },
      { href: "http://cdn/blocked.css", ownerNode: null },
      { href: null, ownerNode: { textContent: ".inline{}" } },
    ];
    const fetchText = (href: string) => (href.includes("blocked") ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(".ok{}"));
    expect(await sheetSources(sheets, fetchText)).toEqual([".ok{}", "", ".inline{}"]);
  });
});

describe("fix round 2 batch 2: labels from the word tables, links to hidden decisions, links in SVGs", () => {
  const runDoc = (lang: "en" | "no", body: string) => {
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = body;
    new Function("document", "window", exportScript(exportLabels(lang)))(doc, win);
    return doc;
  };
  const decision = (id: string, cls: string, lang: "en" | "no", btn: string) =>
    `<div class="dl-item dl-decision${cls}" id="${id}"><span class="dl-text">${id} <button class="dl-more" aria-expanded="false">${btn}</button><span class="dl-rest" id="${id}-rest">r</span></span></div>`;

  test("a decision captured expanded reads 'more' after one click, not its captured 'less'", () => {
    for (const lang of ["en", "no"] as const) {
      const doc = runDoc(lang, `<section class="decision-log"><div class="dl-list">${decision("d1", " dl-expanded", lang, MORE_WORDS[lang].less)}</div></section>`);
      const b = doc.querySelector("button.dl-more") as unknown as HTMLButtonElement;
      b.click();
      expect(doc.querySelector(".dl-item")?.classList.contains("dl-expanded")).toBe(false);
      expect(b.textContent).toBe(MORE_WORDS[lang].more);
    }
  });

  test("a log captured showing all reads 'Show all N decisions' after one click, N its decisions", () => {
    for (const lang of ["en", "no"] as const) {
      const items = [1, 2, 3].map((k) => decision(`d${k}`, "", lang, MORE_WORDS[lang].more)).join("") + '<div class="dl-item">a note, not a decision</div>';
      const doc = runDoc(
        lang,
        `<section class="decision-log lens-show-all"><div class="dl-list">${items}</div><button class="dl-all" aria-expanded="true">${COMPACT_WORDS[lang].showNewest(DL_COMPACT_SHOWN)}</button></section>`,
      );
      const b = doc.querySelector("button.dl-all") as unknown as HTMLButtonElement;
      b.click();
      expect(doc.querySelector("section.decision-log")?.classList.contains("lens-show-all")).toBe(false);
      expect(b.textContent).toBe(COMPACT_WORDS[lang].showAll(3));
    }
  });

  test("a # link to an older decision shows the whole log, with the button's label", () => {
    for (const lang of ["en", "no"] as const) {
      const doc = runDoc(
        lang,
        `<p><a href="#d1">see D1</a></p><section class="decision-log"><div class="dl-list">${decision("d1", " dl-older", lang, MORE_WORDS[lang].more)}${decision("d2", "", lang, MORE_WORDS[lang].more)}</div>` +
          `<button class="dl-all" aria-expanded="false">${COMPACT_WORDS[lang].showAll(2)}</button></section>`,
      );
      (doc.querySelector('a[href="#d1"]') as unknown as HTMLAnchorElement).click();
      expect(doc.querySelector("section.decision-log")?.classList.contains("lens-show-all")).toBe(true);
      expect(doc.querySelector("button.dl-all")?.textContent).toBe(COMPACT_WORDS[lang].showNewest(DL_COMPACT_SHOWN));
      expect(doc.querySelector("button.dl-all")?.getAttribute("aria-expanded")).toBe("true");
    }
  });

  test("a # link to a newest decision, or a line nested in one, expands that decision and leaves the log compact", () => {
    for (const lang of ["en", "no"] as const) {
      for (const target of ["d2", "d2-sub"]) {
        const nested = decision("d2", "", lang, MORE_WORDS[lang].more).replace("</span></div>", '</span><div class="dl-item"><span id="d2-sub">sub</span></div></div>');
        const doc = runDoc(
          lang,
          `<p><a href="#${target}">go</a></p><section class="decision-log"><div class="dl-list">${decision("d1", " dl-older", lang, MORE_WORDS[lang].more)}${nested}</div>` +
            `<button class="dl-all" aria-expanded="false">${COMPACT_WORDS[lang].showAll(2)}</button></section>`,
        );
        (doc.querySelector(`a[href="#${target}"]`) as unknown as HTMLAnchorElement).click();
        expect(doc.getElementById("d2")?.classList.contains("dl-expanded")).toBe(true);
        expect(doc.querySelector("section.decision-log")?.classList.contains("lens-show-all")).toBe(false);
      }
    }
  });

  test("a # link into a decision's hidden part expands that decision", () => {
    for (const lang of ["en", "no"] as const) {
      const doc = runDoc(lang, `<p><a href="#d1-rest">rest</a></p><section class="decision-log"><div class="dl-list">${decision("d1", "", lang, MORE_WORDS[lang].more)}</div></section>`);
      (doc.querySelector('a[href="#d1-rest"]') as unknown as HTMLAnchorElement).click();
      expect(doc.getElementById("d1")?.classList.contains("dl-expanded")).toBe(true);
      expect(doc.querySelector("button.dl-more")?.textContent).toBe(MORE_WORDS[lang].less);
      expect(doc.querySelector("button.dl-more")?.getAttribute("aria-expanded")).toBe("true");
    }
  });

  test("links inside an SVG get the same cleanup as the article's, the SVG otherwise untouched", () => {
    const svg =
      '<svg class="sm"><style>.sm-node>rect{fill:red}</style>' +
      '<a class="sm-node" href="/wiki?wiki=mimir&amp;relPath=x.md" data-relpath="x.md"><rect/></a>' +
      '<a xlink:href="http://localhost:3010/wiki?x=1"><rect/></a>' +
      '<a href="https://example.com/a" target="_self"><rect/></a>' +
      '<a href="#n1"><rect/></a></svg>';
    const { articleHtml } = cleanExport({ headHtml: head, articleHtml: `<div class="wiki-article lens-all">${svg}<p class="after">after</p></div>`, darkSvgs: [] });
    expect(articleHtml).not.toContain('href="/wiki');
    expect(articleHtml).not.toContain("localhost:3010");
    expect(articleHtml).toContain('<a class="sm-node" data-relpath="x.md" data-export-dead=""><rect/></a>');
    expect(articleHtml).toContain('<a data-export-dead=""><rect/></a>');
    expect(articleHtml).toContain('<a href="https://example.com/a" target="_blank" rel="noopener"><rect/></a>');
    expect(articleHtml).toContain('<a href="#n1"><rect/></a>');
    expect(articleHtml).toContain("<style>.sm-node>rect{fill:red}</style>");
    expect(articleHtml).toContain('<p class="after">after</p>');
  });

  test("a mermaid diagram's links are cleaned in its light and its dark copy", () => {
    const linked = (id: string) => mermaid(id).replace("</svg>", '<a xlink:href="/wiki?wiki=mimir&amp;relPath=y.md"><g/></a></svg>');
    const { articleHtml } = cleanExport({ headHtml: head, articleHtml: `<div class="wiki-article lens-all">${linked("wm-1")}</div>`, darkSvgs: [linked("wm-1")] });
    expect(articleHtml).toContain('<svg id="wm-1-dark"');
    expect(articleHtml).not.toContain("/wiki?");
    expect(articleHtml.match(/<a data-export-dead=""><g\/><\/a>/g)).toHaveLength(2);
  });

  test("leaves tables in the reader's own scroll boxes alone (a second box would unstick query-table headers)", () => {
    const { articleHtml } = cleanExport({
      headHtml: "",
      articleHtml: '<div class="wiki-article"><div class="dt-wrap"><table></table></div><div class="query-table-wrap"><table></table></div></div>',
      darkSvgs: [],
    });
    expect(articleHtml).not.toContain("export-scroll");
  });
});

describe("fix round 2 batch 3: self-check by DOM query, embeds of reader pages", () => {
  const docOf = (body: string) => {
    const doc = new Window().document;
    doc.body.innerHTML = body;
    return doc as unknown as Document;
  };

  test("the self-check reports stylesheet links, external scripts and references into the reader, not prose or data attributes", () => {
    const doc = docOf(
      '<link rel="stylesheet" href="https://cdn.example/x.css"><script src="/a.js"></script><script src="https://cdn.example/x.js"></script>' +
        '<a href="/wiki?wiki=mimir">r</a><img src="http://localhost:3010/a.png"><img src="images/b.png">' +
        '<svg><a xlink:href="/wiki?x=1"><g/></a></svg><iframe src="/api/wiki/html?relPath=x"></iframe>' +
        // none of these is a problem:
        '<p>quotes src="http://localhost:3010/x" and href="/wiki" in prose</p><div data-embed-src="./x.html" data-src="flowchart LR"></div>' +
        '<a href="#d1">in-page</a><a href="https://example.com/">ext</a><img src="data:image/png;base64,AA=="><a href="mailto:x@example.com">m</a><script>1</script>',
    );
    expect(selfCheck(doc)).toEqual([
      '<link href="https://cdn.example/x.css">',
      '<script src="/a.js">',
      '<script src="https://cdn.example/x.js">',
      '<a href="/wiki?wiki=mimir">',
      '<img src="http://localhost:3010/a.png">',
      '<img src="images/b.png">',
      '<a xlink:href="/wiki?x=1">',
      '<iframe src="/api/wiki/html?relPath=x">',
    ]);
  });

  test("the self-check scans the head too, where a stylesheet link would sit", () => {
    const doc = docOf("<p>body</p>");
    doc.head.innerHTML = '<link rel="stylesheet" href="/wiki.css">';
    expect(selfCheck(doc)).toEqual(['<link href="/wiki.css">']);
  });

  test("an embed of a reader page becomes a note naming it; an external embed stays", () => {
    const { articleHtml } = cleanExport({
      headHtml: head,
      articleHtml:
        '<div class="wiki-article lens-all"><figure class="embed" data-embed-title="Feed explainer"><iframe class="wiki-embed-frame" title="Feed explainer" src="/api/wiki/html?relPath=blogs%2Fx.html&amp;wiki=mimir" style="height: 420px;"></iframe></figure>' +
        '<figure class="embed"><iframe title="Talk" src="https://www.youtube-nocookie.com/embed/abc"></iframe></figure></div>',
      darkSvgs: [],
    });
    expect(articleHtml).not.toContain("/api/wiki/html");
    expect(articleHtml).toContain('<p class="export-embed-note">Embedded page “Feed explainer”: open it in the muninn reader.</p>');
    expect(articleHtml).toContain('<iframe title="Talk" src="https://www.youtube-nocookie.com/embed/abc"></iframe>');
  });
});
