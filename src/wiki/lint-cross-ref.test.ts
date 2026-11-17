import { test, expect, describe, beforeEach } from "bun:test";
import { countedNextMovesLanes, parseBlocks } from "../format/markdown-ast.ts";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex } from "./store.ts";
import { lintWiki, type LintFinding } from "./lint.ts";
import { checkCrossRefs, localLabels, pageDefinedIds, queryCardText, scanXrefPage, xrefRunsBeforeConnector, type XrefLintDeps, type XrefPageScan } from "./lint-cross-ref.ts";
import { testTempDir } from "../test/temp-dir.ts";

const PROJECTS = ["DEMO"];
const scan = (content: string, subject = true) => scanXrefPage(content, PROJECTS, subject);
const prose = (content: string) => scan(content).mentions.filter((m) => m.kind === "prose").map((m) => m.snippet);

const CASES_PAGE = [
  "---",
  "title: Cases",
  "---",
  "",
  '<Query id="Q-5" question="Who owns the cases?">',
  "",
  "```sql",
  "SELECT * FROM t WHERE k IN ('CASE-10001', 'CASE-10002');",
  "```",
  "",
  "</Query>",
  "",
  '<Query id="Q-5c" question="And the late one?">',
  "",
  "```sql",
  "SELECT * FROM t WHERE k = :case;",
  "```",
  "",
  "</Query>",
  "",
  "<DecisionLog>",
  "",
  "- **D3** — Cases are read once a day.",
  "",
  "</DecisionLog>",
].join("\n");

describe("pageDefinedIds", () => {
  test("Query ids and DecisionLog items, each defined once", () => {
    expect([...pageDefinedIds(CASES_PAGE)]).toEqual([["D3", "decision"], ["Q-5", "query"], ["Q-5c", "query"]]);
  });

  test("an id two items carry names no target; a fenced card defines nothing", () => {
    const twice = ['<Query id="O2" question="a" />', "", "<DecisionLog>", "", "- **O2** — b.", "", "</DecisionLog>"].join("\n");
    expect(pageDefinedIds(twice).size).toBe(0);
    expect(pageDefinedIds(["```mdx", '<Query id="Q-1" question="a" />', "```"].join("\n")).size).toBe(0);
  });
});

describe("localLabels", () => {
  test("a heading id, a bold id that opens an item or a cell, a plain first cell", () => {
    const page = ["## Fix A1 first", "- **S1** — a question", "1. [ ] **S2:** another", "| R1 | row |", "| x | **K2** |", "Text with **T-7** inside and B3 plain."].join("\n");
    expect([...localLabels(page)].sort()).toEqual(["A1", "K2", "R1", "S1", "S2"]);
  });
});

