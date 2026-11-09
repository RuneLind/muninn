import { describe, expect, test } from "bun:test";
import { beforeAfterChipsHtml, beforeAfterParts, isNumberCell, labelGridItems, labelItem, numberColumns, verdictCell } from "./reader-shapes.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { renderWikiHtml } from "../wiki/render.ts";

describe("isNumberCell", () => {
  const cases: [string, boolean][] = [
    ["10,3", true],
    ["1,662,435", true],
    ["~17,300", true],
    ["≈ 4.5", true],
    ["< 5", true],
    ["−12", true],
    ["+3", true],
    ["$40", true],
    ["€1.25", true],
    ["12 345", true],
    ["790 (just lists, no board)", true],
    ["~290 (agent skills, ADRs, operational guides, e2e specs)", false],
    ["27305752256", false],
    ["1234567", false],
    ["719717", false],
    ["12345", true],
    ["1234e56", false],
    ["08.11", false],
    ["07.11", false],
    ["15.09 (15f7bf5108)", false],
    ["15.09", true],
    ["1.10", true],
    ["12%", true],
    ["3.2 s", true],
    ["450ms", true],
    ["3×", true],
    ["1.2k", true],
    ["40 MB", true],
    ["5 files", true],
    ["12 PRs", true],
    ["2026", true],
    ["#782", false],
    ["D7", false],
    ["PR 782", false],
    ["2026-11-08", false],
    ["1.2.3", false],
    ["v2", false],
    ["3–5", false],
    ["5 apples", false],
    ["—", false],
    ["", false],
    ["yes", false],
  ];
  test.each(cases)("%p → %p", (cell, want) => {
    expect(isNumberCell(cell)).toBe(want);
  });
});

describe("numberColumns", () => {
  const headers = ["Name", "Count", "Year", "Note", "Ms", "PR", "Mixed"];
  const rows = [
    ["a", "1,662,435", "2026", "fine", "450ms", "782", "3 s"],
    ["b", "—", "2025", "12", "—", "790", "12%"],
    ["c", "~17,300", "2024", "x", "–", "801", "40 MB"],
  ];
  const cols = numberColumns(headers, rows);
  test("a number column, a lone dash skipped", () => expect(cols.has(1)).toBe(true));
  test("bare years are not a number column", () => expect(cols.has(2)).toBe(false));
  test("one text cell keeps the column text", () => expect(cols.has(3)).toBe(false));
  test("dashes and numbers", () => expect(cols.has(4)).toBe(true));
  test("an id header is never a number column", () => expect(cols.has(5)).toBe(false));
  test("mixed units, each a number, still number", () => expect(cols.has(6)).toBe(true));
  test("the first column never", () => expect(numberColumns(["n", "v"], [["1", "2"]]).has(0)).toBe(false));
  test("an all-dash column is not numeric", () => expect(numberColumns(["n", "v"], [["a", "—"], ["b", "-"]]).size).toBe(0));
  test("a year beside a non-year number is numeric", () => expect(numberColumns(["n", "v"], [["a", "2026"], ["b", "17"]]).has(1)).toBe(true));
});

describe("numberColumns: headers and values that are not quantities (PR #832 fix round 1)", () => {
  const cases: [string, string[], boolean][] = [
    // id headers, with values short enough to read as numbers on their own
    ["behandlingsresultat_id", ["4521", "4522"], false],
    ["Behandling ID", ["4521"], false],
    ["Behandling", ["4521", "4522"], false],
    ["Aktiv behandling", ["4521"], false],
    ["behandlingId", ["4521"], false],
    ["Commit", ["4521"], false],
    ["SHA", ["4521"], false],
    ["hash", ["4521"], false],
    ["Run", ["4521"], false],
    ["CI run", ["4521"], false],
    ["Uke", ["44", "45"], false],
    ["week", ["44", "45"], false],
    ["Saks-nr", ["4521"], false],
    // HTTP status codes
    ["Status", ["200", "204", "500"], false],
    // dates
    ["Landet", ["15.09 (15f7bf5108)"], false],
    ["Landet", ["15.10", "29.10"], false],
    ["Merged", ["08.11", "07.11"], false],
    ["Merged", ["10.30", "1.10"], false],
    ["Merge date", ["10.30"], false],
    ["Kandidat siden", ["03.07", "18.09", "29.09"], false],
    // ids and hashes by value
    ["Value", ["1234567", "12"], false],
    ["Value", ["1234e56", "5"], false],
    // years after the note and lead are stripped
    ["Target", ["2026 (draft)", "2027"], false],
    ["Target", ["~2026", "2027"], false],
    ["Planned", ["2026", "2025"], false],
    // count headers win over the year guess
    ["Antall", ["2070", "2060"], true],
    ["Av", ["2070", "2060"], true],
    ["Of", ["1999", "2001"], true],
    ["Total", ["2070", "2060"], true],
    // `of`/`av` beside other words join two nouns: a year column stays text
    ["Year of release", ["2024", "2025"], false],
    ["År av vedtak", ["2024", "2025"], false],
    ["Number of the year", ["2024", "2025"], false],
    // quantities whose header mentions an id-ish word, kept
    ["Per PR", ["$35.71", "$101.72"], true],
    ["Cost per run", ["0.42", "0.13"], true],
    ["Commits since 09-01", ["116", "32"], true],
    ["Commits", ["105", "75"], true],
    ["runs", ["94", "47"], true],
    ["Behandlinger", ["12", "1 (1337478, 25.09)"], true],
    ["Lines of code", ["1200", "88"], true],
    ["Dryrun 08.09", ["132", "0"], true],
    ["Antall saker", ["186", "198"], true],
    ["with trace_id", ["0", "12"], true],
    ["PRs merged", ["12", "4"], true],
    ["Code", ["248,261", "107,314"], true],
    ["shipped", ["142px", "194px"], true],
  ];
  test.each(cases)("%p %p → %p", (header, vals, want) => {
    expect(numberColumns(["k", header], vals.map((v, i) => [`r${i}`, v])).has(1)).toBe(want);
  });
});

