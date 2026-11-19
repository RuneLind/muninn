/**
 * The Discuss locator's cases, end to end on synthetic pages: the reader's
 * render after every step the reader runs on it (`discuss-reader-article.ts`), a selection made on it, its text read
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
import { locatePassage, type LocateResult } from "../../../wiki/discuss-locate.ts";
import { DISCUSS_TEXT_HIDDEN, discussContext, discussHeading } from "../components/wiki-discuss-text.ts";
import { readerSelectionText } from "../components/wiki-lens.ts";
import { readerArticle } from "./discuss-reader-article.ts";
import {
  DISCUSS_HANDOFF_PAGE_BTN_ID,
  DISCUSS_HANDOFF_PANEL_ID,
  DISCUSS_HANDOFF_SEL_BTN_ID,
  initDiscussHandoff,
  openDiscussHandoff,
  setDiscussHandoffEnabled,
} from "../components/wiki-discuss-handoff.ts";
import { DISCUSS_INPUT_ID, discussAgentOn, initDiscussTab, setDiscussAgentEnabled } from "../components/wiki-discuss-tab.ts";
import { discussTabBodyHtml } from "../components/wiki-discuss-tab-view.ts";
import { applyWikiReadonlyInputLocks, installWikiReadonlyGuard, WIKI_READONLY_INPUT_PLACEHOLDER } from "../components/wiki-readonly-client.ts";

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
  test("a selection over bold, inline code, a link and both kinds of wikilink", async () => {
    const a = await readerArticle(md);
    expectExact(locate(md, rangeOf(a, "winter timetable", { to: "the ferry plan" })), lineOf(md, "winter"));
  });
  test("a bullet that opens in bold and holds inline code", async () => {
    const a = await readerArticle(md);
    expectExact(locate(md, rangeOf(a, "R1, summer.", { to: "MELOSYS-999." })), lineOf(md, "R1, summer"));
  });
  test("across two list items", async () => {
    const a = await readerArticle(md);
    expectExact(locate(md, rangeOf(a, "Example Island", { to: "is unchanged." })), lineOf(md, "R1, summer"), lineOf(md, "night route"));
  });
});

describe("chips the reader adds", () => {
  test("a selection over a live-fact chip (filled by the client) and a fact-check chip", async () => {
    const md = page("Merged MELOSYS-999 today, and the pier is <Fact n=\"1\" v=\"ok\">open at six</Fact> every day of the week.");
    const a = await readerArticle(md);
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
  test("a page with fact wrappers, block and inline", async () => {
    const md = page('<Fact n="2" v="warn">', "A whole checked paragraph about the pier.", "</Fact>", "", 'Before <Fact n="3" v="ok">a claim</Fact> after it.');
    const a = await readerArticle(md);
    expectExact(locate(md, rangeOf(a, "checked paragraph")), lineOf(md, "checked paragraph"));
    expectExact(locate(md, rangeOf(a, "a claim after")), lineOf(md, "a claim"));
  });
});

describe("duplicates", () => {
  test("a sentence twice on the page: each copy gets its own line", async () => {
    const md = page("## One", "", "Boats leave early. The pier opens at six.", "", "## Two", "", "Ferries run late. The pier opens at six.");
    const a = await readerArticle(md);
    expectExact(locate(md, rangeOf(a, "The pier opens at six.", { nth: 1 })), lineOf(md, "The pier opens", 1));
    expectExact(locate(md, rangeOf(a, "The pier opens at six.", { nth: 2 })), lineOf(md, "The pier opens", 2));
  });
  test("twice in one section", async () => {
    const md = page("## One", "", "Boats leave early. The pier opens at six.", "", "Ferries run late. The pier opens at six.");
    const a = await readerArticle(md);
    expectExact(locate(md, rangeOf(a, "The pier opens at six.", { nth: 2 })), lineOf(md, "The pier opens", 2));
  });
  test("two identical bullets whose neighbours are the same further than the context reads fall back, both lines listed", async () => {
    // Neighbours longer than the context the client reads (160 key characters), so no side tells the copies apart.
    const long = "Check the pier, the ramp, the bollards, the lights and the ropes before the first boat leaves the harbour in the morning, and write each finding in the log book by the door, with the time, the name of the person who checked and what was done about it.";
    const md = page("## Steps", "", `- ${long}`, "- Print the boards.", `- ${long}`, "", "## More", "", `- ${long}`, "- Print the boards.", `- ${long}`);
    const a = await readerArticle(md);
    const r = locate(md, rangeOf(a, "Print the boards.", { nth: 1 }));
    expect(r.found).toBe("section");
    expect(r.reason).toBe("ambiguous");
    expect(r.candidates).toEqual([lineOf(md, "Print the boards", 1), lineOf(md, "Print the boards", 2)]);
    expect(r.section?.heading).toBe("Steps");
  });
  test("two identical bullets told apart only past the near context: the far context chooses", async () => {
    const md = page("## Steps", "", "- Check the pier.", "- Print the boards.", "- Check the pier.", "- Print the boards.", "- Check the pier.");
    const a = await readerArticle(md);
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
  test("inside a Fold", async () => {
    const a = await readerArticle(md);
    expectExact(locate(md, rangeOf(a, "summer route adds")), lineOf(md, "summer route adds"));
  });
  test("inside a component inside a Fold", async () => {
    const a = await readerArticle(md);
    expectExact(locate(md, rangeOf(a, "Low water closes the north pier.")), lineOf(md, "Low water"));
  });
  test("in a table row", async () => {
    const a = await readerArticle(md);
    expectExact(locate(md, rangeOf(a, "2 stops a day")), lineOf(md, "| Winter"));
  });
});

describe("text the source does not hold, and short pages", () => {
  test("text the reader shows that is not in the file: no range stated as found", async () => {
    const md = page("## Brief", "", "The pier opens at six.");
    const a = await readerArticle(md);
    a.insertAdjacentHTML("beforeend", "<p>Nothing like this is in the file.</p>");
    const r = locate(md, rangeOf(a, "Nothing like this"));
    expect(r.found).not.toBe("exact");
    expect(r.reason).toBe("no-match");
  });
  test("a page under 3,000 characters", async () => {
    const md = page("A short note: the pier opens at six.");
    expect(md.length).toBeLessThan(3000);
    const a = await readerArticle(md);
    const r = locate(md, rangeOf(a, "the pier opens at six."));
    expectExact(r, lineOf(md, "short note"));
  });
});

describe("review cases: a range stated as found is never another place's", () => {
  test("1: a word in a lane's head goes to the section, though the source holds it elsewhere", async () => {
    const md = page("## Next", "", "<NextMoves>", "", '<Lane kind="you" who="harbourmaster">', "", "- Print the boards.", "", "</Lane>", "", "</NextMoves>", "", "The harbourmaster_config key sets it.");
    const a = await readerArticle(md);
    const head = a.querySelector(".nm-head .nm-who")!;
    const r2 = document.createRange();
    r2.selectNodeContents(head);
    const r = locate(md, r2);
    expect(r.found).not.toBe("exact");
    expect(r.reason).toBe("added");
  });
  test("1: text in a Query card's SQL (a sibling file's content) goes to the section", async () => {
    const md = page("## Data", "", "Count the boats per day.", "", "select count(*) from boats");
    const a = await readerArticle(md);
    a.insertAdjacentHTML("afterbegin", '<details class="query-sql"><summary>SQL</summary><pre>select count(*) from boats</pre></details>');
    const r = locate(md, rangeOf(a, "select count(*) from boats", { nth: 1 }));
    expect(r.found).not.toBe("exact");
  });
  test("1: unknown chrome holding a word the source has elsewhere: the context disagrees", async () => {
    const md = page("## Brief", "", "Boats leave early.", "", "The harbour_pier key is in config.");
    const a = await readerArticle(md);
    // A reader addition this reading does not know of.
    a.insertAdjacentHTML("afterbegin", '<div class="some-new-chrome">harbour</div>');
    const r = locate(md, rangeOf(a, "harbour", { nth: 1 }));
    expect(r.found).not.toBe("exact");
  });
  test("2: a Figure caption that repeats a prose sentence", async () => {
    const md = page("## Map", "", "The pier opens at six.", "", '<Figure caption="The pier opens at six.">', "", "![map](map.png)", "", "</Figure>", "", "More text after.");
    const a = await readerArticle(md);
    const cap = a.querySelector("figcaption")!;
    const r2 = document.createRange();
    r2.selectNodeContents(cap);
    const r = locate(md, r2);
    expect(r.found).not.toBe("exact");
    expect(r.reason).toBe("added");
  });
  test("2: attribute-born text (a Tab label, a FactCheck date, a DeltaTable/Steps/Diagram src line, a Lane's who) is never placed at a prose copy", async () => {
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
      const a = await readerArticle(md);
      // Every copy the reader shows outside the prose line (a FactCheck date
      // shows twice: in its strip and in the page's fact-check toolbar).
      const f = flat(a);
      for (let nth = 1, at = f.text.indexOf(S); at !== -1; nth++, at = f.text.indexOf(S, at + 1)) {
        const range = rangeOf(a, S, { nth });
        if ((range.startContainer.textContent ?? "").includes("Prose:")) continue;
        const r = locate(md, range);
        expect({ c, nth, found: r.found }).not.toEqual({ c, nth, found: "exact" });
      }
    }
  });
  test("3: a Diagram body (source only) and its caption (reader only) with the same words", async () => {
    const md = page("## Flow", "", '<Diagram src="flow.diagram.json" caption="boats to the pier">', "", "boats to the pier", "", "</Diagram>", "", "After the diagram.");
    // As the reader shows a loaded diagram: the picture and its caption.
    const shown = async (captionTag: string) => {
      const a = await readerArticle(md);
      a.querySelector(".dgm-unavailable")!.outerHTML = `<figure class="dgm"><svg></svg><${captionTag}>boats to the pier</${captionTag.split(" ")[0]}></figure>`;
      return a;
    };
    expect(locate(md, rangeOf(await shown("figcaption"), "boats to the pier")).reason).toBe("added");
    // A caption element this reading does not know of: the body is no text the
    // reader shows, so the source holds no match.
    const r = locate(md, rangeOf(await shown('div class="some-caption"'), "boats to the pier"));
    expect(r.found).not.toBe("exact");
    expect(r.reason).toBe("no-match");
  });
  test("4: an identical bullet in two lanes the role reorders gets its own lane's line, or falls back", async () => {
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
    const a = await readerArticle(md, { roles: ["utvikler"] });
    expect(Array.from(a.querySelectorAll(".nm-lanes > .nm-lane")).map((l) => l.getAttribute("data-nm-order"))).toEqual(["1", "0"]);
    // Shown first: the utvikler lane's copy, authored second.
    expectExact(locate(md, rangeOf(a, "Print the new boards.", { nth: 1 })), lineOf(md, "Print the new boards", 2));
    expectExact(locate(md, rangeOf(a, "Print the new boards.", { nth: 2 })), lineOf(md, "Print the new boards", 1));
  });
  test("4: two single-bullet lanes with the same bullet, swapped by the role: never the other lane's line", async () => {
    const md = page("<NextMoves>", "", '<Lane kind="you" role="fag">', "", "- Print the new boards.", "", "</Lane>", "", '<Lane kind="you" role="utvikler">', "", "- Print the new boards.", "", "</Lane>", "", "</NextMoves>");
    const a = await readerArticle(md, { roles: ["utvikler"] });
    expectNotWrong(locate(md, rangeOf(a, "Print the new boards.", { nth: 1 })), lineOf(md, "Print the new boards", 2));
    expectNotWrong(locate(md, rangeOf(a, "Print the new boards.", { nth: 2 })), lineOf(md, "Print the new boards", 1));
  });
  test("4: a selection across two reordered lanes goes to the section", async () => {
    const md = page("## Next", "", "<NextMoves>", "", '<Lane kind="you" role="fag">', "", "- Confirm the stops.", "", "</Lane>", "", '<Lane kind="you" role="utvikler">', "", "- Ship the parser.", "", "</Lane>", "", "</NextMoves>");
    const a = await readerArticle(md, { roles: ["utvikler"] });
    const range = rangeOf(a, "the parser.", { to: "Confirm the" });
    expect(discussContext(a, range)?.edge).toBe("reordered");
    const r = locate(md, range);
    expect(r).toMatchObject({ found: "section", reason: "reordered" });
    // Lanes in their authored order: one stretch of the source, no mark.
    const plain = await readerArticle(md);
    expect(discussContext(plain, rangeOf(plain, "the stops.", { to: "Ship the" }))?.edge).toBeNull();
  });
  test("5: a selection across DecisionLog items shown newest first, with a verbatim copy elsewhere", async () => {
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
    const a = await readerArticle(md);
    // Shown newest first: D2 then D1; select from D2's text into D1's.
    const r = locate(md, rangeOf(a, "Add the summer stop", { to: "Keep the night" }));
    expectNotWrong(r, lineOf(md, "D1", 1), lineOf(md, "D2", 1));
  });
  test("5: one DecisionLog item with a verbatim copy elsewhere: its own line", async () => {
    const md = page("## Log", "", "<DecisionLog>", "", "- **D1** — Keep the night route. Kari Nordmann, 01.11.2026.", "- **D2** — Add the summer stop. Kari Nordmann, 02.11.2026.", "", "</DecisionLog>", "", "## Notes", "", "Add the summer stop. Kari Nordmann, 02.11.2026.");
    const a = await readerArticle(md);
    expectExact(locate(md, rangeOf(a, "Add the summer stop", { nth: 1 })), lineOf(md, "Add the summer stop", 1));
  });
  const ROPES = "Check the ropes. The pier opens at six and closes at ten every day of the week.";
  test("6: a copy inside an untitled Fold, with the same paragraph first on the page: never the top copy's line", async () => {
    const md = page(ROPES, "", "## Notes", "", '<Fold summary="more">', "", ROPES, "", "</Fold>");
    const a = await readerArticle(md);
    const r = locate(md, rangeOf(a, "The pier opens at six", { nth: 2 }));
    expectNotWrong(r, lineOf(md, "The pier opens", 2));
    // The reader shows the Fold's «Details» label before «more»; the context
    // leaves it out (P1b), so the top copy agrees on both sides and is placed.
    // Before that it fell back (`no-agreement`).
    expectExact(locate(md, rangeOf(a, "The pier opens at six", { nth: 1 })), lineOf(md, "The pier opens", 1));
  });
  test("6: a paragraph first on the page and again after a 1) marker: never the top copy's line", async () => {
    const md = page("The pier opens at six and closes at ten every day of the week.", "", "## Steps", "", "1) The pier opens at six and closes at ten every day of the week.");
    const a = await readerArticle(md);
    expectNotWrong(locate(md, rangeOf(a, "The pier opens at six", { nth: 2 })), lineOf(md, "The pier opens", 2));
  });
  const ITEMS = ["Run the database migration on staging and verify that the row counts match", "Ship the release to production after sign-off"];
  test("6: a Checklist item with a ✓/✗ copy at the page's end: never the copy's line", async () => {
    const md = page("## Plan", "", "<Checklist>", "", `- [x] ${ITEMS[0]}`, `- [ ] ${ITEMS[1]}`, "", "</Checklist>", "", "## Summary", "", `✓ ${ITEMS[0]}`, `✗ ${ITEMS[1]}`);
    const a = await readerArticle(md);
    expectNotWrong(locate(md, rangeOf(a, ITEMS[1]!, { nth: 1 })), lineOf(md, ITEMS[1]!, 1));
  });
  test("6: the mirror, a ✓/✗ copy at the page's start: never the copy's line", async () => {
    const md = page(`✓ ${ITEMS[0]}`, `✗ ${ITEMS[1]}`, "", "## Plan", "", "<Checklist>", "", `- [x] ${ITEMS[0]}`, `- [ ] ${ITEMS[1]}`, "", "</Checklist>");
    const a = await readerArticle(md);
    expectNotWrong(locate(md, rangeOf(a, ITEMS[0]!, { nth: 2 })), lineOf(md, ITEMS[0]!, 2));
  });
  // Round 2: the true copy is refused (the reader shows a Fold's «Details» or a
  // callout's «Note» the collapse does not hold), and a copy with one side
  // agreeing in full and the other only partly was the one taken.
  const MIGRATE = "Run the database migration on staging and verify that the row counts match";
  test("V1: an untitled Fold's copy, with a Checklist copy and a ✓ copy below: never the Checklist's line", async () => {
    const md = ["<Fold>", "", MIGRATE, "", "</Fold>", "", "<Checklist>", "", `- [x] ${MIGRATE}`, "", "</Checklist>", "", `✓ ${MIGRATE}`].join("\n");
    const a = await readerArticle(md);
    expectNotWrong(locate(md, rangeOf(a, MIGRATE.slice(10, 40), { nth: 1 })), 3);
  });
  test("V3: a plain copy between a ✓ copy and a callout's copy: never the callout's line", async () => {
    const md = [`✓ ${MIGRATE}`, "", MIGRATE, "", "> [!note]", `> ${MIGRATE}`, "", '<Fold summary="Notes">', "", MIGRATE, "", "</Fold>"].join("\n");
    const a = await readerArticle(md);
    expectNotWrong(locate(md, rangeOf(a, MIGRATE.slice(0, -6), { nth: 2 })), 3);
  });
  test("a fence's label and Copy button inside a selection do not break the match", async () => {
    const md = page("## Code", "", "Run this:", "", "```ts", "const stops = 4;", "```", "", "Then stop.");
    const a = await readerArticle(md);
    expect(a.querySelector(".fence-lang")?.textContent).toBe("ts");
    expectExact(locate(md, rangeOf(a, "Run this:", { to: "Then stop." })), lineOf(md, "Run this"), lineOf(md, "Then stop"));
  });
});

describe("text the reader shows otherwise than the source spells it", () => {
  /** A range over all of `el`'s content: what a triple-click on a list item selects. */
  const over = (el: Element) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return r;
  };
  const CHECKS = page(
    "## Boards",
    "",
    "<Checklist>",
    "",
    "- [x] Order the new boards from the yard",
    "- [ ] Hang the new boards at the pier",
    "- [ ] Paint the frames before the winter",
    "",
    "</Checklist>",
    "",
    "<RunChecklist>",
    "",
    "1. [x] Load the timetable into the board",
    "2. [ ] Publish the timetable to the ferry app",
    "",
    "</RunChecklist>",
  );
  test("a checklist item, its ✓/✗ mark included, is placed on its own line", async () => {
    const a = await readerArticle(CHECKS);
    const items = Array.from(a.querySelectorAll("li.check-item"));
    expectExact(locate(CHECKS, over(items[1]!)), lineOf(CHECKS, "Hang the new boards"));
    expectExact(locate(CHECKS, over(items[3]!)), lineOf(CHECKS, "Load the timetable"));
  });
  test("a selection across two checklist items spans both lines", async () => {
    const a = await readerArticle(CHECKS);
    expectExact(locate(CHECKS, rangeOf(a, "Hang the new", { to: "before the winter" })), lineOf(CHECKS, "Hang the new"), lineOf(CHECKS, "Paint the frames"));
  });
  test("a Timeline item is placed on its own line, past the separator the reader drops", async () => {
    const md = page("## Log", "", "<Timeline>", "", "- **2026-09-28** — Pier survey done by the harbour office.", "- 2026-09-29 – Boards ordered from the yard.", "", "</Timeline>");
    const a = await readerArticle(md);
    const items = Array.from(a.querySelectorAll("li.gtl-item"));
    expectExact(locate(md, over(items[0]!)), lineOf(md, "Pier survey"));
    expectExact(locate(md, over(items[1]!)), lineOf(md, "Boards ordered"));
  });
  test("a selection that starts in the Query explorer's count starts in reader-added text", async () => {
    const md = page("## Queries", "", '<Query id="Q-1" question="How many stops?" answer="Four.">', "", "Counted from the summer route.", "", "</Query>", "", '<Query id="Q-2" question="How many boards?" answer="Six.">', "", "Counted at the pier.", "", "</Query>");
    const a = await readerArticle(md);
    const range = rangeOf(a, "2 queries", { to: "summer route." });
    expect(discussContext(a, range)?.edge).toBe("added");
    expect(locate(md, range)).toMatchObject({ found: "section", reason: "added" });
  });
  test("a `1)` line is prose, placed on its own line", async () => {
    const md = page("## Steps", "", "1) Walk to the pier at six in the morning.", "2) Count the boats that are moored there.");
    const a = await readerArticle(md);
    expectExact(locate(md, rangeOf(a, "Count the boats")), lineOf(md, "Count the boats"));
  });
});

