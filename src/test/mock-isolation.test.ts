import { test, expect, describe } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  MOCK_ALIAS_IMPORT,
  MOCK_MODULE_CALL,
  MOCK_MODULE_SUBSTRING,
  SINGLE_PROCESS_SCRIPTS,
  bunTestLinks,
  discoverTestFiles,
  expandLink,
  isPlaywrightSpec,
  sharedLinkOffenders,
  unrunMockFiles,
} from "./mock-isolation.ts";
import { recordedTestTempDirs, testTempDirSync } from "./temp-dir.ts";

/**
 * Every test file that calls `mock.module()` runs in a `bun test` process of its
 * own — the only FILE its `&&` link expands to, in every chain that runs it.
 *
 * Why a test and not the CLAUDE.md paragraph alone: `bun test` runs files in an
 * order of its own (measured with the junit reporter — not argv order, not
 * alphabetical) that depends on the SET of files in the run, so a mock that leaks
 * into a shared process is green or red per (machine, file set) and flips on any
 * commit that adds a test file. Measured on main, 2026-09-03 → 09-05: the
 * `db/client.ts` mock in `src/ai/haiku-direct.test.ts` sat in the first unit
 * chunk; run #508 loaded the two `setupTestDb` files before it (green), #507 and
 * #509 — one test file added, no chain change — loaded them after it
 * (`TypeError: getDb().unsafe is not a function`; 19 red `test` jobs, one green
 * between them), while the mini loaded them before it every time. Then, once
 * that file was isolated, `src/watchers/anthropic.test.ts`'s partial mock of
 * `db/summary-candidates.ts` in the 14-file `bun test src/watchers/` link reached
 * `runner.test.ts` → `x.ts` on the runner's order (`SyntaxError: Export named
 * 'upsertDestinationCandidate' not found`) — green on both developer machines,
 * and the same mock failed to link the file's OWN import graph the moment it ran
 * alone (masked until then by `x.test.ts`'s fuller mock loading first). A
 * directory argument is what hid the second one: one argument, fourteen files.
 */

const ROOT = join(import.meta.dir, "..", "..");

function allTestFiles(): string[] {
  return discoverTestFiles(ROOT);
}

function mockFiles(files: readonly string[]): string[] {
  return files.filter((f) => MOCK_MODULE_CALL.test(readFileSync(join(ROOT, f), "utf8")));
}

/**
 * The live chains, with the single-process scripts ALREADY removed from `links` —
 * in one place, so no assertion below can forget to. Round 2 of #526 applied the
 * exemption per assertion and missed one: with `expandLink([])` meaning "every
 * file", the unfiltered `test:coverage` link marked every mock file as run by a
 * chain, and deleting every `haiku-direct.test.ts` link left the guard green.
 * `singleProcessLinks` is what the exemption itself is checked against.
 */
function liveInput() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const all = allTestFiles();
  const every = bunTestLinks(pkg.scripts);
  return {
    links: every.filter((l) => !SINGLE_PROCESS_SCRIPTS.has(l.script)),
    singleProcessLinks: every.filter((l) => SINGLE_PROCESS_SCRIPTS.has(l.script)),
    mockFiles: mockFiles(all),
    allTestFiles: all,
    scripts: pkg.scripts,
  };
}