describe("scanXrefPage — prose", () => {
  test("an id run, a connector, then plain text", () => {
    expect(prose("Run Q-5 on the cases page.\n\nT-7 i 8371 fant ingen, og **D3** og Q-5c på vaktsiden også.")).toEqual([
      "Q-5 on the cases",
      "T-7 i 8371 fant",
      "D3 og Q-5c på vaktsiden også",
    ]);
  });

  test("only a wikilink right after the connector is the linked form, emphasis around it aside", () => {
    expect(prose("Q-5 on [[plans/cases|the cases page]], D3 i **[[plans/cases]]**, D4 on _[[plans/cases]]_ and D5 on ~~[[plans/cases]]~~.")).toEqual([]);
  });

  test("a quote, a bracket or a markdown link after the connector is not the linked form", () => {
    // The reader links none of these: its text before the link does not end in the connector.
    const page = "Q-5 on «[[plans/cases]]», D3 on ([[plans/cases]]), D4 on \"[[plans/cases]]\" and Q-5c on [the page](cases.mdx).";
    expect(scan(page).mentions.map((m) => m.ids)).toEqual([["Q-5"], ["D3"], ["D4"], ["Q-5c"]]);
    expect(scan("Q-5 on '[[plans/cases]]' and D3 on “[[plans/cases]]”.").mentions.map((m) => m.ids)).toEqual([["Q-5"], ["D3"]]);
    // Literal text in the reader, not emphasis: `__`, a lone `~`, `~~~`. And `[[]]` is no link.
    const literal = "D3 on __[[plans/cases]]__, D4 on ~[[plans/cases]]~, D5 on ~~~[[plans/cases]]~~~ and D6 on [[]].";
    expect(scan(literal).mentions.map((m) => m.ids)).toEqual([["D3"], ["D4"], ["D5"], ["D6"]]);
  });

  test("a hyphen between two ids is a range, not a glued id", () => {
    expect(scan("See D3-D5 on the cases page, and Q-R4-D7 on the log page.").mentions.map((m) => m.ids)).toEqual([["D3", "D5"]]);
    expect(scan(STEP_PAGE("Settle D1-D2 and Q-R4 first.")).mentions).toEqual([{ kind: "step", ids: ["D1", "D2"], line: 5, snippet: "D1, D2" }]);
  });

  test("a run does not cross a blank line or a list item", () => {
    expect(scan("List D3\n\nD4 on the cases page.").mentions).toMatchObject([{ ids: ["D4"], line: 3, snippet: "D4 on the cases" }]);
    expect(scan("We use D3 on\n\nNext paragraph.").mentions).toEqual([]);
    expect(scan("- D3\n- D4 on the cases page.\n\n* D5\n* D6 on the log page.\n\n## About D7\nD8 on the log page.").mentions.map((m) => [m.ids, m.line])).toEqual([
      [["D4"], 2],
      [["D6"], 5],
      [["D8"], 8],
    ]);
    // One paragraph over two lines is still one run.
    expect(scan("Both D3,\nD4 and\nD5 on\nthe cases page.").mentions).toMatchObject([{ ids: ["D3", "D4", "D5"], line: 1 }]);
  });

  test("an HTML comment is text, as the reader draws it", () => {
    expect(scan("<!-- D3 on foo -->").mentions.map((m) => m.ids)).toEqual([["D3"]]);
    // The reader's text before the link ends in the comment, not in the connector.
    expect(scan("Q-5 on <!-- the card -->[[plans/cases]].").mentions.map((m) => m.ids)).toEqual([["Q-5"]]);
    // A comment between the id and the connector: no run, with or without another run on the page.
    expect(scan("D3 <!-- x --> on the log page.").mentions).toEqual([]);
    expect(scan("D3 <!-- x --> on the log page.\n\nQ-9 on the other page.").mentions.map((m) => m.ids)).toEqual([["Q-9"]]);
  });

  test("a connector that ends its block points at nothing", () => {
    for (const next of ["- the cases page", "* the cases page", "1. the cases page", "## The cases page", "\nThe cases page."]) {
      expect([next, scan(`We settled D3 on\n${next}`).mentions]).toEqual([next, []]);
    }
    expect(scan("We settled D3 on  \n\nNext.").mentions).toEqual([]);
    // Inside a paragraph the next line is the same block.
    expect(scan("We settled D3 on\nthe cases page.").mentions.map((m) => m.ids)).toEqual([["D3"]]);
  });

  test("a star that opens a line is a list marker only before white space", () => {
    expect(scan("D3,\n*D4* on the cases page.").mentions.map((m) => m.ids)).toEqual([["D3", "D4"]]);
    expect(scan("D3,\n* D4 on the cases page.").mentions.map((m) => m.ids)).toEqual([["D4"]]);
  });

  test("the line is the source line of the run's first id", () => {
    const [m] = scan("---\ntitle: T\n---\n\nFirst.\n\nThen *Q-5* on\nthe cases page.").mentions;
    expect(m).toMatchObject({ kind: "prose", ids: ["Q-5"], line: 7, connector: "on" });
  });

  test("an attribute value over two lines moves no line number", () => {
    const [m] = scan('<Fold title="More" summary="first\nsecond">\n\nQ-5 on the cases page.\n\n</Fold>').mentions;
    expect(m).toMatchObject({ ids: ["Q-5"], line: 4 });
  });

  test("not read: frontmatter, code, history blocks, attribute values, link insides", () => {
    const page = [
      "---",
      "description: Q-5 on the cases page",
      "---",
      "",
      "`Q-5 on the cases page` and a fence:",
      "",
      "```",
      "Q-5 on the cases page",
      "```",
      "",
      '<Fold title="More" summary="Q-5 on the cases page">',
      "",
      "See [[plans/cases|Q-5 on the cases page]] and https://example.com/Q-5 on the web.",
      "",
      "</Fold>",
      "",
      "<Timeline>",
      "",
      "- **2026-01-02** — Q-5 on the cases page.",
      "",
      "</Timeline>",
      "",
      "<DecisionLog>",
      "",
      "- **D1** — Q-5 on the cases page.",
      "",
      "</DecisionLog>",
      "",
      "<Historic>",
      "",
      "Q-5 on the cases page.",
      "",
      "</Historic>",
    ].join("\n");
    expect(prose(page)).toEqual([]);
  });

  test("no candidate: a tracker key, an id glued after a hyphen, a state phrase, a date", () => {
    expect(prose("DEMO-8308 on the board. Q-R4 i loggen. Q-1 i prod siden mai. Q-1 in prod. O5 on 14.11 and D3 i 2025.")).toEqual([]);
    // A page number is no date.
    expect(prose("T-4 i 8371.")).toEqual(["T-4 i 8371"]);
  });

  test("a reserved or culled page is read for its definitions only", () => {
    const s = scan(`${CASES_PAGE}\n\nQ-9 on the other page.`, false);
    expect(s.mentions).toEqual([]);
    expect(s.defined.has("Q-5")).toBe(true);
  });
});

