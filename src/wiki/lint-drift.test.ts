import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WikiPageMeta } from "./store.ts";
import { buildWikiIndex } from "./store.ts";
import { lintWiki, LINT_CHECKS, type LintFinding } from "./lint.ts";
import {
  CASE_ROWS_MIN,
  DRAFT_LANE_MAX_DAYS,
  DRIFT_LINT_CHECKS,
  LONG_PAGE_LINES,
  LOOSE_SQL_MIN,
  checkDrift,
  driftContext,
  isCaseRow,
  isLiveReportPage,
  isReadQueryFence,
  isReportPage,
  pageLineCount,
  type DriftContext,
} from "./lint-drift.ts";

const TODAY = "2026-10-01";
const CTX: DriftContext = { today: TODAY };

/** A page as the index would hand it; only the fields the checks read. */
function page(relPath: string, extra: Partial<WikiPageMeta> = {}): WikiPageMeta {
  return { relPath, name: path.posix.basename(relPath).replace(/\.mdx?$/, ""), title: relPath, type: "plan", ...extra } as WikiPageMeta;
}

function run(relPath: string, content: string, extra: Partial<WikiPageMeta> = {}, ctx: DriftContext = CTX): LintFinding[] {
  return checkDrift(page(relPath, extra), content, ctx);
}

function only(findings: LintFinding[], check: string): LintFinding[] {
  return findings.filter((f) => f.check === check);
}

const sql = (body: string) => ["```sql", body, "```", ""].join("\n");

describe("isReportPage — the scope rule", () => {
  const rows: [string, Record<string, unknown>, boolean][] = [
    ["plans/x.mdx", {}, true],
    ["plans/sub/x.md", {}, true],
    ["archive/muninn/x.md", {}, true],
    ["projects/x.md", { plan_status: "shipped" }, true],
    ["projects/x.md", { plan_status: "not-a-status" }, true], // present is enough
    ["projects/x.md", {}, false],
    ["blogs/x.mdx", {}, false],
    ["myplans/x.md", {}, false],
    ["concepts/archive/x.md", {}, false],
  ];
  for (const [rel, fm, want] of rows) {
    test(`${rel} ${JSON.stringify(fm)} → ${want}`, () => expect(isReportPage(rel, fm)).toBe(want));
  }

  test("a page outside the scope gets no drift finding at all", () => {
    const body = ["---", "title: x", "---", sql("SELECT 1"), sql("SELECT 2")].join("\n");
    expect(run("projects/x.md", body)).toEqual([]);
    expect(only(run("plans/x.md", body), "loose-sql")).toHaveLength(1);
  });
});

