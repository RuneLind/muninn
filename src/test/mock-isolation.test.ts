import { test, expect, describe } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  MOCK_ALIAS_IMPORT,
  MOCK_MODULE_CALL,
  bunTestLinks,
  expandLink,
  sharedLinkOffenders,
  unrunMockFiles,
} from "./mock-isolation.ts";

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
  const out: string[] = [];
  for (const dir of ["src", "db", "e2e"]) {
    for (const rel of new Bun.Glob("**/*.test.ts").scanSync({ cwd: join(ROOT, dir) })) {
      out.push(`${dir}/${rel}`);
    }
  }
  return out.sort();
}

function mockFiles(files: readonly string[]): string[] {
  return files.filter((f) => MOCK_MODULE_CALL.test(readFileSync(join(ROOT, f), "utf8")));
}

function liveInput() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const all = allTestFiles();
  return { links: bunTestLinks(pkg.scripts), mockFiles: mockFiles(all), allTestFiles: all, scripts: pkg.scripts };
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
    expect(MOCK_ALIAS_IMPORT.test('import { mock, test } from "bun:test";')).toBe(false);
    expect(MOCK_MODULE_CALL.test(" * a file that mock.module()s a db module\nconst r = /mock\\.module\\(/;")).toBe(false);
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

  /**
   * `bun test --coverage` is bun's whole-repo, single-process run: every mock in
   * the tree leaks into every other file there, and coverage cannot be collected
   * across processes. It is a developer-only script whose numbers are known to be
   * mock-contaminated; it is exempted BY NAME so the exemption is visible here
   * rather than falling out of a zero-argument link the rule never saw.
   */
  const SINGLE_PROCESS_SCRIPTS = new Set(["test:coverage"]);

  test("the exemption list names only scripts that exist and run everything", () => {
    const { links } = liveInput();
    for (const script of SINGLE_PROCESS_SCRIPTS) {
      const own = links.filter((l) => l.script === script);
      expect(own).toHaveLength(1);
      expect(own[0]!.args).toEqual([]);
    }
  });

  test("every file that calls mock.module is ALONE in each bun test process that runs it", () => {
    const input = liveInput();
    const links = input.links.filter((l) => !SINGLE_PROCESS_SCRIPTS.has(l.script));
    expect(sharedLinkOffenders({ ...input, links })).toEqual([]);
  });

  test("every explicit file argument in a chain is on disk (a missing one is a silent name filter, not an error)", () => {
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