describe("a selection that starts or ends in a reader label goes to the section", () => {
  const S = "Run the database migration on staging and verify that the row counts match.";
  // `nth`: the FactCheck strip's own counts; the first copy is the toolbar's
  // clone at the article's top, above every heading.
  const CASES: { name: string; body: string[]; from: string; to: string; nth?: number }[] = [
    { name: "starts in an untitled Fold's «Details»", body: ["<Fold>", "", S, "", "</Fold>"], from: "Details", to: "counts match." },
    { name: "starts in a title-less callout's «Note»", body: ["> [!note]", `> ${S}`], from: "Note", to: "counts match." },
    { name: "ends in a title-less callout's «Note»", body: [S, "", "> [!note]", "> Boats leave early."], from: "Run the", to: "Note" },
    { name: "starts in a FactCheck's counts", body: ['<FactCheck date="2026-01-02" ok="2">', "", S, "", "</FactCheck>"], from: "2 confirmed", to: "counts match.", nth: 2 },
  ];
  for (const { name, body, from, to, nth } of CASES) {
    test(`${name}: edge added, the heading's section`, async () => {
      const md = page("## Pier", "", ...body);
      const a = await readerArticle(md);
      const range = rangeOf(a, from, { to, nth });
      expect(discussContext(a, range)?.edge).toBe("added");
      expect(locate(md, range)).toMatchObject({ found: "section", reason: "added", section: { heading: "Pier" } });
    });
    test(`${name}, on a page with no heading: the marked none`, async () => {
      const md = page(...body);
      const a = await readerArticle(md);
      expect(locate(md, rangeOf(a, from, { to, nth }))).toMatchObject({ found: "none", reason: "added", fromLine: null });
    });
  }
});