describe("isLiveReportPage — the drift scope, one rule for all four checks", () => {
  // [relPath, raw frontmatter, validated plan_status, in scope]
  const rows: [string, Record<string, unknown>, string | undefined, boolean][] = [
    ["plans/x.mdx", {}, undefined, true], // no plan_status, under plans/
    ["plans/sub/x.md", {}, undefined, true],
    ["plans/x.md", { plan_status: "proposed" }, "proposed", true],
    ["plans/x.md", { plan_status: "ready" }, "ready", true],
    ["plans/x.md", { plan_status: "in-flight" }, "in-flight", true],
    ["plans/x.md", { plan_status: "blocked" }, "blocked", true],
    ["archive/x.md", { plan_status: "in-flight" }, "in-flight", true], // a live status anywhere
    ["projects/x.md", { plan_status: "blocked" }, "blocked", true],
    ["plans/x.md", { plan_status: "shipped" }, "shipped", false], // settled
    ["plans/x.md", { plan_status: "superseded" }, "superseded", false],
    ["plans/x.md", { plan_status: "abandoned" }, "abandoned", false],
    ["plans/x.md", { plan_status: "bogus" }, undefined, false], // present but not live
    ["archive/x.md", {}, undefined, false], // archived
    ["archive/muninn/x.mdx", {}, undefined, false],
    ["projects/x.md", { plan_status: "shipped" }, "shipped", false],
    ["projects/x.md", {}, undefined, false], // not a report page
    ["myplans/x.md", {}, undefined, false],
  ];
  for (const [rel, fm, status, want] of rows) {
    test(`${rel} ${JSON.stringify(fm)} → ${want}`, () => expect(isLiveReportPage(rel, fm, status)).toBe(want));
  }

  // The same page body trips all five checks; only the scope differs.
  const everything = (() => {
    const lane = ["<NextMoves>", "", '<Lane kind="draft" since="2026-01-01">', "", "- [ ] send it", "", "</Lane>", "", "</NextMoves>", ""].join("\n");
    const cases = ["| Sak | Status |", "|---|---|", ...[1, 2, 3, 4, 5].map((n) => `| MEL-${n} | ferdig |`), ""].join("\n");
    const filler = Array.from({ length: 700 }, (_, i) => `line ${i}`).join("\n");
    return (fm: string) => `---\ntitle: t\n${fm}---\n\n${lane}\n${sql("SELECT 1")}${sql("SELECT 2")}\n${cases}\n${filler}\n`;
  })();
  const checksOf = (f: LintFinding[]): string[] => [...new Set(f.map((x) => x.check as string))].sort();

  test("a live page gets every structural check; an archived or settled one gets none", () => {
    const all = ["case-table", "draft-lane-stale", "long-page-no-fold", "loose-sql"];
    expect(checksOf(run("plans/a.mdx", everything("")))).toEqual(all);
    expect(checksOf(run("archive/a.mdx", everything("plan_status: in-flight\n"), { plan_status: "in-flight" }))).toEqual(all);
    expect(run("archive/a.mdx", everything(""))).toEqual([]);
    expect(run("plans/a.mdx", everything("plan_status: shipped\n"), { plan_status: "shipped" })).toEqual([]);
    expect(run("archive/a.mdx", everything("plan_status: superseded\n"), { plan_status: "superseded" })).toEqual([]);
  });
});

