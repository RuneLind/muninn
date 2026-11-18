/**
 * The Discuss locator's cases, end to end on synthetic pages: the reader's
 * render after the client's enhancers, a selection made on it, its text read
 * by `readerSelectionText` and its context by `discussContext`, then
 * `locatePassage` on the page source. The one outcome every case guards: a
 * line range stated as found (`exact`) is the passage's own; anything else is
 * a marked fallback. The parity of the two readings is
 * `wiki-discuss-parity.test.ts`, written before these.
 *
 * Own process: it installs happy-dom's globals (the enhancers create nodes
 * through `document`), so it is alone in its `bun test` link.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { questionRenderOptionsFor, renderWikiHtml } from "../../../wiki/render.ts";
import { locatePassage, type LocateResult } from "../../../wiki/discuss-locate.ts";
import { DISCUSS_TEXT_HIDDEN, discussContext, discussHeading } from "../components/wiki-discuss-text.ts";
import { enhanceCodeBlocks } from "../components/code-block-chrome.ts";
import { applyLaneRoles } from "../components/wiki-report-blocks.ts";
import { enhanceLens, readerSelectionText } from "../components/wiki-lens.ts";

const g = globalThis as unknown as Record<string, unknown>;
const IGNORE = new Set(["constructor", "undefined", "NaN", "global", "globalThis", "console"]);
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  const win = new GlobalWindow({ url: "http://localhost:3011/wiki" });
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(win))) {
    if (IGNORE.has(key)) continue;
    const cur = Object.getOwnPropertyDescriptor(globalThis, key);
    if (cur && "value" in desc && cur.value === desc.value) continue;
    saved.set(key, cur);
    const next = "value" in desc && desc.value === win ? { ...desc, value: globalThis } : desc;
    Object.defineProperty(globalThis, key, { ...next, configurable: true });
  }
  // What the reading classes' CSS hides, which happy-dom does not apply.
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

/** The reader's article for `md`, enhanced as `fetchAndRenderPage` does. */
function readerArticle(md: string, opts: { title?: string; roles?: string[] } = {}): HTMLElement {
  document.body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.id = "articleWrap";
  wrap.innerHTML = `<div class="wiki-article">${renderWikiHtml(md, resolve, {
    stripTitle: opts.title,
    readerShapes: true,
    views: true,
    question: questionRenderOptionsFor(md, null, false, null),
  })}</div>`;
  document.body.appendChild(wrap);
  const article = wrap.querySelector<HTMLElement>(".wiki-article")!;
  enhanceCodeBlocks(article);
  applyLaneRoles(article, opts.roles ?? []);
  enhanceLens(wrap, { language: "en", agentAvailable: false, inPlace: false, chipHost: null, initial: "all" } as never);
  return article;
}

/** Text nodes of `root` outside the hidden parts, with a flat string. */
function flat(root: Element) {
  const nodes: { node: Text; at: number }[] = [];
  let text = "";
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      nodes.push({ node: n as Text, at: text.length });
      text += (n as Text).data;
      return;
    }
    if (n.nodeType !== 1 || (n as Element).matches(DISCUSS_TEXT_HIDDEN)) return;
    for (const k of Array.from(n.childNodes)) walk(k);
  };
  walk(root);
  const pos = (i: number, end = false): [Text, number] => {
    let hit = nodes[0]!;
    for (const n of nodes) if (end ? n.at < i : n.at <= i) hit = n;
    return [hit.node, i - hit.at];
  };
  return { text, pos };
}

/** A range over the n-th (1-based) `from` in `root`'s reading, to the end of
 *  `to` (the first after it), or of `from` itself. */
function rangeOf(root: Element, from: string, opts: { nth?: number; to?: string } = {}): Range {
  const f = flat(root);
  let at = -1;
  for (let k = 0; k < (opts.nth ?? 1); k++) at = f.text.indexOf(from, at + 1);
  if (at === -1) throw new Error(`no «${from}»`);
  let end = at + from.length;
  if (opts.to) {
    const e = f.text.indexOf(opts.to, at);
    if (e === -1) throw new Error(`no «${opts.to}»`);
    end = e + opts.to.length;
  }
  const r = document.createRange();
  r.setStart(...f.pos(at));
  r.setEnd(...f.pos(end, true));
  return r;
}

/** Select `range` and locate it in `md` as the client and the route do. */
function locate(md: string, range: Range, title?: string): LocateResult {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  const selection = readerSelectionText(sel).trim();
  const article = (range.startContainer.parentElement ?? (range.startContainer as Element)).closest(".wiki-article")!;
  const ctx = discussContext(article, sel.getRangeAt(0))!;
  return locatePassage(md, { selection, before: ctx.before, after: ctx.after, atStart: ctx.atStart, atEnd: ctx.atEnd, edge: ctx.edge ?? undefined, heading: ctx.heading, stripTitle: title });
}

