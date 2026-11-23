import { describe, expect, test } from "bun:test";
import path from "node:path";
import { checkGenre, firstScreen } from "./lint-genre.ts";
import { checkPageText, LINT_CHECKS, PAGE_TEXT_LINT_CHECKS, type LintFinding } from "./lint.ts";
import { parseFrontmatter, readCull, readFollowups, readPlanStatus, stripFrontmatter } from "./store.ts";
import type { LoadedPageFiles } from "./lint-components.ts";
import { pageDecisionData, prStripHtml } from "../format/decision-views.ts";
import { parseBlocks } from "../format/markdown-ast.ts";

// Invented pages only, except the marked copy of the plan page (A33/A34).
// Test names carry the P2 state table's row ids (A1…A89; Table B retired with chart-candidate).

const lint = (relPath: string, content: string, files?: LoadedPageFiles): LintFinding[] => {
  const fm = parseFrontmatter(content);
  return checkGenre(
    { relPath, plan_status: readPlanStatus(fm), followups: readFollowups(fm), culled: readCull(fm.signal, fm["signal-reason"]).culled === true },
    content,
    files,
  );
};
const doc = (fm: readonly string[], ...body: (readonly string[])[]) => ["---", "title: T", ...fm, "---", "", ...body.flat(), ""].join("\n");
const of = (fs: LintFinding[], check: LintFinding["check"]) => fs.filter((f) => f.check === check);
const missing = (fs: LintFinding[]) => of(fs, "genre-missing").map((f) => f.detail);
const picture = (fs: LintFinding[]) => of(fs, "genre-picture").length > 0;

const H1 = ["# Page", ""];
const TLDR = ["<Tldr>", "", "Short.", "", "</Tldr>", ""];
const wrap = (open: string, close: string, ...inner: string[][]) => [open, "", ...inner.flat(), "", close, ""];
const FOLD = (...inner: string[][]) => wrap('<Fold title="More">', "</Fold>", ...inner);
const CALLOUT = (...inner: string[][]) => wrap('<Callout tone="info" title="c">', "</Callout>", ...inner);
const RANGE_ROWS = ["| Slice | Interval |", "|---|---|", "| P1 | $40–80 |", "| P2 | $50–90 |"];
const RANGE = wrap('<Chart kind="range" value="Interval">', "</Chart>", RANGE_ROWS);
const RANGE_BAD = wrap('<Chart kind="range" value="Interval">', "</Chart>", ["| Slice | Interval |", "|---|---|", "| P1 | $80–40 |", "| P2 | $50–90 |"]);
const COST = ["| Slice | Interval | Basis |", "|---|---|---|", "| P1 | $120–220 | x |", "| P2 | $100–180 | y |", "| P3 | $40–60 | z |", "| **Slate** | **$220–400** | |", ""];
const METER = ['<Meter value="2" max="4">Progress</Meter>', ""];
const STATUS = wrap("<StatusRows>", "</StatusRows>", ["- **Status:** in flight."]);
const NEXT = wrap("<NextMoves>", "</NextMoves>", wrap('<Lane kind="you">', "</Lane>", ["1. Run it."]));
const ledger = (n: number, state = true) => [
  "**PR ledger.**",
  "",
  state ? "| PR | What | State |" : "| PR | What | Review |",
  "|---|---|---|",
  ...Array.from({ length: n }, (_, i) => `| ${i + 1} — part ${i + 1} | x | ${state ? (i === 0 ? "merged" : "open") : "—"} |`),
  "",
];
const glance = (n: number, first = "PR") => ["### At a glance", "", `| ${first} | What |`, "|---|---|", ...Array.from({ length: n }, (_, i) => `| ${i + 1} — part | x |`), ""];
const SLATE = ledger(2);
const QUERY = wrap('<Query id="Q-1" question="How many?">', "</Query>", ["Some reading."]);
const CASEBOARD = ['<CaseBoard src="cases.yaml" />', ""];
const DELTA = wrap("<DeltaTable>", "</DeltaTable>", ["| Metric | Before | After |", "|---|---|---|", "| pages | 10 | 12 |", "| links | 4 | 5 |"]);
const RUNCHECK = wrap("<RunChecklist>", "</RunChecklist>", ["- [ ] Run the job."]);
const FUNNEL = wrap('<Chart kind="funnel">', "</Chart>", ["| Step | Count | Of |", "|---|---|---|", "| all | 10 | |", "| kept | 6 | 10 |"]);
const BARS = wrap('<Chart kind="bars" value="Pages">', "</Chart>", ["| Outcome | Pages |", "|---|---|", "| ok | 5 |", "| failed | 2 |", "| skipped | 1 |"]);
const steps = (x: string) => wrap(`<Chart kind="steps" x="${x}">`, "</Chart>", [`| ${x} | Findings |`, "|---|---|", "| 1 | 9 |", "| 2 | 5 |", "| 3 | 2 |"]);
const MERMAID = ["```mermaid", "flowchart LR", "  A --> B", "```", ""];
const DIAGRAM = ['<Diagram src="./x.architecture.json" />', ""];
const RULETREE = wrap('<RuleTree title="Rule">', "</RuleTree>", ["- *Yes:* → Renew", "- *No:* → Return"]);
const systemMap = (status: string) => wrap("<SystemMap>", "</SystemMap>", ["| From | To | Status | Evidence |", "|---|---|---|---|", `| web | api | ${status} | the call fails |`]);
const caseFiles = (n: number): LoadedPageFiles =>
  new Map([["cases.yaml", { ok: true, text: Array.from({ length: n }, (_, i) => `- id: C-${i + 1}\n  status: hold`).join("\n") }]]);