describe("verdictCell", () => {
  test.each([
    ["✅ good", "good"],
    ["✔️ ok", "good"],
    ["✔ ok", "good"],
    ["🟢 up", "good"],
    ["⚠️ meh", "warn"],
    ["⚠ meh", "warn"],
    ["🟡 slow", "warn"],
    ["❌ no", "bad"],
    ["✗ no", "bad"],
    ["🔴 down", "bad"],
    ["<strong>❌</strong> bad", "bad"],
  ])("%p → %p", (html, tone) => {
    expect(verdictCell(html)?.tone).toBe(tone as "good");
  });
  test("the glyph stays as hidden text", () => {
    expect(verdictCell("✅ good")!.html).toBe('<span class="v-glyph">✅</span> good');
    expect(verdictCell("⚠️  meh")!.html).toBe('<span class="v-glyph">⚠️</span>  meh');
  });
  test.each([
    ["🔴 Critical", "bad"],
    ["🟡 Medium", "warn"],
    ["🟢 Low", "good"],
    ["<strong>🔴</strong> P1", "bad"],
  ])("a traffic light %p keeps its glyph on screen, tone %p", (html, tone) => {
    expect(verdictCell(html)).toEqual({ tone: tone as "bad", light: true, html });
  });
  test("a pass/fail glyph is no traffic light", () => {
    expect(verdictCell("✅ good")!.light).toBe(false);
    expect(verdictCell("❌ no")!.light).toBe(false);
    expect(verdictCell("⚠️ meh")!.light).toBe(false);
  });
  test("a glyph mid-cell is not a verdict", () => {
    expect(verdictCell("works ✅")).toBeNull();
  });
  test("a glyph in a code span is not a verdict", () => {
    expect(verdictCell("<code>✅</code> x")).toBeNull();
  });
});

describe("labelItem (D3)", () => {
  test.each([
    ["**Label:** text", "Label", ":", "text"],
    ["**Label.** text", "Label", ".", "text"],
    ["**Label**: text", "Label", "", "text"],
    ["**Label** — text", "Label", "", "text"],
  ])("%p", (item, label, punct, rest) => {
    expect(labelItem(item)).toMatchObject({ label, punct, rest });
  });
  test.each([
    "**Markdown with a renderer**, which reads it",
    "**Label:**",
    "**Label**:  ",
    "**Label** text",
    "plain **Label:** text",
    "**a** and **b:** text",
    "**2024**–25 was the year",
  ])("%p is no label item", (item) => {
    expect(labelItem(item)).toBeNull();
  });
  // Fix round 1 batch 3: a `:`/`—` after a punctuated label is the separator,
  // never the start of the text column.
  test.each([
    ["**Label.**: x", "Label", ".", ": ", "x"],
    ["**Label:** — x", "Label", ":", " — ", "x"],
    ["**Label.** – x", "Label", ".", " – ", "x"],
  ])("%p: the separator after a punctuated label is not text", (item, label, punct, sep, rest) => {
    expect(labelItem(item)).toEqual({ label, punct, sep, rest });
  });
  // Fix round 2: a mark is a separator only with white space after it and
  // text left over; otherwise it stays in the text.
  test.each([
    ["**Owner:** —", "Owner", ":", " ", "—"],
    ["**Owner:** — ", "Owner", ":", " ", "— "],
    ["**Port:** :3010 is the dev port", "Port", ":", " ", ":3010 is the dev port"],
    ["**Mood.** :) fine", "Mood", ".", " ", ":) fine"],
  ])("%p: the mark is the text", (item, label, punct, sep, rest) => {
    expect(labelItem(item)).toEqual({ label, punct, sep, rest });
  });
  test("a list whose value is a lone em dash is still a grid, the dash shown", () => {
    const html = formatWebHtml("- **Owner:** —\n- **Due:** fredag\n- **Status:** open\n", SHAPES);
    expect(html).toContain('<span class="lg-v">—</span>');
  });
  // The prototype's separators: an en dash beside `:` and `—`.
  test("**Label** – text: an en dash separates", () => {
    expect(labelItem("**Label** – text")).toEqual({ label: "Label", punct: "", sep: " – ", rest: "text" });
  });
});

