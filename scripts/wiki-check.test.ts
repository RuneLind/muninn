import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { noRootNote, runWikiCheck, wikiCheck, wikiRootFor, type WikiCheckResult } from "./wiki-check.ts";
import { buildWikiIndex } from "../src/wiki/store.ts";
import { lintWiki, PAGE_TEXT_LINT_CHECKS } from "../src/wiki/lint.ts";
import { testTempDir } from "../src/test/temp-dir.ts";

const SCRIPT = path.join(import.meta.dir, "wiki-check.ts");
const BAD = ["---", "title: X", "---", '<Callout tone="success">', "x", "</Callout>", ""].join("\n");
const CULLED = ["---", "title: R", "signal: none", "signal-reason: retired", "---", '<Callout tone="success">', "x", "</Callout>", ""].join("\n");
const LOOSE_CLOSE = [
  "---",
  "title: Q",
  "---",
  '<Question id="S1" choices="A|B">',
  "",
  "Which one?",
  "",
  "</Question>",
  "",
  "<DecisionLog>",
  "",
  "- **D1** \u2014 A.",
  "- **S1** \u2014 Which one? Lukket 17.10.2026 (S1).",
  "",
  "</DecisionLog>",
  "",
].join("\n");
const UNKNOWN_ROLE = ["---", "title: L", "---", "<NextMoves>", "", '<Lane kind="you" role="jurist">', "", "1. x", "", "</Lane>", "", "</NextMoves>", ""].join("\n");
const KNOWN_ROLE = ["---", "title: K", "---", "<NextMoves>", "", '<Lane kind="you" role="fag">', "", "1. x", "", "</Lane>", "", "</NextMoves>", ""].join("\n");
const LONG = "This decision sentence runs on and on well past the limit the overview lens shows, so the reader sees a cut-off clause instead of the decision it was meant to state in one line";
const REPORT_TOP = [
  "---",
  "title: T",
  "---",
  "<StatusRows>",
  "",
  `- **Status:** ${LONG}`,
  "",
  "</StatusRows>",
  "",
  '<CaseBoard src="saker.yaml" labels="bogus:Foo" />',
  "",
  "<DecisionLog>",
  "",
  `- **D1** \u2014 ${LONG}.`,
  "",
  "</DecisionLog>",
  "",
].join("\n");
const STATUS_TILES = [
  "---",
  "title: ST",
  "---",
  '<StatusRows view="tiles" tones="Nowhere:red">',
  "",
  "- **Build:** a first part far longer than any tile reads \u00b7 detail",
  "",
  "</StatusRows>",
  "",
].join("\n");
const DECISION_CHAIN = [
  "---",
  "title: DC",
  "---",
  "<DecisionLog>",
  "",
  "- **O1** \u2014 Which store? Closed 2026-10-01 (D1).",
  "- **D1** \u2014 Use the file.",
  "- **D2** \u2014 Use rows. Closes O1.",
  "",
  "</DecisionLog>",
  "",
  "**PR ledger.**",
  "",
  "| PR | State |",
  "|---|---|",
  "| 1 \u2014 store | merged |",
  "| 2 \u2014 rows | somewhere |",
  "",
].join("\n");
const CHART = [
  "---",
  "title: C",
  "plan_status: shipped",
  "---",
  '<Chart kind="funnel">',
  "",
  "| Step | Count | Of |",
  "|---|---|---|",
  "| All | 40 | |",
  "| Kept | many | 40 |",
  "",
  "</Chart>",
  "",
].join("\n");
/** A rule tree with one warning (an outcome with no tone) and one info finding
 *  (an `outcomes=` label that names no leaf). */