describe("the heading the client sends", () => {
  test("the heading itself when the selection starts in it, without the reader's 🧭", async () => {
    const md = page("## One", "", "Text one.", "", "## Two", "", "Text two.");
    const a = await readerArticle(md);
    const h = a.querySelectorAll("h1, h2, h3, h4")[1]!;
    h.insertAdjacentHTML("beforeend", "<button>🧭</button>");
    expect(discussHeading(a, rangeOf(a, "Two"))).toBe("Two");
  });
  test("a heading inside an earlier sibling (a Fold's own heading) counts", async () => {
    const md = page("## Top", "", '<Fold title="Routes">', "", "### Inner", "", "Inside.", "", "</Fold>", "", "After the fold.");
    const a = await readerArticle(md);
    expect(discussHeading(a, rangeOf(a, "After the fold."))).toBe("Inner");
    expect(discussHeading(a, rangeOf(a, "Inside."))).toBe("Inner");
  });
  test("top-level prose under a heading (the selection's parent is the article)", async () => {
    const md = page("## Brief", "", "Bare prose at the top level.");
    const a = await readerArticle(md);
    expect(discussHeading(a, rangeOf(a, "Bare prose"))).toBe("Brief");
  });
  test("a range that starts at the article element itself", async () => {
    const md = page("## Brief", "", "Bare prose at the top level.");
    const a = await readerArticle(md);
    const r = document.createRange();
    r.setStart(a, 0);
    r.setEnd(a, a.childNodes.length);
    expect(discussContext(a, r)?.atStart).toBe(true);
    expect(discussHeading(a, r)).toBe("Brief");
  });
});