/** 1-based line of the n-th line holding `text`. */
function lineOf(md: string, text: string, nth = 1): number {
  const lines = md.split("\n");
  let k = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(text) && ++k === nth) return i + 1;
  throw new Error(`no line with «${text}»`);
}

function expectExact(r: LocateResult, from: number, to = from): void {
  expect({ found: r.found, from: r.fromLine, to: r.toLine }).toEqual({ found: "exact", from, to });
}

/** Never a range stated as found that is not `line`'s. */
function expectNotWrong(r: LocateResult, from: number, to = from): void {
  if (r.found === "exact") expect({ from: r.fromLine, to: r.toLine }).toEqual({ from, to });
}

const page = (...body: string[]) => ["---", "title: Harbour timetable", "---", "", ...body, ""].join("\n");

describe("inline markup and links", () => {
  const md = page(
    "## Brief",
    "",
    "The **winter** timetable moves to `harbour.yaml`, see [the docs](https://example.com/d), [[ferry-plan]] and [[ferry-plan|the ferry plan]] for the rest.",
    "",
    "- **R1, summer.** Adds a stop at `Example Island` for MELOSYS-999.",
    "- The night route is unchanged.",
  );
  test("a selection over bold, inline code, a link and both kinds of wikilink", () => {
    const a = readerArticle(md);
    expectExact(locate(md, rangeOf(a, "winter timetable", { to: "the ferry plan" })), lineOf(md, "winter"));
  });
  test("a bullet that opens in bold and holds inline code", () => {
    const a = readerArticle(md);
    expectExact(locate(md, rangeOf(a, "R1, summer.", { to: "MELOSYS-999." })), lineOf(md, "R1, summer"));
  });
  test("across two list items", () => {
    const a = readerArticle(md);
    expectExact(locate(md, rangeOf(a, "Example Island", { to: "is unchanged." })), lineOf(md, "R1, summer"), lineOf(md, "night route"));
  });
});

describe("chips the reader adds", () => {
  test("a selection over a live-fact chip (filled by the client) and a fact-check chip", () => {
    const md = page("Merged MELOSYS-999 today, and the pier is <Fact n=\"1\" v=\"ok\">open at six</Fact> every day of the week.");
    const a = readerArticle(md);
    // The client fills a live chip after the mention, reader-only.
    const f = flat(a);
    const [node, off] = f.pos(f.text.indexOf("MELOSYS-999") + "MELOSYS-999".length);
    const chip = document.createElement("span");
    chip.className = "fact-chip";
    chip.setAttribute("data-reader-only", "");
    chip.textContent = "merged 2d";
    node.splitText(off);
    node.after(chip);
    expect(a.querySelector(".fc-chip")).not.toBeNull();
    expectExact(locate(md, rangeOf(a, "Merged", { to: "of the week." })), lineOf(md, "Merged"));
  });
  test("a page with fact wrappers, block and inline", () => {
    const md = page('<Fact n="2" v="warn">', "A whole checked paragraph about the pier.", "</Fact>", "", 'Before <Fact n="3" v="ok">a claim</Fact> after it.');
    const a = readerArticle(md);
    expectExact(locate(md, rangeOf(a, "checked paragraph")), lineOf(md, "checked paragraph"));
    expectExact(locate(md, rangeOf(a, "a claim after")), lineOf(md, "a claim"));
  });
});

