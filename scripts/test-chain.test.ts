import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXCLUDED,
  NO_TESTS_EXEMPT,
  PINNED,
  SHARD_TOTAL,
  aloneArgv,
  chainScript,
  changedTestFiles,
  check,
  generate,
  junitName,
  killGroup,
  linkKey,
  needsRetime,
  normalizeTable,
  parseAllowlist,
  parseJunit,
  readTable,
  readTree,
  rebalance,
  refreshTimings,
  tableProblems,
  timeAlone,
  timeChangedFiles,
  timeRefreshFiles,
  type AloneRun,
  type ChainLink,
  type CheckInput,
  type ShardTable,
  type Tree,
} from "./test-chain.ts";
import { bunTestLinks, expandLink } from "../src/test/mock-isolation.ts";
import { testTempDirSync } from "../src/test/temp-dir.ts";

const ROOT = path.join(import.meta.dir, "..");

/** A bun junit report with one file-level suite per file, each holding one testcase. */
function junit(files: string[], seconds = 0.01): string {
  const suites = files
    .map(
      (f) => `  <testsuite name="${f}" file="${f}" tests="1" time="0">
    <testsuite name="describe" file="${f}" line="3" tests="1" time="0">
      <testcase name="a" classname="describe" time="${seconds}" file="${f}" line="4" assertions="1" />
    </testsuite>
  </testsuite>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${files.length}">\n${suites}\n</testsuites>\n`;
}

describe("the live chain", () => {
  test("package.json's `test` is exactly the generated chain, and every test file is in a link", () => {
    const { links, problems } = generate(readTree(), readTable());
    expect(problems).toEqual([]);
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.test, "run `bun scripts/test-chain.ts write`").toBe(chainScript(links));
  });

  test(`every link is on exactly one of the ${SHARD_TOTAL} shards, and the table names no other key`, () => {
    const { links } = generate(readTree(), readTable());
    expect(tableProblems(links, readTable())).toEqual([]);
  });

  test("the groups keep today's directory arguments as directories", () => {
    const groupArgs = Object.values(readTable().groups).flat();
    for (const dir of ["db/migrations/", "src/utils/", "src/summaries/", "src/format/", "src/share/", "src/jira/", "src/sync/", "src/wiki/", "src/gardener/", "src/plans/", "src/auth/", "src/chat/views/components/"]) {
      expect(groupArgs).toContain(dir);
    }
  });

  test("the pinned links are the 25 kept from the hand-written chain plus one A2 found, each with a reason", () => {
    expect(PINNED.map(linkKey)).toEqual([
      "src/ai/connectors/openai-compat-request.test.ts",
      "src/ai/connectors/copilot-sdk.test.ts",
      "src/db/",
      "db/provision.test.ts",
      "src/dashboard/routes/summaries-transcript-check-db.test.ts",
      "src/dashboard/routes/summary-save-delete-race-db.test.ts",
      "src/dashboard/routes/wiki-answers-db.test.ts",
      "src/dashboard/routes/wiki-answers-export-db.test.ts",
      "src/dashboard/routes/wiki-decision-inbox-db.test.ts",
      "src/dashboard/routes/wiki-decision-close-db.test.ts",
      "src/dashboard/routes/wiki-gardener-drift-db.test.ts",
      "src/dashboard/routes/wiki-gardener-factcheck-db.test.ts",
      "src/bot/handler.test.ts",
      "src/bot/middleware.test.ts",
      "watchers",
      "src/goals/detector.test.ts",
      "src/observability/agent-status.test.ts",
      "src/dashboard/views/components/",
      "views-pages",
      "src/tracing/agent-run-trace.test.ts",
      "src/profile/inject.test.ts",
      "src/chat/routes-owner-guard.test.ts",
      "src/ai/tool-surface-fence.test.ts",
      "src/scheduler/haiku-fence.test.ts",
      "src/hivemind/",
      "src/vimeo/captions.test.ts",
    ]);
    expect(PINNED.find((p) => p.name === "watchers")!.args).toHaveLength(9);
    expect(PINNED.find((p) => p.name === "views-pages")!.args).toHaveLength(4);
    for (const p of PINNED) expect(p.reason.trim(), linkKey(p)).not.toBe("");
  });

  // Through `readTree`, the scan `write` and `check` themselves run: a copy of it
  // here would leave its `ownProcessFiles` wiring unexercised.
  test("the wiki boot tests are own-process links: each alone, and in no other link", () => {
    const boots = [
      "src/dashboard/views/wiki-boot/wiki-article-series-boot.test.ts",
      "src/dashboard/views/wiki-boot/wiki-ask-boot.test.ts",
      "src/dashboard/views/wiki-boot/wiki-controllers-boot.test.ts",
      "src/dashboard/views/wiki-boot/wiki-shell-boot.test.ts",
    ];
    const t = readTree();
    expect(t.ownProcessFiles).toBeDefined();
    expect([...(t.ownProcessFiles ?? [])].sort()).toEqual(boots);
    const { links } = generate(t, readTable());
    for (const boot of boots) {
      const running = links.filter((l) => expandLink(l.args, t.allTestFiles).includes(boot));
      expect(running.map((l) => `${l.kind}:${l.args.join(",")}`)).toEqual([`own:${boot}`]);
    }
  });

  // `test:unit` is hand-kept, not generated: an own-process file only `test` runs
  // falls out of the unit group (`count-tests --files` reports it "ungrouped").
  test("every own-process file runs alone in a test:unit link", () => {
    const t = readTree();
    const scripts = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    const unitLinks = bunTestLinks({ "test:unit": scripts["test:unit"]! });
    for (const file of t.ownProcessFiles ?? []) {
      const alone = unitLinks.filter((l) => l.args.length === 1 && l.args[0] === file);
      expect(alone.length, file).toBe(1);
    }
  });

  test("the exclude list starts with the live-bot integration test", () => {
    expect(EXCLUDED.map((e) => e.file)).toEqual(["src/chat/integration.test.ts"]);
    const { links } = generate(readTree(), readTable());
    expect(chainScript(links)).not.toContain("src/chat/integration.test.ts");
  });

  test("the no-tests exemption list starts empty", () => {
    expect(NO_TESTS_EXEMPT).toEqual([]);
  });

  test("the slow-file allowlist names test files on disk, each with a reason", () => {
    const { files, problems } = parseAllowlist(readFileSync(path.join(ROOT, "scripts/unit-slow-allowlist.txt"), "utf8"));
    expect(problems).toEqual([]);
    expect(files.size).toBeGreaterThan(0);
    const onDisk = new Set(readTree().allTestFiles);
    for (const f of files) expect(onDisk.has(f), f).toBe(true);
  });
});

