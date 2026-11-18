/**
 * Parity: the Discuss locator's collapse of a page source (`collapseForLocate`,
 * `src/wiki/discuss-locate.ts`) against the reader's own render of it, read
 * the way the client reads a selection and its context, AFTER the client's
 * enhancers have run: `enhanceCodeBlocks` (a `span.fence-lang` label and a
 * Copy button on every fence), `applyLaneRoles` (a role's lanes first, the
 * authored order in `data-nm-order`) and the lens (a DecisionLog newest first).
 * A selection is made on that article, so a parity test that reads only the
 * server render misses all three (the first build's did).
 *
 * Written before the locator's cases: a locator that guesses the reader's
 * reading of markdown from source rules drifts from it (muninn #872).
 *
 * Own process: it installs happy-dom's globals (the enhancers create nodes
 * through `document`), so it is alone in its `bun test` link.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { questionRenderOptionsFor, renderWikiHtml } from "../../../wiki/render.ts";
import { collapseForLocate } from "../../../wiki/discuss-locate.ts";
import { locateKey } from "../../../wiki/locate-key.ts";
import { DISCUSS_TEXT_HIDDEN, discussText } from "../components/wiki-discuss-text.ts";
import { enhanceCodeBlocks } from "../components/code-block-chrome.ts";
import { applyLaneRoles } from "../components/wiki-report-blocks.ts";
import { enhanceLens, readerSelectionText } from "../components/wiki-lens.ts";

const g = globalThis as unknown as Record<string, unknown>;
const IGNORE = new Set(["constructor", "undefined", "NaN", "global", "globalThis", "console"]);
const saved = new Map<string, PropertyDescriptor | undefined>();
let win: GlobalWindow;

beforeAll(() => {
  win = new GlobalWindow({ url: "http://localhost:3011/wiki" });
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(win))) {
    if (IGNORE.has(key)) continue;
    const cur = Object.getOwnPropertyDescriptor(globalThis, key);
    if (cur && "value" in desc && cur.value === desc.value) continue;
    saved.set(key, cur);
    const next = "value" in desc && desc.value === win ? { ...desc, value: globalThis } : desc;
    Object.defineProperty(globalThis, key, { ...next, configurable: true });
  }
  // Chrome's `Selection.toString` leaves out what CSS hides; happy-dom applies
  // no stylesheet, so the reading classes' `display: none` is played here by
  // dropping what they hide (`DISCUSS_TEXT_HIDDEN`: reader-only, fact chips,
  // fence bars), as the reader's CSS does.
  const proto = Object.getPrototypeOf(win.getSelection()) as { toString(): string };
  proto.toString = function (this: Selection) {
    if (!this.rangeCount) return "";
    const frag = this.getRangeAt(0).cloneContents();
    frag.querySelectorAll(DISCUSS_TEXT_HIDDEN).forEach((e) => e.remove());
    return frag.textContent ?? "";
  };
});

afterAll(() => {
  for (const [key, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete g[key];
  }
  saved.clear();
});

const pages = new Map([["ferry-plan", { name: "ferry-plan", relPath: "plans/ferry-plan.mdx", title: "Ferry plan" }]]);
const resolve = (t: string) => pages.get(t.trim().toLowerCase()) as never;

/** The article as the reader shows it: `GET /api/wiki/page`'s render, then
 *  the client's enhancers, in the order `fetchAndRenderPage` runs them. */
function readerArticle(md: string, title?: string, roles: string[] = ["utvikler"]): HTMLElement {
  document.body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.id = "articleWrap";
  wrap.innerHTML = `<div class="wiki-article">${renderWikiHtml(md, resolve, {
    stripTitle: title,
    readerShapes: true,
    views: true,
    question: questionRenderOptionsFor(md, null, false, null),
  })}</div>`;
  document.body.appendChild(wrap);
  const article = wrap.querySelector<HTMLElement>(".wiki-article")!;
  enhanceCodeBlocks(article);
  applyLaneRoles(article, roles);
  enhanceLens(wrap, { language: "en", agentAvailable: false, inPlace: false, chipHost: null, initial: "all" } as never);
  return article;
}