const DOTS = ['<CaseBoard src="cases.yaml" view="dots" />', ""];

const live = (...fm: string[]) => ["plan_status: in-flight", ...fm];

describe("check 26 scope (Table A)", () => {
  test("A1: a .md page is out of scope", () => {
    expect(lint("plans/x.md", doc(["plan_status: proposed"], QUERY))).toEqual([]);
  });

  test.each(["blogs/x.mdx", "projects/x.mdx"])("A2: %s is out of scope", (rel) => {
    expect(lint(rel, doc(["plan_status: proposed", "genre: campaign"], QUERY))).toEqual([]);
  });

  test.each(["plans/index.mdx", "archive/log.mdx", "plans/CLAUDE.mdx"])("A3: reserved page %s is out of scope", (rel) => {
    expect(lint(rel, doc([], QUERY))).toEqual([]);
  });

  test("A4: a culled page is out of scope", () => {
    expect(lint("plans/x.mdx", doc(["plan_status: proposed", "signal: none", "signal-reason: retired"], SLATE))).toEqual([]);
  });

  test("A5: a plans/ page with no plan_status key is live: genre-missing, suggesting none", () => {
    const fs = lint("plans/sub/x.mdx", doc([], ["Text.", ""]));
    expect(missing(fs)).toEqual(["none"]);
    expect(picture(fs)).toBe(false);
  });

  test("A6: an invalid plan_status is not live (the key is present)", () => {
    expect(lint("plans/x.mdx", doc(["plan_status: bogus"], ["Text.", ""]))).toEqual([]);
  });

  test("A7: an archive page with no plan_status is not picture scope, follow-ups open or not", () => {
    expect(lint("archive/x.mdx", doc(["followups: open"], QUERY))).toEqual([]);
  });

  test("A8: shipped with follow-ups open is picture scope", () => {
    expect(missing(lint("archive/x.mdx", doc(["plan_status: shipped", "followups: open"], SLATE)))).toEqual(["campaign"]);
  });

  test.each([
    ["followups: none", ["followups: none"]],
    ["no followups key", []],
  ])("A9: shipped with %s is not picture scope", (_n, fu) => {
    expect(lint("plans/x.mdx", doc(["plan_status: shipped", ...fu], SLATE))).toEqual([]);
  });

  test("A10: followups: Open is not open (the store's exact-case value, D13)", () => {
    expect(lint("plans/x.mdx", doc(["plan_status: shipped", "followups: Open"], SLATE))).toEqual([]);
  });

  test("A11: an archive page with a live status is picture scope", () => {
    expect(missing(lint("archive/x.mdx", doc(["plan_status: in-flight"], SLATE)))).toEqual(["campaign"]);
  });
});

describe("genre: values (Table A)", () => {
  test("A12: genre: none is present and gets no picture check", () => {
    expect(lint("plans/x.mdx", doc(["plan_status: proposed", "genre: none"], QUERY))).toEqual([]);
  });

  test.each([["genre:"], ['genre: ""']])("A13: %s counts as missing (D10)", (line) => {
    const fs = lint("plans/x.mdx", doc(["plan_status: proposed", line]));
    expect(missing(fs)).toEqual(["none"]);
    expect(picture(fs)).toBe(false);
  });

  test.each(["postmortem", "Campaign", "[campaign]"])("A14: genre: %s is not a genre slug (D10)", (v) => {
    const fs = lint("plans/x.mdx", doc(["plan_status: proposed", `genre: ${v}`]));
    expect(missing(fs)).toEqual([]);
    expect(of(fs, "genre-picture").map((f) => f.message)).toEqual([expect.stringContaining("is not a genre slug")]);
  });

  test("A15: the key wins over the blocks", () => {
    const fs = lint("plans/x.mdx", doc(["plan_status: proposed", "genre: campaign"], H1, RANGE, RUNCHECK));
    expect(fs).toEqual([]);
  });
});