describe("labelGridItems label cap (prototype's 70)", () => {
  const none = () => false;
  const label = (n: number) => "x".repeat(n);
  test("a label of 70 characters with its colon is a grid", () => {
    expect(labelGridItems([`**${label(69)}:** a`, "**B:** b", "**C:** c"], none)).not.toBeNull();
  });
  test("one label over the cap and the whole list is no grid", () => {
    expect(labelGridItems([`**${label(70)}:** a`, "**B:** b", "**C:** c"], none)).toBeNull();
    expect(labelGridItems(["**A** — a", `**${label(71)}** — b`, "**C** — c"], none)).toBeNull();
  });
  test("the cap counts what labelText shows, not the source", () => {
    const items = [`**[${label(60)}](https://example.com/${label(40)}):** a`, "**B:** b", "**C:** c"];
    expect(labelGridItems(items, none)).toBeNull();
    expect(labelGridItems(items, none, (l) => l.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"))).not.toBeNull();
  });
  test("a wikilink counts as the text it shows: 69 shown + colon is a grid, 70 + colon is not", () => {
    const md = (n: number) => `- **${label(n)}[[ab]]'s:** a\n- **B:** b\n- **C:** c\n`;
    expect(renderWikiHtml(md(65), () => undefined, { readerShapes: true })).toContain("label-grid");
    expect(renderWikiHtml(md(66), () => undefined, { readerShapes: true })).not.toContain("label-grid");
  });
  test("the reader render measures the rendered label: a long link target keeps the grid, a long label does not", () => {
    const longTarget = formatWebHtml(`- **[Short](https://example.com/${label(90)}):** a\n- **B:** b\n- **C:** c\n`, SHAPES);
    expect(longTarget).toContain("label-grid");
    const longLabel = formatWebHtml(`- **A bad waitMs THROWS rather than clamping, so a caller that passes ${label(10)}:** a\n- **B:** b\n- **C:** c\n`, SHAPES);
    expect(longLabel).not.toContain("label-grid");
  });
});

const TABLE = [
  "| Option | Cost | Year | Verdict |",
  "|---|---|---|---|",
  "| A | 1,662,435 | 2026 | ✅ good |",
  "| B | — | 2025 | works ❌ mid-cell |",
  "| C | ~17,300 | 2024 | ⚠️ meh |",
].join("\n");
const LABELS = ["- **One:** first", "- **Two.** second", "- **Three**: third"].join("\n");
const PAGE = `${TABLE}\n\n${LABELS}\n`;

const SHAPES = { reader: true, readerShapes: true } as const;

describe("formatWebHtml reader shapes", () => {
  const reader = formatWebHtml(PAGE, SHAPES);
  test("number column on th and td", () => {
    expect(reader).toContain('<th class="num">Cost</th>');
    expect(reader).toContain('<td class="num">1,662,435</td>');
    expect(reader).toContain('<td class="num">—</td>');
    expect(reader).toContain("<th>Year</th>");
    expect(reader).toContain("<td>2026</td>");
  });
  test("a traffic light cell is tinted and keeps its glyph", () => {
    const html = formatWebHtml("| Item | Priority |\n|---|---|\n| Login | 🔴 Critical |\n| Logout | 🟢 Low |\n", SHAPES);
    expect(html).toContain('<td class="v-bad v-light">🔴 Critical</td>');
    expect(html).toContain('<td class="v-good v-light">🟢 Low</td>');
    expect(html).not.toContain("v-glyph");
  });
  test("a number holding a space sits in a nowrap span, a note outside it", () => {
    const html = formatWebHtml("| Run | Rows | Time | Note |\n|---|---|---|---|\n| a | 12 345 | 3.2 s (cold) | 790 (just lists) |\n| b | 8 | 1 s | 4 |\n", SHAPES);
    expect(html).toContain('<td class="num"><span class="num-nw">12 345</span></td>');
    expect(html).toContain('<td class="num"><span class="num-nw">3.2 s</span> (cold)</td>');
    expect(html).toContain('<td class="num">790 (just lists)</td>');
    expect(html).toContain('<td class="num">8</td>');
  });
  test("a bold, linked or code number holding a space keeps the number whole inside the tag", () => {
    const html = formatWebHtml(
      "| Run | Rows | Size |\n|---|---|---|\n| a | **2 921** | *87 MB* (peak) |\n| b | [10 714](https://example.com/x) | `98.5 MB` |\n| c | **−2 480** | 1 |\n",
      SHAPES,
    );
    expect(html).toContain('<td class="num"><strong><span class="num-nw">2 921</span></strong></td>');
    expect(html).toContain('<td class="num"><em><span class="num-nw">87 MB</span></em> (peak)</td>');
    expect(html).toMatch(/<td class="num"><a [^>]*><span class="num-nw">10 714<\/span><\/a><\/td>/);
    expect(html).toContain('<span class="num-nw">98.5 MB</span></code></td>');
    expect(html).toContain('<td class="num"><strong><span class="num-nw">−2 480</span></strong></td>');
  });
  test("verdict cells tinted, mid-cell glyph not", () => {
    expect(reader).toContain('<td class="v-good"><span class="v-glyph">✅</span> good</td>');
    expect(reader).toContain('<td class="v-warn"><span class="v-glyph">⚠️</span> meh</td>');
    expect(reader).toContain("<td>works ❌ mid-cell</td>");
  });
  test("label grid, separators hidden not deleted", () => {
    expect(reader).toContain(
      '<ul class="label-grid"><li><span class="lg-k"><strong>One<span class="lg-c">:</span></strong> </span><span class="lg-v">first</span></li>',
    );
    expect(reader).toContain('<strong>Three</strong><span class="lg-c">:</span> </span><span class="lg-v">third</span>');
    const dash = formatWebHtml("- **A** — a\n- **B** — b\n- **C** — c\n", SHAPES);
    expect(dash).toContain('<strong>A</strong> <span class="lg-c">—</span> </span><span class="lg-v">a</span>');
  });
  test("a separator after a punctuated label is hidden in the key, the text column starts at the text", () => {
    const html = formatWebHtml("- **A.**: a\n- **B.** — b\n- **C** – c\n", SHAPES);
    expect(html).toContain('<strong>A<span class="lg-c">.</span></strong><span class="lg-c">:</span> </span><span class="lg-v">a</span>');
    expect(html).toContain('<strong>B<span class="lg-c">.</span></strong> <span class="lg-c">—</span> </span><span class="lg-v">b</span>');
    expect(html).toContain('<strong>C</strong> <span class="lg-c">–</span> </span><span class="lg-v">c</span>');
  });

  test("chat renders byte-identical to the plain renderer", () => {
    const plainTable =
      "<table><thead><tr><th>Option</th><th>Cost</th><th>Year</th><th>Verdict</th></tr></thead><tbody>" +
      "<tr><td>A</td><td>1,662,435</td><td>2026</td><td>✅ good</td></tr>" +
      "<tr><td>B</td><td>—</td><td>2025</td><td>works ❌ mid-cell</td></tr>" +
      "<tr><td>C</td><td>~17,300</td><td>2024</td><td>⚠️ meh</td></tr></tbody></table>";
    const plainList = "<ul><li><strong>One:</strong> first</li><li><strong>Two.</strong> second</li><li><strong>Three</strong>: third</li></ul>";
    const chat = formatWebHtml(PAGE);
    expect(chat).toBe(`${plainTable}\n${plainList}`);
    expect(formatWebHtml(PAGE, { reader: false })).toBe(chat);
    for (const cls of ["num", "v-good", "v-glyph", "label-grid", "lg-k"]) expect(chat).not.toContain(cls);
  });

  test("a list with one non-matching item draws no grid", () => {
    const html = formatWebHtml("- **One:** a\n- **Two**, which b\n- **Three:** c\n", SHAPES);
    expect(html).not.toContain("label-grid");
  });
  test("a list item with a nested list disqualifies the list", () => {
    const html = formatWebHtml("- **One:** a\n  - sub\n- **Two:** b\n- **Three:** c\n", SHAPES);
    expect(html).not.toContain("label-grid");
  });
  test("a two-item list draws no grid", () => {
    expect(formatWebHtml("- **One:** a\n- **Two:** b\n", SHAPES)).not.toContain("label-grid");
  });
  test("a nested label list inside an ordinary item stays bullets", () => {
    const html = formatWebHtml("- top\n  - **A:** a\n  - **B:** b\n", SHAPES);
    expect(html).not.toContain("label-grid");
  });
  test("a loose item's later paragraph lands in the text column", () => {
    const html = formatWebHtml("- **One:** a\n\n  more\n\n- **Two:** b\n\n- **Three:** c\n", SHAPES);
    expect(html).toContain('<span class="lg-v">a<p>more</p></span>');
  });

  test("a table and list inside a Fold are styled", () => {
    const html = formatWebHtml(`<Fold title="Section">\n\n${PAGE}\n</Fold>\n`, SHAPES);
    expect(html).toContain('<td class="num">1,662,435</td>');
    expect(html).toContain('class="v-good"');
    expect(html).toContain("label-grid");
  });
  test("a table inside a ComparisonTable is styled", () => {
    const html = formatWebHtml(`<ComparisonTable>\n\n${TABLE}\n\n</ComparisonTable>\n`, SHAPES);
    expect(html).toContain('<div class="tablewrap">');
    expect(html).toContain('<td class="num">1,662,435</td>');
    expect(html).toContain('class="v-good"');
  });
  test("a table inside a Chart is untouched", () => {
    const md = '<Chart kind="bars" value="Cost">\n\n| Run | Cost |\n|---|---|\n| a | 30 |\n| b | 45 |\n\n</Chart>\n';
    const html = formatWebHtml(md, SHAPES);
    expect(html).toContain("<td>30</td>");
    expect(html).not.toContain('class="num"');
  });
  test("a list inside a Question card draws no grid", () => {
    const md = `<Question id="O1">\n\nWhich one?\n\n${LABELS}\n\n</Question>\n`;
    const html = formatWebHtml(md, SHAPES);
    expect(html).toContain("<strong>One:</strong> first");
    expect(html).not.toContain("label-grid");
  });
  test("a table inside a Callout is untouched, and a Fold inside it too", () => {
    const md = `<Callout tone="info">\n\n<Fold title="x">\n\n${TABLE}\n\n</Fold>\n\n</Callout>\n`;
    const html = formatWebHtml(md, SHAPES);
    expect(html).not.toContain('class="num"');
    expect(html).not.toContain("v-good");
  });
  test("after a component closes, the page's next table is styled again", () => {
    const md = `<Callout tone="info">\n\nbody\n\n</Callout>\n\n${TABLE}\n`;
    expect(formatWebHtml(md, SHAPES)).toContain('<td class="num">1,662,435</td>');
  });
});

describe("reader shapes reach the article render only", () => {
  test("reader alone (the gardener preview, the What's-new card) draws none", () => {
    const html = formatWebHtml(PAGE, { reader: true });
    for (const cls of ["num", "v-good", "v-glyph", "label-grid", "lg-k"]) expect(html).not.toContain(cls);
  });
  test("renderWikiHtml draws them only with readerShapes", () => {
    const plain = renderWikiHtml(PAGE, () => undefined);
    expect(plain).not.toContain("label-grid");
    expect(plain).not.toContain('class="num"');
    expect(plain).not.toContain("v-good");
    const article = renderWikiHtml(PAGE, () => undefined, { readerShapes: true });
    expect(article).toContain('<ul class="label-grid">');
    expect(article).toContain('<td class="num">1,662,435</td>');
    expect(article).toContain('class="v-good"');
  });
});

/** Each chip's visible text, in order. */
function chipTexts(html: string): string[] {
  const re = /<span class="ba-chip(?: ba-chip-[op])*">((?:(?!<span class="ba-chip)[\s\S])*?<span class="ba-new">[^<]*<\/span>)<\/span>/g;
  return [...html.matchAll(re)].map((m) => m[1]!.replace(/<[^>]*>/g, ""));
}

describe("before → after chips: the matcher", () => {
  // [text as escaped HTML, the chips' text]
  const cases: [string, string[]][] = [
    ["CI 10.5 → 6.4 min", ["10.5 → 6.4 min"]],
    ["10.5 min → 6.4 min", ["10.5 min → 6.4 min"]],
    ["ratchet 113→57", ["113→57"]],
    ["1,066 → 992 files", ["1,066 → 992 files"]],
    ["ranges 3–5 → 6–7", ["3–5 → 6–7"]],
    ["40% → 55%", ["40% → 55%"]],
    ["~290 → 300", ["~290 → 300"]],
    ["≈ 12 → 9", ["≈ 12 → 9"]],
    ["-3 → 5", ["-3 → 5"]],
    ["−2 480 → 3", ["−2 480 → 3"]],
    ["12 345 → 12 400 rows", ["12 345 → 12 400 rows"]],
    ["$40 → $55", ["$40 → $55"]],
    ["5 PRs → 3 PRs", ["5 PRs → 3 PRs"]],
    ["3x → 5x", ["3x → 5x"]],
    ["+3 pp → +5 pp", ["+3 pp → +5 pp"]],
    ["2 -&gt; 4", ["2 -&gt; 4"]],
    ["a chain 1 → 2 → 3 here", ["1 → 2 → 3"]],
    ["costs 5 → 6.", ["5 → 6"]],
    ["5 → 6 x", ["5 → 6"]],
    ["went 1.5 → 2.5, then 7 → 8", ["1.5 → 2.5", "7 → 8"]],
    // Not a before → after number pair.
    ["v1.2 → v1.3", []],
    ["1.2.3 → 1.3.0", []],
    ["08.11 → 09.11", []],
    ["15.09 → 16.09", []],
    ["2026-11-08 → 2026-11-09", []],
    ["10:30 → 11:00", []],
    ["#810 → #827", []],
    ["x-3 → 4", []],
    ["PR → 5", []],
    ["5 → done", []],
    ["5a → 5b", []],
    ["run 1356583 → 1356590", []],
    ["006→050", []],
    ["10-29 → 10-31", []],
    ["2025-09→2026-07", []],
    ["on 08-24 → 1 s", []],
    ["101–160 762.2 → 795.5", ["762.2 → 795.5"]],
    ["10–12 → 14–16", ["10–12 → 14–16"]],
    ["10 → 20 ", ["10 → 20"]],
    // Fix round 1 batch 2: order notation, thresholds, versions, cut chains.
    ["Reasonable order: 4 → 1 → 5 → 6 → 3 → 2", []],
    ["Final order shipped: 4 → 1 → 5", []],
    ["Sequencing: PR 1 → 2 → 3, then", []],
    ["3 ordered PRs (1→2→3; review", []],
    ["PR 1 → 2", []],
    ["fase 1 → 2", []],
    ["phase 2 → 3", []],
    ["strict 1→2→3→4", []],
    ["must land serially, 4 → 5", []],
    ["sequence 4 → 5 → 10", []],
    ["(round 1 → 2 → 3)", []],
    ["Step 6→12 all pass", []],
    ["rows 3 → 133 during the run", ["3 → 133"]],
    ["POLICY_VERSION 1→2", ["1→2"]],
    ["PRs went 5 → 3", ["5 → 3"]],
    ["fase 10% → 50%", ["10% → 50%"]],
    ["≥3 → 260", []],
    ["≥ 3 → 260", []],
    ["≤2 → 4", []],
    ["refs &gt;3 → 5", []],
    ["refs &lt; 3 → 5", []],
    ["chrome above row 1 315→179px", ["315→179px"]],
    ["row 1 314 → 194px", ["314 → 194px"]],
    ["Opus 4.6 → 429", []],
    ["Sonnet 5 → 404", []],
    ["version 1.2 → 1.3", []],
    ["CDM 4.2 → 4.3 → 4.4", []],
    ["Jira-oppgavene → 8332 → 8337 → 8351", []],
    ["24.12 → 1.1", []],
    ["1.5 → 2.5", ["1.5 → 2.5"]],
    ["1 → 2 → v3", []],
    ["8501 → 47 → 46 → 38/8 → 3", []],
    ["a → 5 → 6", []],
    ["*v*1 → 2", []],
    ["10\u00A0kr → 20\u00A0kr", ["10\u00A0kr → 20\u00A0kr"]],
    ["5\u202Fms → 6\u202Fms", ["5\u202Fms → 6\u202Fms"]],
    ["20 000 → 25 000\u00A0kr", ["20 000 → 25 000\u00A0kr"]],
    ["5 → 6\u00A0x", ["5 → 6"]],
    ["10 → 20 ms/s", ["10 → 20 ms/s"]],
    ["5 MB/s → 9 MB/s", ["5 MB/s → 9 MB/s"]],
    ["10 → 20 req/s", ["10 → 20"]],
    ["cleared ~15s/claim → 8-claim/280s budget", []],
    ["20 000 → 25 000 kr/mnd", ["20 000 → 25 000 kr/mnd"]],
    // Fix round 2 batch 1: a count or measure word is no order word, even
    // before a colon; only an order word itself takes one more word.
    ["Row count: 315 → 179", ["315 → 179"]],
    ["Phase time: 30 → 20", ["30 → 20"]],
    ["Round trip: 120 → 80", ["120 → 80"]],
    ["Step count: 6 → 12", ["6 → 12"]],
    ["open PRs: 12 → 4", ["12 → 4"]],
    ["PRs: 5 → 3", ["5 → 3"]],
    ["strict mode: 3 → 0", ["3 → 0"]],
    ["Steps 6 → 12 in CI", ["6 → 12"]],
    ["row 3 → 5", ["3 → 5"]],
    ["sequence length: 5 → 10", ["5 → 10"]],
    // A rejected rate falls back to the unit before its `/`.
    ["latency 120 → 80ms/req", ["120 → 80ms"]],
    ["latency 120 → 80 ms/request", ["120 → 80 ms"]],
    ["10 → 20 tokens/turn", ["10 → 20 tokens"]],
    // Fix round 2 batch 2: a loose day.month is a date only beside a side
    // whose day is past 12 with a two-digit month; else it is a decimal.
    ["1.5 → 2.10", ["1.5 → 2.10"]],
    ["2.5 → 3.10", ["2.5 → 3.10"]],
    ["13.5 → 14.5", ["13.5 → 14.5"]],
    ["9.12 → 1.1", ["9.12 → 1.1"]],
    ["1.1 → 24.12", []],
    ["31.12 → 1.1", []],
    ["13.5 → 14.10", []],
    ["3.10 → 4.10", []],
  ];
  for (const [text, want] of cases) {
    test(JSON.stringify(text), () => expect(chipTexts(beforeAfterChipsHtml(text))).toEqual(want));
  }

  test("the spans hold the source text and nothing else", () => {
    const html = beforeAfterChipsHtml("CI 10.5 → 6.4 min today");
    expect(html).toBe(
      'CI <span class="ba-chip"><span class="ba-old">10.5</span> <span class="ba-arr">→</span> <span class="ba-new">6.4 min</span></span> today',
    );
    expect(html.replace(/<[^>]*>/g, "")).toBe("CI 10.5 → 6.4 min today");
  });
  test("a chain: every value before the last soft, the last bold", () => {
    expect(beforeAfterChipsHtml("1 → 2 → 3")).toBe(
      '<span class="ba-chip"><span class="ba-old">1</span> <span class="ba-arr">→</span> <span class="ba-old">2</span> <span class="ba-arr">→</span> <span class="ba-new">3</span></span>',
    );
  });
  test("a value glued to the inline code or tag before it is not free-standing", () => {
    expect(chipTexts(beforeAfterChipsHtml("<code>v</code>1.2 → 1.3"))).toEqual([]);
    expect(chipTexts(beforeAfterChipsHtml("<em>v</em>1 → 2"))).toEqual([]);
    expect(chipTexts(beforeAfterChipsHtml("\x00INLINE0\x001 → 2"))).toEqual([]);
    expect(chipTexts(beforeAfterChipsHtml("<code>v</code> 1 → 2"))).toEqual(["1 → 2"]);
    expect(chipTexts(beforeAfterChipsHtml("<strong>CI</strong>: 10 → 6 min"))).toEqual(["10 → 6 min"]);
    expect(chipTexts(beforeAfterChipsHtml("one<br>2 → 3"))).toEqual(["2 → 3"]);
  });
  test("a chain cut by a tag keeps its chip: the arrow ends the text run", () => {
    expect(chipTexts(beforeAfterChipsHtml("(100% → 88% → 67% → <strong>60%</strong>)"))).toEqual(["100% → 88% → 67%"]);
  });
  test("never inside a tag or across a placeholder", () => {
    expect(beforeAfterChipsHtml('<a href="https://x/1 → 2">see</a>')).toBe('<a href="https://x/1 → 2">see</a>');
    expect(beforeAfterChipsHtml("\x00INLINE0\x00 → 5")).toBe("\x00INLINE0\x00 → 5");
    expect(beforeAfterParts("1 → 2")).toEqual({ sides: ["1", "2"], arrows: [" → "] });
  });
});

describe("before → after chips: fix round 2 batch 1", () => {
  test("a rejected rate keeps its `/…` outside the chip", () => {
    expect(beforeAfterChipsHtml("latency 120 → 80ms/req")).toBe(
      'latency <span class="ba-chip"><span class="ba-old">120</span> <span class="ba-arr">→</span> <span class="ba-new">80ms</span></span>/req',
    );
  });
  // Each candidate used to rescan the whole run before it: 5.2 s at 50k
  // chars on 27bce79f, 34 ms after, 81 ms at the 150k used here (measured).
  test("one long run full of pairs renders in linear time", () => {
    for (const unit of ["5 → 6, ", "order: 1 → 2; "]) {
      const text = unit.repeat(Math.ceil(150_000 / unit.length));
      const t0 = performance.now();
      const out = beforeAfterChipsHtml(text);
      expect(performance.now() - t0).toBeLessThan(3_000);
      // Every pair a chip, every ordered one none: a fast matcher that drops
      // or blocks them all fails here.
      expect(out.match(/<span class="ba-chip/g)?.length ?? 0).toBe(unit.startsWith("order") ? 0 : Math.ceil(150_000 / unit.length));
    }
  }, 120_000);
});

describe("before → after chips: the context rules, pinned (fix round 2 batch 3)", () => {
  test("an arrow at the start of a run, after a tag, does not cut the chain after it", () => {
    expect(chipTexts(beforeAfterChipsHtml("<strong>40%</strong> → 30% → 20%"))).toEqual(["30% → 20%"]);
  });
  test("a word split off the chain's end is read with the text after it", () => {
    // ` then` is no unit: the chain is `3 → 5`, and ` then → done` follows it.
    expect(chipTexts(beforeAfterChipsHtml("tests 3 → 5 then → done"))).toEqual(["3 → 5"]);
  });
  test("an order or version word in an earlier run blocks the pair after the tag", () => {
    expect(chipTexts(beforeAfterChipsHtml("<strong>Phase</strong> 2 → 3"))).toEqual([]);
    expect(chipTexts(beforeAfterChipsHtml("<strong>Opus</strong> 4.6 → 429"))).toEqual([]);
  });
  test("an order phrase longer than 20 chars still blocks (the look-back is 64)", () => {
    // ` order recommendation: ` is 23 chars.
    expect(chipTexts(beforeAfterChipsHtml("Rollout order recommendation: 3 → 1 → 2"))).toEqual([]);
  });
});

describe("before → after chips: where the renderer draws them", () => {
  test("chat renders byte-identical to the plain renderer", () => {
    expect(formatWebHtml("CI went 10.5 → 6.4 min.")).toBe("CI went 10.5 → 6.4 min.");
    expect(formatWebHtml("CI went 10.5 → 6.4 min.", { reader: true })).not.toContain("ba-chip");
  });
  test("prose, a list item, a table cell, a grid value and a link's text take one", () => {
    expect(chipTexts(formatWebHtml("CI went 10.5 → 6.4 min.", SHAPES))).toEqual(["10.5 → 6.4 min"]);
    expect(chipTexts(formatWebHtml("- one 2 → 3\n- two\n", SHAPES))).toEqual(["2 → 3"]);
    const table = formatWebHtml("| Step | CI |\n|---|---|\n| a | 10.5 → 6.4 min |\n| b | 7 |\n", SHAPES);
    // A cell holding a pair is no number cell: the column stays text.
    expect(table).toContain('<td><span class="ba-chip"><span class="ba-old">10.5</span>');
    expect(table).not.toContain('class="num"');
    expect(chipTexts(formatWebHtml("- **A:** 1 → 2\n- **B:** b\n- **C:** c\n", SHAPES))).toEqual(["1 → 2"]);
    const link = formatWebHtml("[ratchet 113 → 57](https://example.com/a-1-2)", SHAPES);
    expect(link).toContain('href="https://example.com/a-1-2"');
    expect(chipTexts(link)).toEqual(["113 → 57"]);
  });
  test("a heading, inline code and a fence take none", () => {
    expect(formatWebHtml("## CI 10 → 6 min\n", SHAPES)).not.toContain("ba-chip");
    expect(formatWebHtml("run `10 → 6` now", SHAPES)).not.toContain("ba-chip");
    expect(formatWebHtml("```\n10 → 6\n```\n", SHAPES)).not.toContain("ba-chip");
  });
  test("a table header takes none; a cell under it still does", () => {
    const table = formatWebHtml("| H 1 → 2 | B |\n|---|---|\n| 3 → 4 | x |\n", SHAPES);
    expect(table).toContain("<th>H 1 → 2</th>");
    expect(chipTexts(table)).toEqual(["3 → 4"]);
  });
  test("a Fold's duplicate heading takes none; the body under it still does", () => {
    const html = formatWebHtml('<Fold title="Speed 10 → 20 s">\n\n## Speed 10 → 20 s\n\nCI 7 → 5 min\n\n</Fold>\n', SHAPES);
    expect(html).toContain('<h3 class="fold-heading-dup">Speed 10 → 20 s</h3>');
    expect(chipTexts(html)).toEqual(["7 → 5 min"]);
  });
  test("inside a Fold yes, inside a Callout or a Question no (the shapes' SHAPE_TRANSPARENT rule)", () => {
    expect(chipTexts(formatWebHtml('<Fold title="S">\n\nCI 10 → 6 min\n\n</Fold>\n', SHAPES))).toEqual(["10 → 6 min"]);
    expect(formatWebHtml('<Callout tone="info">\n\nCI 10 → 6 min\n\n</Callout>\n', SHAPES)).not.toContain("ba-chip");
    expect(formatWebHtml('<Question id="O1">\n\nCI 10 → 6 min?\n\n</Question>\n', SHAPES)).not.toContain("ba-chip");
  });
  test("renderWikiHtml draws them only with readerShapes", () => {
    expect(renderWikiHtml("CI 10 → 6 min\n", () => undefined)).not.toContain("ba-chip");
    expect(renderWikiHtml("CI 10 → 6 min\n", () => undefined, { readerShapes: true })).toContain("ba-chip");
  });
});

describe("before → after chips: punctuation right after a chip", () => {
  const tight = (html: string) => (beforeAfterChipsHtml(html).match(/<span class="ba-chip[^"]*">/g) ?? []);
  test.each([
    ["went 7→4, then", ","],
    ["went 7→4. Then", "."],
    ["(went 7→4)", ")"],
    ["went 7→4; then", ";"],
    ["went <strong>7→4</strong>, then", "after a closing tag"],
  ])("%p: the chip drops its right padding (%s)", (html) => {
    expect(tight(html)).toEqual(['<span class="ba-chip ba-chip-p">']);
  });
  test.each([["went 7→4 then"], ["went 7→4 (then)"], ["went 7→4"], ["went 7→4 and, then"]])("%p: padding kept", (html) => {
    expect(tight(html)).toEqual(['<span class="ba-chip">']);
  });
  // Fix round 2 batch 2: closing quotes and the rest of the class.
  test.each([
    ["«went 105 → 15» then", "»"],
    ["“went 105 → 15” then", "”"],
    ["‘went 105 → 15’ then", "’"],
    ["went 7→4: then", ":"],
    ["went 7→4! Then", "!"],
    ["went 7→4? Then", "?"],
    ["[went 7→4] then", "]"],
    ["went 7→4… then", "…"],
    ['went <a href="https://x.example">7→4</a>, then', "after a link's closing tag"],
  ])("%p: the chip drops its right padding (%s)", (html) => {
    expect(tight(html)).toEqual(['<span class="ba-chip ba-chip-p">']);
  });
  test.each([
    ["went (7→4 then", "("],
    ["went [7→4 then", "["],
    ["went «7→4 then", "«"],
    ["went “7→4 then", "“"],
    ["went ‘7→4 then", "‘"],
    ["went (<strong>7→4</strong> then", "past an opening tag"],
    ['went (<a href="https://x.example">7→4</a> then', "past a link's opening tag"],
  ])("%p: the chip drops its left padding (%s)", (html) => {
    expect(tight(html)).toEqual(['<span class="ba-chip ba-chip-o">']);
  });
  test.each([["went (113 → 57)"], ["went «105 → 15»"], ["went [<em>7→4</em>]"]])("%p: both sides drop", (html) => {
    expect(tight(html)).toEqual(['<span class="ba-chip ba-chip-o ba-chip-p">']);
  });
  test.each([["went ( 7→4 then"], ["went x7 → 4"], ['went <a href="(">7→4</a> then'], ["went (a) 7→4 then"]])(
    "%p: left padding kept",
    (html) => {
      expect(tight(html).every((t) => !t.includes("ba-chip-o"))).toBe(true);
    },
  );
  test("the text is unchanged: the class is the only addition", () => {
    const out = beforeAfterChipsHtml("went 10 → 6 min, then (1 → 2).");
    expect(out.replace(/<[^>]*>/g, "")).toBe("went 10 → 6 min, then (1 → 2).");
    expect(out).toContain('<span class="ba-chip ba-chip-p"><span class="ba-old">10</span> <span class="ba-arr">→</span> <span class="ba-new">6 min</span></span>,');
  });
});
