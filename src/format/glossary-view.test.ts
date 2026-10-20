import { describe, expect, test } from "bun:test";
import { renderWikiHtml } from "../wiki/render.ts";
import { checkPageText } from "../wiki/lint.ts";
import { locateExcerpt } from "../wiki/explain-context.ts";
import type { WikiPageMeta } from "../wiki/store.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";
import { PEEK_GLOSSARY_CHROME } from "../dashboard/views/components/wiki-ref-links.ts";
import { GLOSSARY_CHROME_CLASSES, markGlossaryTerms } from "./glossary-view.ts";
import { READER_ONLY_ATTR } from "./reader-lens.ts";
import { glossaryKey, type GlossaryEntry } from "./glossary.ts";

// Invented pages only: a lending library.

const glossary = (...items: string[]) => ["", "<Glossary>", "", ...items, "", "</Glossary>", ""].join("\n");
const HOLD = glossary("- **Hold:** a book kept back for one reader");
const reader = (md: string, resolve: (t: string) => WikiPageMeta | undefined = () => undefined) =>
  renderWikiHtml(md, resolve, { views: true, language: "no" });
/** Each mark's [key, the text it wraps], in page order, outside the list. */
const marks = (html: string) =>
  [...html.matchAll(/<span class="gl-term" tabindex="0" aria-describedby="gl-tip-\d+" data-gl-key="([^"]*)">([^]*?)<\/span>/g)].map((m) => [m[1], m[2]]);
const marked = (md: string) => marks(reader(md));

test("a peek strips exactly the glossary's chrome", () => {
  expect([...PEEK_GLOSSARY_CHROME]).toEqual([...GLOSSARY_CHROME_CLASSES]);
});

describe("which words a term matches", () => {
  test.each([
    ["the term", "A Hold lasts a week.", [["hold", "Hold"]]],
    ["lower case", "A hold lasts a week.", [["hold", "hold"]]],
    ["upper case", "A HOLD lasts a week.", [["hold", "HOLD"]]],
    ["before punctuation", "Ask for a Hold.", [["hold", "Hold"]]],
    ["in parentheses", "One request (Hold) per reader.", [["hold", "Hold"]]],
    ["in bold", "A **Hold** lasts a week.", [["hold", "Hold"]]],
    ["in italics", "A *Hold* lasts a week.", [["hold", "Hold"]]],
    ["a plural", "Two Holds lapse.", []],
    ["a hyphenated word", "A Hold-out lapses.", []],
    ["inside a longer word", "Withhold it.", []],
    ["bold run on into a word", "The **Hold**s lapse.", []],
    ["a digit after", "Hold2 is a code.", []],
    ["after a Timeline item's date", "<Timeline>\n\n- **2026-09-01** — Hold opened\n\n</Timeline>", [["hold", "Hold"]]],
  ])("%s", (_name, prose, want) => {
    expect(marked(prose + "\n" + HOLD)).toEqual(want);
  });

  test("a term with two capitals matches letter for letter", () => {
    const g = glossary("- **LIB:** the library's code");
    expect(marked("The lib desk uses LIB codes.\n" + g)).toEqual([["LIB", "LIB"]]);
  });

  test("Norwegian letters are word letters, and NFD text matches an NFC term", () => {
    const g = glossary("- **Låneår:** the year a loan runs", "- **Ærend:** an errand");
    expect(marked("Et låneår og et ærend. Ærendet er ikke et treff.\n" + g)).toEqual([
      ["låneår", "låneår"],
      ["ærend", "ærend"],
    ]);
  });

  test("an NFD term matches NFC text", () => {
    expect(marked("Et låneår.\n" + glossary("- **Låneår:** a loan year"))).toEqual([["låneår", "låneår"]]);
  });

  test("the longest term wins where two start at one place", () => {
    const g = glossary("- **Due:** owed", "- **Due date:** the day a book goes back");
    expect(marked("The due date is set. Nothing is due yet.\n" + g)).toEqual([
      ["due date", "due date"],
      ["due", "due"],
    ]);
  });

  test("an entity in the text is read as its character", () => {
    const g = glossary("- **Hold & Renew:** both at once");
    expect(marked("Ask for Hold & Renew at the desk.\n" + g)).toEqual([["Hold &amp; Renew", "Hold &amp; Renew"]]);
  });
});