describe("genre suggestion: the four ordered rules (Table A)", () => {
  const archiveOpen = (...fm: string[]) => ["plan_status: shipped", "followups: open", ...fm];
  const cases: [string, string, string[], string[][], string][] = [
    ["A16", "archive/x.mdx", archiveOpen("tags: [postmortem]"), [RUNCHECK, SLATE], "bug"],
    ["A17", "archive/x.mdx", archiveOpen("tags: [handover, postmortem]"), [], "bug"],
    ["A18", "archive/x.mdx", archiveOpen("tags: [handover]"), [DELTA, SLATE], "none"],
    ["A19", "archive/x.mdx", archiveOpen("tags: [Audit]"), [], "audit"],
    ["A20", "archive/x.mdx", archiveOpen("tags: [plan]"), [FOLD(DELTA)], "campaign"],
    ["A21", "archive/x.mdx", archiveOpen("tags: [review]"), [QUERY], "investigation"],
    ["A22", "plans/x.mdx", live("tags: [postmortem]"), [SLATE], "campaign"],
    ["A23", "plans/x.mdx", live(), [RUNCHECK, DELTA, SLATE], "runbook"],
    ["A24", "plans/x.mdx", live(), [FOLD(CALLOUT(DELTA))], "run-report"],
    ["A25", "plans/x.mdx", live(), [DELTA, SLATE], "campaign"],
    ["A26 (Query)", "plans/x.mdx", live(), [QUERY, SLATE], "investigation"],
    ["A26 (CaseBoard)", "plans/x.mdx", live(), [CASEBOARD, SLATE], "investigation"],
    ["A27", "plans/x.mdx", live(), [DELTA, QUERY], "run-report"],
    ["A28", "plans/x.mdx", live(), [DELTA, QUERY, SLATE], "investigation"],
    ["A29", "plans/x.mdx", live(), [ledger(1)], "none"],
    ["A30", "plans/x.mdx", ["plan_status: proposed"], [["### P1 — first", "", "x", "", "### P2 — second", "", "y", ""]], "campaign"],
    ["A31", "plans/x.mdx", ["plan_status: proposed"], [["```", '<Query id="Q-1">', "```", ""]], "none"],
  ];
  test.each(cases)("%s: %s suggests the right genre", (_id, rel, fm, body, want) => {
    expect(missing(lint(rel, doc(fm, ...body)))).toEqual([want]);
  });
});