describe("check 1 — draft-lane-stale", () => {
  const lanes = (kind: string, since: string, wrap = (s: string) => s) =>
    ["---", "title: t", "---", "", "# T", "", wrap(["<NextMoves>", "", `<Lane kind="${kind}" since="${since}">`, "", "- **Send it.**", "", "</Lane>", "", "</NextMoves>"].join("\n"))].join("\n");

  test(`exactly ${DRAFT_LANE_MAX_DAYS} days old is not reported; one more day is`, () => {
    expect(only(run("plans/a.mdx", lanes("draft", "2026-09-29")), "draft-lane-stale")).toEqual([]);
    const f = only(run("plans/a.mdx", lanes("draft", "2026-09-28")), "draft-lane-stale");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain("since 2026-09-28 (3 days)");
    expect(f[0]!.line).toBe(9);
  });

  test("the kode-wiki DD.MM.YYYY form is read", () => {
    expect(only(run("plans/a.mdx", lanes("draft", "14.09.2026")), "draft-lane-stale")).toHaveLength(1);
  });

  test("other lane kinds, a missing or unparseable since, and a future since are not reported", () => {
    for (const kind of ["you", "waiting", "blocked", "bogus"]) {
      expect(only(run("plans/a.mdx", lanes(kind, "2026-01-01")), "draft-lane-stale")).toEqual([]);
    }
    expect(only(run("plans/a.mdx", lanes("draft", "soon")), "draft-lane-stale")).toEqual([]);
    expect(only(run("plans/a.mdx", lanes("draft", "2026-12-01")), "draft-lane-stale")).toEqual([]);
  });

  test("a lane inside <Historic> or a resolved <Callout> is history, not a finding", () => {
    const hist = (s: string) => `<Historic since="2026-09-01">\n\n${s}\n\n</Historic>`;
    const resolved = (s: string) => `<Callout tone="info" resolved="2026-09-20">\n\n${s}\n\n</Callout>`;
    const open = (s: string) => `<Fold title="Moves">\n\n${s}\n\n</Fold>`;
    expect(only(run("plans/a.mdx", lanes("draft", "2026-01-01", hist)), "draft-lane-stale")).toEqual([]);
    expect(only(run("plans/a.mdx", lanes("draft", "2026-01-01", resolved)), "draft-lane-stale")).toEqual([]);
    expect(only(run("plans/a.mdx", lanes("draft", "2026-01-01", open)), "draft-lane-stale")).toHaveLength(1);
  });

  test("a lane quoted inside a code fence is not a lane", () => {
    const quoted = (s: string) => "```mdx\n" + s + "\n```";
    expect(only(run("plans/a.mdx", lanes("draft", "2026-01-01", quoted)), "draft-lane-stale")).toEqual([]);
  });

  test("only a lane that COUNTS: directly inside an unsettled <NextMoves>, with an open item", () => {
    const fm = "---\ntitle: t\n---\n\n";
    const lane = (items: string) => `<Lane kind="draft" since="2026-01-01">\n\n${items}\n\n</Lane>`;
    const nm = (s: string) => `<NextMoves>\n\n${s}\n\n</NextMoves>`;
    const fold = (s: string) => `<Fold title="older">\n\n${s}\n\n</Fold>`;
    const stale = (body: string) => only(run("plans/a.mdx", fm + body), "draft-lane-stale").length;
    // [what, body, findings]
    const rows: [string, string, number][] = [
      ["open item", nm(lane("- [ ] send it")), 1],
      ["plain item", nm(lane("- send it")), 1],
      ["one open, one done", nm(lane("- [x] drafted\n- [ ] send it")), 1],
      ["stray lane, no <NextMoves>", lane("- [ ] send it"), 0],
      ["lane in a <Fold> under <NextMoves>", nm(fold(lane("- [ ] send it"))), 0],
      ["every item done", nm(lane("- [x] drafted\n- [X] sent")), 0],
      ["no items at all", nm(lane("Prose only.")), 0],
    ];
    for (const [what, body, want] of rows) expect([what, stale(body)]).toEqual([what, want]);
  });

  describe("the line is exact or absent, never another line", () => {
    // The real stale lane; `decoy` sits above it. Returns [finding count, line,
    // the real opener's line].
    const probe = (decoy: string): [number, number | undefined, number] => {
      const head = ["---", "title: t", "---", "", ...decoy.split("\n"), ""];
      const real = head.length + 3; // after "<NextMoves>" and a blank line
      const body = [...head, "<NextMoves>", "", '<Lane kind="draft" since="2026-09-01">', "", "- [ ] send it", "", "</Lane>", "", "</NextMoves>", ""].join("\n");
      const f = only(run("plans/a.mdx", body), "draft-lane-stale");
      return [f.length, f[0]?.line, real];
    };
    // [decoy, the decoy line, exact | absent]. "absent" where the decoy looks
    // like a lane opener to a line scan but the parser read it as text, so the
    // scan's candidates no longer map one-to-one onto the parser's lanes.
    const decoys: [string, string, "exact" | "absent"][] = [
      ["a prose line opening with <Lane>", "<Lane> blocks are how this page tracks moves.", "exact"],
      ["a 4-space indented line", '    <Lane kind="draft" since="2026-01-01">', "absent"],
      ["a self-closing <Lane />", '<Lane kind="draft" since="2026-01-01" />', "exact"],
      ["two lanes on one line", '<Lane kind="you">a</Lane><Lane kind="draft" since="2026-01-01">b</Lane>', "exact"],
      ["a <Lane> in a list item", '- item one\n  <Lane kind="draft" since="2026-01-01">\n- item two', "absent"],
      // an unclosed opener with the real lane's own attributes: only the count can tell
      ["an unclosed twin of the real lane", '<Lane kind="draft" since="2026-09-01">', "absent"],
    ];
    for (const [what, decoy, want] of decoys) {
      test(`${what} → ${want}`, () => {
        const [n, line, real] = probe(decoy);
        expect(n).toBe(1);
        expect(line).toBe(want === "exact" ? real : undefined);
      });
    }

    // A lane the parser builds with no opener line of its own cancels out a later
    // unclosed decoy in the count; only the attributes tell the two apart.
    const fm = ["---", "title: t", "---", ""];
    const realLane = ['<Lane kind="draft" since="2026-09-01">', "", "- [ ] send it", "", "</Lane>"];
    const strayThenDecoy = (strayAttrs: string, decoy: string) => [
      ...fm, `<Fold><Lane ${strayAttrs}>- a</Lane></Fold>`, "", "<NextMoves>", "", ...realLane, "", "</NextMoves>", "", decoy, "",
    ];
    const attrRows: [string, string[]][] = [
      ["a one-line <NextMoves> lane, then an unclosed decoy", [
        ...fm, '<NextMoves><Lane kind="draft" since="2026-01-01">- send it</Lane></NextMoves>', "", '<Lane kind="you">', "",
      ]],
      ["a one-line stray lane in a <Fold>, the real lane, then an unclosed decoy", strayThenDecoy('kind="you" since="2026-01-01"', '<Lane kind="you">')],
      // the stray lane differs from the real one in a single attribute; the decoy is the real lane's twin
      ["… the stray lane differs only in who", strayThenDecoy('kind="draft" who="Ola" since="2026-09-01"', realLane[0]!)],
      ["… the stray lane differs only in since", strayThenDecoy('kind="draft" since="2026-01-01"', realLane[0]!)],
    ];
    for (const [what, lines] of attrRows) {
      test(`${what} → absent`, () => {
        const f = only(run("plans/a.mdx", lines.join("\n")), "draft-lane-stale");
        expect(f).toHaveLength(1);
        expect(f[0]!.line).toBeUndefined();
      });
    }
  });

  test("the line names the stale lane's own opener, past a quoted lane and an earlier lane", () => {
    const body = [
      "---", "title: t", "---", // 1-3
      "```mdx", '<Lane kind="draft" since="2026-01-01">', "```", // 4-6
      "<NextMoves>", // 7
      '<Lane kind="you">', "", "- a", "", "</Lane>", // 8-12
      '<Lane kind="draft" since="2026-09-01">', "", "- b", "", "</Lane>", // 13-17
      "</NextMoves>",
    ].join("\n");
    const f = only(run("plans/a.mdx", body), "draft-lane-stale");
    expect(f.map((x) => x.line)).toEqual([13]);
  });
});