describe("reader-made copies placed away from their source", () => {
  const md = page("## First", "", "The gate opens at dawn.", "", "## Last", "", "The gate shuts at dusk.");
  /** A peek card as `showPeek` appends it: at the article's end, with a copy of its target. */
  const withPeek = async () => {
    const a = await readerArticle(md);
    a.insertAdjacentHTML("beforeend", '<div class="wiki-ref-peek" role="tooltip"><div class="wiki-ref-peek-head"><span class="wiki-ref-peek-label">First</span></div><div class="wiki-ref-peek-body"><p>The gate opens at dawn.</p></div></div>');
    return a;
  };
  test("a selection inside a peek card has no context: the card is not the page", async () => {
    const a = await withPeek();
    expect(discussContext(a, rangeOf(a, "The gate opens at dawn.", { nth: 2 }))).toBeNull();
  });
  test("a selection that runs from the page into a peek card has none either", async () => {
    const a = await withPeek();
    expect(discussContext(a, rangeOf(a, "shuts at dusk.", { to: "opens at" }))).toBeNull();
  });
  test("the same passage on the page keeps its own heading", async () => {
    const a = await withPeek();
    expect(discussContext(a, rangeOf(a, "The gate opens at dawn."))?.heading).toBe("First");
  });
  test("a decision view is reader-only: a selection inside it has no context, so no heading is sent", async () => {
    const a = await readerArticle(md);
    a.querySelectorAll("h1, h2, h3, h4")[0]!.insertAdjacentHTML("afterend", '<section class="dc-view dc-chain" data-reader-only><div class="dc-title">Chain</div><p>The gate shuts at dusk.</p></section>');
    const t = a.querySelector(".dc-view p")!.firstChild!;
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(t, t.textContent!.length);
    expect(discussContext(a, r)).toBeNull();
  });
});