const STEP_PAGE = (step: string) => ["<NextMoves>", "", '<Lane kind="you">', "", `1. ${step}`, "- [x] Done: ask about Q-9.", "", "</Lane>", "", "</NextMoves>"].join("\n");

describe("scanXrefPage — steps", () => {
  test("an open step's ids outside the connector form; a done step is not read", () => {
    const s = scan(STEP_PAGE("**Run Q-5 with the id number** on the cases page for CASE-10001; T-4 could not tell."));
    expect(s.mentions).toEqual([{ kind: "step", ids: ["Q-5", "CASE-10001", "T-4"], line: 5, snippet: "Q-5, CASE-10001, T-4" }]);
  });

  test("a step's connected ids are read block by block too", () => {
    // The item's second line opens a block, so the connector ends the first: Q-5 is loose.
    const s = scan(STEP_PAGE("Settle Q-5 on\n   # [[plans/cases]]"));
    expect(s.mentions.map((m) => [m.kind, m.ids])).toEqual([["step", ["Q-5"]]]);
  });

  test("an id a connector follows is the prose rule's, linked or not", () => {
    const s = scan(STEP_PAGE("Run Q-5c on [[plans/cases|the cases page]] and Q-7 on the other page."));
    expect(s.mentions.map((m) => [m.kind, m.ids])).toEqual([["prose", ["Q-7"]]]);
  });

  test("a step's line is its own, not an earlier line that quotes it", () => {
    const quotes = ["---", "description: Run Q-5 for CASE-10001.", "---", "", "As said: Run Q-5 for CASE-10001.", "", "- Run Q-5 for CASE-10001.", ""];
    const s = scan([...quotes, STEP_PAGE("Run Q-5 for CASE-10001.")].join("\n"));
    expect(s.mentions.filter((m) => m.kind === "step").map((m) => m.line)).toEqual([13]);
    expect(s.steps.map((st) => st.line)).toEqual([13]);
    // Inside the lane too: a prose line with the step's words is no list item.
    const lane = ["<NextMoves>", "", '<Lane kind="you">', "", "Run Q-5 for CASE-10001.", "", "1. Run Q-5 for CASE-10001.", "", "</Lane>", "", "</NextMoves>"];
    expect(scan(lane.join("\n")).steps.map((st) => st.line)).toEqual([7]);
  });

  describe("a step's line is the parser's", () => {
    const STEP = "Run Q-5 for CASE-10001.";
    const lane = (...body: string[]) => ["<NextMoves>", "", '<Lane kind="you">', "", ...body, "", "</Lane>", "", "</NextMoves>"];
    const linesOf = (page: string[]) => {
      const s = scan(page.join("\n"));
      return { mentions: s.mentions.filter((m) => m.kind === "step").map((m) => m.line), steps: s.steps.map((st) => st.line) };
    };

    test("a done item with the same words comes first", () => {
      expect(linesOf(lane(`- [x] ${STEP}`, `- [ ] ${STEP}`))).toEqual({ mentions: [6], steps: [6] });
    });

    test("a settled block above holds the same step", () => {
      const page = ["<Historic>", "", ...lane(`- ${STEP}`), "", "</Historic>", "", ...lane(`- ${STEP}`)];
      expect(linesOf(page)).toEqual({ mentions: [19], steps: [19] });
    });

    test("a list item outside the lanes, and prose that names the tag", () => {
      const page = ["Text about `<NextMoves>` blocks.", "", `- ${STEP}`, "", ...lane(`- ${STEP}`)];
      expect(linesOf(page)).toEqual({ mentions: [9], steps: [9] });
    });

    test("two steps that open alike, and the same step twice", () => {
      expect(linesOf(lane(`- ${STEP.slice(0, -1)} again later.`, `- ${STEP}`, `- ${STEP}`))).toEqual({ mentions: [5, 6, 7], steps: [5, 6, 7] });
    });

    test("a checkbox with no space after it, a numbered item and a second line", () => {
      expect(linesOf(lane(`- [ ]${STEP}`, "", "1. Run Q-7 for", "   CASE-10002."))).toEqual({ mentions: [5, 7], steps: [5, 7] });
    });

    test("the steps read are the lane's own, in every shape a lane holds them", () => {
      const page = [
        ...lane("- T-1 first", "- [x] T-2 done", "- [ ] T-3 open", "- [ ]", "", "Prose with T-4.", "", "1. T-5 numbered", "2. [X] T-6 done"),
        "",
        ...lane("<Checklist>", "", "- [ ] T-7 row", "- [x] T-8 done", "", "</Checklist>", "", "<RunChecklist>", "", "- [ ] T-9 run", "  - Command: `x`", "- [x] T-10 done", "", "</RunChecklist>"),
      ].join("\n");
      const items = countedNextMovesLanes(parseBlocks(page)).lanes.flatMap((l) => l.items);
      expect(items.map((i) => /T-\d+/.exec(i)![0])).toEqual(["T-1", "T-3", "T-5", "T-7", "T-9"]);
      expect(scan(page).mentions.map((m) => [m.kind, m.ids.join(","), m.line])).toEqual([
        ["step", "T-1", 5],
        ["step", "T-3", 7],
        ["step", "T-5", 12],
        ["step", "T-7", 23],
        ["step", "T-9", 30],
      ]);
    });

    test("a <Checklist> row takes its block's line", () => {
      expect(linesOf(lane("<Checklist>", "", `- [x] ${STEP}`, `- [ ] ${STEP}`, "", "</Checklist>"))).toEqual({ mentions: [5], steps: [5] });
    });
  });

  test("a clause that names an id and a case key, with the step's link targets", () => {
    const s = scan(STEP_PAGE("Run Q-5 on [[plans/cases#q-5|the cases page]] for CASE-10001 and DEMO-8308; T-4 found nothing. CASE-10009 waits."));
    expect(s.steps).toEqual([{ line: 5, clauses: [{ ids: ["Q-5"], cases: ["CASE-10001"] }], links: ["plans/cases"] }]);
  });
});

