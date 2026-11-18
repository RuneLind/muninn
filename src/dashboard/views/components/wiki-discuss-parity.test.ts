/**
 * Parity: the Discuss locator's collapse of a page source
 * (`collapseForLocate`, `src/wiki/discuss-locate.ts`) against the reader's own
 * render of it (`renderWikiHtml` with the page route's options), read the way
 * the client reads a selection and counts its occurrence (`discussText`,
 * `wiki-discuss-text.ts`), in a happy-dom `Window` of the test's own (no
 * globals). Written before the locator's cases: a locator that guesses the
 * reader's reading of markdown from source rules drifts from it (muninn #872).
 *
 * Three parts: every text block of the render is found in the collapse; on
 * every form in the table the two readings are equal under the key, so a
 * selection's occurrence number means the same on both sides; and the forms
 * where the two differ on purpose, each with the side that differs.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { questionRenderOptionsFor, renderWikiHtml } from "../../../wiki/render.ts";
import { collapseForLocate } from "../../../wiki/discuss-locate.ts";
import { locateKey } from "../../../wiki/locate-key.ts";
import { discussHeading, discussText, selectionOccurrence } from "./wiki-discuss-text.ts";

const pages = new Map([["ferry-plan", { name: "ferry-plan", relPath: "plans/ferry-plan.mdx", title: "Ferry plan" }]]);
const resolve = (t: string) => pages.get(t.trim().toLowerCase()) as never;

/** The article as `GET /api/wiki/page` renders it, in a window of its own. */
function article(md: string, title?: string): Element {
  const doc = new Window().document;
  const el = doc.createElement("div");
  el.className = "wiki-article";
  el.innerHTML = renderWikiHtml(md, resolve, { stripTitle: title, readerShapes: true, views: true, question: questionRenderOptionsFor(md, null, false, null) });
  doc.body.appendChild(el);
  return el as unknown as Element;
}

const clientKey = (md: string, title?: string) => locateKey(discussText(article(md, title)));
const serverKey = (md: string, title?: string) => collapseForLocate(md, { stripTitle: title }).text;

/** The fixture: components, escapes, both kinds of wikilink, fact wrappers. */
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
  "## Brief",
  "",
  "Kari Nordmann owns it. Escapes stay as written: \\*not bold\\*, &amp; and &lt;tag&gt;; a [link](https://example.com/a) reads as its label.",
  "",
  '<Fold title="Design" summary="three routes, one new stop">',
  "",
  "## Design",
  "",
  "- **R1, summer.** Adds a stop at `Example Island` for MELOSYS-123.",
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
  "",
  "</DecisionLog>",
  "",
].join("\n");

describe("the fixture page", () => {
  test("every text block of the render is found in the collapse", () => {
    const a = article(FIXTURE, "Harbour timetable");
    const server = serverKey(FIXTURE, "Harbour timetable");
    const blocks = Array.from(a.querySelectorAll("li, td, th, h1, h2, h3, h4, summary, blockquote, .callout-body, .tldr-body, pre"));
    expect(blocks.length).toBeGreaterThan(12);
    const missing = blocks.map((b) => locateKey(discussText(b))).filter((k) => k && !server.includes(k));
    expect(missing).toEqual([]);
  });

  test("the two readings are equal under the key", () => {
    expect(clientKey(FIXTURE, "Harbour timetable")).toBe(serverKey(FIXTURE, "Harbour timetable"));
  });
});

/** One form, rendered and collapsed: equal under the key. */
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
  ["a fenced code block", "```js\nlet x = '**y**';\n```\n"],
  ["an HTML comment shows", "Before <!-- a note --> after.\n"],
  ["a DecisionLog", "<DecisionLog>\n\n- **D1** — First. Kari Nordmann, 01.11.2026.\n- **D2** — Second.\n\n</DecisionLog>\n"],
  ["a thematic break", "Above.\n\n---\n\nBelow.\n"],
];

describe("forms: the render and the collapse agree", () => {
  for (const [name, md] of FORMS) {
    test(name, () => {
      const title = name.startsWith("the leading H1") ? "Same title" : undefined;
      expect(clientKey(md, title)).toBe(serverKey(md, title));
    });
  }
});

describe("where the two differ on purpose", () => {
  test("a mermaid fence: the client drops it (an SVG once drawn), and so does the collapse", () => {
    const md = "Before.\n\n```mermaid\ngraph LR\n  A --> B\n```\n\nAfter.\n";
    expect(clientKey(md)).toBe("before.after.");
    expect(serverKey(md)).toBe("before.after.");
  });
  test("reader-made labels are not counted: TL;DR, the fact-check chip, a fold's size", () => {
    expect(clientKey("<Tldr>\n\nShort.\n\n</Tldr>\n")).toBe("short.");
    expect(clientKey('A <Fact n="1" v="ok">claim</Fact>.\n')).toBe("aclaim.");
  });
  test("a Figure's caption, a Query's question and answer, a Lane's who: the client skips or the collapse leaves out", () => {
    // Figure: the caption renders after the body; the collapse leaves it out, the client reads it.
    const fig = '<Figure caption="A caption">\n\nBody.\n\n</Figure>\n';
    expect(clientKey(fig)).toContain("acaption");
    expect(serverKey(fig)).not.toContain("acaption");
    // Query: its head (id, question, answer) is reader chrome to the client and an attribute to the collapse.
    const q = '<Query id="Q-1" question="How many?" answer="Four.">\n\nBody.\n\n</Query>\n';
    expect(clientKey(q)).not.toContain("howmany");
    expect(serverKey(q)).not.toContain("howmany");
  });
  test("a code tab's label is a button: the client skips it, and the collapse leaves it out", () => {
    const md = '<CodeTabs>\n<Tab label="TypeScript">\n\n```ts\nconst a = 1;\n```\n\n</Tab>\n</CodeTabs>\n';
    expect(clientKey(md)).toBe("consta=1;");
    expect(serverKey(md)).toBe("consta=1;");
  });
  test("the decision views (`dc-view`) copy text from elsewhere on the page; the client skips them", () => {
    const a = article("The pier opens at six.\n");
    const view = a.ownerDocument.createElement("section");
    view.className = "dc-view qg";
    view.textContent = "The pier opens at six.";
    a.prepend(view);
    expect(locateKey(discussText(a))).toBe("thepieropensatsix.");
  });
});