describe("duplicates", () => {
  test("a sentence twice on the page: each copy gets its own line", () => {
    const md = page("## One", "", "Boats leave early. The pier opens at six.", "", "## Two", "", "Ferries run late. The pier opens at six.");
    const a = readerArticle(md);
    expectExact(locate(md, rangeOf(a, "The pier opens at six.", { nth: 1 })), lineOf(md, "The pier opens", 1));
    expectExact(locate(md, rangeOf(a, "The pier opens at six.", { nth: 2 })), lineOf(md, "The pier opens", 2));
  });
  test("twice in one section", () => {
    const md = page("## One", "", "Boats leave early. The pier opens at six.", "", "Ferries run late. The pier opens at six.");
    const a = readerArticle(md);
    expectExact(locate(md, rangeOf(a, "The pier opens at six.", { nth: 2 })), lineOf(md, "The pier opens", 2));
  });
  test("two identical bullets whose neighbours are the same further than the context reads fall back, both lines listed", () => {
    // Neighbours longer than the context the client reads (160 key characters), so no side tells the copies apart.
    const long = "Check the pier, the ramp, the bollards, the lights and the ropes before the first boat leaves the harbour in the morning, and write each finding in the log book by the door, with the time, the name of the person who checked and what was done about it.";
    const md = page("## Steps", "", `- ${long}`, "- Print the boards.", `- ${long}`, "", "## More", "", `- ${long}`, "- Print the boards.", `- ${long}`);
    const a = readerArticle(md);
    const r = locate(md, rangeOf(a, "Print the boards.", { nth: 1 }));
    expect(r.found).toBe("section");
    expect(r.reason).toBe("ambiguous");
    expect(r.candidates).toEqual([lineOf(md, "Print the boards", 1), lineOf(md, "Print the boards", 2)]);
    expect(r.section?.heading).toBe("Steps");
  });
  test("two identical bullets told apart only past the near context: the far context chooses", () => {
    const md = page("## Steps", "", "- Check the pier.", "- Print the boards.", "- Check the pier.", "- Print the boards.", "- Check the pier.");
    const a = readerArticle(md);
    expectExact(locate(md, rangeOf(a, "Print the boards.", { nth: 1 })), lineOf(md, "Print the boards", 1));
    expectExact(locate(md, rangeOf(a, "Print the boards.", { nth: 2 })), lineOf(md, "Print the boards", 2));
  });
});

describe("inside components", () => {
  const md = page(
    "## Design",
    "",
    '<Fold title="Routes" summary="three routes">',
    "",
    "The summer route adds a stop at the island.",
    "",
    '<Callout tone="warn" title="Watch the tide">',
    "",
    "Low water closes the north pier.",
    "",
    "</Callout>",
    "",
    "</Fold>",
    "",
    "| Route | Stops |",
    "|---|---|",
    "| Summer | `4` stops a day |",
    "| Winter | `2` stops a day |",
  );
  test("inside a Fold", () => {
    const a = readerArticle(md);
    expectExact(locate(md, rangeOf(a, "summer route adds")), lineOf(md, "summer route adds"));
  });
  test("inside a component inside a Fold", () => {
    const a = readerArticle(md);
    expectExact(locate(md, rangeOf(a, "Low water closes the north pier.")), lineOf(md, "Low water"));
  });
  test("in a table row", () => {
    const a = readerArticle(md);
    expectExact(locate(md, rangeOf(a, "2 stops a day")), lineOf(md, "| Winter"));
  });
});

describe("text the source does not hold, and short pages", () => {
  test("text the reader shows that is not in the file: no range stated as found", () => {
    const md = page("## Brief", "", "The pier opens at six.");
    const a = readerArticle(md);
    a.insertAdjacentHTML("beforeend", "<p>Nothing like this is in the file.</p>");
    const r = locate(md, rangeOf(a, "Nothing like this"));
    expect(r.found).not.toBe("exact");
    expect(r.reason).toBe("no-match");
  });
  test("a page under 3,000 characters", () => {
    const md = page("A short note: the pier opens at six.");
    expect(md.length).toBeLessThan(3000);
    const a = readerArticle(md);
    const r = locate(md, rangeOf(a, "the pier opens at six."));
    expectExact(r, lineOf(md, "short note"));
  });
});