// --- fixtures ---

const tree: Tree = {
  allTestFiles: ["src/a/one.test.ts", "src/a/two.test.ts", "src/b/m.test.ts", "src/b/three.test.ts", "src/p.test.ts", "src/x.test.ts"],
  mockFiles: ["src/b/m.test.ts"],
};
const pinned = [{ args: ["src/p.test.ts"], reason: "fixture" }];
const excluded = ["src/x.test.ts"];
const opts = { pinned, excluded };
const table: ShardTable = {
  groups: { g1: ["src/a/"], g2: ["src/b/"] },
  shards: [["g1"], ["g2", "src/b/m.test.ts"], ["src/p.test.ts"]],
};

describe("generate", () => {
  test("a directory stays a directory unless a file under it belongs to another link; mock files run alone", () => {
    const { links, problems } = generate(tree, table, opts);
    expect(problems).toEqual([]);
    expect(links.map((l) => `${l.kind}:${l.key}:${l.args.join(",")}`)).toEqual([
      "group:g1:src/a/",
      "group:g2:src/b/three.test.ts",
      "mock:src/b/m.test.ts:src/b/m.test.ts",
      "pinned:src/p.test.ts:src/p.test.ts",
    ]);
    expect(chainScript(links)).toBe("bun test src/a/ && bun test src/b/three.test.ts && bun test src/b/m.test.ts && bun test src/p.test.ts");
  });

  test("an own-process file runs alone like a mock file, and naming it in a group or a pinned link is a problem", () => {
    const t: Tree = { ...tree, ownProcessFiles: ["src/a/two.test.ts"] };
    const { links, problems } = generate(t, table, opts);
    expect(problems).toEqual([]);
    expect(links.map((l) => `${l.kind}:${l.key}:${l.args.join(",")}`)).toEqual([
      "group:g1:src/a/one.test.ts",
      "group:g2:src/b/three.test.ts",
      "own:src/a/two.test.ts:src/a/two.test.ts",
      "mock:src/b/m.test.ts:src/b/m.test.ts",
      "pinned:src/p.test.ts:src/p.test.ts",
    ]);
    expect(generate(t, { ...table, groups: { g1: ["src/a/one.test.ts", "src/a/two.test.ts"], g2: ["src/b/"] } }, opts).problems).toContain(
      "group g1 names src/a/two.test.ts, which needs a process of its own (ownProcessFiles) and must run alone",
    );
    expect(generate(t, { ...table, groups: { g2: ["src/b/"] } }, { pinned: [...pinned, { args: ["src/a/"], reason: "x" }], excluded }).problems).toContain(
      "pinned link src/a/ runs src/a/two.test.ts, which needs a process of its own (ownProcessFiles) and runs alone",
    );
  });

  test("a mock.module file named in a group is a problem", () => {
    const { problems } = generate(tree, { ...table, groups: { g1: ["src/a/", "src/b/m.test.ts"] } }, opts);
    expect(problems).toContain("group g1 names src/b/m.test.ts, which calls mock.module and must run alone");
  });

  test("a test file in no link is a problem, not a silent skip", () => {
    const { problems } = generate(tree, { ...table, groups: { g1: ["src/a/"] } }, opts);
    expect(problems).toEqual(["src/b/three.test.ts is in no link: add it to a group in scripts/unit-shards.json, or pin it"]);
  });

  test("dropping the exclude entry puts the excluded file in no link", () => {
    const { problems } = generate(tree, table, { pinned });
    expect(problems).toEqual(["src/x.test.ts is in no link: add it to a group in scripts/unit-shards.json, or pin it"]);
  });

  test("an excluded file under a group directory writes that directory out file by file, so bun never runs it", () => {
    const t: Tree = { ...tree, allTestFiles: [...tree.allTestFiles, "src/a/x.test.ts"].sort() };
    const { links, problems } = generate(t, table, { pinned, excluded: [...excluded, "src/a/x.test.ts"] });
    expect(problems).toEqual([]);
    expect(links.find((l) => l.key === "g1")!.args).toEqual(["src/a/one.test.ts", "src/a/two.test.ts"]);
  });

  test("a Playwright spec is not bun's: in no link is fine, and a group directory over it is written out file by file", () => {
    const t: Tree = { allTestFiles: ["e2e/a.test.ts", "e2e/x.spec.ts"], mockFiles: [] };
    const { links, problems } = generate(t, { groups: { g: ["e2e/"] }, shards: [["g"], [], []] }, { pinned: [], excluded: [] });
    expect(problems).toEqual([]);
    expect(links.map((l) => l.args)).toEqual([["e2e/a.test.ts"]]);
  });

  test("a mock file whose path contains a group directory (bun matches substrings) splits that directory", () => {
    const t: Tree = { ...tree, allTestFiles: [...tree.allTestFiles, "e2e/fixtures/src/a/m.test.ts"].sort(), mockFiles: [...tree.mockFiles, "e2e/fixtures/src/a/m.test.ts"] };
    const { links, problems } = generate(t, table, opts);
    expect(problems).toEqual([]);
    expect(links.find((l) => l.key === "g1")!.args).toEqual(["src/a/one.test.ts", "src/a/two.test.ts"]);
  });

  test("a link whose file argument also matches another link's file is a problem", () => {
    const t: Tree = { ...tree, allTestFiles: [...tree.allTestFiles, "sub/src/b/m.test.ts"].sort() };
    const { problems } = generate(t, { ...table, groups: { g1: ["src/a/"], g2: ["src/b/three.test.ts"], g3: ["sub/"] } }, opts);
    expect(problems).toEqual(["link src/b/m.test.ts also runs sub/src/b/m.test.ts (in g3): bun reads a path argument as a substring of the file path"]);
  });

  test("a link whose file argument also matches an excluded file is a problem", () => {
    const t: Tree = { ...tree, allTestFiles: [...tree.allTestFiles, "sub/src/b/three.test.ts"].sort() };
    const { problems } = generate(t, table, { pinned, excluded: [...excluded, "sub/src/b/three.test.ts"] });
    expect(problems).toEqual(["link g2 also runs sub/src/b/three.test.ts (in EXCLUDED): bun reads a path argument as a substring of the file path"]);
  });

  test("dropping a pinned entry leaves its file in no link", () => {
    const { problems } = generate(tree, table, { pinned: [], excluded });
    expect(problems).toEqual(["src/p.test.ts is in no link: add it to a group in scripts/unit-shards.json, or pin it"]);
  });

  test("a pinned link that runs a mock file, or a file twice, is a problem", () => {
    const { problems } = generate(tree, { ...table, groups: { g1: ["src/a/", "src/p.test.ts"], g2: ["src/b/"] } }, { pinned: [...pinned, { args: ["src/b/"], reason: "x" }], excluded });
    expect(problems).toContain("pinned link src/b/ runs src/b/m.test.ts, which calls mock.module and runs alone");
    expect(problems).toContain("src/p.test.ts is in two links: src/p.test.ts and g1");
  });
});

