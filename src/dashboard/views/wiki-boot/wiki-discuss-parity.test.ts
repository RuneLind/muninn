/**
 * Parity: the Discuss locator's collapse of a page source (`collapseForLocate`,
 * `src/wiki/discuss-locate.ts`) against the reader's own render of it, read
 * the way the client reads a selection and its context, AFTER every step the
 * reader runs on the article (`readerArticle`, `discuss-reader-article.ts`,
 * which lists them). A selection is made on that article, so a parity test
 * that reads only the server render, or a few of the enhancers, misses what
 * the rest add (the first build's did, and so did the second's).
 *
 * Written before the locator's cases: a locator that guesses the reader's
 * reading of markdown from source rules drifts from it (muninn #872).
 *
 * Own process: it installs happy-dom's globals (the enhancers create nodes
 * through `document`), so it is alone in its `bun test` link.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { collapseForLocate } from "../../../wiki/discuss-locate.ts";
import { locateKey } from "../../../wiki/locate-key.ts";
import { DISCUSS_TEXT_HIDDEN, DISCUSS_TEXT_SKIP, discussText, discussTextParts } from "../components/wiki-discuss-text.ts";
import { readerSelectionText } from "../components/wiki-lens.ts";
import { readerArticle as renderReader } from "./discuss-reader-article.ts";

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

/** The article as the reader shows it, roles `utvikler` unless named. */
const readerArticle = (md: string, title?: string, roles: string[] = ["utvikler"]) => renderReader(md, { title, roles });

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
 *  a fence, two role lanes, a DecisionLog, and every component an enhancer of
 *  the chain changes the text of (a Checklist and a RunChecklist, a Timeline,
 *  a Query run, a FactCheck block, a bare id the ref links wrap). */
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
  // Labels the reader writes where the source has none: an untitled Fold's
  // «Details», a callout's type name when `> [!type]` has no title.
  "<Fold>",
  "",
  "An untitled fold's body.",
  "",
  "</Fold>",
  "",
  '<Fold summary="a teaser only">',
  "",
  "A teaser fold's body.",
  "",
  "</Fold>",
  "",
  "> [!note]",
  "> A note with no title.",
  "",
  "> [!caution]",
  "> A caution with no title.",
  "",
  "> [!warning]",
  "> A warning with no title.",
  "",
  "> [!tip]",
  "> A tip with no title.",
  "",
  "> [!danger]",
  "> A danger with no title.",
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
  "As D2 says, the summer stop comes first.",
  "",
  "<Checklist>",
  "",
  "- [x] Order the new boards",
  "- [ ] Hang the new boards",
  "  - [X] Measure the frames",
  "  - plain note under a step",
  "",
  "</Checklist>",
  "",
  "<RunChecklist>",
  "",
  "1. [x] Load the timetable",
  "   - Command: `bun run load`",
  "   - Expected: four stops",
  "2. [ ] Publish the timetable",
  "",
  "</RunChecklist>",
  "",
  "<Timeline>",
  "",
  "- **2026-09-28** — Pier survey done.",
  "- 2026-09-29 – Boards ordered.",
  "- 29.09: Night route checked.",
  "- Undated step — keeps its dash.",
  "",
  "</Timeline>",
  "",
  '<Query id="Q-1" question="How many stops?" answer="Four.">',
  "",
  "Counted from the summer route.",
  "",
  "</Query>",
  "",
  '<Query id="Q-2" question="How many boards?" answer="Six.">',
  "",
  "Counted at the pier.",
  "",
  "</Query>",
  "",
  '<FactCheck date="2026-11-01">',
  "",
  "The pier claim was checked.",
  "",
  "</FactCheck>",
  "",
].join("\n");

const TITLE = "Harbour timetable";
const BLOCKS = "li, td, th, h1, h2, h3, h4, summary, blockquote, .callout-body, .tldr-body, pre, .fence, section.decision-log, .nm-lanes, .nm-lane";