describe("review cases: a range stated as found is never another place's", () => {
  test("1: a word in a lane's head goes to the section, though the source holds it elsewhere", () => {
    const md = page("## Next", "", "<NextMoves>", "", '<Lane kind="you" who="harbourmaster">', "", "- Print the boards.", "", "</Lane>", "", "</NextMoves>", "", "The harbourmaster_config key sets it.");
    const a = readerArticle(md);
    const head = a.querySelector(".nm-head .nm-who")!;
    const r2 = document.createRange();
    r2.selectNodeContents(head);
    const r = locate(md, r2);
    expect(r.found).not.toBe("exact");
    expect(r.reason).toBe("added");
  });
  test("1: text in a Query card's SQL (a sibling file's content) goes to the section", () => {
    const md = page("## Data", "", "Count the boats per day.", "", "select count(*) from boats");
    const a = readerArticle(md);
    a.insertAdjacentHTML("afterbegin", '<details class="query-sql"><summary>SQL</summary><pre>select count(*) from boats</pre></details>');
    const r = locate(md, rangeOf(a, "select count(*) from boats", { nth: 1 }));
    expect(r.found).not.toBe("exact");
  });
  test("1: unknown chrome holding a word the source has elsewhere: the context disagrees", () => {
    const md = page("## Brief", "", "Boats leave early.", "", "The harbour_pier key is in config.");
    const a = readerArticle(md);
    // A reader addition this reading does not know of.
    a.insertAdjacentHTML("afterbegin", '<div class="some-new-chrome">harbour</div>');
    const r = locate(md, rangeOf(a, "harbour", { nth: 1 }));
    expect(r.found).not.toBe("exact");
  });
  test("2: a Figure caption that repeats a prose sentence", () => {
    const md = page("## Map", "", "The pier opens at six.", "", '<Figure caption="The pier opens at six.">', "", "![map](map.png)", "", "</Figure>", "", "More text after.");
    const a = readerArticle(md);
    const cap = a.querySelector("figcaption")!;
    const r2 = document.createRange();
    r2.selectNodeContents(cap);
    const r = locate(md, r2);
    expect(r.found).not.toBe("exact");
    expect(r.reason).toBe("added");
  });
  test("2: attribute-born text (a Tab label, a FactCheck date, a DeltaTable/Steps/Diagram src line, a Lane's who) is never placed at a prose copy", () => {
    const S = "zz copy here";
    const cases = [
      `<Tab label="${S}">\n\nBody.\n\n</Tab>`,
      `<FactCheck date="${S}">\n\nBody.\n\n</FactCheck>`,
      `<DeltaTable src="${S}" />`,
      `<Steps src="${S}" />`,
      `<Diagram src="${S}" caption="x" />`,
      `<Lane kind="you" who="${S}">\n\n- item\n\n</Lane>`,
    ];
    for (const c of cases) {
      const md = page("## A", "", `Prose: ${S}.`, "", c, "", "After.");
      const a = readerArticle(md);
      const f = flat(a);
      const first = f.text.indexOf(S);
      const second = f.text.indexOf(S, first + 1);
      if (second === -1) continue; // the component does not show it
      const r = locate(md, rangeOf(a, S, { nth: 2 }));
      expect({ c, found: r.found }).not.toEqual({ c, found: "exact" });
    }
  });
  test("3: a Diagram body (source only) and its caption (reader only) with the same words", () => {
    const md = page("## Flow", "", '<Diagram src="flow.diagram.json" caption="boats to the pier">', "", "boats to the pier", "", "</Diagram>", "", "After the diagram.");
    // As the reader shows a loaded diagram: the picture and its caption.
    const shown = (captionTag: string) => {
      const a = readerArticle(md);
      a.querySelector(".dgm-unavailable")!.outerHTML = `<figure class="dgm"><svg></svg><${captionTag}>boats to the pier</${captionTag.split(" ")[0]}></figure>`;
      return a;
    };
    expect(locate(md, rangeOf(shown("figcaption"), "boats to the pier")).reason).toBe("added");
    // A caption element this reading does not know of: the body is no text the
    // reader shows, so the source holds no match.
    const r = locate(md, rangeOf(shown('div class="some-caption"'), "boats to the pier"));
    expect(r.found).not.toBe("exact");
    expect(r.reason).toBe("no-match");
  });
  test("4: an identical bullet in two lanes the role reorders gets its own lane's line, or falls back", () => {
    const md = page(
      "<NextMoves>",
      "",
      '<Lane kind="you" role="fag">',
      "",
      "- Confirm the stops.",
      "- Print the new boards.",
      "",
      "</Lane>",
      "",
      '<Lane kind="you" role="utvikler">',
      "",
      "- Ship the parser.",
      "- Print the new boards.",
      "",
      "</Lane>",
      "",
      "</NextMoves>",
    );
    const a = readerArticle(md, { roles: ["utvikler"] });
    expect(Array.from(a.querySelectorAll(".nm-lanes > .nm-lane")).map((l) => l.getAttribute("data-nm-order"))).toEqual(["1", "0"]);
    // Shown first: the utvikler lane's copy, authored second.
    expectExact(locate(md, rangeOf(a, "Print the new boards.", { nth: 1 })), lineOf(md, "Print the new boards", 2));
    expectExact(locate(md, rangeOf(a, "Print the new boards.", { nth: 2 })), lineOf(md, "Print the new boards", 1));
  });
  test("4: two single-bullet lanes with the same bullet, swapped by the role: never the other lane's line", () => {
    const md = page("<NextMoves>", "", '<Lane kind="you" role="fag">', "", "- Print the new boards.", "", "</Lane>", "", '<Lane kind="you" role="utvikler">', "", "- Print the new boards.", "", "</Lane>", "", "</NextMoves>");
    const a = readerArticle(md, { roles: ["utvikler"] });
    expectNotWrong(locate(md, rangeOf(a, "Print the new boards.", { nth: 1 })), lineOf(md, "Print the new boards", 2));
    expectNotWrong(locate(md, rangeOf(a, "Print the new boards.", { nth: 2 })), lineOf(md, "Print the new boards", 1));
  });
  test("4: a selection across two reordered lanes goes to the section", () => {
    const md = page("## Next", "", "<NextMoves>", "", '<Lane kind="you" role="fag">', "", "- Confirm the stops.", "", "</Lane>", "", '<Lane kind="you" role="utvikler">', "", "- Ship the parser.", "", "</Lane>", "", "</NextMoves>");
    const a = readerArticle(md, { roles: ["utvikler"] });
    const range = rangeOf(a, "the parser.", { to: "Confirm the" });
    expect(discussContext(a, range)?.edge).toBe("reordered");
    const r = locate(md, range);
    expect(r).toMatchObject({ found: "section", reason: "reordered" });
    // Lanes in their authored order: one stretch of the source, no mark.
    const plain = readerArticle(md);
    expect(discussContext(plain, rangeOf(plain, "the stops.", { to: "Ship the" }))?.edge).toBeNull();
  });
  test("5: a selection across DecisionLog items shown newest first, with a verbatim copy elsewhere", () => {
    const md = page(
      "## Log",
      "",
      "<DecisionLog>",
      "",
      "- **D1** — Keep the night route. Kari Nordmann, 01.11.2026.",
      "- **D2** — Add the summer stop. Kari Nordmann, 02.11.2026.",
      "",
      "</DecisionLog>",
      "",
      "## Copy",
      "",
      "- **D1** — Keep the night route. Kari Nordmann, 01.11.2026.",
      "- **D2** — Add the summer stop. Kari Nordmann, 02.11.2026.",
    );
    const a = readerArticle(md);
    // Shown newest first: D2 then D1; select from D2's text into D1's.
    const r = locate(md, rangeOf(a, "Add the summer stop", { to: "Keep the night" }));
    expectNotWrong(r, lineOf(md, "D1", 1), lineOf(md, "D2", 1));
  });
  test("5: one DecisionLog item with a verbatim copy elsewhere: its own line", () => {
    const md = page("## Log", "", "<DecisionLog>", "", "- **D1** — Keep the night route. Kari Nordmann, 01.11.2026.", "- **D2** — Add the summer stop. Kari Nordmann, 02.11.2026.", "", "</DecisionLog>", "", "## Notes", "", "Add the summer stop. Kari Nordmann, 02.11.2026.");
    const a = readerArticle(md);
    expectExact(locate(md, rangeOf(a, "Add the summer stop", { nth: 1 })), lineOf(md, "Add the summer stop", 1));
  });
  test("a fence's label and Copy button inside a selection do not break the match", () => {
    const md = page("## Code", "", "Run this:", "", "```ts", "const stops = 4;", "```", "", "Then stop.");
    const a = readerArticle(md);
    expect(a.querySelector(".fence-lang")?.textContent).toBe("ts");
    expectExact(locate(md, rangeOf(a, "Run this:", { to: "Then stop." })), lineOf(md, "Run this"), lineOf(md, "Then stop"));
  });
});

