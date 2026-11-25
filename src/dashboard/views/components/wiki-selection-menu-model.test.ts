/**
 * The selection menu's pure half (Discuss v2 PR 5): which actions a selection
 * gets, the key chips (the mentions route's own check and classifier), the
 * `Oppfølging` heading, where an inline card goes (in a happy-dom Window of
 * its own, no globals) and the mentions cards' markup.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  NOT_AS_WRITTEN,
  detectKeys,
  followHeading,
  historyHtml,
  inlineCardAnchor,
  inlineCardHtml,
  keyKindsFrom,
  selBarHtml,
  selMenuHtml,
  selMenuItems,
  whereElseHtml,
  type SelMenuInput,
} from "./wiki-selection-menu-model.ts";
import type { MentionsBody } from "../../../wiki/mentions.ts";

const input = (over: Partial<SelMenuInput>): SelMenuInput => ({ text: "The pier opens at six.", explainer: false, mentions: true, follow: false, keys: [], ...over });
const acts = (s: SelMenuInput) => selMenuItems(s).map((i) => (i.key ? `${i.act}:${i.key}` : i.act));

describe("selMenuItems", () => {
  test("Explain first, then the no-model pair only for a selection the mentions route takes", () => {
    expect(acts(input({}))).toEqual(["explain", "where", "history", "factcheck", "copy"]);
    // Over 80 characters, or two lines: the route refuses it as a key.
    expect(acts(input({ text: "x".repeat(81) }))).toEqual(["explain", "factcheck", "copy"]);
    expect(acts(input({ text: "one line\nand another" }))).toEqual(["explain", "factcheck", "copy"]);
    // No route here (read slice, auth on, not admin): no pair, no chips.
    expect(acts(input({ mentions: false, keys: ["MEL-1"] }))).toEqual(["explain", "factcheck", "copy"]);
  });

  test("«Add to Oppfølging» only with the heading, never on an explainer; a key chip unless the selection is that key", () => {
    expect(acts(input({ follow: true, keys: ["MEL-12"] }))).toEqual(["explain", "where", "history", "factcheck", "copy", "follow", "key:MEL-12"]);
    expect(acts(input({ follow: true, explainer: true }))).not.toContain("follow");
    expect(acts(input({ text: "MEL-12", keys: ["MEL-12"] }))).toEqual(["explain", "where", "history", "factcheck", "copy"]);
  });

  test("the bar keeps the old buttons' ids; the menu shows the same actions, the chips under their own heading", () => {
    const items = selMenuItems(input({ keys: ["MEL-12"] }));
    const doc = new Window().document;
    const barEl = doc.createElement("div");
    barEl.innerHTML = selBarHtml(items);
    expect(barEl.querySelector('[data-selact="explain"]')!.id).toBe("wikiExplainBtn");
    expect(barEl.querySelector('[data-selact="factcheck"]')!.id).toBe("wikiFactcheckBtn");
    expect(barEl.querySelector(".def")!.getAttribute("data-selact")).toBe("explain");
    const menuEl = doc.createElement("div");
    menuEl.innerHTML = selMenuHtml(items, "The pier opens at six.");
    const a = (el: { querySelectorAll(s: string): ArrayLike<{ getAttribute(n: string): string | null }> }) => Array.from(el.querySelectorAll("[data-selact]")).map((e) => e.getAttribute("data-selact"));
    expect(a(menuEl)).toEqual(a(barEl));
    expect(menuEl.querySelectorAll("[id]").length).toBe(0);
    expect(menuEl.textContent).toContain("For this selection");
    expect(menuEl.textContent).toContain("⇧ right-click");
  });
});

describe("detectKeys: the mentions route's check and classifier", () => {
  const kinds = keyKindsFrom([{ name: "case", pattern: "MEL-\\d+" }]);
  test("a tracker project's key and a `keys` kind's, in order and once", () => {
    expect(detectKeys("MELOSYS-8332 waits on MEL-1029036, and MELOSYS-8332 again.", ["MELOSYS"], kinds)).toEqual(["MELOSYS-8332", "MEL-1029036"]);
  });
  test("a word no kind claims is no key; an unconfigured project is no key", () => {
    expect(detectKeys("ABC-12 and TEAM-3 and MEL-x", ["MELOSYS"], kinds)).toEqual([]);
    expect(detectKeys("MEL-1029036", [], [])).toEqual([]);
  });
  test("anchored on a whole word: a key inside a longer word is not one", () => {
    expect(detectKeys("XMEL-12 MEL-12x", [], kinds)).toEqual([]);
  });
  test("at most three chips", () => {
    expect(detectKeys("MEL-1 MEL-2 MEL-3 MEL-4", [], kinds)).toEqual(["MEL-1", "MEL-2", "MEL-3"]);
  });
  test("a kind outside the key grammar is dropped by the same parser the server runs", () => {
    expect(keyKindsFrom([{ name: "bad", pattern: "(a+)+" }])).toEqual([]);
  });
});

describe("followHeading", () => {
  test("an h2–h4 whose own text is Oppfølging, without the reader's additions", () => {
    const doc = new Window().document;
    const a = doc.createElement("div");
    a.innerHTML = `<h2>Brief</h2><h3>Oppfølging<span data-reader-only>¶</span><button>Walk</button></h3>`;
    expect(followHeading(a as unknown as Element)?.tagName).toBe("H3");
    a.innerHTML = `<h2>Oppfølging av saken</h2><h1>Oppfølging</h1>`;
    expect(followHeading(a as unknown as Element)).toBeNull();
    a.innerHTML = `<h2>oppfølging</h2>`;
    expect(followHeading(a as unknown as Element)?.tagName).toBe("H2");
  });
});

describe("inlineCardAnchor: under the paragraph the selection ends in", () => {
  function setup(html: string) {
    const doc = new Window().document;
    const article = doc.createElement("div");
    article.className = "wiki-article";
    article.innerHTML = html;
    doc.body.appendChild(article);
    const textOf = (needle: string) => {
      const walker = doc.createTreeWalker(article, 4);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) if ((t.textContent ?? "").includes(needle)) return t;
      throw new Error(needle);
    };
    const place = (needle: string) => {
      const t = textOf(needle);
      const r = doc.createRange();
      const i = t.textContent!.indexOf(needle);
      r.setStart(t, i);
      r.setEnd(t, i + needle.length);
      const at = inlineCardAnchor(r as unknown as Range, article as unknown as Element);
      const card = doc.createElement("div");
      card.className = "card";
      (at.parent as unknown as { insertBefore(a: unknown, b: unknown): void }).insertBefore(card, at.before);
      return article.innerHTML;
    };
    return { place };
  }

  test("a bare paragraph run: after its <br><br>, before the next paragraph", () => {
    const { place } = setup(`<h2>Brief</h2>The night route is unchanged.<br><br>The morning route adds a stop.`);
    expect(place("night route")).toBe(`<h2>Brief</h2>The night route is unchanged.<br><br><div class="card"></div>The morning route adds a stop.`);
  });
  test("a bare run with inline markup, and blank text between the breaks: still at the run's end", () => {
    const { place } = setup(`Plain <b>bold night</b> tail.<br>\n<br>Next.<br><br>Last.`);
    expect(place("bold night")).toBe(`Plain <b>bold night</b> tail.<br>\n<br><div class="card"></div>Next.<br><br>Last.`);
  });
  test("a single <br> is a line break inside the paragraph, not its end", () => {
    const { place } = setup(`Line one<br>line two.<br><br>Next.`);
    expect(place("Line one")).toBe(`Line one<br>line two.<br><br><div class="card"></div>Next.`);
  });
  test("a run that ends at a block: before the block", () => {
    const { place } = setup(`The night route.<ul><li>one</li></ul>`);
    expect(place("night")).toBe(`The night route.<div class="card"></div><ul><li>one</li></ul>`);
  });
  test("the last run: at the container's end", () => {
    const { place } = setup(`<h2>A</h2>Last words here.`);
    expect(place("Last words")).toBe(`<h2>A</h2>Last words here.<div class="card"></div>`);
  });
  test("a list item: inside it, before its nested list", () => {
    const { place } = setup(`<ul><li>Check <b>the berth</b> list.<ul><li>sub</li></ul></li><li>two</li></ul>`);
    expect(place("the berth")).toBe(`<ul><li>Check <b>the berth</b> list.<div class="card"></div><ul><li>sub</li></ul></li><li>two</li></ul>`);
  });
  test("a table cell: after the table; a paragraph: after it", () => {
    expect(setup(`<table><tr><td>cell text</td></tr></table><p>after</p>`).place("cell text")).toBe(`<table><tbody><tr><td>cell text</td></tr></tbody></table><div class="card"></div><p>after</p>`);
    expect(setup(`<p>one para</p><p>two</p>`).place("one para")).toBe(`<p>one para</p><div class="card"></div><p>two</p>`);
  });
});

describe("inlineCardAnchor: a range that ends on a boundary (triple-click, a drag to the next line)", () => {
  /** `html` in an article; the range starts at `from`'s first character and
   *  ends at the point `end` picks. Returns the article with the card placed. */
  function place(html: string, from: string, end: (article: Element) => [Node, number]): string {
    const doc = new Window().document;
    const article = doc.createElement("div");
    article.className = "wiki-article";
    article.innerHTML = html;
    doc.body.appendChild(article);
    const walker = doc.createTreeWalker(article, 4);
    let t = walker.nextNode();
    while (t && !(t.textContent ?? "").includes(from)) t = walker.nextNode();
    if (!t) throw new Error(from);
    const r = doc.createRange();
    r.setStart(t, t.textContent!.indexOf(from));
    const [node, offset] = end(article as unknown as Element);
    r.setEnd(node as never, offset);
    const at = inlineCardAnchor(r as unknown as Range, article as unknown as Element);
    const card = doc.createElement("div");
    card.className = "card";
    (at.parent as unknown as { insertBefore(a: unknown, b: unknown): void }).insertBefore(card, at.before);
    return article.innerHTML;
  }

  test("an end at (the next block, 0): under the block the text is in, not the next one", () => {
    expect(place(`<p>Alpha para.</p><p id="b">Beta para.</p><p>Gamma.</p>`, "Alpha", (a) => [a.querySelector("#b")!, 0])).toBe(
      `<p>Alpha para.</p><div class="card"></div><p id="b">Beta para.</p><p>Gamma.</p>`,
    );
    // Blank text between the blocks, and the end in the next block's text at 0.
    expect(place(`<ul><li>Alpha item.</li>\n<li id="b">Beta item.</li></ul>`, "Alpha", (a) => [a.querySelector("#b")!.firstChild!, 0])).toBe(
      `<ul><li>Alpha item.<div class="card"></div></li>\n<li id="b">Beta item.</li></ul>`,
    );
  });

  test("an end at (the container, child index) in a bare run: under the run, never at the article's end", () => {
    const html = `<h2>Brief</h2>Alpha paragraph.<br><br>Beta paragraph.<h2>Oppfølging</h2><ul><li>one</li></ul>`;
    const want = `<h2>Brief</h2>Alpha paragraph.<br><br><div class="card"></div>Beta paragraph.<h2>Oppfølging</h2><ul><li>one</li></ul>`;
    // Right after the text, after the first <br>, after both.
    for (const k of [2, 3, 4]) expect([k, place(html, "Alpha", (a) => [a, k])]).toEqual([k, want]);
  });

  test("a <br><br> run ending at (article, 1): under that paragraph", () => {
    expect(place(`Alpha.<br><br>Beta.<br><br>Gamma.`, "Alpha", (a) => [a, 1])).toBe(`Alpha.<br><br><div class="card"></div>Beta.<br><br>Gamma.`);
  });

  test("an end at (the container, child index) after a block: under that block", () => {
    expect(place(`<p>Alpha para.</p><p>Beta.</p>`, "Alpha", (a) => [a, 1])).toBe(`<p>Alpha para.</p><div class="card"></div><p>Beta.</p>`);
  });
});