describe("where a term is never marked", () => {
  test.each([
    ["a resolved wikilink", "See [[hold-page|Hold]] here."],
    ["a missing wikilink", "See [[Hold]] here."],
    ["link text", "See [Hold](https://lib.example/hold) here."],
    ["a bare URL", "See https://lib.example/Hold here."],
    ["inline code", "Set `Hold` here."],
    ["a code fence", "```\nHold\n```"],
    ["a heading", "## Hold rules"],
    ["a callout title", '<Callout tone="info" title="Hold rules">\n\nBody text.\n\n</Callout>'],
    ["a fact-check mark", '<Fact n="1" v="ok">A Hold lasts a week.</Fact>'],
    ["a Query's SQL", '<Query id="Q-1">\n\n```sql\nSELECT hold FROM loans;\n```\n\n</Query>'],
  ])("%s", (_name, md) => {
    const resolve = (t: string) => (t === "hold-page" ? ({ relPath: "hold-page.md", name: "hold-page", title: "Hold page" } as WikiPageMeta) : undefined);
    expect(marks(reader(md + "\n" + HOLD, resolve))).toEqual([]);
  });

  test("a component attribute is never read or written", () => {
    const html = reader('<Callout tone="info" title="Hold">\n\nNo term here.\n\n</Callout>\n' + HOLD);
    expect(html).toContain('<strong class="callout-title">Hold</strong>');
    expect(marks(html)).toEqual([]);
  });

  test("a CaseBoard's count strip and status pills are never marked; its note is prose", () => {
    const files = new Map([["c.yaml", { ok: true as const, text: "- {id: LIB-1, status: hold, note: Asked for a Hold}\n" }]]);
    const html = renderWikiHtml('<CaseBoard src="c.yaml" />\n' + HOLD, () => undefined, { views: true, files });
    expect(html).toContain('<span class="cb-pill cb-hold">hold</span>');
    expect(marks(html)).toEqual([["hold", "Hold"]]);
    expect(html.indexOf('class="gl-mark"')).toBeGreaterThan(html.indexOf('class="cb-note'));
  });

  test("the derived timeline lanes are never marked", () => {
    const md = [
      "<StatusRows>\n\n- **Desk:** open\n\n</StatusRows>\n",
      "<DecisionLog>\n\n- **D1** — A. 2026-09-01\n- **D2** — B. 2026-09-02\n\n</DecisionLog>\n",
      "<Timeline>\n\n- **2026-09-01** — Hold opened\n- **2026-09-02** — Closed\n\n</Timeline>\n",
    ].join("\n");
    const html = renderWikiHtml(md + HOLD, () => undefined, { views: true, today: "2026-10-01" });
    expect(html).toContain("tl-lanes");
    expect(marks(html)).toEqual([["hold", "Hold"]]);
    expect(html.indexOf('class="gl-mark"')).toBeGreaterThan(html.indexOf('class="gtl'));
  });

  test("a table cell is prose and is marked", () => {
    expect(marked("| Kind | Note |\n| --- | --- |\n| Hold | a week |\n" + HOLD)).toEqual([["hold", "Hold"]]);
  });

  test("the glossary list itself is never marked", () => {
    const html = reader("No term here.\n" + HOLD);
    expect(marks(html)).toEqual([]);
    expect(html).toContain('<div class="glossary">');
  });
});

describe("sections", () => {
  test("once per section: before the first heading, then per # and ##, not per ###", () => {
    const md = [
      "A Hold before any heading. Another Hold.",
      "",
      "## Loans",
      "",
      "A Hold here.",
      "",
      "### Detail",
      "",
      "A Hold in a subsection.",
      "",
      "## Returns",
      "",
      "A Hold again.",
      HOLD,
    ].join("\n");
    const html = reader(md);
    expect(marks(html).length).toBe(3);
    const at = (s: string) => html.indexOf(s);
    const marksAt = [...html.matchAll(/class="gl-mark"/g)].map((m) => m.index);
    expect(marksAt[0]).toBeLessThan(at("Loans"));
    expect(marksAt[1]).toBeGreaterThan(at("Loans"));
    expect(marksAt[1]).toBeLessThan(at("Detail"));
    expect(marksAt[2]).toBeGreaterThan(at("Returns"));
  });

  test("two blocks on a page both mark", () => {
    const md = ["A Hold and a Renewal.", glossary("- **Hold:** kept back"), glossary("- **Renewal:** a new loan")].join("\n");
    expect(marked(md)).toEqual([
      ["hold", "Hold"],
      ["renewal", "Renewal"],
    ]);
  });

  test("a block inside <More> marks the page", () => {
    expect(marked("A Hold.\n\n<More>\n" + HOLD + "\n</More>\n")).toEqual([["hold", "Hold"]]);
  });

  test("a fenced fake block marks nothing", () => {
    const md = "A Hold.\n\n```\n<Glossary>\n\n- **Hold:** x\n\n</Glossary>\n```\n";
    expect(marked(md)).toEqual([]);
  });
});