describe("the fixture page, after the client's enhancers", () => {
  test("the enhancers ran: a fence label, lanes reordered for the role, the DecisionLog newest first", async () => {
    const a = await readerArticle(FIXTURE, TITLE);
    expect(a.querySelector(".fence .fence-lang")?.textContent).toBe("ts");
    const lanes = Array.from(a.querySelectorAll(".nm-lanes > .nm-lane"));
    expect(lanes.map((l) => l.getAttribute("data-nm-order"))).toEqual(["1", "0"]);
    const items = Array.from(a.querySelectorAll("section.decision-log .dl-list > li"));
    expect(items.map((li) => li.getAttribute("data-dl-order"))).toEqual(["2", "1", "0"]);
    // The rest of the chain: the Query explorer's bar, the fact-check toolbar,
    // a ref link on the bare id, the checklist marks.
    expect(a.querySelector(".qx-bar .qx-count")?.textContent).toBe("2 of 2 queries");
    expect(a.querySelector(".fc-toolbar")).not.toBeNull();
    expect(Array.from(a.querySelectorAll(".check-mark")).map((m) => m.textContent)).toEqual(["✓", "✗", "✓", "✓", "✗"]);
  });

  test("every text block, as the context reads it, is found in the collapse", async () => {
    const a = await readerArticle(FIXTURE, TITLE);
    const server = serverKey(FIXTURE, TITLE);
    // A block inside reader-added text (the dates view a Timeline brings) is
    // the reader's own: a selection there goes to the section by design.
    const blocks = Array.from(a.querySelectorAll(BLOCKS)).filter((b) => !b.closest(DISCUSS_TEXT_SKIP));
    expect(blocks.length).toBeGreaterThan(16);
    const missing = blocks.map((b) => locateKey(discussText(b))).filter((k) => k && !server.includes(k));
    expect(missing).toEqual([]);
  });

  test("every text block, as a selection over it reads (`readerSelectionText`), is found in the collapse", async () => {
    const a = await readerArticle(FIXTURE, TITLE);
    const server = serverKey(FIXTURE, TITLE);
    // Lanes are left out here: a selection over the lane list in its shown
    // order is not one stretch of the source (the client marks it `reordered`).
    const blocks = Array.from(a.querySelectorAll(BLOCKS)).filter((b) => !b.matches(".nm-lanes") && !b.closest(".nm-head") && !b.closest(DISCUSS_TEXT_SKIP));
    // A block whose text is all reader-added (a mermaid fence, drawn as an
    // SVG), or that opens with a reader label (an untitled Fold's summary), is
    // left out too: a selection there goes to the section by design.
    const opensAdded = (b: Element) => {
      const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent!.trim()) return !!n.parentElement?.closest(DISCUSS_TEXT_SKIP);
      return false;
    };
    const missing = blocks
      .filter((b) => (!b.closest(".nm-lane") || b.matches("li")) && locateKey(discussText(b)) !== "" && !opensAdded(b))
      .map((b) => locateKey(selectionTextOver(b)))
      .filter((k) => k && !server.includes(k));
    expect(missing).toEqual([]);
  });

  test("every text the context keeps is in the collapse, in order: a reader addition missing from the skip lists is named", async () => {
    const a = await readerArticle(FIXTURE, TITLE);
    const server = serverKey(FIXTURE, TITLE);
    // Each piece must start where the previous one ended: an `indexOf` from the
    // cursor lets a short label («Note») match a later word and names the
    // passage after it instead.
    const missing: string[] = [];
    let at = 0;
    for (const part of discussTextParts(a)) {
      const k = locateKey(part);
      if (!k) continue;
      if (server.startsWith(k, at)) at += k.length;
      else missing.push(part.trim());
    }
    expect(missing).toEqual([]);
  });

  test("the whole article, as the context reads it, equals the collapse", async () => {
    expect(locateKey(discussText(await readerArticle(FIXTURE, TITLE)))).toBe(serverKey(FIXTURE, TITLE));
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
  ["an untitled Fold: its «Details» is the reader's", "<Fold>\n\nBody.\n\n</Fold>\n"],
  ["an untitled Fold with a summary", '<Fold summary="a teaser">\n\nBody.\n\n</Fold>\n'],
  ["an Obsidian callout with no title: its type name is the reader's", "> [!caution]\n> Body.\n"],
  ["an Obsidian callout with no title and no body", "Above.\n\n> [!warning]\n\nBelow.\n"],
  ["a fold's title and summary",'<Fold title="Title here" summary="summary here">\n\nBody.\n\n</Fold>\n'],
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
  // Checklist marks: ✓/✗ are the reader's, `[x]`/`[ ]` the source's.
  ["a Checklist's marks", "<Checklist>\n\n- [x] Done item\n- [ ] Open item\n  - [X] Nested done\n  - plain nested\n\n</Checklist>\n"],
  ["a RunChecklist's marks, step numbers and labels", "<RunChecklist>\n\n1. [x] Step one\n   - Command: `ls`\n   - Expected: a list\n2. [ ] Step two\n\n</RunChecklist>\n"],
  ["a task list in a lane", '<NextMoves>\n\n<Lane kind="you">\n\n- [x] Done step\n- [ ] Open step\n\n</Lane>\n\n</NextMoves>\n'],
  ["a task marker outside a checklist is text", "- [x] Done item\n- [ ] Open item\n"],
  ["a Lane outside NextMoves keeps its task markers as text", '<Lane kind="you">\n\n- [x] Done step\n- [ ] Open step\n\n</Lane>\n'],
  // A Timeline shows a dated item's date and text, not the separator between.
  ["a Timeline's date separators", "<Timeline>\n\n- **2026-09-28** — Pier opened.\n- 2026-09-29 – Boards printed.\n- 29.09: Short one.\n- Undated — keeps its dash.\n\n</Timeline>\n"],
  ["a Query run: the explorer's search bar and count", '<Query id="Q-1" question="How many?" answer="Four.">\n\nBody one.\n\n</Query>\n\n<Query id="Q-2" question="Which?" answer="Two.">\n\nBody two.\n\n</Query>\n'],
  // List markers, as the reader's parser (`parseBlocks`) reads them.
  ["`1)` is no list marker", "1) first\n2) second\n"],
  ["a wrapped line that starts `1979)` is prose", "A paragraph that wraps\n1979) a year line.\n"],
  ["a column-0 number under prose opens a list", "A paragraph that wraps\n2022. a year line.\n"],
  ["`1.` interrupts a paragraph", "Text before\n1. one\n2. two\n"],
  ["`2.` at column 0 interrupts a paragraph", "Text before\n2. two\n3. three\n"],
  ["an indented number under prose is text", "Para\n  1. indented\n"],
  ["`3.` under an item's text is continuation text", "- item\n  3. wraps\n"],
  ["`1.` under an item's text opens a child list", "- item\n  1. wraps\n"],
  ["a number after a blank line under an item opens a child list", "- item\n\n  2. after blank\n"],
  ["one marker per line", "- 1. deep\n- 2) paren\n"],
  ["a number with no text after it is text", "Para.\n\n2.\n\nAnd 7.\n"],
  ["numbers after a blank line", "Para.\n\n3. three\n4. four\n"],
];

describe("forms: the enhanced render and the collapse agree", () => {
  for (const [name, md] of FORMS) {
    test(name, async () => {
      const title = name.startsWith("the leading H1") ? "Same title" : undefined;
      expect(locateKey(discussText(await readerArticle(md, title)))).toBe(serverKey(md, title));
    });
  }
});

describe("where the two differ on purpose", () => {
  test("a mermaid fence: the client drops it (an SVG once drawn), and so does the collapse", async () => {
    const md = "Before.\n\n```mermaid\ngraph LR\n  A --> B\n```\n\nAfter.\n";
    expect(locateKey(discussText(await readerArticle(md)))).toBe("before.after.");
    expect(serverKey(md)).toBe("before.after.");
  });
  test("a Figure's caption is reader-added: the client skips it and the collapse leaves it out", async () => {
    const fig = '<Figure caption="A caption">\n\nBody.\n\n</Figure>\n';
    expect((await readerArticle(fig)).querySelector("figcaption")?.textContent).toContain("A caption");
    expect(locateKey(discussText(await readerArticle(fig)))).not.toContain("acaption");
    expect(serverKey(fig)).not.toContain("acaption");
  });
  test("a Query's head: reader chrome to the client, an attribute to the collapse", async () => {
    const q = '<Query id="Q-1" question="How many?" answer="Four.">\n\nBody.\n\n</Query>\n';
    expect(locateKey(discussText(await readerArticle(q)))).not.toContain("howmany");
    expect(serverKey(q)).not.toContain("howmany");
  });
  test("the decision views (`dc-view`) copy text from elsewhere on the page; the client skips them", async () => {
    const a = await readerArticle("The pier opens at six.\n");
    const view = document.createElement("section");
    view.className = "dc-view qg";
    view.textContent = "The pier opens at six.";
    a.prepend(view);
    expect(locateKey(discussText(a))).toBe("thepieropensatsix.");
  });
});