const serverKey = (md: string, title?: string) => collapseForLocate(md, { stripTitle: title }).text;

/** The selection's text over all of `el`, read by the client's own function. */
function selectionTextOver(el: Element): string {
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
  return readerSelectionText(sel);
}

/** The fixture: components, escapes, both kinds of wikilink, fact wrappers,
 *  a fence, two role lanes and a DecisionLog. */
const FIXTURE = [
  "---",
  "title: Harbour timetable",
  "plan_status: in-flight",
  "---",
  "",
  "# Harbour timetable",
  "",
  "<Tldr>",
  "",
  "The **winter** timetable moves to `harbour.yaml`, see [[ferry-plan]] and [[ferry-plan|the ferry plan]].",
  "",
  "</Tldr>",
  "",
  "<NextMoves>",
  "",
  '<Lane kind="you" role="fag">',
  "",
  "- Confirm the winter stops with the harbour office.",
  "- Print the new boards.",
  "",
  "</Lane>",
  "",
  '<Lane kind="you" role="utvikler">',
  "",
  "- Ship the timetable parser.",
  "- Print the new boards.",
  "",
  "</Lane>",
  "",
  "</NextMoves>",
  "",
  "## Brief",
  "",
  "Kari Nordmann owns it. Escapes stay as written: \\*not bold\\*, &amp; and &lt;tag&gt;; a [link](https://example.com/a) reads as its label.",
  "",
  '<Fold title="Design" summary="three routes, one new stop">',
  "",
  "## Design",
  "",
  "- **R1, summer.** Adds a stop at `Example Island` for MELOSYS-999.",
  "- The night route is unchanged.",
  "  It keeps its two departures.",
  "1. First numbered step",
  "2. Second numbered step",
  "",
  "| Route | Stops |",
  "|---|---|",
  "| Summer | `4` |",
  "",
  '<Callout tone="warn" title="Watch the tide">',
  "",
  "Low water closes the north pier.",
  "",
  "</Callout>",
  "",
  "</Fold>",
  "",
  "> A quote line.",
  "> 1. a quoted number stays text",
  "",
  "> [!note] An Obsidian callout keeps its words.",
  "",
  'Before <Fact n="1" v="ok">a checked claim</Fact> after.',
  "",
  '<Fact n="2" v="warn">',
  "A whole checked paragraph.",
  "</Fact>",
  "",
  '<Meter value="1" max="3">Routes done</Meter>',
  "",
  '<FileRef path="src/harbour.ts" />',
  "",
  'A block tag mid-line stays text: <FileRef path="x.ts" /> here.',
  "",
  "```ts",
  "const stops = 4; // **not markup**",
  "```",
  "",
  "```mermaid",
  "graph LR",
  "  A --> B",
  "```",
  "",
  "<DecisionLog>",
  "",
  "- **D1** — Keep the night route. Kari Nordmann, 01.11.2026.",
  "- **D2** — Add the summer stop. Kari Nordmann, 02.11.2026.",
  "- **D3** — Move the boards. Kari Nordmann, 03.11.2026.",
  "",
  "</DecisionLog>",
  "",
].join("\n");

const TITLE = "Harbour timetable";
const BLOCKS = "li, td, th, h1, h2, h3, h4, summary, blockquote, .callout-body, .tldr-body, pre, .fence, section.decision-log, .nm-lanes, .nm-lane";