describe("tableProblems", () => {
  const { links } = generate(tree, table, opts);
  test("green on a table that places each link once", () => {
    expect(tableProblems(links, table)).toEqual([]);
  });
  test("a link dropped from the table", () => {
    expect(tableProblems(links, { ...table, shards: [["g1"], ["g2"], ["src/p.test.ts"]] })).toEqual(["link src/b/m.test.ts is on no shard"]);
  });
  test("a link assigned twice", () => {
    expect(tableProblems(links, { ...table, shards: [["g1", "src/p.test.ts"], ["g2", "src/b/m.test.ts"], ["src/p.test.ts"]] })).toEqual([
      "link src/p.test.ts is assigned 2 times (shards 1, 3)",
    ]);
  });
  test("a key that is not a link", () => {
    expect(tableProblems(links, { ...table, shards: [["g1", "gone"], ["g2", "src/b/m.test.ts"], ["src/p.test.ts"]] })).toEqual([
      "the table names gone, which is not a link of the chain",
    ]);
  });
});

describe("check (the fan-in)", () => {
  const { links } = generate(tree, table, opts);
  const greenJunit = () =>
    new Map([
      [junitName("g1"), junit(["src/a/one.test.ts", "src/a/two.test.ts"])],
      [junitName("g2"), junit(["src/b/three.test.ts"])],
      [junitName("src/b/m.test.ts"), junit(["src/b/m.test.ts"])],
      [junitName("src/p.test.ts"), junit(["src/p.test.ts"])],
    ]);
  const input = (over: Partial<CheckInput> = {}): CheckInput => ({
    links,
    table,
    tree,
    junit: greenJunit(),
    shards: [1, 2, 3],
    results: ["success"],
    timings: Object.fromEntries(tree.allTestFiles.map((f) => [f, 1])),
    excluded,
    ...over,
  });

  test("green when every file ran once, mock files alone, every shard succeeded", () => {
    expect(check(input())).toEqual({ problems: [], warnings: [], ran: 5 });
  });

  test("red on a link dropped from the table", () => {
    const r = check(input({ table: { ...table, shards: [["g1"], ["g2"], ["src/p.test.ts"]] } }));
    expect(r.problems).toContain("link src/b/m.test.ts is on no shard");
  });

  test("red on a link assigned twice", () => {
    const r = check(input({ table: { ...table, shards: [["g1", "src/p.test.ts"], ["g2", "src/b/m.test.ts"], ["src/p.test.ts"]] } }));
    expect(r.problems).toContain("link src/p.test.ts is assigned 2 times (shards 1, 3)");
    expect(r.problems).toContain("ran 2 times: src/p.test.ts (links src/p.test.ts, src/p.test.ts)");
  });

  test("red on a mock.module file put into a group", () => {
    const groupLinks: ChainLink[] = links.map((l) => (l.key === "g2" ? { ...l, args: ["src/b/three.test.ts", "src/b/m.test.ts"] } : l)).filter((l) => l.key !== "src/b/m.test.ts");
    const j = greenJunit();
    j.set(junitName("g2"), junit(["src/b/three.test.ts", "src/b/m.test.ts"]));
    j.delete(junitName("src/b/m.test.ts"));
    const r = check(input({ links: groupLinks, junit: j, table: { ...table, shards: [["g1"], ["g2"], ["src/p.test.ts"]] } }));
    expect(r.problems).toEqual(["src/b/m.test.ts calls mock.module and shared its process with 1 other file(s) (link g2)"]);
  });

  test("red on an own-process file that shared its process", () => {
    const r = check(input({ tree: { ...tree, ownProcessFiles: ["src/a/two.test.ts"] } }));
    expect(r.problems).toEqual(["src/a/two.test.ts needs a process of its own (ownProcessFiles) and shared its process with 1 other file(s) (link g1)"]);
  });

  test("a link that exits without junit is named as a crash, not as missing files", () => {
    const j = greenJunit();
    j.delete(junitName("g1"));
    const r = check(input({ junit: j }));
    expect(r.problems).toEqual(["crash: link g1 on shard 1 exited without writing g1.xml (a process.exit or a crash), so its 2 file(s) are unaccounted for"]);
  });

  test("red on a shard result that is not success", () => {
    expect(check(input({ results: ["failure"] })).problems).toEqual(["a unit shard finished failure"]);
    expect(check(input({ results: ["cancelled"] })).problems).toEqual(["a unit shard finished cancelled"]);
  });

  test("red on a file that never ran, and on one no link runs", () => {
    const j = greenJunit();
    j.set(junitName("g1"), junit(["src/a/one.test.ts", "src/elsewhere.test.ts"]));
    const r = check(input({ junit: j }));
    expect(r.problems).toEqual(["never ran: src/a/two.test.ts (link g1)", "ran, but no checked link runs it: src/elsewhere.test.ts"]);
  });

  test("an exempt file may write no suite, and an exempt file that ran is red", () => {
    const j = greenJunit();
    j.set(junitName("g1"), junit(["src/a/one.test.ts"]));
    expect(check(input({ junit: j, exempt: ["src/a/two.test.ts"] })).problems).toEqual([]);
    expect(check(input({ exempt: ["src/a/two.test.ts"] })).problems).toEqual(["src/a/two.test.ts is in NO_TESTS_EXEMPT but ran: drop it from the list"]);
  });

  test("one shard checks only its own links", () => {
    const only1 = new Map([[junitName("g1"), junit(["src/a/one.test.ts", "src/a/two.test.ts"])]]);
    expect(check(input({ junit: only1, shards: [1], results: [] }))).toEqual({ problems: [], warnings: [], ran: 2 });
  });

  test("warns, without failing, when files missing from the timing table took over 60 s", () => {
    const j = greenJunit();
    j.set(junitName("src/p.test.ts"), junit(["src/p.test.ts"], 61));
    const r = check(input({ junit: j, timings: { "src/a/one.test.ts": 1 } }));
    expect(r.problems).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("src/p.test.ts 61.0 s");
    expect(check(input({ junit: j })).warnings).toEqual([]);
  });
});