describe("the rule, on fixtures", () => {
  const all = ["src/a/one.test.ts", "src/a/two.test.ts", "src/b/solo.test.ts", "src/c/x.test.ts"];
  const scripts = {
    test: "bun run typecheck && bun test src/a/ && bun test src/b/ && bun test src/c/x.test.ts src/a/one.test.ts && bun test --coverage src/b/solo.test.ts",
    "test:other": "bun test src/a/two.test.ts",
    build: "bun build x",
  };
  const links = bunTestLinks(scripts);

  test("only `bun test` links of `test*` scripts are read, flags dropped", () => {
    expect(links.map((l) => `${l.script}:${l.args.join(",")}`)).toEqual([
      "test:src/a/",
      "test:src/b/",
      "test:src/c/x.test.ts,src/a/one.test.ts",
      "test:src/b/solo.test.ts",
      "test:other:src/a/two.test.ts",
    ]);
  });

  test("a directory argument expands to every test file under it; a file is itself", () => {
    expect(expandLink(["src/a/"], all)).toEqual(["src/a/one.test.ts", "src/a/two.test.ts"]);
    expect(expandLink(["src/b/"], all)).toEqual(["src/b/solo.test.ts"]);
    expect(expandLink(["src/c/x.test.ts", "src/c/x.test.ts"], all)).toEqual(["src/c/x.test.ts"]);
  });

  test("a ONE-argument directory link that runs several files is a shared process", () => {
    const out = sharedLinkOffenders({ links, mockFiles: ["src/a/one.test.ts"], allTestFiles: all });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("test: src/a/one.test.ts shares a bun test process with 1 other file(s) (link: bun test src/a/)");
    expect(out[1]).toContain("(link: bun test src/c/x.test.ts src/a/one.test.ts)");
  });

  test("a directory link that expands to exactly one file is isolation", () => {
    expect(sharedLinkOffenders({ links, mockFiles: ["src/b/solo.test.ts"], allTestFiles: all })).toEqual([]);
  });

  test("a link with NO path argument is bun's whole-repo run: every file, one process", () => {
    const l = bunTestLinks({ "test:coverage": "bun test --coverage" });
    expect(l).toEqual([{ script: "test:coverage", args: [] }]);
    expect(expandLink([], all)).toEqual(all);
    expect(sharedLinkOffenders({ links: l, mockFiles: ["src/b/solo.test.ts"], allTestFiles: all })).toHaveLength(1);
  });

  test("a path argument is a substring of the file's path, as bun reads it; a leading `./` makes it a path", () => {
    const files = ["src/plans/a.test.ts", "src/plans/a.test.tsx", "src/plansx/f.test.ts", "sub/src/plans/a.test.ts", "xsrc/plans/e.test.ts"];
    expect(expandLink(["src/plans/"], files)).toEqual(["src/plans/a.test.ts", "src/plans/a.test.tsx", "sub/src/plans/a.test.ts", "xsrc/plans/e.test.ts"]);
    expect(expandLink(["src/plans/a.test.ts"], files)).toEqual(["src/plans/a.test.ts", "src/plans/a.test.tsx", "sub/src/plans/a.test.ts"]);
    expect(expandLink(["./src/plans/"], files)).toEqual(["src/plans/a.test.ts", "src/plans/a.test.tsx"]);
    expect(expandLink(["./src/plans/a.test.ts"], files)).toEqual(["src/plans/a.test.ts"]);
    expect(expandLink(["src/gone.test.ts"], files)).toEqual(["src/gone.test.ts"]);
  });

  test("a mock file whose path contains a group's directory shares that group's process", () => {
    const files = ["e2e/fixtures/src/wiki/m.test.ts", "src/wiki/a.test.ts"];
    const l = bunTestLinks({ test: "bun test src/wiki/" });
    expect(sharedLinkOffenders({ links: l, mockFiles: ["e2e/fixtures/src/wiki/m.test.ts"], allTestFiles: files })).toHaveLength(1);
  });

  test("a mock file no chain runs is reported, not silently skipped", () => {
    expect(unrunMockFiles({ links, mockFiles: ["src/zz/lost.test.ts", "src/b/solo.test.ts"], allTestFiles: all })).toEqual([
      "src/zz/lost.test.ts",
    ]);
  });

  test("the call detector matches every call form and not the same words in prose or a regex", () => {
    expect(MOCK_MODULE_CALL.test('import x;\nmock.module("../db/client.ts", () => ({}));')).toBe(true);
    expect(MOCK_MODULE_CALL.test('  mock.module("./a.ts", () => ({}));')).toBe(true);
    expect(MOCK_MODULE_CALL.test('  await mock.module("./a.ts", async () => ({}));')).toBe(true);
    expect(MOCK_MODULE_CALL.test('void mock.module("./a.ts", () => ({}));')).toBe(true);
    expect(MOCK_MODULE_CALL.test('const p = mock.module("./a.ts", () => ({}));')).toBe(true);
    expect(MOCK_MODULE_CALL.test('bt.mock.module("./a.ts", () => ({}));')).toBe(true);
    expect(MOCK_ALIAS_IMPORT.test('import { mock as m } from "bun:test";')).toBe(true);
    expect(MOCK_ALIAS_IMPORT.test('import { test, mock as m, expect } from "bun:test";')).toBe(true);
    expect(MOCK_ALIAS_IMPORT.test('import { mock, test } from "bun:test";')).toBe(false);
    expect(MOCK_ALIAS_IMPORT.test("// treat the mock as a stand-in for the DB")).toBe(false);
    expect(MOCK_MODULE_CALL.test(" * a file that mock.module()s a db module\nconst r = /mock\\.module\\(/;")).toBe(false);
  });
});