describe("queryCardText", () => {
  test("the card's attributes, body and files; null for an unknown id", () => {
    const page = '<Query id="Q-1" question="Which?" sql="q1.sql" csv="q1.csv">\n\nNote on CASE-10001.\n\n</Query>';
    const files = new Map([
      ["q1.sql", { ok: true as const, text: "SELECT 'CASE-10002'" }],
      ["q1.csv", { ok: true as const, text: "k\nCASE-10003\n" }],
    ]);
    const text = queryCardText(page, files, "Q-1")!;
    for (const k of ["Which?", "CASE-10001", "CASE-10002", "CASE-10003"]) expect(text).toContain(k);
    expect(queryCardText(page, files, "Q-2")).toBeNull();
  });
});

describe("checkCrossRefs", () => {
  const scans = (pages: Record<string, string>) => new Map<string, XrefPageScan>(Object.entries(pages).map(([p, c]) => [p, scan(c)]));
  const deps = (pages: Record<string, string>, near: Record<string, string[]>): XrefLintDeps => ({
    neighbours: (p) => near[p] ?? [],
    resolve: (t) => (pages[`${t}.mdx`] !== undefined ? `${t}.mdx` : undefined),
    cardText: async (p, id) => queryCardText(pages[p]!, undefined, id),
    connector: "on",
    trackerProjects: PROJECTS,
  });
  const run = (pages: Record<string, string>, near: Record<string, string[]>) => checkCrossRefs(scans(pages), deps(pages, near));

  test("an id a neighbour defines, with the one page to link", async () => {
    const pages = { "plans/a.mdx": "Run Q-5 on the cases page.", "plans/cases.mdx": CASES_PAGE };
    expect(await run(pages, { "plans/a.mdx": ["plans/cases.mdx"] })).toEqual([
      {
        check: "cross-page-id-unlinked",
        relPath: "plans/a.mdx",
        message:
          '"Q-5 on the cases": no wikilink follows "on", so the reader cannot link Q-5. Q-5 is defined on plans/cases.mdx. Write "Q-5 on [[plans/cases|…]]"',
        detail: "prose",
        line: 1,
      },
    ]);
  });

  test("no finding: nobody near defines it, the page defines it, or it is the page's own label", async () => {
    const own = `${CASES_PAGE}\n\nSee Q-5 on the cases page.`;
    const label = "| S1 | a row |\n\nSee S1 on the cases page.";
    const other = "<DecisionLog>\n\n- **S1** — x.\n\n</DecisionLog>";
    expect(await run({ "a.mdx": "Run Q-5 on the cases page.", "cases.mdx": CASES_PAGE }, {})).toEqual([]);
    expect(await run({ "a.mdx": own, "cases.mdx": CASES_PAGE }, { "a.mdx": ["cases.mdx"] })).toEqual([]);
    expect(await run({ "a.mdx": label, "b.mdx": other }, { "a.mdx": ["b.mdx"] })).toEqual([]);
  });

  test("two pages define it: the message names both and leaves the page open", async () => {
    const pages = { "a.mdx": "D3 on the plan.", "b.mdx": CASES_PAGE, "c.mdx": CASES_PAGE };
    const [f] = await run(pages, { "a.mdx": ["b.mdx", "c.mdx"] });
    expect(f!.message).toBe('"D3 on the plan": no wikilink follows "on", so the reader cannot link D3. D3 is defined on b.mdx, c.mdx. Write "D3 on [[<page>|…]]"');
  });

  test("a step: only the ids a neighbour defines, in the wiki's connector", async () => {
    const pages = { "a.mdx": STEP_PAGE("Run Q-5 with the number for CASE-10001; T-4 could not tell."), "cases.mdx": CASES_PAGE };
    const found = await run(pages, { "a.mdx": ["cases.mdx"] });
    expect(found.map((f) => [f.check, f.detail, f.line, f.message])).toEqual([
      [
        "cross-page-id-unlinked",
        "step",
        5,
        'a <NextMoves> step names Q-5 with no link to the page that defines it. Q-5 is defined on cases.mdx. Write "Q-5 on [[cases|…]]"',
      ],
    ]);
  });

  describe("step-query-missing-case", () => {
    const near = { "plans/a.mdx": ["plans/cases.mdx"] };
    const step = (text: string) => ({ "plans/a.mdx": STEP_PAGE(text), "plans/cases.mdx": CASES_PAGE });
    const missing = async (text: string) => (await run(step(text), near)).filter((f) => f.check === "step-query-missing-case");

    test("the card lists cases and not the one the step names", async () => {
      expect(await missing("Run Q-5 on [[plans/cases|the cases page]] for CASE-10001 and CASE-10777.")).toEqual([
        {
          check: "step-query-missing-case",
          relPath: "plans/a.mdx",
          message:
            "a <NextMoves> step names Q-5 with CASE-10777, but the Q-5 card on plans/cases.mdx lists other cases and not CASE-10777; add it to the card or write a new card for it",
          detail: "CASE-10777",
          line: 5,
        },
      ]);
    });

    test("no finding: a general card, a case in another clause, a case the card lists", async () => {
      expect(await missing("Run Q-5c on [[plans/cases|the cases page]] for CASE-10777.")).toEqual([]);
      expect(await missing("Run Q-5 on [[plans/cases|the cases page]]; CASE-10777 waits.")).toEqual([]);
      expect(await missing("Run Q-5 on [[plans/cases|the cases page]] for CASE-10002.")).toEqual([]);
    });

    test("a card that names one case may hold an example row: no finding", async () => {
      const example = '<Query id="Q-8" question="One?">\n\n```sql\nSELECT * FROM t WHERE k = \'CASE-10001\';\n```\n\n</Query>';
      const pages = { "plans/a.mdx": STEP_PAGE("Run Q-8 on [[plans/cases|the cases page]] for CASE-10777."), "plans/cases.mdx": example };
      expect(await run(pages, near)).toEqual([]);
    });

    test("a longer key that starts with the step's key does not list it", async () => {
      const card = '<Query id="Q-8" question="Which?">\n\n```sql\nSELECT * FROM t WHERE k IN (\'CASE-102345\', \'CASE-20000\');\n```\n\n</Query>';
      const pages = { "plans/a.mdx": STEP_PAGE("Run Q-8 on [[plans/cases|the cases page]] for CASE-10234."), "plans/cases.mdx": card };
      expect((await run(pages, near)).map((f) => [f.check, f.detail])).toEqual([["step-query-missing-case", "CASE-10234"]]);
    });

    test("the page's own card is read too", async () => {
      const page = `${CASES_PAGE}\n\n${STEP_PAGE("Run Q-5 for CASE-10777.")}`;
      const found = await run({ "a.mdx": page }, {});
      expect(found.map((f) => f.message)).toEqual([
        "a <NextMoves> step names Q-5 with CASE-10777, but the Q-5 card lists other cases and not CASE-10777; add it to the card or write a new card for it",
      ]);
    });

    test("two neighbours define the card: the one the step links to is read, and none when it links to neither", async () => {
      const general = '<Query id="Q-5" question="Any?">\n\n```sql\nSELECT 1;\n```\n\n</Query>';
      const pages = { ...step("Run Q-5 on [[plans/cases|the cases page]] for CASE-10777."), "plans/other.mdx": general };
      const both = { "plans/a.mdx": ["plans/cases.mdx", "plans/other.mdx"] };
      expect((await run(pages, both)).map((f) => f.check)).toEqual(["step-query-missing-case"]);
      const unlinked = { ...pages, "plans/a.mdx": STEP_PAGE("Run Q-5 for CASE-10777.") };
      expect((await run(unlinked, both)).map((f) => f.check)).toEqual(["cross-page-id-unlinked"]);
    });
  });
});