describe("parseJunit", () => {
  test("reads the file-level suites of a bun report and sums their testcase time", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" time="0.5">
  <testsuite name="src/a.test.ts" file="src/a.test.ts" tests="2" time="0" hostname="h">
    <testsuite name="outer" file="src/a.test.ts" line="3" tests="2" time="0">
      <testcase name="x" classname="outer" time="0.25" file="src/a.test.ts" line="4" assertions="1" />
      <testsuite name="inner &apos;q&apos;" file="src/a.test.ts" line="9" tests="1" time="0">
        <testcase name="y" classname="inner" time="0.5" file="src/a.test.ts" line="10" assertions="1">
          <failure message="boom" type="AssertionError" />
        </testcase>
      </testsuite>
    </testsuite>
  </testsuite>
  <testsuite name="src/b &amp; c.test.ts" file="src/b.test.ts" tests="1" time="0" hostname="h">
    <testcase name="z" classname="" time="1" file="src/b.test.ts" line="2" assertions="1" />
  </testsuite>
</testsuites>
`;
    expect(parseJunit(xml)).toEqual([
      { file: "src/a.test.ts", testcaseSeconds: 0.75 },
      { file: "src/b & c.test.ts", testcaseSeconds: 1 },
    ]);
  });
});

describe("rebalance", () => {
  const big: Tree = {
    allTestFiles: ["src/d/a.test.ts", "src/d/b.test.ts", "src/e.test.ts", "src/f.test.ts", "src/g.test.ts", "src/b/m.test.ts"],
    mockFiles: ["src/b/m.test.ts"],
  };
  const timings = { "src/d/a.test.ts": 30, "src/d/b.test.ts": 30, "src/e.test.ts": 50, "src/f.test.ts": 10, "src/g.test.ts": 10, "src/b/m.test.ts": 40 };
  const start: ShardTable = { groups: { "unit-1": ["src/d/", "src/e.test.ts", "src/f.test.ts", "src/g.test.ts"] }, shards: [["unit-1", "src/b/m.test.ts"], [], []] };

  test("packs longest first, keeps a directory whole, and places every link once", () => {
    const { table: t, loads } = rebalance(big, start, timings, { pinned: [], excluded: [] });
    expect(t.groups).toEqual({ "unit-1": ["src/d/"], "unit-2": ["src/e.test.ts", "src/g.test.ts"], "unit-3": ["src/f.test.ts"] });
    expect(t.shards).toEqual([["unit-1"], ["unit-2"], ["unit-3", "src/b/m.test.ts"]]);
    expect(loads).toEqual([60, 60, 50]);
    const { links, problems } = generate(big, t, { pinned: [], excluded: [] });
    expect(problems).toEqual([]);
    expect(tableProblems(links, t)).toEqual([]);
  });
});

describe("normalizeTable (run by write)", () => {
  test("a new link goes to the least-loaded shard and a vanished key is dropped", () => {
    const { links } = generate(tree, table, opts);
    const stale: ShardTable = { ...table, shards: [["g1", "gone"], ["g2"], ["src/p.test.ts"]] };
    const timings = { "src/a/one.test.ts": 50, "src/a/two.test.ts": 50, "src/b/three.test.ts": 20, "src/p.test.ts": 5, "src/b/m.test.ts": 3 };
    expect(normalizeTable(links, stale, tree, timings).shards).toEqual([["g1"], ["g2"], ["src/p.test.ts", "src/b/m.test.ts"]]);
  });
});

describe("the changed-file step", () => {
  test("keeps the test files the chain runs, so excluded and non-test files drop out", () => {
    const chain = new Set(["src/a/one.test.ts", "src/p.test.ts"]);
    expect(changedTestFiles("src/p.test.ts\nsrc/x.test.ts\nsrc/a/one.ts\nsrc/a/one.test.ts\n", chain)).toEqual(["src/a/one.test.ts", "src/p.test.ts"]);
  });

  test("any bun test file name counts, as discovery reads it; Playwright specs do not", () => {
    const chain = new Set(["src/a/x.test.tsx", "src/a/y_test.ts", "src/a/z.spec.ts", "e2e/o.spec.ts"]);
    expect(changedTestFiles("src/a/x.test.tsx\nsrc/a/y_test.ts\nsrc/a/z.spec.ts\ne2e/o.spec.ts\nsrc/a/w.ts\n", chain)).toEqual(["src/a/x.test.tsx", "src/a/y_test.ts", "src/a/z.spec.ts"]);
  });

  test("a chain file whose name is not a bun test file name drops out", () => {
    expect(changedTestFiles("src/a/helper.ts\nsrc/a/one.test.ts\n", new Set(["src/a/helper.ts", "src/a/one.test.ts"]))).toEqual(["src/a/one.test.ts"]);
  });

  test("a timed-out file is reported as a timeout, not as a failure, and is not timed again", async () => {
    const calls: string[] = [];
    const run: AloneRun = { seconds: 300, code: 137, output: "", timedOut: true };
    const problems = await timeChangedFiles(["src/a.test.ts"], new Set(), async (f) => (calls.push(f), run));
    expect(problems).toEqual(["src/a.test.ts timed out: killed after 300 s alone"]);
    expect(calls).toEqual(["src/a.test.ts"]);
  });

  test("a file within 2 s over the 10 s bar is timed again; under the bar or further over is not", () => {
    expect(needsRetime(9.9)).toBe(false);
    expect(needsRetime(10)).toBe(false); // exactly on the bar passes (the step fails only `> 10`), so no second timing
    expect(needsRetime(10.1)).toBe(true);
    expect(needsRetime(12)).toBe(true);
    expect(needsRetime(12.1)).toBe(false);
  });

  test("an allowlist entry needs a reason", () => {
    const { files, problems } = parseAllowlist("# header\nsrc/a.test.ts  # real ffmpeg\nsrc/b.test.ts\n");
    expect([...files]).toEqual(["src/a.test.ts", "src/b.test.ts"]);
    expect(problems).toEqual(["allowlist entry without a reason: src/b.test.ts"]);
  });
});

describe("timeAlone", () => {
  // A grandchild that inherits the pipes keeps them open after its parent dies.
  const fixture = (body: string) => {
    const f = path.join(testTempDirSync(path.join(tmpdir(), "time-alone-")), "fixture.ts");
    writeFileSync(f, body);
    return f;
  };

  test("a timed-out run returns at the timeout, reported as a timeout, though a grandchild holds the pipes", async () => {
    const f = fixture(`Bun.spawn(["sleep", "8"], { stdout: "inherit", stderr: "inherit" });\nsetInterval(() => {}, 1000);\n`);
    const t0 = performance.now();
    const r = await timeAlone(f, { argv: ["bun", f], timeoutMs: 1500 });
    expect((performance.now() - t0) / 1000).toBeLessThan(4);
    expect(r.timedOut).toBe(true);
  }, 15_000);

  test("a run that exits while a grandchild outside its group holds the pipes returns promptly, not as a timeout", async () => {
    const f = fixture(`Bun.spawn(["sleep", "8"], { stdout: "inherit", stderr: "inherit", detached: true }).unref();\nconsole.log("done");\n`);
    const t0 = performance.now();
    const r = await timeAlone(f, { argv: ["bun", f], timeoutMs: 6000 });
    expect((performance.now() - t0) / 1000).toBeLessThan(4);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.output).toContain("done");
  }, 15_000);
});

describe("timeAlone's kill", () => {
  const fixture = (body: string) => {
    const dir = testTempDirSync(path.join(tmpdir(), "time-alone-kill-"));
    writeFileSync(path.join(dir, "fixture.ts"), body);
    return dir;
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test("the whole process group is killed: a grandchild in it does not outlive the run", async () => {
    const dir = fixture(`const c = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });\nawait Bun.write(import.meta.dir + "/pid", String(c.pid));\nsetInterval(() => {}, 1000);\n`);
    const r = await timeAlone("x", { argv: ["bun", path.join(dir, "fixture.ts")], timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    const pid = Number(readFileSync(path.join(dir, "pid"), "utf8"));
    for (let i = 0; i < 20 && alive(pid); i++) await Bun.sleep(100);
    const survived = alive(pid);
    if (survived) process.kill(pid, "SIGKILL");
    expect(survived).toBe(false);
  }, 15_000);

  test("when the group kill fails with other than ESRCH, the child itself is killed and the run says so", async () => {
    const dir = fixture("setInterval(() => {}, 1000);\n");
    const calls: number[] = [];
    const kill = (pid: number, sig: NodeJS.Signals) => {
      calls.push(pid);
      if (pid < 0) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      process.kill(pid, sig);
    };
    const t0 = performance.now();
    const r = await timeAlone("x", { argv: ["bun", path.join(dir, "fixture.ts")], timeoutMs: 1000, kill });
    expect((performance.now() - t0) / 1000).toBeLessThan(5);
    expect(r.timedOut).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(-calls[1]!);
    expect(r.killWarning).toContain("(EPERM)");
  }, 10_000);

  test("killGroup: ESRCH after the child exited is a gone group, no fallback; a failed kill of an exited child does not touch its pid", () => {
    const calls: number[] = [];
    const throwing = (code: string) => (pid: number) => {
      calls.push(pid);
      if (pid < 0) throw Object.assign(new Error(code), { code });
    };
    expect(killGroup({ pid: 7, exitCode: 0, signalCode: null }, throwing("ESRCH"))).toBeUndefined();
    expect(calls).toEqual([-7]);
    calls.length = 0;
    expect(killGroup({ pid: 7, exitCode: 0, signalCode: null }, throwing("EPERM"))).toContain("(EPERM)");
    expect(calls).toEqual([-7]);
  });

  test("killGroup: ESRCH while the child still runs kills the child", () => {
    const calls: number[] = [];
    const w = killGroup({ pid: 7, exitCode: null, signalCode: null }, (pid) => {
      calls.push(pid);
      if (pid < 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    expect(calls).toEqual([-7, 7]);
    expect(w).toContain("killed only the child");
  });

  test("killGroup's warning never claims a kill that did not happen", () => {
    const fail = (pid: number) => {
      throw Object.assign(new Error("x"), { code: pid < 0 ? "EPERM" : "EACCES" });
    };
    const exited = killGroup({ pid: 7, exitCode: 0, signalCode: null }, fail);
    expect(exited).not.toContain("killed only the child");
    expect(exited).toContain("after the child exited");
    const both = killGroup({ pid: 7, exitCode: null, signalCode: null }, fail);
    expect(both).not.toContain("killed only the child");
    expect(both).toContain("(EACCES)");
  });

  test("the wait after the kill is bounded even when no kill lands", async () => {
    let pid = 0;
    const noKill = (p: number) => {
      pid = Math.abs(p);
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    };
    try {
      const t0 = performance.now();
      const r = await timeAlone("x", { argv: ["sleep", "30"], timeoutMs: 300, killWaitMs: 500, kill: noKill });
      expect((performance.now() - t0) / 1000).toBeLessThan(3);
      expect(r.timedOut).toBe(true);
      expect(r.killWarning).toContain("stopped waiting");
    } finally {
      if (pid) process.kill(-pid, "SIGKILL");
    }
  }, 8_000);
});

describe("the changed-file step prints a kill warning", () => {
  test("a run with killWarning yields a ::warning:: line naming the file", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((s: unknown) => void lines.push(String(s)));
    try {
      await timeChangedFiles(["src/a.test.ts"], new Set(), async () => ({ seconds: 1, code: 0, output: "", timedOut: false, killWarning: "group kill failed" }));
    } finally {
      spy.mockRestore();
    }
    expect(lines).toContain("::warning::src/a.test.ts: group kill failed");
  });
});

describe("refresh prints a kill warning", () => {
  test("a run with killWarning yields a ::warning:: line naming the file", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((s: unknown) => void lines.push(String(s)));
    let runs: Awaited<ReturnType<typeof timeRefreshFiles>> = [];
    try {
      runs = await timeRefreshFiles(["src/a.test.ts"], async () => ({ seconds: 1, code: 0, output: "", timedOut: false, killWarning: "group kill failed" }));
    } finally {
      spy.mockRestore();
    }
    expect(lines).toContain("::warning::src/a.test.ts: group kill failed");
    expect(runs.map((r) => r.file)).toEqual(["src/a.test.ts"]);
  });
});

describe("timeAlone's default argv", () => {
  test("without argv it runs aloneArgv: only the named file, not its .tsx twin", async () => {
    const dir = testTempDirSync(path.join(tmpdir(), "time-alone-argv-"));
    for (const f of ["src/a/x.test.ts", "src/a/x.test.tsx"]) {
      mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      writeFileSync(path.join(dir, f), 'import { test } from "bun:test";\ntest("t", () => {});\n');
    }
    const r = await timeAlone("src/a/x.test.ts", { cwd: dir, timeoutMs: 15_000 });
    expect(r.code).toBe(0);
    expect(r.output).toContain("Ran 1 test across 1 file.");
  }, 20_000);
});

describe("aloneArgv", () => {
  test("bun runs only the named file, not a .tsx twin or a deeper path that ends the same", () => {
    const dir = testTempDirSync(path.join(tmpdir(), "alone-argv-"));
    for (const f of ["src/a/x.test.ts", "src/a/x.test.tsx", "sub/src/a/x.test.ts"]) {
      mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      writeFileSync(path.join(dir, f), 'import { test } from "bun:test";\ntest("t", () => {});\n');
    }
    const report = path.join(dir, "report.xml");
    Bun.spawnSync([...aloneArgv("src/a/x.test.ts"), "--reporter=junit", `--reporter-outfile=${report}`], { cwd: dir, stdout: "ignore", stderr: "ignore" });
    expect([...new Set([...readFileSync(report, "utf8").matchAll(/ file="([^"]+)"/g)].map((m) => m[1]))]).toEqual(["src/a/x.test.ts"]);
  }, 20_000);
});

describe("refreshTimings", () => {
  test("a failed or timed-out file gets no timing entry and is reported", () => {
    const r = refreshTimings([
      { file: "ok.test.ts", run: { seconds: 1.23, code: 0, output: "", timedOut: false } },
      { file: "fail.test.ts", run: { seconds: 2, code: 1, output: "", timedOut: false } },
      { file: "slow.test.ts", run: { seconds: 300, code: 137, output: "", timedOut: true } },
    ]);
    expect(r.seconds).toEqual({ "ok.test.ts": 1.2 });
    expect(r.failed).toEqual(["fail.test.ts"]);
    expect(r.timedOut).toEqual(["slow.test.ts"]);
  });
});