describe("a reader label beside one copy, the same word in the source beside the other", () => {
  // The label-pair pages (P1b): a passage once after a label the reader writes
  // (an untitled Fold's «Details», a title-less callout's type name) and once
  // after that word written in the source, between the same neighbours. With
  // the label in the client's context the written copy agreed in full on both
  // sides and took the exact line.
  const S = "Run the database migration on staging and verify that the row counts match";
  const LB = "Boats leave early from the north pier on every weekday morning in winter.";
  const LA = "Kari keeps the winter timetable on the wall beside the ticket office door.";
  const LABELS: { name: string; reader: string[]; written: string[][] }[] = [
    { name: "an untitled Fold's «Details»", reader: ["<Fold>", "", S, "", "</Fold>"], written: [["Details", "", S], ["### Details", "", S]] },
    { name: "«Details» before a Fold's summary", reader: ['<Fold summary="more">', "", S, "", "</Fold>"], written: [["Details more", "", S]] },
    ...["note", "caution", "warning", "tip", "danger"].map((t) => {
      const label = t[0]!.toUpperCase() + t.slice(1);
      return { name: `a title-less [!${t}]'s «${label}»`, reader: [`> [!${t}]`, `> ${S}`], written: [[label, "", S], [`${label}: ${S}`]] };
    }),
    // A body-less Verdict's fallback label, a resolved Callout's ✓ and date
    // (and the « · » before its title), an AnnotatedCode's file name.
    ...(["yes", "no"] as const).map((v) => {
      const label = v === "yes" ? "Yes" : "No";
      return { name: `a body-less Verdict's «${label}»`, reader: [`Is it ok? <Verdict value="${v}" /> ${S}`], written: [[`Is it ok? ${label} ${S}`]] };
    }),
    { name: "a resolved Callout's ✓ and date", reader: ['<Callout resolved="2026-01-02">', "", S, "", "</Callout>"], written: [["✓ 2026-01-02", "", S], ["2026-01-02", "", S]] },
    { name: "a resolved Callout's ✓, date and « · » before its title", reader: ['<Callout resolved="2026-01-02" title="Pier">', "", S, "", "</Callout>"], written: [["✓ 2026-01-02 · Pier", "", S]] },
    { name: "an AnnotatedCode's file name", reader: ['<AnnotatedCode file="harbour.ts">', "", "```ts", S, "```", "", "</AnnotatedCode>"], written: [["harbour.ts", "", "```ts", S, "```"]] },
    // A FactCheck's counts, a one-run DeltaTable's note under the table, a
    // DeltaTable's attribute warning above it.
    { name: "a FactCheck's counts", reader: ['<FactCheck date="2026-01-02" ok="2" warn="1">', "", S, "", "</FactCheck>"], written: [["✓ 2 confirmed ⚠ 1 needs care", "", S]] },
    { name: "a one-run DeltaTable's «Two runs are needed for a delta»", reader: ["<DeltaTable>", "", "| Pier | Week 1 |", "|---|---|", "| North | 10 |", "", "</DeltaTable>", "", S], written: [["| Pier | Week 1 |", "|---|---|", "| North | 10 |", "", "Two runs are needed for a delta", "", S]] },
    { name: "a DeltaTable's unknown decimal= warning", reader: ['<DeltaTable decimal="weird">', "", S, "", "| Pier | Week 1 | Week 2 |", "|---|---|---|", "| North | 10 | 12 |", "", "</DeltaTable>"], written: [[S, "", "Unknown decimal value: weird — use comma or dot", "", "| Pier | Week 1 | Week 2 |", "|---|---|---|", "| North | 10 | 12 |"]] },
  ];
  const pages = LABELS.flatMap(({ name, reader, written }) =>
    written.flatMap((w) => [
      { name: `${name}, reader copy first`, md: [LB, "", ...reader, "", LA, "", LB, "", ...w, "", LA].join("\n"), labelCopy: 1 },
      { name: `${name}, written copy first`, md: [LB, "", ...w, "", LA, "", LB, "", ...reader, "", LA].join("\n"), labelCopy: 2 },
    ]),
  );
  /** Select copy `n` of `sel` (a slice of S) in the reader's text and locate it. */
  function locateCopy(a: Element, md: string, n: number, sel: string): LocateResult {
    const f = flat(a);
    let at = -1;
    for (let k = 0; k < n; k++) at = f.text.indexOf(S, at + 1);
    if (at === -1) throw new Error(`copy ${n} not shown`);
    const off = S.indexOf(sel);
    const r = document.createRange();
    r.setStart(...f.pos(at + off));
    r.setEnd(...f.pos(at + off + sel.length, true));
    return locate(md, r);
  }
  test(`no exact answer names the other copy's line (${pages.length} pages)`, async () => {
    const wrong: string[] = [];
    for (const { name, md } of pages) {
      const a = await readerArticle(md);
      const lines = md.split("\n").flatMap((l, i) => (l.includes(S) ? [i + 1] : []));
      expect(lines.length).toBe(2);
      for (let n = 1; n <= 2; n++) {
        for (const sel of [S, S.slice(4), S.slice(0, -6)]) {
          const res = locateCopy(a, md, n, sel);
          if (res.found === "exact" && res.fromLine !== lines[n - 1]) wrong.push(`${name}: copy ${n} «${sel.slice(0, 12)}…» at line ${res.fromLine}, not ${lines[n - 1]}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
  test("the copy beside the reader's label gets its own line, its context without the label", async () => {
    for (const { name, md, labelCopy } of pages) {
      const a = await readerArticle(md);
      const own = md.split("\n").flatMap((l, i) => (l.includes(S) ? [i + 1] : []))[labelCopy - 1]!;
      const res = locateCopy(a, md, labelCopy, S);
      expect({ name, found: res.found, from: res.fromLine }).toEqual({ name, found: "exact", from: own });
    }
  });
});

describe("seeded guard: a range stated as found is the selection's own line", () => {
  // Synthetic pages built to hold one sentence two or more times (some blocks
  // leave it out), in blocks the reader shows differently from the source (a
  // Fold's label, a callout's frame,
  // a checklist mark, a table row, a `1)` line). Every copy is selected whole
  // and in three slices; an `exact` answer must name that copy's line.
  const SENTS = [
    "The pier opens at six and closes at ten every day of the week.",
    "Run the database migration on staging and verify that the row counts match",
  ];
  const FILL = ["Boats leave early.", "Kari keeps the winter timetable.", "Bells ring at noon.", "more", "Notes", "Plan"];
  /** A page per step of a fixed linear congruential sequence from `seed`. The
   *  multiplier overflows a double, so seeds share pages: the three below hold
   *  326 distinct pages of 450. */
  function* seededPages(seed: number, count: number): Generator<{ md: string; s: string }> {
    let x = seed;
    const rnd = () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
    const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
    const block = (s: string): string[] => {
      const f = pick(FILL);
      return pick<() => string[]>([
        () => [s],
        () => [`1) ${s}`],
        () => [`- ${s}`],
        () => [`✓ ${s}`],
        () => [`${f} ${s}`],
        () => [`${s} ${f}`],
        () => ["<Fold>", "", s, "", "</Fold>"],
        () => [`<Fold summary="${f}">`, "", s, "", "</Fold>"],
        () => [`<Fold title="${f}">`, "", s, "", "</Fold>"],
        () => ["<Checklist>", "", `- [x] ${s}`, "", "</Checklist>"],
        () => [`> ${s}`],
        () => ["> [!note]", `> ${s}`],
        () => [`| ${s} | ${f} |`, "|---|---|", "| a | b |"],
        () => [`## ${f}`],
        () => [`### ${pick(FILL)}`],
        () => [f],
        () => [`**${s}**`],
      ])();
    };
    for (let p = 0; p < count; p++) {
      const s = pick(SENTS);
      const blocks: string[][] = [];
      const nb = 2 + Math.floor(rnd() * 6);
      let has = 0;
      for (let b = 0; b < nb; b++) {
        const useS = rnd() < 0.5;
        if (useS) has++;
        blocks.push(block(useS ? s : pick(FILL)));
      }
      if (has < 2) blocks.push(block(s));
      yield { md: blocks.map((b) => b.join("\n")).join("\n\n"), s };
    }
  }
  /** Every exact answer on the seed's pages that names another line. */
  async function wrongExacts(seed: number, count: number): Promise<string[]> {
    const wrong: string[] = [];
    for (const { md, s } of seededPages(seed, count)) {
      const a = await readerArticle(md);
      const lines = md.split("\n").flatMap((l, i) => (l.includes(s) ? [i + 1] : []));
      const f = flat(a);
      // Only pages where the reader shows each copy once, in source order.
      if (f.text.split(s).length - 1 !== lines.length) continue;
      for (let n = 1; n <= lines.length; n++) {
        for (const sel of [s, s.slice(4), s.slice(0, -6), s.slice(10, 40)]) {
          let at = -1;
          for (let k = 0; k < n; k++) at = f.text.indexOf(s, at + 1);
          const off = s.indexOf(sel);
          const r = document.createRange();
          r.setStart(...f.pos(at + off));
          r.setEnd(...f.pos(at + off + sel.length, true));
          const res = locate(md, r);
          if (res.found === "exact" && res.fromLine !== lines[n - 1]) wrong.push(`seed ${seed}: copy ${n} «${sel.slice(0, 20)}…» at line ${res.fromLine}, not ${lines[n - 1]}\n${md}`);
        }
      }
    }
    return wrong;
  }
  // Seeds whose pages held a wrong exact answer under the one-side-full rule.
  for (const seed of [3, 10, 16]) {
    test(`seed ${seed}: no exact answer names another copy's line`, async () => {
      expect(await wrongExacts(seed, 150)).toEqual([]);
    }, 8000);
  }
});