const RULE_TREE = [
  "---",
  "title: R",
  "plan_status: shipped",
  "---",
  '<RuleTree title="Can the book be renewed?" outcomes="Renew=good;Lapse=muted">',
  "",
  "- *Yes:* → Renew — LIB-1",
  "- *No:* → Return",
  "",
  "</RuleTree>",
  "",
].join("\n");
/** A glossary with one warning (a term twice). */
const GLOSSARY = [
  "---",
  "title: G",
  "plan_status: shipped",
  "---",
  "A Hold keeps the book on the shelf.",
  "",
  "<Glossary>",
  "",
  "- **Hold:** a book kept back for one reader",
  "- **Renewal:** a new loan period",
  "- **Hold:** said twice",
  "",
  "</Glossary>",
  "",
].join("\n");
const TEXT_SHAPES = [
  "---",
  "title: S",
  "---",
  "See [[broken link here",
  "",
  '[[<Fact n="4" v="ok">Page</Fact>]]',
  "",
  "| Drink | Effect |",
  "|---|---|",
  '| <Fact n="1" v="ok">Coffee | Lower risk</Fact> |',
  "",
].join("\n");
const CULLED_TEXT_SHAPES = TEXT_SHAPES.replace("title: S", "title: RS\nsignal: none\nsignal-reason: retired");
const ORDERED = LOOSE_CLOSE.replace("title: Q\n---\n", "title: O\n---\nSee [[dangling\n\n");
const TLDR_NO_MORE = ["---", "title: M", "plan_status: in-flight", "---", "# M", "", "<Tldr>", "", "Short.", "", "</Tldr>", "", "Body.", ""].join("\n");
const SHIPPED = ["---", "title: D", "plan_status: shipped", "---", "# D", "", "Body.", ""].join("\n");
const REFERENCE = ["---", "title: Ref", "---", "# Ref", "", "Body.", ""].join("\n");
const COMMENTED_STATUS = ["---", "title: CS", "plan_status: in-flight  # until the review lands", "---", "# CS", "", "Body.", ""].join("\n");
const UNKNOWN_ATTR = ["---", "title: A", "---", '<Callout tone="info" bogus="x">', "x", "</Callout>", ""].join("\n");
const CULLED_LOOSE_CLOSE = LOOSE_CLOSE.replace("title: Q", "title: Q\nsignal: none\nsignal-reason: retired");
const COMPILED = "<!-- generated from blogs/src/s.mdx -->\n<html></html>\n";