const body = (over: Partial<MentionsBody> = {}): MentionsBody => ({
  key: "MEL-1",
  kind: "case",
  files: [
    { relPath: "plans/a.mdx", title: "Plan A", lines: [{ n: 7, text: "  MEL-1 waits." }, { n: 9, text: "again MEL-1" }] },
    { relPath: "sql/q3.csv", title: null, lines: [{ n: 2, text: "MEL-1,open" }] },
  ],
  commits: [
    { sha: "abcdef1234", date: "2026-11-12T10:00:00+01:00", subject: "Add the case", files: ["plans/a.mdx"] },
    { sha: "1234567abc", date: "2026-11-01T10:00:00+01:00", subject: "First <mention>", files: ["sql/q3.csv"] },
  ],
  log: [{ date: "2026-11-04", kind: "note", line: "- MEL-1 is outside", n: 5 }],
  prs: [{ repo: "navikt/x", number: 3625, state: "merged", mergedAt: "2026-11-17T09:00:00Z", url: "https://github.com/navikt/x/pull/3625", stale: false }],
  totalLines: 4,
  totalFiles: 3,
  totalsAtLeast: false,
  truncated: false,
  ...over,
});

describe("the mentions cards", () => {
  test("«Where else»: each file with its lines and first line, a page as a nav link, the open page marked, then log.md and the PRs", () => {
    const html = whereElseHtml(body(), { currentRelPath: "plans/a.mdx", hrefFor: (r) => `/wiki?relPath=${encodeURIComponent(r)}` });
    const doc = new Window().document;
    const el = doc.createElement("div");
    el.innerHTML = html;
    const rows = Array.from(el.querySelectorAll(".wiki-sel-file"));
    expect(rows.map((r) => r.getAttribute("data-sel-file"))).toEqual(["plans/a.mdx", "sql/q3.csv"]);
    expect(rows[0]!.querySelector("a")!.getAttribute("data-relpath")).toBe("plans/a.mdx");
    expect(rows[0]!.querySelector(".wiki-sel-here")!.textContent).toBe("this page");
    expect(rows[0]!.querySelector(".wiki-sel-lines")!.textContent).toBe("lines 7, 9");
    expect(rows[0]!.querySelector(".wiki-sel-line")!.textContent).toBe("MEL-1 waits.");
    expect(rows[1]!.querySelector("a")).toBeNull();
    expect(el.querySelector(".wiki-sel-meta")!.textContent).toBe("4 lines in 3 files");
    expect(el.querySelector(".wiki-sel-log")!.textContent).toBe("log.md: 1 line (2026-11-04 → 2026-11-04)");
    expect(el.querySelector(".wiki-sel-prs")!.textContent).toBe("navikt/x#3625 merged 2026-11-17");
  });
  test("«Where else» with nothing found says so", () => {
    expect(whereElseHtml(body({ files: [], log: [] }), { currentRelPath: null, hrefFor: (r) => r })).toContain("is named nowhere");
  });
  // Fix round 1 batch 3, F8: the route greps each source line for the phrase as
  // written, and the selection is the rendered text, so a phrase that wraps in
  // the source (`The ferry leaves\nfrom the north quay.`) or carries markup there
  // (`The **berth** list`) is not found although it is on the open page.
  test("a free phrase the route did not find is «not found as written», with why: never «named nowhere»", () => {
    const html = whereElseHtml(body({ key: "The berth list is long.", kind: null, files: [], log: [], prs: [] }), { currentRelPath: "plans/a.mdx", hrefFor: (r) => r });
    expect(html).not.toContain("named nowhere");
    expect(html).toContain("«The berth list is long.» is not found as written");
    expect(html).toContain(NOT_AS_WRITTEN);
  });
  test("a free phrase found elsewhere but not in the open page's source: the page is said to be not listed, and why", () => {
    const opts = { currentRelPath: "plans/here.mdx", hrefFor: (r: string) => r };
    const phrase = body({ key: "the ferry leaves", kind: null });
    expect(whereElseHtml(phrase, opts)).toContain(`This page is not listed: its source does not have the phrase as written. ${NOT_AS_WRITTEN}`);
    // Listed, or a key, or a list cut short: no such line.
    expect(whereElseHtml(phrase, { ...opts, currentRelPath: "plans/a.mdx" })).not.toContain("This page is not listed");
    expect(whereElseHtml(body(), opts)).not.toContain("This page is not listed");
    expect(whereElseHtml(body({ kind: null, truncated: true }), opts)).not.toContain("This page is not listed");
    // No open page to speak of (off a page): no such line.
    expect(whereElseHtml(phrase, { ...opts, currentRelPath: null })).not.toContain("This page is not listed");
  });
  test("«History»: commits and log lines newest first, escaped", () => {
    const doc = new Window().document;
    const el = doc.createElement("div");
    el.innerHTML = historyHtml(body());
    const evs = Array.from(el.querySelectorAll(".wiki-sel-ev")).map((e) => `${e.getAttribute("data-ev")} ${e.querySelector(".wiki-sel-d")!.textContent}`);
    expect(evs).toEqual(["commit 2026-11-12", "log 2026-11-04", "commit 2026-11-01"]);
    expect(el.textContent).toContain("First <mention>");
    expect(historyHtml(body({ commits: [], log: [] }))).toContain("No commit or log.md entry");
  });
  test("a card is reader-only, links its turn to the pane, and always has ✕", () => {
    const html = inlineCardHtml("explain", "", "", "t3");
    expect(html).toContain("data-reader-only");
    expect(html).toContain('data-sel-turn="t3"');
    expect(html).toContain('data-sel-card-pane="t3"');
    expect(inlineCardHtml("where", "MEL-1", "", null)).not.toContain("data-sel-card-pane");
    expect(inlineCardHtml("where", "MEL-1", "", null)).toContain("data-sel-card-close");
  });
});