describe("the fixture page, after the client's enhancers", () => {
  test("the enhancers ran: a fence label, lanes reordered for the role, the DecisionLog newest first", () => {
    const a = readerArticle(FIXTURE, TITLE);
    expect(a.querySelector(".fence .fence-lang")?.textContent).toBe("ts");
    const lanes = Array.from(a.querySelectorAll(".nm-lanes > .nm-lane"));
    expect(lanes.map((l) => l.getAttribute("data-nm-order"))).toEqual(["1", "0"]);
    const items = Array.from(a.querySelectorAll("section.decision-log .dl-list > li"));
    expect(items.map((li) => li.getAttribute("data-dl-order"))).toEqual(["2", "1", "0"]);
  });

  test("every text block, as the context reads it, is found in the collapse", () => {
    const a = readerArticle(FIXTURE, TITLE);
    const server = serverKey(FIXTURE, TITLE);
    const blocks = Array.from(a.querySelectorAll(BLOCKS));
    expect(blocks.length).toBeGreaterThan(16);
    const missing = blocks.map((b) => locateKey(discussText(b))).filter((k) => k && !server.includes(k));
    expect(missing).toEqual([]);
  });

  test("every text block, as a selection over it reads (`readerSelectionText`), is found in the collapse", () => {
    const a = readerArticle(FIXTURE, TITLE);
    const server = serverKey(FIXTURE, TITLE);
    // Lanes are left out here: a selection over the lane list in its shown
    // order is not one stretch of the source (the client marks it `reordered`).
    const blocks = Array.from(a.querySelectorAll(BLOCKS)).filter((b) => !b.matches(".nm-lanes") && !b.closest(".nm-head"));
    // A block whose text is all reader-added (a mermaid fence, drawn as an
    // SVG) is left out too: a selection there goes to the section by design.
    const missing = blocks
      .filter((b) => (!b.closest(".nm-lane") || b.matches("li")) && locateKey(discussText(b)) !== "")
      .map((b) => locateKey(selectionTextOver(b)))
      .filter((k) => k && !server.includes(k));
    expect(missing).toEqual([]);
  });

  test("the whole article, as the context reads it, equals the collapse", () => {
    expect(locateKey(discussText(readerArticle(FIXTURE, TITLE)))).toBe(serverKey(FIXTURE, TITLE));
  });
});

/** One form, rendered, enhanced and collapsed: equal under the key. */
const FORMS: [string, string][] = [
  ["bold, italic, strike", "Some **bold**, *italic*, _under_ and ~~struck~~ words.\n"],
  ["inline code", "Run `bun test` and `a_b`.\n"],
  ["a link", "See [the docs](https://example.com/docs) now.\n"],
  ["a non-http link reads as its label", "See [the page](plans/x.md) now.\n"],
  ["a bare wikilink", "See [[ferry-plan]] now.\n"],
  ["a labelled wikilink", "See [[ferry-plan|the plan]] now.\n"],
  ["a missing wikilink", "See [[no-such-page]] and [[no-such|its label]].\n"],
  ["escapes and entities stay as written", "A \\*star\\*, &amp;, &lt;b&gt; and \\_x\\_.\n"],
  ["a heading the title does not repeat", "## Section one\n\nText.\n"],
  ["the leading H1 that repeats the title", "# Same title\n\nText.\n"],
  ["bullets and numbers", "- one\n- two\n\n1. first\n2. second\n"],
  ["a wrapped bullet", "- one line\n  that wraps\n- next\n"],
  ["a nested list", "- outer\n  - inner\n    1. deep\n"],
  ["a table", "| A | B |\n|:--|--:|\n| x | `y` |\n"],
  ["a quote with a number", "> line\n> 1. stays text\n"],
  ["an Obsidian callout", "> [!warning] Mind the gap.\n> More.\n"],
  ["a fold's title and summary", '<Fold title="Title here" summary="summary here">\n\nBody.\n\n</Fold>\n'],
  ["a callout's title", '<Callout tone="info" title="Heads up">\n\nBody.\n\n</Callout>\n'],
  ["a TL;DR with its label", '<Tldr label="In short">\n\nShort.\n\n</Tldr>\n'],
  ["inline fact wrappers", 'A <Fact n="3" v="bad">wrong claim</Fact> here.\n'],
  ["a block fact wrapper", '<Fact n="4" v="ok">\nA checked paragraph.\n</Fact>\n'],
  ["a meter", '<Meter value="2" max="5">Steps done</Meter>\n'],
  ["a self-closing FileRef", '<FileRef path="src/a.ts" />\n'],
  ["a block tag mid-line is text", 'Lives in <FileRef path="src/a.ts" /> now.\n'],
  ["a block tag followed by text is text", '<FileRef path="src/a.ts" /> and more.\n'],
  ["a fenced code block, with its label and Copy button", "```js\nlet x = '**y**';\n```\n"],
  ["an HTML comment shows", "Before <!-- a note --> after.\n"],
  ["a DecisionLog shown newest first", "<DecisionLog>\n\n- **D1** — First. Kari Nordmann, 01.11.2026.\n- **D2** — Second.\n\n</DecisionLog>\n"],
  ["a thematic break", "Above.\n\n---\n\nBelow.\n"],
  ["a Figure: its caption is the reader's", '<Figure caption="A caption">\n\nBody.\n\n</Figure>\n'],
  ["a Diagram's body is not shown (drawn from its src)", '<Diagram caption="Flow">\n\nboats to the pier\n\n</Diagram>\n\nAfter.\n'],
  ["an Embed's body is not shown", '<Embed src="demo.html">\n\nfallback words\n\n</Embed>\n\nAfter.\n'],
  ["a tag over several lines is text", '<Callout\n  title="Long tag">\n\nInside.\n\n</Callout>\n'],
  ["a tag with a bare attribute is text", '<Fold title="D" open>\n\nBody.\n\n</Fold>\n'],
  ["a tag with a single-quoted value is text", "<Fold title='D'>\n\nBody.\n\n</Fold>\n"],
  ["an unclosed opener is text", '<Callout title="x">\n\nNever closed.\n'],
  ["nested same-name components", '<Callout title="a">\n\n<Callout title="b">\n\nIn.\n\n</Callout>\n\n</Callout>\n'],
  ["a code tab's label is a button", '<CodeTabs>\n<Tab label="TypeScript">\n\n```ts\nconst a = 1;\n```\n\n</Tab>\n</CodeTabs>\n'],
];

