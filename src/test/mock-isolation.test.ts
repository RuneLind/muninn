import { test, expect, describe } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
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
 * Why a test and not the CLAUDE.md paragraph alone: `bun test` runs files in a
 * path-hash order over the ABSOLUTE path (measured with the junit reporter — not
 * argv order, not alphabetical), so a mock that leaks into a shared process is
 * green on one machine and red on another. Measured twice on main, 2026-09-03 →
 * 09-06: `src/ai/haiku-direct.test.ts`'s `db/client.ts` mock in the first unit
 * chunk ran after the two `setupTestDb` files on macOS and before them on the
 * GitHub runner (`TypeError: getDb().unsafe is not a function`, 18 red runs);
 * then, once that was isolated, `src/watchers/anthropic.test.ts`'s partial mock
 * of `db/summary-candidates.ts` in the 14-file `bun test src/watchers/` link
 * reached `runner.test.ts` → `x.ts` on the runner's order (`SyntaxError: Export
 * named 'upsertDestinationCandidate' not found`) — green on both developer
 * machines. A directory argument is what hid the second one: one argument,
 * fourteen files.
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

  test("a mock file no chain runs is reported, not silently skipped", () => {
    expect(unrunMockFiles({ links, mockFiles: ["src/zz/lost.test.ts", "src/b/solo.test.ts"], allTestFiles: all })).toEqual([
      "src/zz/lost.test.ts",
    ]);
  });

  test("the call detector matches a call at line start and not the same words in prose or a regex", () => {
    expect(MOCK_MODULE_CALL.test('import x;\nmock.module("../db/client.ts", () => ({}));')).toBe(true);
    expect(MOCK_MODULE_CALL.test('  mock.module("./a.ts", () => ({}));')).toBe(true);
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

  test("every file that calls mock.module is ALONE in each bun test process that runs it", () => {
    expect(sharedLinkOffenders(liveInput())).toEqual([]);
  });

  test("every file that calls mock.module is run by at least one chain", () => {
    expect(unrunMockFiles(liveInput())).toEqual([]);
  });

  test("the two directories this rule de-globbed still run every file under them in `test`", () => {
    // `src/watchers/` and `src/profile/` used to be one directory argument each; listing
    // files by hand is what isolates the mock files, and this is what keeps a new test
    // file in either directory from being silently skipped.
    const { links, allTestFiles: all } = liveInput();
    const run = new Set(links.filter((l) => l.script === "test").flatMap((l) => expandLink(l.args, all)));
    for (const f of all.filter((f) => f.startsWith("src/watchers/") || f.startsWith("src/profile/"))) {
      expect(run.has(f), `${f} is not run by the test chain`).toBe(true);
    }
  });
});