let tmp: string;
beforeAll(async () => {
  tmp = await testTempDir(path.join(tmpdir(), "wiki-check-"));
  // A wiki with a reader config, a page two folders down, and every place the store skips.
  await Bun.write(path.join(tmp, "wiki/.wiki-reader.json"), "{}");
  await Bun.write(path.join(tmp, "wiki/plans/deep/a.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/plans/b.md"), BAD);
  await Bun.write(path.join(tmp, "wiki/plans/r.mdx"), CULLED);
  await Bun.write(path.join(tmp, "wiki/plans/z.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/notes/z.md"), BAD);
  await Bun.write(path.join(tmp, "wiki/blogs/src/c.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/blogs/src/s.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/blogs/s.html"), COMPILED);
  await Bun.write(path.join(tmp, "wiki/blogs/src/u.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/blogs/u.html"), "<html>hand-written</html>\n");
  await Bun.write(path.join(tmp, "wiki/blogs/d.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/node_modules/x/e.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/.hidden/f.mdx"), BAD);
  // A wiki whose reader config scopes the scan.
  await Bun.write(path.join(tmp, "scoped/.wiki-reader.json"), JSON.stringify({ include: ["plans/**"] }));
  await Bun.write(path.join(tmp, "scoped/plans/in.mdx"), BAD);
  await Bun.write(path.join(tmp, "scoped/other/out.mdx"), BAD);
  // A folder with no reader config anywhere above it.
  await Bun.write(path.join(tmp, "loose/sub/g.mdx"), BAD);
  await Bun.write(path.join(tmp, "clean/h.mdx"), "no components here\n");
  await Bun.write(path.join(tmp, "empty/note.md"), BAD);
  await Bun.write(path.join(tmp, "locked/i.mdx"), BAD);
  await chmod(path.join(tmp, "locked/i.mdx"), 0o000);
  await Bun.write(path.join(tmp, "mixed/j.mdx"), BAD);
  await chmod(path.join(tmp, "mixed/j.mdx"), 0o000);
  await Bun.write(path.join(tmp, "mixed/k.mdx"), BAD);
  // A wiki whose pages break the checks lintWiki runs on a page's own text.
  await Bun.write(path.join(tmp, "page-checks/.wiki-reader.json"), JSON.stringify({ roleKeys: ["fag", "utvikler"] }));
  await Bun.write(path.join(tmp, "page-checks/plans/q.mdx"), LOOSE_CLOSE);
  await Bun.write(path.join(tmp, "page-checks/plans/l.mdx"), UNKNOWN_ROLE);
  await Bun.write(path.join(tmp, "page-checks/plans/c.mdx"), BAD);
  await Bun.write(path.join(tmp, "page-checks/plans/k.mdx"), KNOWN_ROLE);
  await Bun.write(path.join(tmp, "page-checks/plans/t.mdx"), REPORT_TOP);
  await Bun.write(path.join(tmp, "page-checks/plans/r.mdx"), CULLED_LOOSE_CLOSE);
  await Bun.write(path.join(tmp, "page-checks/plans/s.mdx"), TEXT_SHAPES);
  await Bun.write(path.join(tmp, "page-checks/plans/a.mdx"), UNKNOWN_ATTR);
  await Bun.write(path.join(tmp, "page-checks/plans/rs.mdx"), CULLED_TEXT_SHAPES);
  await Bun.write(path.join(tmp, "page-checks/plans/dc.mdx"), DECISION_CHAIN);
  await Bun.write(path.join(tmp, "page-checks/plans/ch.mdx"), CHART);
  await Bun.write(path.join(tmp, "page-checks/plans/rt.mdx"), RULE_TREE);
  await Bun.write(path.join(tmp, "page-checks/plans/gl.mdx"), GLOSSARY);
  await Bun.write(path.join(tmp, "page-checks/plans/st.mdx"), STATUS_TILES);
  await Bun.write(path.join(tmp, "page-checks/plans/o.mdx"), ORDERED);
  await Bun.write(path.join(tmp, "page-checks/plans/m.mdx"), TLDR_NO_MORE);
  await Bun.write(path.join(tmp, "page-checks/plans/d.mdx"), SHIPPED);
  await Bun.write(path.join(tmp, "page-checks/plans/index.mdx"), SHIPPED.replace("plan_status: shipped\n", ""));
  await Bun.write(path.join(tmp, "page-checks/concepts/ref.mdx"), REFERENCE);
  await Bun.write(path.join(tmp, "page-checks/archive/cs.mdx"), COMMENTED_STATUS);
  // A wiki with no reader config: wiki-check cannot know its root.
  await Bun.write(path.join(tmp, "noconf/plans/live.mdx"), REFERENCE);
  await Bun.write(path.join(tmp, "noconf/archive/projects/old.mdx"), REFERENCE);
  await Bun.write(path.join(tmp, "noconf/archive/projects/short.mdx"), TLDR_NO_MORE.replace("plan_status: in-flight\n", ""));
  await Bun.write(path.join(tmp, "noconf/notes/flight.mdx"), SHIPPED.replace("shipped", "in-flight"));
});
afterAll(async () => {
  for (const f of ["locked/i.mdx", "mixed/j.mdx"]) await chmod(path.join(tmp, f), 0o644).catch(() => {});
  await rm(tmp, { recursive: true, force: true });
});

// Root reads a 0o000 file, so the permission cases need an ordinary user.
const asRoot = process.getuid?.() === 0;

