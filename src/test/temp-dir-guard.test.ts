import { test, expect, describe } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { testTempDirSync } from "./temp-dir.ts";
import { directUses, listGuardedFiles, readEntries, scanForDirectUses } from "./temp-dir-scan.ts";

/**
 * Test code makes temp dirs through `src/test/temp-dir.ts`, never with
 * `mkdtemp`/`mkdtempSync` directly.
 *
 * The helper records each dir and the preload removes them all when the run
 * ends. Before it, a full `bun run test` left temp dirs under TMPDIR (18
 * `muninn-popup-` dirs per run from one file alone), and a dev machine had
 * collected 2,000+. The scan itself is `src/test/temp-dir-scan.ts`.
 */

const ROOT = join(import.meta.dir, "..", "..");

/** Files allowed to use it directly, each with the reason. */
const ALLOWED: Record<string, string> = {
  "src/test/temp-dir.ts": "the helper itself makes the dirs it records",
};

// Built, so this file's own source names neither the shell command nor a bare name.
const SHELL_WORD = ["mk", "temp"].join("");

/** [case, source, refused]. The first rows are the variants a line regex missed or misread. */
const CASES: [string, string, boolean][] = [
  ["alias import", `import { mkdtempSync as m } from "node:fs";\nm("x");`, true],
  ["fs.mkdtempSync(", `import fs from "node:fs";\nfs.mkdtempSync("x");`, true],
  ["require mkdtemp", `require("fs").mkdtemp("x", cb);`, true],
  ["await mkdtemp(", `await mkdtemp("x");`, true],
  ["string literal that looks like a call", `const s = "mkdtempSync(";`, false],
  ["line comment", `// mkdtempSync(`, false],
  ["block comment", `/* mkdtempSync("x") */`, false],
  ["namespace import, reference passed", `import * as fs from "node:fs";\nconst make = fs.mkdtempSync;\nmake("x");`, true],
  ["promisify", `promisify(fs.mkdtemp)("x")`, true],
  ["bracket access", `fs["mkdtempSync"]("x")`, true],
  ["call split across lines", `fs.mkdtempSync\n  ("x")`, true],
  ["multi-line destructure", `const {\n  mkdtempSync\n} = fs;`, true],
  ["glob strings around a call", `const a = glob("docs/*.md");\nconst d = mkdtempSync("x");\nconst b = new Bun.Glob("src/**/x.ts");`, true],
  ["url in a string before a call", `const u = "http://x"; const d = mkdtempSync("x");`, true],
  ["' // ' in a string before a call", `const u = "a // b"; mkdtempSync("x");`, true],
  ["Bun.$ shell command", "await Bun.$`" + SHELL_WORD + " -d`;", true],
  ["Bun.$ shell command with a substitution", "await Bun.$`" + SHELL_WORD + " -d ${dir}/x`;", true],
  ["fs.promises.mkdtemp", `await fs.promises.mkdtemp("x")`, true],
  ["the helper", `const d = await testTempDir(join(tmpdir(), "x-"));`, false],
  ["a longer identifier", `const mkdtempSyncCalls = 0;`, false],
];

describe("temp dir scan", () => {
  for (const [name, source, want] of CASES) {
    test(`${want ? "refuses" : "allows"}: ${name}`, () => {
      expect(directUses("a.test.ts", source).length > 0).toBe(want);
    });
  }

  test("reports the line of each use", () => {
    const src = [`// mkdtempSync( in a comment`, `const x = 1;`, `const d = fs.mkdtempSync(\n  "x");`].join("\n");
    expect(directUses("a.test.ts", src)).toEqual(["a.test.ts:3"]);
  });

  test("scanForDirectUses reports an offending file, passes a clean one, skips an allowlisted one", () => {
    const entries = [
      { path: "new-untracked.test.ts", source: `fs.mkdtempSync("x");` },
      { path: "clean.test.ts", source: `testTempDirSync("x");` },
      { path: "allowed.ts", source: `mkdtempSync("x");` },
    ];
    expect(scanForDirectUses(entries, { "allowed.ts": "reason" })).toEqual(["new-untracked.test.ts:1"]);
    expect(scanForDirectUses(entries, {})).toEqual(["new-untracked.test.ts:1", "allowed.ts:1"]);
  });

  test("listGuardedFiles lists tracked and untracked test files and src/test helpers, not ignored or other files", () => {
    const repo = testTempDirSync(join(tmpdir(), "temp-dir-guard-repo-"));
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    git("init", "-q");
    mkdirSync(join(repo, "src", "test"), { recursive: true });
    mkdirSync(join(repo, "src", "a"), { recursive: true });
    for (const f of ["src/a/tracked.test.ts", "src/a/gone.test.ts", "src/test/tracked-helper.ts", "src/a/other.ts", ".gitignore"]) {
      writeFileSync(join(repo, f), f === ".gitignore" ? "ignored.test.ts\n" : "");
    }
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    rmSync(join(repo, "src/a/gone.test.ts"));
    for (const f of ["src/a/untracked.test.ts", "src/test/untracked-helper.ts", "src/a/ignored.test.ts", "src/a/untracked.ts"]) {
      writeFileSync(join(repo, f), "");
    }

    expect(listGuardedFiles(repo)).toEqual([
      "src/a/tracked.test.ts",
      "src/a/untracked.test.ts",
      "src/test/tracked-helper.ts",
      "src/test/untracked-helper.ts",
    ]);
  });
});

describe("temp dir guard", () => {
  test("no test file or shared test helper makes a temp dir directly", () => {
    const files = listGuardedFiles(ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("src/test/fake-messages-api.ts");
    expect(scanForDirectUses(readEntries(ROOT, files), ALLOWED)).toEqual([]);
  });

  test("every allowlist entry still uses it directly", () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(directUses(rel, readFileSync(join(ROOT, rel), "utf8")).length).toBeGreaterThan(0);
    }
  });

  test("the test preload removes the helper's dirs when the run ends", () => {
    expect(readFileSync(join(ROOT, "bunfig.toml"), "utf8")).toContain(`preload = ["./src/test/preload.ts"]`);
    const preload = ts.createSourceFile("preload.ts", readFileSync(join(ROOT, "src/test/preload.ts"), "utf8"), ts.ScriptTarget.Latest);
    const top = preload.statements.map((s) => s.getText(preload));
    expect(top).toContain(`import { removeTestTempDirs } from "./temp-dir.ts";`);
    expect(top).toContain("afterAll(removeTestTempDirs);");
  });
});