describe("the mark", () => {
  const html = reader("A Hold and a Renewal.\n" + glossary("- **Hold:** kept back", "- **Renewal:** a new & \"quick\" loan"));

  test("is focusable, described by a reader-only tooltip with a unique id", () => {
    const ids = [...html.matchAll(/aria-describedby="(gl-tip-\d+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["gl-tip-1", "gl-tip-2"]);
    for (const id of ids) expect(html).toContain(`<span class="gl-tip" id="${id}" role="tooltip" ${READER_ONLY_ATTR}>`);
  });

  test("the definition is escaped text", () => {
    expect(html).toContain('<b class="gl-tip-term">Renewal</b> a new &amp; "quick" loan</span>');
  });

  test("unwrapping the marks gives back the source's bytes", () => {
    const prose = "A &amp; B: Hold, <em>hold</em> — a Hold.";
    const entries: GlossaryEntry[] = [{ term: "Hold", ...glossaryKey("Hold"), definition: "kept back", codeSpelled: false, at: 0 }];
    const out = markGlossaryTerms(`<p>${prose}</p>`, entries);
    const unwrapped = out.replace(/<\/span><span class="gl-tip"[^>]*>[^]*?<\/span><\/span>/g, "").replace(/<span class="gl-mark"><span class="gl-term"[^>]*>/g, "");
    expect(unwrapped).toBe(`<p>${prose}</p>`);
  });
});

describe("off the reader a <Glossary> is its list", () => {
  const bare = "A Hold lasts a week.\n\n- **Hold:** a book kept back\n";
  const wrapped = "A Hold lasts a week.\n" + glossary("- **Hold:** a book kept back");
  const surfaces: [string, (s: string) => string][] = [
    ["web chat", (s) => formatWebHtml(s)],
    ["web with views", (s) => formatWebHtml(s, { views: true }).replace('<div class="glossary">', "").replace(/<\/div>\s*$/, "")],
    ["the reader without views", (s) => renderWikiHtml(s, () => undefined)],
    ["telegram", formatTelegramHtml],
    ["slack", formatSlackMrkdwn],
    ["email", formatEmailHtml],
  ];
  for (const [name, fmt] of surfaces) {
    test(`${name} prints the list as written, unmarked`, () => {
      const out = fmt(wrapped);
      expect(out).not.toContain("gl-");
      expect(out.replace(/\s+/g, " ").trim()).toBe(fmt(bare).replace(/\s+/g, " ").trim());
    });
  }
});

describe("the reader and the lint read one glossary", () => {
  const never = (md: string) =>
    checkPageText({ relPath: "plans/g.mdx" }, md, []).filter((f) => f.check === "glossary" && f.message.includes("never uses")).length;
  test.each([
    ["prose", "A Hold lasts a week."],
    ["a table cell", "| Kind |\n| --- |\n| Hold |"],
    ["a decision", "<DecisionLog>\n\n- **D1** (2026-01-02): A Hold lasts a week.\n\n</DecisionLog>"],
    ["a missing wikilink", "See [[Hold]]."],
    ["a wikilink with a label", "See [[hold-page|Hold]]."],
    ["inline code", "Set `Hold`."],
    ["a heading", "## Hold"],
    ["a plural", "Two Holds."],
    ["a bare URL", "https://lib.example/Hold"],
    ["a fact mark", '<Fact n="1" v="ok">A Hold.</Fact>'],
  ])("%s", (_name, md) => {
    const page = md + "\n" + HOLD;
    const drawn = marks(reader(page)).length;
    expect(never(page)).toBe(drawn === 0 ? 1 : 0);
  });
});

test("an Explain excerpt is found across a marked term", () => {
  const filler = Array.from({ length: 400 }, (_, i) => `Shelf ${i} holds books.`).join(" ");
  const body = `${filler}\n\n## Loans\n\nA Hold keeps a book back for one reader.\n${HOLD}`;
  // The selection is the visible text: the tooltip is hidden, so it is not in it.
  const excerpt = locateExcerpt(body, "A Hold keeps a book back");
  expect(excerpt).toContain("A Hold keeps a book back for one reader.");
  expect(excerpt.length).toBeLessThan(body.length);
});

describe("a glossary's shapes, as the reader and the lint read them", () => {
  const lintGlossary = (md: string) =>
    checkPageText({ relPath: "plans/g.mdx" }, md, []).filter((f) => f.check === "glossary").map((f) => f.message);
  /** Each tip's text, tags dropped. */
  const tips = (html: string) =>
    [...html.matchAll(/<span class="gl-tip" [^>]*>([^]*?)<\/span>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));

  test("only a paragraph sentence's lead emphasis is a term, not emphasis inside its definition", () => {
    const g = glossary("**Hold** is a book *not* returned.");
    expect(marked("A Hold is not lent.\n" + g)).toEqual([["hold", "Hold"]]);
    expect(lintGlossary("A Hold lasts a week.\n" + g)).toEqual([]);
  });

  test("a list item whose emphasis has no separator after it is an item with no term", () => {
    const g = glossary("- **Note** this list is short", "- **Hold:** a book kept back");
    expect(marked("Note the Hold.\n" + g)).toEqual([["hold", "Hold"]]);
    expect(lintGlossary("Note the Hold.\n" + g)).toEqual(["<Glossary> has an item with no term: «Note this list is short»"]);
  });

  test("a paragraph term's tip does not repeat the term", () => {
    expect(tips(reader("A Hold lasts.\n" + glossary("**Hold** is a book kept back.")))).toEqual(["Hold is a book kept back."]);
    expect(tips(reader("A Hold lasts.\n" + glossary("A **Hold** keeps a book back. It lasts a week.")))).toEqual([
      "Hold keeps a book back. It lasts a week.",
    ]);
  });
});