describe("genre-picture: campaign (Table A)", () => {
  const ps = (s: string) => [`plan_status: ${s}`, "genre: campaign"];

  test("A32: a drawable range chart on the first screen", () => {
    expect(lint("plans/x.mdx", doc(ps("proposed"), H1, RANGE, glance(4)))).toEqual([]);
  });

  const FIXTURE = path.join(import.meta.dir, "__fixtures__/genre-plan-copy.mdx");
  test("A33: the plan page's copy, proposed: fires without the range chart (D2), though its ledger draws a strip", async () => {
    const text = await Bun.file(FIXTURE).text();
    const data = pageDecisionData(parseBlocks(stripFrontmatter(text)), { proposed: true });
    expect(prStripHtml(data.ledgers, "en", data.analysis)).not.toBe("");
    expect(picture(lint("plans/muninn-mdx-genre-pictures.mdx", text))).toBe(true);
  });

  test("A34: the same copy with the slice costs as a range chart in the brief is silent", async () => {
    const text = (await Bun.file(FIXTURE).text()).replace(
      "**How.**",
      ['<Chart kind="range" value="Interval">', "", "| Slice | Interval |", "|---|---|", "| P1 — chart kinds | $120–220 |", "| P2 — lint | $100–180 |", "| P3 — skill rule | $30–70 |", "| P4 — sweep | $80–200 |", "| **Slate** | **$330–670** |", "", "</Chart>", "", "**How.**"].join("\n"),
    );
    expect(of(lint("plans/muninn-mdx-genre-pictures.mdx", text), "genre-picture")).toEqual([]);
  });

  test("A35: a Meter counts on a page with no cost table", () => {
    expect(picture(lint("plans/x.mdx", doc(ps("proposed"), H1, METER)))).toBe(false);
  });

  test("A36: the glance strip counts under the reader's own conditions", () => {
    expect(picture(lint("plans/x.mdx", doc(ps("proposed"), H1, STATUS, glance(4))))).toBe(false);
  });

  test("A37: a glance of 3 PRs draws no strip", () => {
    expect(picture(lint("plans/x.mdx", doc(ps("proposed"), H1, STATUS, glance(3))))).toBe(true);
  });

  test("A38: a glance whose first header is not PR is not read", () => {
    expect(picture(lint("plans/x.mdx", doc(ps("proposed"), H1, STATUS, glance(4, "Slice"))))).toBe(true);
  });

  test("A39: StatusRows only inside a Fold gives no view slot", () => {
    expect(picture(lint("plans/x.mdx", doc(ps("proposed"), H1, glance(4), FOLD(STATUS))))).toBe(true);
  });

  test("A40: on a ready page the glance strip is not drawn", () => {
    expect(picture(lint("plans/x.mdx", doc(ps("ready"), H1, STATUS, glance(4))))).toBe(true);
  });

  test("A41: on a ready page a labelled ledger's strip counts (D3)", () => {
    expect(picture(lint("plans/x.mdx", doc(ps("ready"), H1, STATUS, ledger(4))))).toBe(false);
  });

  test("A42: in flight, a drawing ledger strip with a top-level StatusRows", () => {
    expect(picture(lint("plans/x.mdx", doc(ps("in-flight"), H1, STATUS, ledger(4))))).toBe(false);
  });

  test("A43: blocked, 3 PRs but 3 chains: the chain view counts", () => {
    const log = wrap("<DecisionLog>", "</DecisionLog>", [
      "- **O1** — Which store? Closed 2026-10-01 (D1).",
      "- **O2** — Which shape? Closed 2026-10-02 (D2).",
      "- **O3** — Which key? Closed 2026-10-03 (D3).",
      "- **D1** — Use the flat file.",
      "- **D2** — Rows per item.",
      "- **D3** — One row per group.",
    ]);
    const led = ["**PR ledger.**", "", "| PR | State | Decisions |", "|---|---|---|", "| 1 — store | merged | D1 |", "| 2 — rows | open | D2 |", "| 3 — groups | open | D3 |", ""];
    expect(picture(lint("plans/x.mdx", doc(ps("blocked"), H1, NEXT, log, led)))).toBe(false);
  });

  test("A44: a ledger with no State column draws nothing", () => {
    expect(picture(lint("plans/x.mdx", doc(ps("in-flight"), H1, STATUS, ledger(4, false))))).toBe(true);
  });

  test("A45: the view slot below the first Fold does not count (D4)", () => {
    expect(picture(lint("plans/x.mdx", doc(ps("in-flight"), H1, ledger(4), FOLD(["x"]), NEXT)))).toBe(true);
  });

  test("A46: an archive page with no plan_status takes the Meter", () => {
    expect(lint("archive/x.mdx", doc(["genre: campaign"], H1, METER))).toEqual([]);
  });

  test.each(["superseded", "abandoned"])("A47: %s uses the shipped branch (D9)", (s) => {
    expect(picture(lint("plans/x.mdx", doc(ps(s), H1, ["Text.", ""])))).toBe(true);
  });

  test("A48: a range chart only below the first Fold", () => {
    expect(picture(lint("plans/x.mdx", doc(ps("proposed"), H1, FOLD(RANGE))))).toBe(true);
  });

  test("A49: a range chart inside a Callout on the first screen", () => {
    expect(picture(lint("plans/x.mdx", doc(ps("proposed"), H1, CALLOUT(RANGE))))).toBe(false);
  });

  test.each([
    ["Fold", CALLOUT(FOLD(RANGE))],
    ["More", CALLOUT(wrap("<More>", "</More>", RANGE))],
  ])("A50: a range chart in a nested %s is collapsed (D7)", (_n, body) => {
    expect(picture(lint("plans/x.mdx", doc(ps("proposed"), H1, body)))).toBe(true);
  });

  test("A51: a range chart that does not draw (low > high) does not count (D8)", () => {
    expect(picture(lint("plans/x.mdx", doc(ps("proposed"), H1, RANGE_BAD)))).toBe(true);
  });

  test.each([
    ["proposed", false],
    ["ready", false],
    ["in-flight", false],
    ["blocked", false],
    ["shipped", true],
  ])("A87: a bars chart counts as a %s campaign's picture where a Meter does (plan D13)", (s, fires) => {
    expect(picture(lint("plans/x.mdx", doc([`plan_status: ${s}`, "genre: campaign"], H1, BARS)))).toBe(fires);
  });
  test.each(["superseded", "abandoned"])("A87: a %s campaign takes a bars chart as it takes a Meter (plan D13)", (s) => {
    expect(picture(lint("plans/x.mdx", doc([`plan_status: ${s}`, "genre: campaign"], H1, BARS)))).toBe(false);
  });
  test("A87: an archive page with no plan_status takes a bars chart as it takes a Meter (plan D13)", () => {
    expect(picture(lint("archive/x.mdx", doc(["genre: campaign"], H1, BARS)))).toBe(false);
  });
  test("A87: past ready, a bars chart counts beside a parsing cost table, as a Meter does (plan D13)", () => {
    const cost = ["| Slice | Interval |", "|---|---|", "| P1 | $40–80 |", "| P2 | $10–20 |", ""];
    expect(picture(lint("plans/x.mdx", doc(["plan_status: in-flight", "genre: campaign"], H1, BARS, cost)))).toBe(false);
  });
  test.each([
    ["investigation", "in-flight"],
    ["campaign", "proposed"],
    ["campaign", "in-flight"],
  ])("A88: a bars chart that does not draw is no picture on a %s, %s (plan D13)", (genre, s) => {
    const mixed = wrap('<Chart kind="bars" value="Time">', "</Chart>", ["| Step | Time |", "|---|---|", "| a | 82 s |", "| b | 20 min |"]);
    expect(picture(lint("plans/x.mdx", doc([`plan_status: ${s}`, `genre: ${genre}`], H1, mixed)))).toBe(true);
  });
  test.each([
    ["investigation", "in-flight", true],
    ["campaign", "in-flight", true],
    ["campaign", "shipped", false],
  ])("A89: the %s %s message names a bars chart only where one counts (plan D13)", (genre, s, named) => {
    const found = lint("plans/x.mdx", doc([`plan_status: ${s}`, `genre: ${genre}`], H1)).find((f) => f.check === "genre-picture");
    expect(found?.message.includes('<Chart kind="bars">')).toBe(named);
  });
  test("A87: a parsing cost table still needs the range chart beside a bars chart (the cost-table gate)", () => {
    const cost = ["| Slice | Interval |", "|---|---|", "| P1 | $40–80 |", "| P2 | $10–20 |", ""];
    expect(picture(lint("plans/x.mdx", doc(["plan_status: proposed", "genre: campaign"], H1, BARS, cost)))).toBe(true);
  });
  test("A52: an extra funnel chart is never the campaign's picture (D25)", () => {
    expect(picture(lint("plans/x.mdx", doc(ps("proposed"), H1, FUNNEL)))).toBe(true);
  });
});