/** The files a real `bun test <args>` loads in `dir`, read off its junit report. */
function bunRuns(dir: string, args: string[]): string[] {
  // The report sits in a recorded temp dir so the run's cleanup removes it; inside `dir` it would be in the tree bun scans.
  const out = join(testTempDirSync(join(tmpdir(), "bun-junit-")), `${basename(dir)}.xml`);
  Bun.spawnSync(["bun", "test", "--reporter=junit", `--reporter-outfile=${out}`, ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  return [...new Set([...readFileSync(out, "utf8").matchAll(/ file="([^"]+)"/g)].map((m) => m[1]!))].sort();
}

describe("the model agrees with bun itself (spawns bun on a fixture tree)", () => {
  const dir = testTempDirSync(join(tmpdir(), "bun-discovery-"));
  for (const f of [
    "src/plans/a.test.ts", "src/plans/b.test.tsx", "src/plans/c.spec.ts", "src/plans/d_test.ts", "src/plans/e_spec.js",
    "src/plans/f.test.mts", "src/plans/G.TEST.TS", "src/plans/.h.test.ts", "src/plans/i.tests.ts", "src/plans/j-test.ts",
    "src/plans/k.test.d.ts", "src/plans/.hidden/l.test.ts", "src/plans/node_modules/m.test.ts", "src/plansx/n.test.ts",
    "sub/src/plans/a.test.ts", "e2e/o.spec.ts",
  ]) {
    mkdirSync(join(dir, dirname(f)), { recursive: true });
    writeFileSync(join(dir, f), 'import { test } from "bun:test";\ntest("t", () => {});\n');
  }

  test("discovery: every file bun runs with no argument, and no other", () => {
    expect(discoverTestFiles(dir)).toEqual(bunRuns(dir, []));
  }, 20_000);

  test("matching: expandLink gives the files bun runs for each argument shape", () => {
    const all = discoverTestFiles(dir);
    for (const args of [["src/plans/"], ["src/plans/a.test.ts"], ["./src/plans/"], ["./src/plans/a.test.ts"], ["rc/pla"], ["src/plansx/", "./sub/"]]) {
      expect(expandLink(args, all).sort(), args.join(" ")).toEqual(bunRuns(dir, args));
    }
  }, 20_000);

  test("the junit report lands inside a recorded temp dir, never next to the fixture", () => {
    const fresh = testTempDirSync(join(tmpdir(), "bun-discovery-"));
    writeFileSync(join(fresh, "a.test.ts"), 'import { test } from "bun:test";\ntest("t", () => {});\n');
    expect(bunRuns(fresh, [])).toEqual(["a.test.ts"]);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith(basename(fresh)) && n !== basename(fresh))).toEqual([]);
    const reports = recordedTestTempDirs().flatMap((d) => readdirSync(d, { recursive: true }).map(String)).filter((n) => n.endsWith(`${basename(fresh)}.xml`));
    expect(reports).toHaveLength(1);
  }, 20_000);

  test("Playwright's specs are e2e/**/*.spec.ts (playwright.config.ts testDir + testMatch)", () => {
    expect(discoverTestFiles(dir).filter(isPlaywrightSpec)).toEqual(["e2e/o.spec.ts"]);
    expect(readFileSync(join(ROOT, "playwright.config.ts"), "utf8")).toMatch(/testDir: "\.\/e2e",[\s\S]*testMatch: "\*\*\/\*\.spec\.ts"/);
  });
});

describe("the live chains", () => {
  test("the files the rule exists for are detected (so it cannot pass vacuously)", () => {
    const { mockFiles: m } = liveInput();
    for (const f of [
      "src/ai/haiku-direct.test.ts",
      "src/scheduler/executor.test.ts",
      "src/watchers/anthropic.test.ts",
      "src/watchers/x.test.ts",
      "src/dashboard/routes/data-routes-bot-scope.test.ts",
    ]) {
      expect(m).toContain(f);
    }
  });

  test("no test file aliases the `mock` import, the one call form the detector cannot see", () => {
    const { allTestFiles: all } = liveInput();
    const aliased = all.filter((f) => f !== "src/test/mock-isolation.test.ts" && MOCK_ALIAS_IMPORT.test(readFileSync(join(ROOT, f), "utf8")));
    expect(aliased).toEqual([]);
  });

  test("every chain link has a shape the parser reads: `&&`-chained, no `;`/`|`, flags only from the known set", () => {
    // `bun test --timeout 5000 x.test.ts` would read `5000` as a file; `a.test.ts; echo` would
    // read `a.test.ts;` as a file that matches nothing. Neither shape exists; this keeps it so.
    const { scripts } = liveInput();
    for (const [script, cmd] of Object.entries(scripts)) {
      if (!script.startsWith("test")) continue;
      expect(cmd.includes(";") || cmd.includes("|"), `${script} chains with something other than &&`).toBe(false);
      for (const raw of cmd.split("&&")) {
        const words = raw.trim().split(/\s+/);
        if (words[0] !== "bun" || words[1] !== "test") continue;
        for (const flag of words.slice(2).filter((w) => w.startsWith("-"))) {
          expect(["--coverage"], `${script}: flag ${flag} is not one the parser knows to be value-less`).toContain(flag);
        }
      }
    }
  });

  test("every chain argument that is a directory ends in `/` (the shape expandLink reads)", () => {
    const { links } = liveInput();
    for (const { args } of links) {
      for (const a of args) {
        if (a.endsWith("/")) continue;
        let isDir = false;
        try {
          isDir = statSync(join(ROOT, a)).isDirectory();
        } catch {
          /* a file that is not on disk is a dead filter, not a directory */
        }
        expect(isDir, `${a} is a directory argument without a trailing slash`).toBe(false);
      }
    }
  });

  test("the exemption list names only scripts that exist and run everything", () => {
    const { singleProcessLinks } = liveInput();
    expect(singleProcessLinks.map((l) => l.script).sort()).toEqual([...SINGLE_PROCESS_SCRIPTS].sort());
    for (const l of singleProcessLinks) expect(l.args, `${l.script} is exempt only while it has no path argument`).toEqual([]);
  });

  test("every file that calls mock.module is ALONE in each bun test process that runs it", () => {
    expect(sharedLinkOffenders(liveInput())).toEqual([]);
  });

  test("the detector and the plain substring agree on every test file (a call form it cannot see is a red here, not a hole)", () => {
    const { allTestFiles: all } = liveInput();
    const disagree = all.filter((f) => {
      if (f === "src/test/mock-isolation.test.ts") return false; // quotes the forms in its fixtures
      const src = readFileSync(join(ROOT, f), "utf8");
      return MOCK_MODULE_SUBSTRING.test(src) !== MOCK_MODULE_CALL.test(src);
    });
    expect(disagree).toEqual([]);
  });

  test("every explicit file argument in a chain is on disk (beside other arguments a missing one is a silent name filter, exit 0)", () => {
    const { links, allTestFiles: all } = liveInput();
    const onDisk = new Set(all);
    for (const { script, args } of links) {
      for (const a of args) {
        if (a.endsWith("/")) continue;
        expect(onDisk.has(a), `${script}: ${a} is listed but not on disk`).toBe(true);
      }
    }
  });

  test("every file that calls mock.module is run by at least one chain", () => {
    expect(unrunMockFiles(liveInput())).toEqual([]);
  });

  /**
   * The directory arguments this rule replaced with hand lists, per chain — read off
   * main's package.json at the time (`git show ce5dfb4:package.json`). Listing files
   * by hand is what isolates the mock files; this keeps a new test file in either
   * directory from being silently skipped by a chain that used to run all of it.
   * `test:unit` is NOT listed for `src/watchers/`: it always ran a hand-picked
   * unit-only subset of that directory, and that is unchanged.
   */
  const DE_GLOBBED: Record<string, string[]> = {
    "src/watchers/": ["test", "test:handlers"],
    "src/profile/": ["test", "test:unit"],
  };

  test("a de-globbed directory is still run WHOLE by every chain that used to glob it", () => {
    const { links, allTestFiles: all } = liveInput();
    for (const [dir, scripts] of Object.entries(DE_GLOBBED)) {
      const under = all.filter((f) => f.startsWith(dir));
      expect(under.length).toBeGreaterThan(1);
      for (const script of scripts) {
        const run = new Set(links.filter((l) => l.script === script).flatMap((l) => expandLink(l.args, all)));
        expect(under.filter((f) => !run.has(f)), `${script} used to run all of ${dir} and now skips these`).toEqual([]);
      }
    }
  });
});