describe("check 3 — loose-sql", () => {
  const rows: [string, boolean][] = [
    ["SELECT 1", true],
    ["select count(*) from x", true],
    ["WITH a AS (SELECT 1) SELECT * FROM a", true],
    ["-- a comment\n\nSELECT 1", true],
    ["SET search_path TO x;\nSELECT 1", true],
    ["CREATE TABLE x (a int)", false],
    ["ALTER TABLE x ADD b int", false],
    ["INSERT INTO x VALUES (1)", false],
    ["UPDATE x SET a = 1", false],
    ["DELETE FROM x", false],
    ["EXPLAIN PLAN FOR SELECT 1", false],
    ["AND br.type = 'X'", false],
    ["selected_rows", false],
    ["", false],
  ];
  for (const [code, want] of rows) {
    test(`isReadQueryFence(${JSON.stringify(code)}) → ${want}`, () => expect(isReadQueryFence(code)).toBe(want));
  }

  const fm = "---\ntitle: t\n---\n";
  test(`${LOOSE_SQL_MIN} read queries are reported; one is not`, () => {
    expect(only(run("plans/a.md", fm + sql("SELECT 1")), "loose-sql")).toEqual([]);
    const f = only(run("plans/a.md", fm + sql("SELECT 1") + sql("SELECT 2")), "loose-sql");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toStartWith("2 SQL queries outside a <Query>");
  });

  test("a fence inside a <Query> at any depth does not count; one in a list item does", () => {
    const inQuery = `<Query id="q1" question="How many?" answer="3">\n\n${sql("SELECT 1")}\n</Query>\n`;
    const deep = `<Fold title="Queries">\n\n<Query id="q2" question="x">\n\n${sql("SELECT 2")}\n</Query>\n\n</Fold>\n`;
    expect(only(run("plans/a.md", fm + inQuery + deep + sql("SELECT 3")), "loose-sql")).toEqual([]);
    const listed = "1. Run this:\n\n   ```sql\n   SELECT 4\n   ```\n";
    expect(only(run("plans/a.md", fm + listed + sql("SELECT 5")), "loose-sql")).toHaveLength(1);
  });

  test("DDL/DML, other languages and a sql fence quoted inside another fence do not count", () => {
    const quoted = "````markdown\n" + sql("SELECT 9") + "````\n";
    const body = fm + sql("CREATE TABLE x (a int)") + sql("DELETE FROM x") + "```postgresql\nSELECT 1\n```\n" + quoted + sql("SELECT 1");
    expect(only(run("plans/a.md", body), "loose-sql")).toEqual([]);
  });

  test("only a LIVE report page: plans/ with no plan_status, or a live plan_status anywhere", () => {
    const body = fm + sql("SELECT 1") + sql("SELECT 2");
    expect(only(run("archive/a.md", body), "loose-sql")).toEqual([]);
    expect(only(run("archive/a.md", body, { plan_status: "shipped" }), "loose-sql")).toEqual([]);
    expect(only(run("archive/a.md", body, { plan_status: "in-flight" }), "loose-sql")).toHaveLength(1);
    expect(only(run("plans/a.md", body, { plan_status: "shipped" }), "loose-sql")).toEqual([]);
  });
});