describe("the heading the client sends", () => {
  test("the heading itself when the selection starts in it, without the reader's 🧭", () => {
    const md = page("## One", "", "Text one.", "", "## Two", "", "Text two.");
    const a = readerArticle(md);
    const h = a.querySelectorAll("h1, h2, h3, h4")[1]!;
    h.insertAdjacentHTML("beforeend", "<button>🧭</button>");
    expect(discussHeading(a, rangeOf(a, "Two"))).toBe("Two");
  });
  test("a heading inside an earlier sibling (a Fold's own heading) counts", () => {
    const md = page("## Top", "", '<Fold title="Routes">', "", "### Inner", "", "Inside.", "", "</Fold>", "", "After the fold.");
    const a = readerArticle(md);
    expect(discussHeading(a, rangeOf(a, "After the fold."))).toBe("Inner");
    expect(discussHeading(a, rangeOf(a, "Inside."))).toBe("Inner");
  });
  test("top-level prose under a heading (the selection's parent is the article)", () => {
    const md = page("## Brief", "", "Bare prose at the top level.");
    const a = readerArticle(md);
    expect(discussHeading(a, rangeOf(a, "Bare prose"))).toBe("Brief");
  });
  test("a range that starts at the article element itself", () => {
    const md = page("## Brief", "", "Bare prose at the top level.");
    const a = readerArticle(md);
    const r = document.createRange();
    r.setStart(a, 0);
    r.setEnd(a, a.childNodes.length);
    expect(discussContext(a, r)?.atStart).toBe(true);
    expect(discussHeading(a, r)).toBe("Brief");
  });
});