const spawn = (...args: string[]) => {
  const p = Bun.spawnSync([process.execPath, "--no-env-file", SCRIPT, ...args], { cwd: tmp, env: { PATH: process.env.PATH ?? "" } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const relPaths = async (target: string) => [...new Set((await runWikiCheck([target])).out.map((l) => (JSON.parse(l) as { relPath: string }).relPath))];

const PAGE_TEXT = new Set<string>(PAGE_TEXT_LINT_CHECKS);

describe("wiki-check walks the pages lintWiki checks", () => {
  test("a culled page, a page a same-stem .md shadows, and a compiled source are skipped", async () => {
    expect(await relPaths(path.join(tmp, "wiki"))).toEqual(["blogs/d.mdx", "blogs/src/c.mdx", "blogs/src/u.mdx", "plans/deep/a.mdx"]);
  });

  test("a blogs/src page is dropped only when its compiled .html sibling exists", async () => {
    const found = await relPaths(path.join(tmp, "wiki/blogs"));
    expect(found).toContain("blogs/src/c.mdx");
    expect(found).toContain("blogs/src/u.mdx");
    expect(found).not.toContain("blogs/src/s.mdx");
  });

  test.skipIf(asRoot)("an unreadable same-stem .md is no page, so it shadows nothing: the same findings as lintWiki", async () => {
    const root = path.join(tmp, "unreadable-shadow");
    await Bun.write(path.join(root, ".wiki-reader.json"), "{}");
    await Bun.write(path.join(root, "plans/q.mdx"), BAD);
    await Bun.write(path.join(root, "notes/q.md"), BAD);
    await chmod(path.join(root, "notes/q.md"), 0o000);
    try {
      const lint = (await lintWiki(await buildWikiIndex(root))).findings.filter((f) => PAGE_TEXT.has(f.check));
      expect([...new Set(lint.map((f) => f.relPath))]).toEqual(["plans/q.mdx"]);
      expect((await runWikiCheck([root])).out.map((l) => JSON.parse(l))).toEqual(lint.map((f) => JSON.parse(JSON.stringify(f))));
    } finally {
      await chmod(path.join(root, "notes/q.md"), 0o644);
    }
  });

  test("a .wiki-reader.json include scopes the walk", async () => {
    expect(await relPaths(path.join(tmp, "scoped"))).toEqual(["plans/in.mdx"]);
  });

  test("the same pages, and the same findings, as lintWiki", async () => {
    const root = path.join(tmp, "wiki");
    const lint = (await lintWiki(await buildWikiIndex(root))).findings.filter((f) => PAGE_TEXT.has(f.check));
    expect((await runWikiCheck([root])).out.map((l) => JSON.parse(l))).toEqual(lint.map((f) => JSON.parse(JSON.stringify(f))));
  });
});

describe("wiki-check runs the checks lintWiki runs on a page's own text", () => {
  test("a question closed without a decision id is a question-block finding", async () => {
    const { findings } = await wikiCheck(path.join(tmp, "page-checks/plans/q.mdx"));
    expect(findings.map((f) => f.check)).toContain("question-block");
  });

  test("a lane role the reader config does not list is a role-key finding", async () => {
    const { findings } = await wikiCheck(path.join(tmp, "page-checks/plans/l.mdx"));
    expect(findings.map((f) => f.check)).toContain("role-key");
  });

  test("a lane role the reader config lists is no finding", async () => {
    expect((await wikiCheck(path.join(tmp, "page-checks/plans/k.mdx"))).findings.filter((f) => f.check === "role-key")).toEqual([]);
  });

  test("an unclosed [[, markup inside a wikilink and a <Fact> that renders as text are findings", async () => {
    const { findings } = await wikiCheck(path.join(tmp, "page-checks/plans/s.mdx"));
    expect(new Set(findings.map((f) => f.check))).toEqual(new Set(["index-truncation", "nested-annotation", "unrendered-fact-mark", "missing-tldr"]));
  });

  test("a live plan with no <Tldr> first is a missing-tldr finding, and one whose box holds no <More> a tldr-no-more", async () => {
    expect((await wikiCheck(path.join(tmp, "page-checks/plans/k.mdx"))).findings.map((f) => f.check)).toContain("missing-tldr");
    expect((await wikiCheck(path.join(tmp, "page-checks/plans/m.mdx"))).findings.map((f) => f.check)).toEqual(["tldr-no-more"]);
    expect((await wikiCheck(path.join(tmp, "page-checks/concepts/ref.mdx"))).findings.map((f) => f.check)).toEqual(["missing-tldr"]);
  });

  test("a shipped plan and a reserved page need no <Tldr>", async () => {
    expect((await wikiCheck(path.join(tmp, "page-checks/plans/d.mdx"))).findings).toEqual([]);
    expect((await wikiCheck(path.join(tmp, "page-checks/plans/index.mdx"))).findings).toEqual([]);
  });

  test("a live plan_status with a trailing comment is read as the index reads it", async () => {
    expect((await wikiCheck(path.join(tmp, "page-checks/archive/cs.mdx"))).findings.map((f) => f.check)).toEqual(["missing-tldr"]);
    const found = (await runWikiCheck([path.join(tmp, "page-checks")])).out.map((l) => JSON.parse(l) as { check: string; relPath: string });
    expect(found).toContainEqual(expect.objectContaining({ check: "missing-tldr", relPath: "archive/cs.mdx" }));
  });

  test("a single culled page is checked as given, the Tldr checks included", async () => {
    expect((await wikiCheck(path.join(tmp, "page-checks/plans/rs.mdx"))).findings.map((f) => f.check)).toContain("missing-tldr");
  });

  test("with no .wiki-reader.json the Tldr checks are skipped, and stderr says so", async () => {
    const archive = path.join(tmp, "noconf/archive");
    const dir = await runWikiCheck([archive]);
    expect(dir.out).toEqual([]);
    expect(dir.err).toEqual([noRootNote(archive)]);
    for (const page of [path.join(tmp, "noconf/plans/live.mdx"), path.join(tmp, "noconf/notes/flight.mdx")]) {
      expect({ page, ...(await runWikiCheck([page])) }).toEqual({ page, code: 0, out: [], err: [noRootNote(path.dirname(page))] });
    }
  });

  test("a culled page in a directory gets checks 5, 6 and 6b but no Tldr or component checks", async () => {
    const found = (await runWikiCheck([path.join(tmp, "page-checks")])).out.map((l) => JSON.parse(l) as { check: string; relPath: string });
    expect(new Set(found.filter((f) => f.relPath === "plans/rs.mdx").map((f) => f.check))).toEqual(
      new Set(["index-truncation", "nested-annotation", "unrendered-fact-mark"]),
    );
  });

  test("lintWiki reports a page's page-text findings in checkPageText's order", async () => {
    const root = path.join(tmp, "page-checks");
    const lint = (await lintWiki(await buildWikiIndex(root))).findings.filter((f) => f.relPath === "plans/o.mdx" && PAGE_TEXT.has(f.check));
    expect(lint.map((f) => f.check)).toEqual(["index-truncation", "question-block", "missing-tldr"]);
  });

  test("a culled page in a directory still gets the page-text checks lintWiki runs on it", async () => {
    const found = (await runWikiCheck([path.join(tmp, "page-checks")])).out.map((l) => JSON.parse(l) as { check: string; relPath: string });
    expect(found).toContainEqual(expect.objectContaining({ check: "question-block", relPath: "plans/r.mdx" }));
  });

  test("the same page-text findings as lintWiki, over a directory", async () => {
    const root = path.join(tmp, "page-checks");
    const lint = (await lintWiki(await buildWikiIndex(root))).findings.filter((f) => PAGE_TEXT.has(f.check));
    expect(new Set(lint.map((f) => f.check))).toEqual(
      new Set([
        "question-block",
        "role-key",
        "component-value",
        "component-attr",
        "decision-first-sentence",
        "status-row-long",
        "status-tones",
        "status-tile-long",
        "case-board-labels",
        "index-truncation",
        "nested-annotation",
        "unrendered-fact-mark",
        "missing-tldr",
        "tldr-no-more",
        "ledger-row-state",
        "chain-close-conflict",
        "chart-table",
        "rule-tree",
        "glossary",
      ]),
    );
    expect((await runWikiCheck([root])).out.map((l) => JSON.parse(l))).toEqual(lint.map((f) => JSON.parse(JSON.stringify(f))));
  });

  test("wiki-check reports a tiles block's status-tones and status-tile-long, as lintWiki does", async () => {
    const root = path.join(tmp, "page-checks");
    const keys = new Set(["status-tones", "status-tile-long"]);
    const lint = (await lintWiki(await buildWikiIndex(root))).findings.filter((f) => f.relPath === "plans/st.mdx" && keys.has(f.check));
    const cli = (await runWikiCheck([path.join(root, "plans/st.mdx")])).out
      .map((l) => JSON.parse(l) as { check: string; relPath: string })
      .filter((f) => keys.has(f.check));
    expect(cli.map((f) => f.check)).toEqual(["status-tones", "status-tile-long"]);
    expect(cli).toEqual(lint.map((f) => JSON.parse(JSON.stringify(f))));
  });
});

describe("wiki-check", () => {
  test("relPath is relative to the nearest .wiki-reader.json, else to the argument", async () => {
    expect(wikiRootFor(path.join(tmp, "wiki/plans/deep"))).toBe(path.join(tmp, "wiki"));
    const component = (r: WikiCheckResult) => r.findings.filter((f) => f.check === "component-value");
    expect(component(await wikiCheck(path.join(tmp, "wiki/plans"))).map((f) => f.relPath)).toEqual(["plans/deep/a.mdx"]);
    const one = await wikiCheck(path.join(tmp, "wiki/plans/deep/a.mdx"));
    expect(component(one).map((f) => [f.relPath, f.line])).toEqual([["plans/deep/a.mdx", 4]]);
    expect((await wikiCheck(path.join(tmp, "loose"))).findings.map((f) => f.relPath)).toEqual(["sub/g.mdx"]);
    expect((await wikiCheck(path.join(tmp, "loose/sub/g.mdx"))).findings.map((f) => f.relPath)).toEqual(["g.mdx"]);
  });

  test("runs with no .env, prints only JSON lines and exits 0 with and without findings", () => {
    const found = spawn(path.join(tmp, "wiki/plans"));
    expect(found.code).toBe(0);
    expect(found.err).toBe("");
    expect(found.out.trimEnd().split("\n").map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ check: "component-value", relPath: "plans/deep/a.mdx", line: 4 }),
      expect.objectContaining({ check: "missing-tldr", relPath: "plans/deep/a.mdx" }),
    ]);
    expect(spawn(path.join(tmp, "clean"))).toEqual({ code: 0, out: "", err: `${noRootNote(path.join(tmp, "clean"))}\n` });
  });

  test("a directory with no .mdx page says so on stderr and exits 0", () => {
    expect(spawn(path.join(tmp, "empty"))).toEqual({ code: 0, out: "", err: `wiki-check: no .mdx pages under ${path.join(tmp, "empty")}\n` });
  });

  test("a usage error exits 2 with the usage line", () => {
    for (const args of [[], [path.join(tmp, "clean"), path.join(tmp, "wiki")]]) {
      const r = spawn(...args);
      expect({ args, code: r.code, out: r.out }).toEqual({ args, code: 2, out: "" });
      expect(r.err).toStartWith("usage: ");
    }
  });

  test("a relative path exits 2 and says the path must be absolute", () => {
    const r = spawn("relative/path");
    expect({ code: r.code, out: r.out }).toEqual({ code: 2, out: "" });
    expect(r.err.split("\n")[0]).toBe("wiki-check: the path must be absolute: relative/path");
    expect(r.err).toContain("usage: ");
  });

  test("a page that is not .mdx exits 2 with a usage message", () => {
    const r = spawn(path.join(tmp, "wiki/plans/b.md"));
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain(`not an .mdx page: ${path.join(tmp, "wiki/plans/b.md")}`);
    expect(r.err).toContain("usage: ");
  });

  test("an unreadable page or a missing path exits 2 with one line and no stack trace", () => {
    const targets = [path.join(tmp, "nope"), path.join(tmp, "nope.mdx"), ...(asRoot ? [] : [path.join(tmp, "locked/i.mdx")])];
    for (const target of targets) {
      const r = spawn(target);
      expect({ target, code: r.code, out: r.out, lines: r.err.trimEnd().split("\n").length }).toEqual({ target, code: 2, out: "", lines: 1 });
      expect(r.err).toStartWith("wiki-check: cannot read ");
      expect(r.err).not.toContain("    at ");
    }
  });

  test.skipIf(asRoot)("an unreadable page in a directory is one stderr line; the run goes on", () => {
    const r = spawn(path.join(tmp, "mixed"));
    expect(r.code).toBe(0);
    expect(r.err).toBe(`${noRootNote(path.join(tmp, "mixed"))}\nwiki-check: cannot read ${path.join(tmp, "mixed/j.mdx")}: EACCES\n`);
    expect(r.out.trimEnd().split("\n").map((l) => (JSON.parse(l) as { relPath: string }).relPath)).toEqual(["k.mdx"]);
  });

  test.skipIf(asRoot)("a directory none of whose pages can be read exits 3", async () => {
    const r = await runWikiCheck([path.join(tmp, "locked")]);
    expect(r.code).toBe(3);
    expect(r.err).toEqual([noRootNote(path.join(tmp, "locked")), expect.stringMatching(/^wiki-check: cannot read .*i\.mdx: EACCES$/)]);
  });
});
