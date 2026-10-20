import { describe, expect, test } from "bun:test";
import { pageGlossaries, renderWikiHtml } from "../wiki/render.ts";
import { checkPageText } from "../wiki/lint.ts";
import { locateExcerpt } from "../wiki/explain-context.ts";
import type { WikiPageMeta } from "../wiki/store.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";
import { PEEK_GLOSSARY_CHROME } from "../dashboard/views/components/wiki-ref-links.ts";
import { GLOSSARY_CHROME_CLASSES, markGlossaryTerms, termPattern, termScanner } from "./glossary-view.ts";
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

  test("a term with a capital past its first letter matches letter for letter", () => {
    const g = glossary("- **LIB:** the library's code");
    expect(marked("The lib desk uses LIB codes.\n" + g)).toEqual([["lIB", "LIB"]]);
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
    expect(marked("Ask for Hold & Renew at the desk.\n" + g)).toEqual([["hold &amp; Renew", "Hold &amp; Renew"]]);
  });

  test("a numeric entity no code point can hold reads as U+FFFD, a non-word character", () => {
    const entries: GlossaryEntry[] = [{ term: "Hold", ...glossaryKey("Hold"), definition: "kept back", codeSpelled: false, at: 0 }];
    for (const ent of ["&#99999999;", "&#x110000;", "&#xD800;", "&#0;"]) {
      expect(marks(markGlossaryTerms(`<p>Ask ${ent}Hold${ent} now.</p>`, entries))).toEqual([["hold", "Hold"]]);
    }
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

  // Each page's only use of the term is a label the renderer writes around a component's body.
  const caseFiles = new Map([
    ["c.yaml", { ok: true as const, text: "- {status: hold}\n- {id: LIB-1, status: hold}\n" }],
    ["big.yaml", { ok: true as const, text: Array.from({ length: 501 }, (_, k) => `- {id: LIB-${k}, status: ok}`).join("\n") }],
  ]);
  const question = { questionsTo: [], language: "en" as const, answerable: true, owner: null };
  test.each([
    ["Query", "a Query without an id", '<Query question="Which desk?">\n\nBody text.\n\n</Query>', "query-warning"],
    ["run", "a Query's run date", '<Query id="Q-1" run="2026-09-01">\n\nBody text.\n\n</Query>', "query-run"],
    ["uses", "a Query's uses line", '<Query id="Q-1" uses="loans">\n\nBody text.\n\n</Query>', "query-uses"],
    ["Question", "a Question's label", '<Question id="O1">\n\nWhich desk?\n\n</Question>', "q-label"],
    ["better", "a DeltaTable's direction", '<DeltaTable better="lower">\n\n| Run | a | b |\n|---|---|---|\n| T | 1 | 2 |\n\n</DeltaTable>', "dt-delta-dir"],
    ["runs", "a DeltaTable's note", "<DeltaTable>\n\n| Run | a |\n|---|---|\n| T | 1 |\n\n</DeltaTable>", "dt-note"],
    ["step", "a RunChecklist's count", "<RunChecklist>\n\n- [ ] Renew it\n\n</RunChecklist>", "rc-count"],
    ["Command", "a RunChecklist's row label", "<RunChecklist>\n\n- [ ] Renew it\n  - Command: `renew`\n\n</RunChecklist>", "rc-label"],
    ["page", "an Embed's fallback line", '<Embed src="./x.html" />', "embed-fallback"],
    ["Hold", "a Historic's stamp", '<Historic since="2026-01-01" note="Hold policy">\n\nBody text.\n\n</Historic>', "historic-stamp"],
    ["entry", "a CaseBoard's warning", '<CaseBoard src="c.yaml" />', "cb-warning"],
    ["showing", "a CaseBoard's row cap", '<CaseBoard src="big.yaml" />', "cb-truncated"],
    ["without", "a CaseBoard with no src", "<CaseBoard />", "cb-unavailable"],
    ["value", "a DeltaTable's warning", '<DeltaTable better="sideways">\n\n| Run | a | b |\n|---|---|---|\n| T | 1 | 2 |\n\n</DeltaTable>', "dt-warning"],
    ["available", "a DeltaTable's file note", '<DeltaTable src="r.csv" />', "dt-unavailable"],
    ["available", "a Query's SQL file note", '<Query id="Q-1" sql="q.sql" />', "query-unavailable"],
    ["Open", "a Question card's state", '<Question id="O1">\n\nWhich desk?\n\n</Question>', "q-state"],
    ["Team", "a Question card's for line", '<Question id="O1" to="Desk Team">\n\nWhich desk?\n\n</Question>', "q-for"],
    ["Another", "a Question card's duplicate note", '<Question id="O1">\n\nWhich desk?\n\n</Question>\n\n<Question id="O1">\n\nWhich shelf?\n\n</Question>', "q-note q-duplicate"],
  ])("%s in %s", (term, _name, md, cls) => {
    const html = renderWikiHtml(md + "\n" + glossary(`- **${term}:** a word the renderer writes`), () => undefined, { views: true, files: caseFiles, question });
    expect(html).toContain(`class="${cls}"`);
    expect(marks(html)).toEqual([]);
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
    expect(html).toContain('<b class="gl-tip-term">Renewal</b> a new &amp; &quot;quick&quot; loan</span>');
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

describe("where the reader marks a term on the page", () => {
  test.each([
    ["prose", "A Hold lasts a week.", 1],
    ["a table cell", "| Kind |\n| --- |\n| Hold |", 1],
    ["a decision", "<DecisionLog>\n\n- **D1** (2026-01-02): A Hold lasts a week.\n\n</DecisionLog>", 1],
    ["a missing wikilink", "See [[Hold]].", 0],
    ["a wikilink with a label", "See [[hold-page|Hold]].", 0],
    ["inline code", "Set `Hold`.", 0],
    ["a heading", "## Hold", 0],
    ["a plural", "Two Holds.", 0],
    ["a bare URL", "https://lib.example/Hold", 0],
    ["a fact mark", '<Fact n="1" v="ok">A Hold.</Fact>', 0],
  ] as const)("%s", (_name, md, drawn) => {
    expect(marks(reader(md + "\n" + HOLD)).length).toBe(drawn);
  });
});

test("an Explain excerpt is found across a marked term", () => {
  const filler = Array.from({ length: 400 }, (_, i) => `Shelf ${i} holds books.`).join(" ");
  const body = `${filler}\n\n## Loans\n\nAsk at the desk: a hold keeps a book back for one reader.\n${HOLD}`;
  const html = reader(body);
  // The paragraph the reader selects across: after the heading, before the list.
  const para = html.slice(html.indexOf("Ask at the desk"), html.indexOf("one reader.") + "one reader.".length);
  expect(marks(para)).toEqual([["hold", "hold"]]);
  // A selection leaves out reader-only parts (readerSelectionText), as here.
  const visible = new HTMLRewriter().on(`[${READER_ONLY_ATTR}]`, { element: (e) => void e.remove() }).transform(para);
  const selection = visible.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
  const excerpt = locateExcerpt(body, selection);
  expect(excerpt).toContain("Ask at the desk: a hold keeps a book back for one reader.");
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
    expect(pageGlossaries(g)[0]!.entries.map((e) => e.term)).toEqual(["Hold"]);
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

describe("a term's case, whitespace and longer terms around it", () => {
  test.each([
    ["Soft AND", "A soft AND query.", [["soft AND", "soft AND"]]],
    ["Loan-DB", "The loan-DB is full.", [["loan-DB", "loan-DB"]]],
    ["Hold B", "Ask for hold B now.", [["hold B", "hold B"]]],
  ])("a sentence-case capital is free: «%s»", (term, prose, want) => {
    expect(marked(prose + "\n" + glossary(`- **${term}:** a library word`))).toEqual(want);
  });

  test("a capital past the first letter matches exactly", () => {
    const g = glossary("- **RRF:** a ranking");
    expect(marked("Not rrf, not Rrf, but RRF.\n" + g)).toEqual([["rRF", "RRF"]]);
  });

  test("a shorter term never marks inside a later occurrence of a longer one", () => {
    const g = glossary("- **Hold:** kept back", "- **Hold queue:** the readers waiting");
    expect(marked("The hold queue grows. The hold queue shrinks.\n" + g)).toEqual([["hold queue", "hold queue"]]);
    const h = glossary("- **Hold:** kept back", "- **Long hold:** a month kept back");
    expect(marked("A long hold. A long hold ends.\n" + h)).toEqual([["long hold", "long hold"]]);
  });

  test.each([
    ["a no-break space", "The due date is set.", "due date"],
    ["a narrow no-break space", "The due date is set.", "due date"],
    ["a soft line break", "The due\ndate is set.", "due\ndate"],
    ["a double space", "The due  date is set.", "due  date"],
  ])("white space inside a term matches %s, and the mark wraps it as written", (_name, prose, wraps) => {
    expect(marked(prose + "\n" + glossary("- **Due date:** the day a book goes back"))).toEqual([["due date", wraps]]);
  });
});

describe("text that holds a character outside the BMP", () => {
  const g = glossary("- **Hold queue:** the readers waiting", "- **Data:** the catalogue's records");
  test.each([
    ["an emoji-led list item", "- 📄 Data"],
    ["an emoji-led table cell", "| Kind |\n| --- |\n| 📄 Raw Data |"],
  ])("a term after %s is marked", (_name, md) => {
    expect(marked(md + "\n" + g)).toEqual([["data", "Data"]]);
  });

  test("the scanner finds every place a term's own pattern matches, in random text with astral characters", () => {
    let seed = 0x5eed;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) % n;
    const pick = <T,>(xs: readonly T[]) => xs[rand(xs.length)]!;
    const alphabet = ["a", "d", "t", "h", "o", "l", "D", "H", " ", " ", "\u00a0", "é", "📄", "📚", "𝔸", "-", "."];
    const words = ["data", "hold", "hold queue", "dat", "a data", "Ho", "LIB-101", "📄 data", "olé"];
    let checked = 0;
    for (let round = 0; round < 400; round++) {
      const terms = [...new Set(Array.from({ length: 1 + rand(4) }, () => pick(words)))]
        .sort((a, b) => [...b].length - [...a].length)
        .map((term) => termPattern({ term, ...glossaryKey(term), definition: "", codeSpelled: false, at: 0 }));
      const scan = termScanner(terms);
      for (let n = 0; n < 5; n++) {
        const text = Array.from({ length: 3 + rand(20) }, () => (rand(3) === 0 ? pick(words) : pick(alphabet))).join("");
        const subject = scan.subject(text);
        const found = new Set<number>();
        for (let at = scan.next(subject, 0); at >= 0; at = scan.next(subject, at + 1)) found.add(at);
        for (let at = 0; at < text.length; at++) {
          const first = terms.findIndex((re) => ((re.lastIndex = at), re.test(text)));
          if (first < 0) continue;
          checked++;
          expect({ text, at, found: found.has(at) }).toEqual({ text, at, found: true });
          const which = scan.which(subject, at);
          expect({ text, at, ok: which >= 0 && which <= first }).toEqual({ text, at, ok: true });
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  test("a multi-word term after an emoji is marked too", () => {
    expect(marked("- 📄 Ask for the hold queue\n" + g)).toEqual([["hold queue", "hold queue"]]);
  });
});

describe("the word before a term, as the composed text reads it", () => {
  test("a skipped run ending in a mark that composes to a non-word character lets the next word start a term", () => {
    const entries: GlossaryEntry[] = [{ term: "Renewal", ...glossaryKey("Renewal"), definition: "another loan period", codeSpelled: false, at: 0 }];
    // `=` + U+0338 composes to `≠`, not a word character; the raw last unit is the mark.
    for (const tail of ["≠", "=&#x338;"]) {
      expect(marks(markGlossaryTerms(`<p><mark class="fc-mark">a ${tail}</mark>renewal</p>`, entries))).toEqual([["renewal", "renewal"]]);
    }
    expect(marks(markGlossaryTerms(`<p><mark class="fc-mark">a é</mark>renewal</p>`, entries))).toEqual([]);
  });
});

describe("a first letter whose lower case is two characters", () => {
  test.each([
    ["an exact-case term", "İSTANBUL", "The İSTANBUL branch opens.", [["i̇STANBUL", "İSTANBUL"]]],
    ["a case-free term", "İzmir", "The İzmir branch opens.", [["i̇zmir", "İzmir"]]],
  ])("%s matches its own spelling", (_name, term, prose, want) => {
    expect(marked(prose + "\n" + glossary(`- **${term}:** a branch library`))).toEqual(want);
  });

  test.each([
    ["an exact-case term", "İSTANBUL", "The i\u0307STANBUL branch opens.", [["i̇STANBUL", "i\u0307STANBUL"]]],
    ["a case-free term", "İzmir", "The i\u0307zmir branch opens.", [["i̇zmir", "i\u0307zmir"]]],
  ])("%s matches its first letter's lower case too", (_name, term, prose, want) => {
    expect(marked(prose + "\n" + glossary(`- **${term}:** a branch library`))).toEqual(want);
  });
});