describe("genre-picture: the other genres (Table A)", () => {
  const g = (genre: string, ps = "in-flight") => [`plan_status: ${ps}`, `genre: ${genre}`];

  test.each([
    ["5 cases", 5, false],
    ["4 cases", 4, true],
  ])("A53: CaseBoard dots with %s", (_n, n, fires) => {
    expect(picture(lint("plans/x.mdx", doc(g("investigation"), H1, DOTS), caseFiles(n)))).toBe(fires);
  });
  test("A53: CaseBoard dots with an unreadable src stays silent (D23)", () => {
    expect(picture(lint("plans/x.mdx", doc(g("investigation"), H1, DOTS), new Map([["cases.yaml", { ok: false, reason: "unavailable" }]])))).toBe(false);
  });

  test.each([
    ["funnel", FUNNEL],
    ["RuleTree", RULETREE],
    ["bars chart (plan D13)", BARS],
  ])("A54: investigation accepts a %s", (_n, body) => {
    expect(picture(lint("plans/x.mdx", doc(g("investigation"), H1, body)))).toBe(false);
  });

  test.each([
    ["DeltaTable", [DELTA, RUNCHECK], false],
    ["bars chart", [BARS, RUNCHECK], false],
    ["only the RunChecklist", [RUNCHECK], true],
  ] as const)("A55: runbook with %s", (_n, body, fires) => {
    expect(picture(lint("plans/x.mdx", doc(g("runbook"), H1, ...body)))).toBe(fires);
  });

  test.each([
    ["bars chart", [BARS], false],
    ["DeltaTable", [DELTA], false],
    ["plain Delta table", [["| Metric | Before | After |", "|---|---|---|", "| pages | 10 | 12 |", ""]], true],
  ] as const)("A56: run-report with a %s", (_n, body, fires) => {
    expect(picture(lint("plans/x.mdx", doc(g("run-report"), H1, ...body)))).toBe(fires);
  });

  test.each([
    ["a SystemMap with a wrong row", systemMap("wrong"), false],
    ["a SystemMap with ok rows only", systemMap("ok"), true],
    ["a mermaid fence", MERMAID, false],
  ] as const)("A57: bug with %s", (_n, body, fires) => {
    expect(picture(lint("archive/x.mdx", doc(["plan_status: shipped", "genre: bug", "tags: [postmortem]"], H1, body)))).toBe(fires);
  });

  test.each([
    ["mermaid", MERMAID, false],
    ["Diagram", DIAGRAM, false],
    ["RuleTree", RULETREE, false],
    ["only a table", ["| A | B |", "|---|---|", "| x | y |", ""], true],
  ] as const)("A58: design with %s", (_n, body, fires) => {
    expect(picture(lint("plans/x.mdx", doc(g("design"), H1, body)))).toBe(fires);
  });

  test.each([
    ["Round", false],
    ["Date", true],
  ] as const)('A59: audit with <Chart kind="steps" x="%s"> (D24)', (x, fires) => {
    expect(picture(lint("archive/x.mdx", doc(["plan_status: shipped", "genre: audit"], H1, steps(x))))).toBe(fires);
  });
});

describe("the first screen (Table A)", () => {
  const ps = ["plan_status: proposed", "genre: campaign"];

  test("A60: with no Tldr the window runs from the H1; with no H1 either, from the first block", () => {
    expect(picture(lint("plans/x.mdx", doc(ps, H1, RANGE)))).toBe(false);
    expect(picture(lint("plans/x.mdx", doc(ps, RANGE)))).toBe(false);
    expect(picture(lint("plans/x.mdx", doc(ps, H1, TLDR, RANGE)))).toBe(false);
  });

  test("A61: with no top-level Fold the window runs to the end of the page (D6)", () => {
    const body = [H1, TLDR, ...Array.from({ length: 20 }, () => ["Prose.", ""]), RANGE];
    expect(firstScreen(parseBlocks(body.flat().join("\n"))).foldAt).toBe(-1);
    expect(picture(lint("plans/x.mdx", doc(ps, ...body)))).toBe(false);
  });

  test.each([
    ["inside the <Tldr>", [H1, wrap("<Tldr>", "</Tldr>", RANGE)]],
    ["inside the box's <More>", [H1, wrap("<Tldr>", "</Tldr>", ["Short.", ""], wrap("<More>", "</More>", RANGE))]],
    ["inside a <Tldr> that is not the first block", [H1, ["Prose.", ""], wrap("<Tldr>", "</Tldr>", RANGE)]],
  ])("A62: a range chart %s never counts", (_n, body) => {
    expect(picture(lint("plans/x.mdx", doc(ps, ...body)))).toBe(true);
  });
});