describe("«Ask Claude Code»: the selection is read when the control is activated, not on every change", () => {
  const settle = () => new Promise((r) => setTimeout(r, 120));
  const change = () => document.dispatchEvent(new Event("selectionchange"));
  const btn = () => document.getElementById(DISCUSS_HANDOFF_SEL_BTN_ID)!;
  const panelEl = () => document.getElementById(DISCUSS_HANDOFF_PANEL_ID);
  test("a settled selectionchange shows the control without the reading class; activating reads once; the control follows the panel", async () => {
    document.body.innerHTML =
      `<div id="wikiBreadcrumb"><button id="wikiFactcheckBtn" type="button">Fact check</button></div>` +
      `<div class="wiki-article"><h2>Brief</h2><p>The pier opens at six.</p><p>The night route is unchanged.</p></div>`;
    initDiscussHandoff({ wiki: () => "w", relPath: () => "plans/harbour.mdx" });
    setDiscussHandoffEnabled(true);
    const root = document.documentElement;
    // Every time the root gets the reading class: one per full read of the selection.
    expect(root.classList).toBe(root.classList);
    const list = root.classList;
    const realAdd = list.add.bind(list);
    const reads: string[] = [];
    list.add = (...tokens: string[]) => {
      if (tokens.includes("discuss-reading")) reads.push(tokens.join(" "));
      realAdd(...tokens);
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const article = document.querySelector(".wiki-article")!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(rangeOf(article, "The pier opens at six."));
    change();
    await settle();
    await flush();
    expect(btn().style.display).toBe("");
    expect(reads).toEqual([]);

    btn().click();
    await flush();
    expect(panelEl()?.hidden).toBe(false);
    expect(panelEl()!.querySelector(".wiki-handoff-quote")!.textContent).toBe("The pier opens at six.");
    expect(reads.length).toBe(1);

    // Open on a passage, the control is its opener: it stays though the page's selection goes.
    sel.removeAllRanges();
    change();
    await settle();
    expect(btn().style.display).toBe("");

    // Open on the whole page, the control follows the selection the reader makes meanwhile.
    document.getElementById(DISCUSS_HANDOFF_PAGE_BTN_ID)!.click();
    expect(panelEl()!.querySelector(".wiki-handoff-whole")).not.toBeNull();
    change();
    await settle();
    expect(btn().style.display).toBe("none");
    sel.addRange(rangeOf(article, "The night route is unchanged."));
    change();
    await settle();
    expect(btn().style.display).toBe("");
    await flush();
    expect(reads.length).toBe(1);
    delete (list as { add?: unknown }).add;
    setDiscussHandoffEnabled(false);
    document.body.innerHTML = "";
  });
});

describe("the handoff panel with the wiki agent on (fix round 1)", () => {
  type Call = { url: string; body: string };
  const realFetch = globalThis.fetch;
  let calls: Call[] = [];
  const stubFetch = (respond: (url: string) => Response) => {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: String(init?.body ?? "") });
      return respond(url);
    }) as typeof fetch;
  };
  const panelEl = () => document.getElementById(DISCUSS_HANDOFF_PANEL_ID)!;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const pageHtml = () =>
    `<div id="wikiBreadcrumb"><button id="wikiFactcheckBtn" type="button">Fact check</button><button id="wikiFactcheckArticleBtn" type="button">Fact check page</button></div>` +
    `<div class="wiki-article"><h2>Brief</h2><p>The pier opens at six.</p></div>`;

  beforeAll(() => {
    initDiscussTab({ wiki: () => "w", relPath: () => "plans/harbour.mdx", switchTab: () => {} });
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("Copy prompt disables and refocuses its own button, never «Ask here»", async () => {
    document.body.innerHTML = pageHtml();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
    // Cast: an assignment inside the fetch closure does not widen a `null` initializer's narrowed type.
    let disabledAtFetch = null as { copy: boolean; askHere: boolean } | null;
    stubFetch(() => {
      disabledAtFetch = {
        copy: panelEl().querySelector<HTMLButtonElement>('[data-handoff="copy"]')!.disabled,
        askHere: panelEl().querySelector<HTMLButtonElement>('[data-handoff="ask-here"]')!.disabled,
      };
      return new Response(JSON.stringify({ prompt: "the prompt" }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    setDiscussHandoffEnabled(true, true);
    expect(discussAgentOn()).toBe(true);
    document.getElementById(DISCUSS_HANDOFF_PAGE_BTN_ID)!.click();
    const copy = panelEl().querySelector<HTMLButtonElement>('[data-handoff="copy"]')!;
    const askHere = panelEl().querySelector<HTMLButtonElement>('[data-handoff="ask-here"]')!;
    expect(askHere).not.toBeNull();
    panelEl().querySelector<HTMLTextAreaElement>(".wiki-handoff-q")!.value = "Why six?";
    copy.click();
    for (let i = 0; i < 5; i++) await flush();
    expect(calls.map((c) => c.url)).toEqual(["/api/wiki/discuss/handoff"]);
    expect(disabledAtFetch).toEqual({ copy: true, askHere: false });
    expect(panelEl().querySelector(".wiki-handoff-status")!.textContent).toContain("Copied");
    // Compare by attribute and identity flag: a failing toBe on a happy-dom node hangs its diff printer.
    expect(document.activeElement?.getAttribute("data-handoff")).toBe("copy");
    expect(document.activeElement === copy).toBe(true);
    setDiscussHandoffEnabled(false);
    document.body.innerHTML = "";
  });

  test("⌘/Ctrl+Enter in the panel sends nothing to the agent on a read-only wiki, even with the agent flag on", async () => {
    document.body.innerHTML = pageHtml();
    stubFetch(() => new Response(JSON.stringify({ error: "x" }), { status: 403, headers: { "Content-Type": "application/json" } }));
    // The agent flag is computed while the page reads as writable (the flag computed wrongly)...
    setDiscussHandoffEnabled(false, true);
    expect(discussAgentOn()).toBe(true);
    openDiscussHandoff(false);
    expect(panelEl().hidden).toBe(false);
    // ...then the wiki is read-only and its guard is installed.
    g.__WIKI_READONLY_WIKI__ = true;
    installWikiReadonlyGuard();
    expect(document.body.classList.contains("wiki-readonly-wiki")).toBe(true);
    const q = panelEl().querySelector<HTMLTextAreaElement>(".wiki-handoff-q")!;
    q.value = "Why six?";
    q.focus();
    q.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    for (let i = 0; i < 5; i++) await flush();
    expect(calls.filter((c) => c.url.startsWith("/api/wiki/discuss"))).toEqual([]);
    // The panel's own check answered, not a busy note from the tab.
    expect(panelEl().querySelector(".wiki-handoff-status")!.textContent).toContain("read-only");
    delete g.__WIKI_READONLY_WIKI__;
    document.body.classList.remove("wiki-readonly", "wiki-readonly-wiki");
    setDiscussHandoffEnabled(false);
    document.body.innerHTML = "";
  });
});

describe("the Discuss box on a read-only wiki (fix round 1 batch 4)", () => {
  // The boot-time locks set the read-only placeholder once; a paint after them
  // (every page render calls `setDiscussAgentEnabled`) must not undo it.
  test("a paint keeps the read-only placeholder and the box disabled", () => {
    initDiscussTab({ wiki: () => "w", relPath: () => "plans/harbour.mdx", switchTab: () => {} });
    document.body.innerHTML = `<button data-conntab="discuss" hidden>Discuss</button>${discussTabBodyHtml()}`;
    g.__WIKI_READONLY_WIKI__ = true;
    try {
      applyWikiReadonlyInputLocks();
      const input = document.getElementById(DISCUSS_INPUT_ID) as HTMLTextAreaElement;
      expect(input.placeholder).toBe(WIKI_READONLY_INPUT_PLACEHOLDER);
      setDiscussAgentEnabled(true);
      expect(input.placeholder).toBe(WIKI_READONLY_INPUT_PLACEHOLDER);
      expect(input.disabled).toBe(true);
    } finally {
      delete g.__WIKI_READONLY_WIKI__;
      document.body.innerHTML = "";
    }
  });
});