describe("lintWiki — checks 29 and 30 over an index", () => {
  let root: string;
  const write = (rel: string, content: string) => Bun.write(path.join(root, rel), content);
  const page = (fm: string[], body: string) => ["---", ...fm, "updated: 2026-06-01", "---", "", body, "", "## Sources", "- https://example.com/a"].join("\n");
  const xref = async (): Promise<LintFinding[]> => {
    const { findings } = await lintWiki(await buildWikiIndex(root), { now: () => Date.parse("2026-06-02T12:00:00Z") });
    return findings.filter((f) => f.check === "cross-page-id-unlinked" || f.check === "step-query-missing-case");
  };

  beforeEach(async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-lint-xref-"));
    await mkdir(path.join(root, "plans"), { recursive: true });
    await write("plans/cases.mdx", page(["title: Cases", "series: Year end"], CASES_PAGE.split("\n").slice(4).join("\n")));
  });

  test("a page of the same series is a neighbour without a link", async () => {
    await write("plans/status.mdx", page(["title: Status", "series: Year end"], "Run Q-5 on the cases page."));
    await write("plans/elsewhere.mdx", page(["title: Elsewhere"], "Run Q-5 on the cases page."));
    const found = await xref();
    expect(found.map((f) => [f.relPath, f.detail])).toEqual([["plans/status.mdx", "prose"]]);
    expect(found[0]!.message).toContain('Write "Q-5 on [[plans/cases|…]]"');
  });

  test("a linked page is a neighbour, and its card is read for the step's case", async () => {
    await write(
      "plans/todo.mdx",
      page(["title: Todo"], `See [[plans/cases]].\n\n${STEP_PAGE("Run Q-5 on [[plans/cases|the cases page]] for CASE-10777, as D3 says.")}`),
    );
    expect((await xref()).map((f) => [f.check, f.detail])).toEqual([
      ["cross-page-id-unlinked", "step"],
      ["step-query-missing-case", "CASE-10777"],
    ]);
  });

  test("log.md and index.md are linted for none", async () => {
    await write("log.md", "## [2026-06-01] note | x\n- Run Q-5 on the cases page, see [[plans/cases]].\n");
    await write("index.md", "- [[plans/cases]] — Q-5 on the cases page\n");
    expect(await xref()).toEqual([]);
  });
});