describe("wiring", () => {
  test("the two checks are in LINT_CHECKS and PAGE_TEXT_LINT_CHECKS, and checkPageText runs them", () => {
    for (const c of ["genre-missing", "genre-picture"] as const) {
      expect(LINT_CHECKS).toContain(c);
      expect(PAGE_TEXT_LINT_CHECKS).toContain(c);
    }
    const fs = checkPageText({ relPath: "plans/x.mdx", plan_status: "in-flight" }, doc(["plan_status: in-flight"], H1, SLATE), []);
    expect(fs.filter((f) => f.check.startsWith("genre")).map((f) => [f.check, f.severity, f.detail])).toEqual([["genre-missing", "info", "campaign"]]);
  });
});

describe("fix round 1: trailing comments, an empty genre: key, lettered slate headings (Table A, §8)", () => {
  const PROP = ["plan_status: proposed"];

  test("A63: genre: none with a trailing comment is none", () => {
    expect(lint("plans/x.mdx", doc([...PROP, "genre: none # no picture"], QUERY))).toEqual([]);
  });

  test("A64: genre: campaign with a trailing comment is campaign, so the accept list runs", () => {
    const fm = [...PROP, "genre: campaign  # picture: range"];
    expect(lint("plans/x.mdx", doc(fm, H1, RANGE))).toEqual([]);
    expect(of(lint("plans/x.mdx", doc(fm, H1, ["Text.", ""])), "genre-picture").map((f) => f.detail)).toEqual(["campaign"]);
  });

  test("A65: a quoted genre with a trailing comment", () => {
    expect(lint("plans/x.mdx", doc([...PROP, 'genre: "design" # drawn below'], H1, MERMAID))).toEqual([]);
  });

  test("A66: an archive tag list with a trailing comment reads its tags", () => {
    expect(missing(lint("archive/x.mdx", doc(["plan_status: shipped", "followups: open", "tags: [postmortem]  # x"], SLATE)))).toEqual(["bug"]);
  });

  test.each([["genre:"], ['genre: ""'], ["genre: # later"]])("A67: %s says the key is empty, not absent", (line) => {
    const fs = of(lint("plans/x.mdx", doc([...PROP, line])), "genre-missing");
    expect(fs.map((f) => f.detail)).toEqual(["none"]);
    expect(fs[0]!.message).toStartWith("The genre: key is empty.");
  });
  test("A67: an absent key says No genre: key", () => {
    expect(of(lint("plans/x.mdx", doc(PROP)), "genre-missing")[0]!.message).toStartWith("No genre: key.");
  });

  const heads = (...hs: string[]) => hs.flatMap((h) => [h, "", "x", ""]);
  test.each([
    ["A68", heads("## PR A — first", "## PR B — second"), "campaign"],
    ["A68 (colon, en dash, level 4)", heads("#### PR A: first", "#### PR B – second"), "campaign"],
    ["A69", heads("### PR A — first", "### PR A — again"), "none"],
    ["A70", heads("##### PR A — first", "##### PR B — second"), "none"],
    ["A71", heads("## PR A — first", "## PR 1 — second"), "campaign"],
    ["A72", heads("## PR Approach — first", "## PR Budget — second"), "none"],
    ["A73", heads("## PRA — first", "## PRB — second"), "none"],
    ["A74", heads("## PR a — first", "## PR b — second"), "none"],
    ["A75", heads("## P A — first", "## P B — second"), "none"],
  ])("%s: lettered slate headings", (_id, body, want) => {
    expect(missing(lint("plans/x.mdx", doc(PROP, body)))).toEqual([want]);
  });
});