describe("check 4 — case-table", () => {
  // [row, is a case row]. A case row: the first cell opens with a case id (a
  // wikilink's TARGET or its alias), and some later cell is a STATUS CELL — its
  // leading clause is a status phrase, alone or followed by a date or a
  // preposition-led tail.
  const caseRows: [string[], boolean][] = [
    // accepted
    [["MEL-436385", "1658", "Kandidat siden 03.07"], true],
    [["MEL-1", "Kandidat siden 03.07, på 2024-lista"], true],
    [["[MELOSYS-8306](https://x/browse/MELOSYS-8306) — A1", "Venter på møte"], true],
    [["**MEL-483333**", "ok"], true],
    [["`MEL-1`", "Holdt ute, wait"], true],
    [["[[plans/x|MEL-2]]", "done"], true], // the alias
    [["[[MEL-123|the bug]]", "done"], true], // the target
    [["MEL-1, MEL-2", "Blokkert"], true],
    [["MEL-1", "**Holdt ute av lista til S4.** Mer tekst her"], true],
    [["MEL-1", "**Blokkert til oppgave 3 er i prod.** Mer"], true],
    [["MEL-1", "Ny kandidat 29.09. Holdt ute"], true],
    [["MEL-1", "Ikke kandidat («uten treff»). Mer"], true],
    [["MEL-1", "Ikke i rapporten. Grunnlaget er vedtaket"], true],
    [["MEL-1", "Datafikset 07.09 (rad 1)"], true],
    [["MEL-1", "Hoppet over, har en annen"], true],
    [["MELOSYS-1", "I prod"], true],
    [["MEL-1", "✅ done"], true],
    [["MEL-1", "Done ✅"], true],
    [["MEL-1", "ferdig."], true],
    [["MEL-1", "Pending (waiting for review)"], true],
    [["MEL-1", "2024", "Fikset 2026-09-01"], true],
    // rejected
    [["UTF-8", "hold the line"], false],
    [["SHA-256", "ok so far"], false],
    [["MEL-1", "looks ok to me but untested"], false],
    [["MEL-1", "Ingen vedtak i Melosys; ikke kandidat"], false], // the status is not the cell's lead
    [["MEL-1", "kandidater"], false],
    [["MEL-1", "Kandidat 18.09 etter 8173"], false], // a date tail must be the whole tail
    [["MEL-1", "okai etter x"], false], // a phrase is a whole word
    [["MEL-436385", "1658", "2024"], false], // no status cell
    [["MEL-436385", "Okay then"], false],
    [["Sak MEL-1", "ok"], false], // the id must open the cell
    [["[[plans/x|the bug]]", "done"], false], // neither target nor alias is an id
    [["M-1", "ok"], false], // one capital is not a project
    [["mel-1", "ok"], false],
    [["MEL-12x", "ok"], false],
    [["MEL-1", "ja"], false], // a yes/no answer is not a status
    [["MEL-1 ok"], false], // the status must be in a later cell
  ];
  for (const [row, want] of caseRows) {
    test(`isCaseRow(${JSON.stringify(row)}) → ${want}`, () => expect(isCaseRow(row)).toBe(want));
  }

  const table = (n: number, status = "ferdig") =>
    ["| Sak | Status |", "|---|---|", ...Array.from({ length: n }, (_, i) => `| MEL-${i + 1} | ${status} |`), ""].join("\n");
  const fm = "---\ntitle: t\n---\n";

  test(`${CASE_ROWS_MIN} case rows are reported; ${CASE_ROWS_MIN - 1} are not; rows add up across tables`, () => {
    expect(only(run("plans/a.md", fm + table(CASE_ROWS_MIN - 1)), "case-table")).toEqual([]);
    const f = only(run("plans/a.md", fm + table(CASE_ROWS_MIN)), "case-table");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain("MEL-1, MEL-2, MEL-3");
    expect(only(run("plans/a.md", fm + table(3) + "\ntext\n\n" + table(2)), "case-table")).toHaveLength(1);
  });

  test("a <CaseBoard> anywhere on the page silences it", () => {
    expect(only(run("plans/a.md", fm + table(9) + '\n<CaseBoard src="cases.yaml" />\n'), "case-table")).toEqual([]);
    expect(only(run("plans/a.md", fm + table(9) + '\n<Fold title="x">\n\n<CaseBoard src="cases.yaml" />\n\n</Fold>\n'), "case-table")).toEqual([]);
  });

  test("a CaseBoard or a table quoted in a code fence does not count", () => {
    expect(only(run("plans/a.md", fm + table(9) + '\n```mdx\n<CaseBoard src="cases.yaml" />\n```\n'), "case-table")).toHaveLength(1);
    expect(only(run("plans/a.md", fm + "```md\n" + table(9) + "```\n"), "case-table")).toEqual([]);
  });

  test("a table of ids with no status word is not a case table", () => {
    expect(only(run("plans/a.md", fm + table(9, "1658")), "case-table")).toEqual([]);
  });
});