describe("the occurrence number and the heading, as the client sends them", () => {
  /** A range over the n-th (1-based) text node holding `needle`, whole needle. */
  function rangeOver(a: Element, needle: string, n = 1): Range {
    const doc = a.ownerDocument;
    const walker = doc.createTreeWalker(a, 4);
    let k = 0;
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const i = (t as Text).data.indexOf(needle);
      if (i !== -1 && ++k === n) {
        const r = doc.createRange();
        r.setStart(t, i);
        r.setEnd(t, i + needle.length);
        return r;
      }
    }
    throw new Error(`no ${needle}`);
  }

  const TWICE = "## One\n\nThe pier opens at six.\n\n## Two\n\nAgain: The pier opens at six.\n";
  test("a sentence twice: the second counts one before it, of two", () => {
    const a = article(TWICE);
    expect(selectionOccurrence(a, rangeOver(a, "The pier opens at six.", 2), "The pier opens at six.")).toEqual({ occurrence: 1, total: 2 });
    expect(selectionOccurrence(a, rangeOver(a, "The pier opens at six.", 1), "The pier opens at six.")).toEqual({ occurrence: 0, total: 2 });
  });
  test("the heading above the selection, without the reader's additions", () => {
    const a = article(TWICE);
    const h = a.querySelectorAll("h2, h3")[1]!;
    const extra = a.ownerDocument.createElement("button");
    extra.textContent = "🧭";
    h.appendChild(extra);
    expect(discussHeading(a, rangeOver(a, "The pier opens at six.", 2))).toBe("Two");
  });
  test("a DecisionLog the reader shows newest first is counted in authored order", () => {
    const md = "<DecisionLog>\n\n- **D1** — Keep the pier. Kari Nordmann, 01.11.2026.\n- **D2** — Keep the pier. Kari Nordmann, 02.11.2026.\n\n</DecisionLog>\n";
    const a = article(md);
    const list = a.querySelector(".dl-list")!;
    const items = Array.from(list.children);
    items.forEach((li, k) => li.setAttribute("data-dl-order", String(k)));
    list.prepend(items[1]!); // newest first, as the lens does
    // The selection in the item authored first (now shown second).
    expect(selectionOccurrence(a, rangeOver(a, "Keep the pier.", 2), "Keep the pier.")).toEqual({ occurrence: 0, total: 2 });
  });
  test("a selection inside a skipped element sends no occurrence", () => {
    const a = article(TWICE);
    const peek = a.ownerDocument.createElement("div");
    peek.className = "wiki-ref-peek";
    peek.textContent = "The pier opens at six.";
    a.appendChild(peek);
    const r = a.ownerDocument.createRange();
    r.selectNodeContents(peek);
    expect(selectionOccurrence(a, r, "The pier opens at six.")).toEqual({ occurrence: null, total: 2 });
  });
});

describe("a question card the reader moves into the Follow-up lane", () => {
  const MOVED = [
    "<NextMoves>",
    "",
    '<Lane kind="you" who="Kari Nordmann">',
    "",
    "- Check the pier.",
    "",
    "</Lane>",
    "",
    "</NextMoves>",
    "",
    "## Decisions",
    "",
    "The pier opens at six.",
    "",
    '<Question id="O1" choices="A|B" to="Kari Nordmann">',
    "",
    "Which route first? The pier opens at six.",
    "",
    "- **A — north:** short.",
    "- **B — south:** long.",
    "",
    "</Question>",
    "",
    "<DecisionLog>",
    "",
    "- **O1** — Which route first? Kari Nordmann replied A. Closed 2026-11-09 (D1).",
    "- **D1** — North first. Answer A on card O1. Kari Nordmann, 09.11.2026.",
    "",
    "</DecisionLog>",
    "",
  ].join("\n");

  test("the render moves it (the case this guards), and the client reads it at its line: the readings are equal", () => {
    const a = article(MOVED);
    expect(a.querySelector(".nm-settled-rows section.question")).not.toBeNull();
    expect(a.querySelector("[data-q-moved-ids]")?.getAttribute("data-q-moved-ids")).toBe("O1");
    expect(locateKey(discussText(a))).toBe(serverKey(MOVED));
  });

  test("a selection inside the moved card counts the copy above the card's line, as the source does", () => {
    const a = article(MOVED);
    const card = a.querySelector(".nm-settled-rows section.question .q-body")!;
    const doc = a.ownerDocument;
    const walker = doc.createTreeWalker(card, 4);
    let node: Text | null = null;
    for (let t = walker.nextNode(); t; t = walker.nextNode()) if ((t as Text).data.includes("The pier opens at six.")) node = t as Text;
    const r = doc.createRange();
    const i = node!.data.indexOf("The pier opens at six.");
    r.setStart(node!, i);
    r.setEnd(node!, i + "The pier opens at six.".length);
    expect(selectionOccurrence(a, r, "The pier opens at six.")).toEqual({ occurrence: 1, total: 2 });
  });
});
