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
  isReadQueryFence,
  isReportPage,
  type DriftContext,
} from "./lint-drift.ts";

const TODAY = "2026-10-01";
const CTX: DriftContext = { today: TODAY, hasPlanStaleCheck: false };

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

describe("check 2 — status-date-behind", () => {
  const body = ["---", "title: t", "plan_status: in-flight", "status_date: 2026-09-20", "---", "", "Body."].join("\n");
  const at = (iso: string) => Date.parse(iso);

  test("a content commit on a later day is reported, with the status_date line", () => {
    const f = only(run("plans/a.md", body, { plan_status: "in-flight", status_date: "2026-09-20", gitTouchedMs: at("2026-09-22T10:00:00Z") }), "status-date-behind");
    expect(f).toHaveLength(1);
    expect(f[0]!.line).toBe(4);
    expect(f[0]!.message).toContain("status_date 2026-09-20 is older than the last content commit (2026-09-22)");
  });

  test("a commit on the same day, or earlier, is not", () => {
    for (const iso of ["2026-09-20T21:00:00Z", "2026-09-19T08:00:00Z"]) {
      expect(only(run("plans/a.md", body, { plan_status: "in-flight", status_date: "2026-09-20", gitTouchedMs: at(iso) }), "status-date-behind")).toEqual([]);
    }
  });

  test("the commit's day is the Europe/Oslo day, not the UTC day", () => {
    // 22:30 UTC on the 20th is 00:30 on the 21st in Oslo (CEST, +2).
    const f = only(run("plans/a.md", body, { plan_status: "in-flight", status_date: "2026-09-20", gitTouchedMs: at("2026-09-20T22:30:00Z") }), "status-date-behind");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain("(2026-09-21)");
  });

  test("only a LIVE plan_status is checked", () => {
    const touched = at("2026-09-25T10:00:00Z");
    for (const s of ["proposed", "ready", "in-flight", "blocked"] as const) {
      expect(only(run("plans/a.md", body, { plan_status: s, status_date: "2026-09-20", gitTouchedMs: touched }), "status-date-behind")).toHaveLength(1);
    }
    for (const s of ["shipped", "superseded", "abandoned"] as const) {
      expect(only(run("plans/a.md", body, { plan_status: s, status_date: "2026-09-20", gitTouchedMs: touched }), "status-date-behind")).toEqual([]);
    }
    expect(only(run("plans/a.md", body, { status_date: "2026-09-20", gitTouchedMs: touched }), "status-date-behind")).toEqual([]);
  });

  test("no git date (non-git wiki, or every commit a sweep) or no status_date ⇒ no finding", () => {
    expect(only(run("plans/a.md", body, { plan_status: "in-flight", status_date: "2026-09-20" }), "status-date-behind")).toEqual([]);
    expect(only(run("plans/a.md", body, { plan_status: "in-flight", gitTouchedMs: at("2026-09-25T10:00:00Z") }), "status-date-behind")).toEqual([]);
  });

  test("on a wiki carrying mimir's check 10, its population (top-level plans/, in-flight or ready) is left to it", () => {
    const ctx = { ...CTX, hasPlanStaleCheck: true };
    const touched = at("2026-09-25T10:00:00Z");
    const f = (rel: string, s: "in-flight" | "ready" | "blocked" | "proposed") =>
      only(run(rel, body, { plan_status: s, status_date: "2026-09-20", gitTouchedMs: touched }, ctx), "status-date-behind");
    expect(f("plans/a.md", "in-flight")).toEqual([]);
    expect(f("plans/a.mdx", "ready")).toEqual([]);
    expect(f("plans/a.md", "blocked")).toHaveLength(1);
    expect(f("plans/a.md", "proposed")).toHaveLength(1);
    expect(f("plans/sub/a.md", "in-flight")).toHaveLength(1);
    expect(f("archive/a.md", "in-flight")).toHaveLength(1);
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

  test("only a LIVE report page: plans/, or a live plan_status elsewhere", () => {
    const body = fm + sql("SELECT 1") + sql("SELECT 2");
    expect(only(run("archive/a.md", body), "loose-sql")).toEqual([]);
    expect(only(run("archive/a.md", body, { plan_status: "shipped" }), "loose-sql")).toEqual([]);
    expect(only(run("archive/a.md", body, { plan_status: "in-flight" }), "loose-sql")).toHaveLength(1);
    expect(only(run("plans/a.md", body, { plan_status: "shipped" }), "loose-sql")).toHaveLength(1);
  });
});

describe("check 4 — case-table", () => {
  const caseRows: [string[], boolean][] = [
    [["MEL-436385", "1658", "Kandidat siden 03.07"], true],
    [["[MELOSYS-8306](https://x/browse/MELOSYS-8306) — A1", "Venter på møte"], true],
    [["**MEL-483333**", "ok"], true],
    [["`MEL-1`", "Holdt ute, wait"], true],
    [["[[plans/x|MEL-2]]", "done"], true],
    [["MEL-1, MEL-2", "Blokkert"], true],
    [["MEL-436385", "1658", "2024"], false], // no status word
    [["MEL-436385", "Okay then"], false], // `ok` must be a whole word
    [["Sak MEL-1", "ok"], false], // the id must open the cell
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
    expect(only(run("archive/a.md", fm + table(CASE_ROWS_MIN - 1)), "case-table")).toEqual([]);
    const f = only(run("archive/a.md", fm + table(CASE_ROWS_MIN)), "case-table");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain("MEL-1, MEL-2, MEL-3");
    expect(only(run("archive/a.md", fm + table(3) + "\ntext\n\n" + table(2)), "case-table")).toHaveLength(1);
  });

  test("a <CaseBoard> anywhere on the page silences it", () => {
    expect(only(run("archive/a.md", fm + table(9) + '\n<CaseBoard src="cases.yaml" />\n'), "case-table")).toEqual([]);
    expect(only(run("archive/a.md", fm + table(9) + '\n<Fold title="x">\n\n<CaseBoard src="cases.yaml" />\n\n</Fold>\n'), "case-table")).toEqual([]);
  });

  test("a CaseBoard or a table quoted in a code fence does not count", () => {
    expect(only(run("archive/a.md", fm + table(9) + '\n```mdx\n<CaseBoard src="cases.yaml" />\n```\n'), "case-table")).toHaveLength(1);
    expect(only(run("archive/a.md", fm + "```md\n" + table(9) + "```\n"), "case-table")).toEqual([]);
  });

  test("a table of ids with no status word is not a case table", () => {
    expect(only(run("archive/a.md", fm + table(9, "1658")), "case-table")).toEqual([]);
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
  test("today is the Europe/Oslo day of now", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-drift-ctx-"));
    try {
      expect((await driftContext(root, Date.parse("2026-09-30T22:30:00Z"))).today).toBe("2026-10-01");
      expect((await driftContext(root, Date.parse("2026-09-30T21:30:00Z"))).today).toBe("2026-09-30");
      expect((await driftContext(root, 0)).hasPlanStaleCheck).toBe(false);
      await Bun.write(path.join(root, "scripts", "plan-status-stale.ts"), "// check 10\n");
      expect((await driftContext(root, 0)).hasPlanStaleCheck).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  test("a later body commit is behind; a later metadata-only commit is not", async () => {
    await write("plans/body.md", plan("in-flight", "2026-09-10", "First."));
    await write("plans/meta.md", plan("in-flight", "2026-09-10", "First."));
    commit("2026-09-10T09:00:00Z");
    await write("plans/body.md", plan("in-flight", "2026-09-10", "First. Then more work."));
    await write("plans/meta.md", plan("in-flight", "2026-09-10", "First.", "series: s\npriority: p1\n"));
    commit("2026-09-15T09:00:00Z");

    const f = await drift();
    expect(f.map((x) => `${x.check} ${x.relPath}:${x.line}`)).toEqual(["status-date-behind plans/body.md:4"]);
    expect(f[0]!.message).toContain("(2026-09-15)");
  });

  test("a status_date bumped in the same commit as the work is not behind", async () => {
    await write("plans/a.md", plan("blocked", "2026-09-10", "First."));
    commit("2026-09-10T09:00:00Z");
    await write("plans/a.md", plan("blocked", "2026-09-15", "First. More."));
    commit("2026-09-15T09:00:00Z");
    expect(await drift()).toEqual([]);
  });

  test("a wiki carrying check 10 leaves an in-flight plans/ page to it", async () => {
    await write("plans/a.md", plan("in-flight", "2026-09-10", "First."));
    await write("plans/b.md", plan("blocked", "2026-09-10", "First."));
    await write("scripts/plan-status-stale.ts", "// mimir check 10\n");
    commit("2026-09-10T09:00:00Z");
    await write("plans/a.md", plan("in-flight", "2026-09-10", "More."));
    await write("plans/b.md", plan("blocked", "2026-09-10", "More."));
    commit("2026-09-12T09:00:00Z");
    expect((await drift()).map((x) => x.relPath)).toEqual(["plans/b.md"]);
  });

  test("a wiki that is not a git repo degrades: no status-date finding, no throw, other checks still run", async () => {
    await rm(path.join(root, ".git"), { recursive: true, force: true });
    await write("plans/a.md", plan("in-flight", "2026-09-10", sql("SELECT 1") + sql("SELECT 2")));
    const f = await drift();
    expect(f.map((x) => x.check)).toEqual(["loose-sql"]);
  });

  test("the five drift keys are in LINT_CHECKS, so counts always carry them", async () => {
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