describe("fix round 2: quoted genre values, the cost-table bar, tags, the empty-key anchor, multi-letter ids (Table A, §8)", () => {
  const PROP = ["plan_status: proposed"];

  test.each([
    ['genre: "none # x"', "none # x"],
    ['genre: "#campaign"', "#campaign"],
    [`genre: "'campaign'"`, "'campaign'"],
  ])("A76: %s is a quoted string, unquoted once and keeping its #, not a slug", (line, raw) => {
    const fs = lint("plans/x.mdx", doc([...PROP, line], QUERY));
    expect(missing(fs)).toEqual([]);
    expect(of(fs, "genre-picture").map((f) => f.message)).toEqual([expect.stringContaining(`genre: "${raw}" is not a genre slug`)]);
  });
  test("A76: a single-quoted genre with a trailing comment is the slug", () => {
    expect(lint("plans/x.mdx", doc([...PROP, "genre: 'design'  # drawn below"], H1, MERMAID))).toEqual([]);
  });

  test.each([
    ["the last genre: line wins", ["genre: none", 'genre: "none # x"']],
    ["an empty genre: line after it is skipped", ['genre: "none # x"', "genre:"]],
  ])("A86: %s, read as written", (_n, lines) => {
    expect(of(lint("plans/x.mdx", doc([...PROP, ...lines], QUERY)), "genre-picture").map((f) => f.detail)).toEqual(["invalid"]);
  });
  test("A86: a CRLF page reads the quoted value as written", () => {
    expect(of(lint("plans/x.mdx", doc([...PROP, 'genre: "none # x"'], QUERY).replaceAll("\n", "\r\n")), "genre-picture").map((f) => f.detail)).toEqual(["invalid"]);
  });

  // D2 through the output: a Meter on the first screen counts only when no table parses as a cost table (D14: one `a–b` interval, any row count, totals counted).
  const cost = (...rows: string[]) => doc([...PROP, "genre: campaign"], H1, METER, FOLD(rows));
  test.each([
    ["A77", "an interval only in the bold total row", cost("| Slice | Cost |", "|---|---|", "| P1 | $40 |", "| P2 | $50 |", "| **Slate** | **$90–120** |"), true],
    ["A78", "one interval among points", cost("| Slice | Cost |", "|---|---|", "| P1 | $40–80 |", "| P2 | $50 |", "| P3 | $60 |"), true],
    ["A79", "spaced-hyphen intervals", cost("| Slice | Cost |", "|---|---|", "| P1 | $40 - 80 |", "| P2 | $50 - 90 |", "| P3 | $60 - 70 |"), true],
    ["A80", "points only", cost("| Slice | Cost |", "|---|---|", "| P1 | $40 |", "| P2 | $50 |", "| P3 | $60 |"), false],
    ["A81", "two interval rows", cost("| Slice | Cost |", "|---|---|", "| P1 | $40–80 |", "| P2 | $50–90 |"), true],
    ["A82", "the interval column second", cost("| Slice | Basis | Cost |", "|---|---|---|", "| P1 | first | $40–80 |", "| P2 | second | $50–90 |", "| P3 | third | $60–70 |"), true],
  ] as const)("%s: a Meter on the first screen, a table in a Fold with %s", (_id, _n, content, fires) => {
    expect(of(lint("plans/x.mdx", content), "genre-picture").map((f) => f.detail)).toEqual(fires ? ["campaign"] : []);
  });

  test("A83: an archive inline tag list with a quoted tag and a trailing comment reads each tag", () => {
    expect(missing(lint("archive/x.mdx", doc(["plan_status: shipped", "followups: open", "tags: ['postmortem', bug]  # x"], SLATE)))).toEqual(["bug"]);
  });

  test.each([["subgenre: campaign"], ["# genre: later"]])("A84: a page with %s and no genre: key says No genre: key", (line) => {
    const fs = of(lint("plans/x.mdx", doc([...PROP, line])), "genre-missing");
    expect(fs.map((f) => f.detail)).toEqual(["none"]);
    expect(fs[0]!.message).toStartWith("No genre: key.");
  });

  test("A85: two capital letters after PR are no slate id", () => {
    expect(missing(lint("plans/x.mdx", doc(PROP, ["## PR AB — first", "", "x", "", "## PR CD — second", "", "y", ""])))).toEqual(["none"]);
  });
});