describe("xrefRunsBeforeConnector — every run a connector follows", () => {
  const runs = (text: string, projects: string[] = []) =>
    xrefRunsBeforeConnector(text, projects).map((r) => ({ ids: r.ids.map((i) => i.id), connector: r.connector, after: text.slice(r.end) }));

  test("each run with its connector and where the text after it starts", () => {
    expect(runs("Kjør Q-5 på vaktsaksiden, og T-7 i 8371.")).toEqual([
      { ids: ["Q-5"], connector: "på", after: "vaktsaksiden, og T-7 i 8371." },
      { ids: ["T-7"], connector: "i", after: "8371." },
    ]);
    expect(runs("D3, D4 og Q-16 på [[plans/x|siden]]")).toEqual([{ ids: ["D3", "D4", "Q-16"], connector: "på", after: "[[plans/x|siden]]" }]);
  });

  test("the connector may stand on the next line", () => {
    expect(runs("Se Q-5c\npå\n[[x]]")).toEqual([{ ids: ["Q-5c"], connector: "på", after: "[[x]]" }]);
  });

  test("no connector, a word or a tracker key gives no run", () => {
    expect(runs("Q-5 med fødselsnummer på vaktsaksiden")).toEqual([]);
    expect(runs("omtalt i planen")).toEqual([]);
    expect(runs("MELOSYS-8308 på siden", ["MELOSYS"])).toEqual([]);
    expect(runs("MELOSYS-8308 og D4 på siden", ["MELOSYS"])).toEqual([{ ids: ["D4"], connector: "på", after: "siden" }]);
  });

  test("a column of ids with no connector answers at once", () => {
    const t = performance.now();
    expect(xrefRunsBeforeConnector(Array.from({ length: 200 }, (_, k) => `A${k}`).join("\n"))).toEqual([]);
    expect(performance.now() - t).toBeLessThan(500);
  });

  test("20,000 ids with no connector are read in linear time, as a row and as a page", () => {
    const row = Array.from({ length: 20_000 }, (_, k) => `A${k}`).join(", ");
    const t = performance.now();
    expect(xrefRunsBeforeConnector(row)).toEqual([]);
    expect(scan(row).mentions).toEqual([]);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  test("the offsets point at the ids in the given text", () => {
    const text = "x D3, Q-16c i y";
    for (const r of xrefRunsBeforeConnector(text)[0]!.ids) expect(text.slice(r.start, r.end)).toBe(r.id);
  });
});