describe("check 5 — long-page-no-fold (info)", () => {
  const lines = (n: number, extra = "") => {
    const head = ["---", "title: t", "---", extra];
    return [...head, ...Array.from({ length: n - head.length }, (_, i) => `line ${i}`)].join("\n");
  };

  test(`${LONG_PAGE_LINES} lines is not reported; ${LONG_PAGE_LINES + 1} is, at info severity`, () => {
    expect(only(run("plans/a.md", lines(LONG_PAGE_LINES)), "long-page-no-fold")).toEqual([]);
    const f = only(run("plans/a.md", lines(LONG_PAGE_LINES + 1)), "long-page-no-fold");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.message).toStartWith(`${LONG_PAGE_LINES + 1} lines`);
  });

  test("lines are counted like wc -l: a trailing newline adds no line", () => {
    const nl = (n: number) => lines(n) + "\n";
    expect(pageLineCount(nl(LONG_PAGE_LINES))).toBe(LONG_PAGE_LINES);
    expect(pageLineCount(lines(LONG_PAGE_LINES))).toBe(LONG_PAGE_LINES); // a last line with no newline still counts
    expect(pageLineCount("")).toBe(0);
    expect(only(run("plans/a.md", nl(LONG_PAGE_LINES)), "long-page-no-fold")).toEqual([]);
    const f = only(run("plans/a.md", nl(LONG_PAGE_LINES + 1)), "long-page-no-fold");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toStartWith(`${LONG_PAGE_LINES + 1} lines`);
  });

  test("a <Fold> silences it; one quoted in a code fence does not", () => {
    expect(only(run("plans/a.md", lines(700, '<Fold title="x">\n\nbody\n\n</Fold>')), "long-page-no-fold")).toEqual([]);
    expect(only(run("plans/a.md", lines(700, '```mdx\n<Fold title="x">\n</Fold>\n```')), "long-page-no-fold")).toHaveLength(1);
  });

  test("every other drift finding is a warning (no severity)", () => {
    const f = run("plans/a.md", "---\ntitle: t\n---\n" + sql("SELECT 1") + sql("SELECT 2"));
    expect(f.map((x) => x.severity)).toEqual([undefined]);
  });
});