describe("plan D7: a full Meter is no picture, and a shipped campaign may show its system", () => {
  const ps = (s: string) => [`plan_status: ${s}`, "genre: campaign"];
  const meter = (attrs: string) => [`<Meter ${attrs}>PRs landed</Meter>`, ""];
  const fires = (s: string, ...body: string[][]) => picture(lint("plans/x.mdx", doc(ps(s), H1, ...body)));

  test.each(["proposed", "ready", "in-flight", "blocked", "shipped", "superseded", "abandoned"])("a full Meter on %s is refused", (s) => {
    expect(fires(s, meter('value="2" max="2"'))).toBe(true);
  });

  test.each([
    ["over max, which the reader clamps to full", 'value="3" max="2"', true],
    ["the default max of 5, full", 'value="5"', true],
    ["the default max of 5, partial", 'value="3"', false],
    ["partial", 'value="1" max="2"', false],
    ["zero", 'value="0" max="2"', false],
    ["no value, which the reader draws as its label", 'max="2"', false],
  ] as const)("a Meter with %s", (_name, attrs, expected) => {
    expect(fires("in-flight", meter(attrs))).toBe(expected);
  });

  test("a partial Meter beside a full one counts, in either order", () => {
    expect(fires("in-flight", meter('value="2" max="2"'), meter('value="1" max="2"'))).toBe(false);
    expect(fires("in-flight", meter('value="1" max="2"'), meter('value="2" max="2"'))).toBe(false);
  });

  test("a full Meter inside a Callout is refused like one at the top level", () => {
    expect(fires("shipped", CALLOUT(meter('value="2" max="2"')))).toBe(true);
  });

  test("a mermaid fence is accepted on shipped", () => {
    expect(fires("shipped", MERMAID)).toBe(false);
  });

  test("a mermaid fence beside a full Meter on shipped passes on the fence", () => {
    expect(fires("shipped", meter('value="2" max="2"'), MERMAID)).toBe(false);
  });

  test.each(["proposed", "ready", "in-flight", "blocked", "superseded", "abandoned"])("a mermaid fence alone on %s is no picture", (s) => {
    expect(fires(s, MERMAID)).toBe(true);
  });

  test("a mermaid fence in a Fold on shipped is off the first screen", () => {
    expect(fires("shipped", FOLD(MERMAID))).toBe(true);
  });

  test("a <Diagram> on shipped is not accepted: only the fence is", () => {
    expect(fires("shipped", DIAGRAM)).toBe(true);
  });

  test("the range chart and the strip still count beside a full Meter", () => {
    expect(fires("in-flight", meter('value="2" max="2"'), RANGE)).toBe(false);
    expect(fires("shipped", meter('value="2" max="2"'), STATUS, ledger(4))).toBe(false);
  });

  test("the message offers the fence on a shipped page only", () => {
    const message = (s: string) => of(lint("plans/x.mdx", doc(ps(s), H1, meter('value="2" max="2"'))), "genre-picture")[0]!.message;
    expect(message("shipped")).toContain("a mermaid fence of how the system works");
    expect(message("shipped")).not.toContain("<Meter>");
    expect(message("shipped")).toContain('<Chart kind="range">');
    expect(message("shipped")).toContain("a PR strip or chain view");
    for (const s of ["in-flight", "blocked", "superseded"]) {
      expect(message(s)).toContain("a <Meter> that is not full");
      expect(message(s)).not.toContain("mermaid");
    }
  });

  test("plan O9: a partial Meter is no picture on shipped, and still is on every other status", () => {
    expect(fires("shipped", meter('value="1" max="2"'))).toBe(true);
    for (const s of ["proposed", "ready", "in-flight", "blocked", "superseded", "abandoned"]) {
      expect(fires(s, meter('value="1" max="2"'))).toBe(false);
    }
  });

  test("plan O9: what else passes on shipped still passes beside a partial Meter", () => {
    expect(fires("shipped", meter('value="1" max="2"'), MERMAID)).toBe(false);
    expect(fires("shipped", meter('value="1" max="2"'), RANGE)).toBe(false);
    expect(fires("shipped", meter('value="1" max="2"'), STATUS, ledger(4))).toBe(false);
  });

  test("plan O9: a chain view passes on shipped beside a partial Meter", () => {
    const log = wrap("<DecisionLog>", "</DecisionLog>", [
      "- **O1** — Which store? Closed 2026-10-01 (D1).",
      "- **O2** — Which shape? Closed 2026-10-02 (D2).",
      "- **O3** — Which key? Closed 2026-10-03 (D3).",
      "- **D1** — Use the flat file.",
      "- **D2** — Rows per item.",
      "- **D3** — One row per group.",
    ]);
    const led = ["**PR ledger.**", "", "| PR | State | Decisions |", "|---|---|---|", "| 1 — store | merged | D1 |", "| 2 — rows | merged | D2 |", "| 3 — groups | merged | D3 |", ""];
    expect(fires("shipped", NEXT, meter('value="1" max="2"'), log, led)).toBe(false);
  });

  test("the shipped message is a campaign's: a shipped bug keeps its own list", () => {
    const [f] = of(lint("plans/x.mdx", doc(["plan_status: shipped", "genre: bug"], H1)), "genre-picture");
    expect(f!.message).toContain("<SystemMap>");
    expect(f!.message).not.toContain("<Chart");
  });

  test("an archive page with no plan_status takes no fence, and its message offers none", () => {
    const [f] = of(lint("archive/x.mdx", doc(["genre: campaign"], H1, MERMAID)), "genre-picture");
    expect(f!.detail).toBe("campaign");
    expect(f!.message).not.toContain("mermaid");
  });
});

describe("chart-candidate dropped (§8)", () => {
  test("checkPageText reports no chart-candidate on a page that used to produce one", () => {
    expect(LINT_CHECKS as readonly string[]).not.toContain("chart-candidate");
    expect(PAGE_TEXT_LINT_CHECKS as readonly string[]).not.toContain("chart-candidate");
    const content = doc(["plan_status: in-flight"], H1, ["| Outcome | Pages |", "|---|---|", "| ok | 5 |", "| failed | 2 |", "| skipped | 1 |", ""], FOLD(COST));
    const fs = checkPageText({ relPath: "plans/x.mdx", plan_status: "in-flight" }, content, []);
    expect(fs.map((f) => f.check as string)).not.toContain("chart-candidate");
    expect(fs.filter((f) => f.check.startsWith("genre")).map((f) => [f.check, f.detail])).toEqual([["genre-missing", "none"]]);
  });
});