describe("forms: the enhanced render and the collapse agree", () => {
  for (const [name, md] of FORMS) {
    test(name, () => {
      const title = name.startsWith("the leading H1") ? "Same title" : undefined;
      expect(locateKey(discussText(readerArticle(md, title)))).toBe(serverKey(md, title));
    });
  }
});

describe("where the two differ on purpose", () => {
  test("a mermaid fence: the client drops it (an SVG once drawn), and so does the collapse", () => {
    const md = "Before.\n\n```mermaid\ngraph LR\n  A --> B\n```\n\nAfter.\n";
    expect(locateKey(discussText(readerArticle(md)))).toBe("before.after.");
    expect(serverKey(md)).toBe("before.after.");
  });
  test("a Figure's caption is reader-added: the client skips it and the collapse leaves it out", () => {
    const fig = '<Figure caption="A caption">\n\nBody.\n\n</Figure>\n';
    expect(readerArticle(fig).querySelector("figcaption")?.textContent).toContain("A caption");
    expect(locateKey(discussText(readerArticle(fig)))).not.toContain("acaption");
    expect(serverKey(fig)).not.toContain("acaption");
  });
  test("a Query's head: reader chrome to the client, an attribute to the collapse", () => {
    const q = '<Query id="Q-1" question="How many?" answer="Four.">\n\nBody.\n\n</Query>\n';
    expect(locateKey(discussText(readerArticle(q)))).not.toContain("howmany");
    expect(serverKey(q)).not.toContain("howmany");
  });
  test("the decision views (`dc-view`) copy text from elsewhere on the page; the client skips them", () => {
    const a = readerArticle("The pier opens at six.\n");
    const view = document.createElement("section");
    view.className = "dc-view qg";
    view.textContent = "The pier opens at six.";
    a.prepend(view);
    expect(locateKey(discussText(a))).toBe("thepieropensatsix.");
  });
});