describe("driftContext", () => {
  test("today is the Europe/Oslo day of now", () => {
    expect(driftContext(Date.parse("2026-09-30T22:30:00Z")).today).toBe("2026-10-01");
    expect(driftContext(Date.parse("2026-09-30T21:30:00Z")).today).toBe("2026-09-30");
  });
});

describe("lintWiki — drift checks over a real git repo", () => {
  let root: string;
  const NOW = Date.parse("2026-10-01T12:00:00Z");

  function git(args: string[], iso?: string): void {
    execFileSync("git", ["-C", root, ...args], {
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
        ...(iso ? { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } : {}),
      },
    });
  }
  const write = (rel: string, body: string) => Bun.write(path.join(root, rel), body);
  const commit = (iso: string) => {
    git(["add", "-A"]);
    git(["commit", "-q", "-m", `at ${iso}`], iso);
  };
  const plan = (status: string, date: string, body: string, extra = "") =>
    `---\ntitle: P\nplan_status: ${status}\nstatus_date: ${date}\n${extra}---\n\n${body}\n`;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-drift-git-"));
    await mkdir(path.join(root, "plans"), { recursive: true });
    git(["init", "-q"]);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function drift(): Promise<LintFinding[]> {
    const index = await buildWikiIndex(root);
    const { findings } = await lintWiki(index, { now: () => NOW });
    return findings.filter((f) => (DRIFT_LINT_CHECKS as readonly string[]).includes(f.check));
  }

  test("status-date-behind is gone: a body commit after status_date is not a finding", async () => {
    await write("plans/a.md", plan("in-flight", "2026-09-10", "First."));
    commit("2026-09-10T09:00:00Z");
    await write("plans/a.md", plan("in-flight", "2026-09-10", "First. Then more work."));
    commit("2026-09-15T09:00:00Z");
    expect(DRIFT_LINT_CHECKS as readonly string[]).not.toContain("status-date-behind");
    expect(LINT_CHECKS as readonly string[]).not.toContain("status-date-behind");
    expect(await drift()).toEqual([]);
  });

  test("a wiki that is not a git repo still lints: no throw, the checks run", async () => {
    await rm(path.join(root, ".git"), { recursive: true, force: true });
    await write("plans/a.md", plan("in-flight", "2026-09-10", sql("SELECT 1") + sql("SELECT 2")));
    const f = await drift();
    expect(f.map((x) => x.check)).toEqual(["loose-sql"]);
  });

  test("the four drift keys are in LINT_CHECKS, so counts always carry them", async () => {
    for (const c of DRIFT_LINT_CHECKS) expect(LINT_CHECKS).toContain(c);
    const index = await buildWikiIndex(root);
    const { counts } = await lintWiki(index, { now: () => NOW });
    for (const c of DRIFT_LINT_CHECKS) expect(counts[c]).toBe(0);
  });

  test("reserved and culled pages are not drift subjects", async () => {
    const body = "---\ntitle: t\n---\n" + sql("SELECT 1") + sql("SELECT 2");
    await write("plans/index.md", body);
    await write("plans/old.md", body.replace("title: t", "title: t\nsignal: none\nsignal-reason: retired"));
    await write("plans/live.md", body);
    expect((await drift()).map((x) => x.relPath)).toEqual(["plans/live.md"]);
  });
});
