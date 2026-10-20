import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Test files make temp dirs through `src/test/temp-dir.ts`, never with
 * `mkdtemp`/`mkdtempSync` directly.
 *
 * The helper records each dir and the preload removes them all when the run
 * ends. Before it, a full `bun run test` left temp dirs under TMPDIR (18
 * `muninn-popup-` dirs per run from one file alone), and a dev machine had
 * collected 2,000+. This guard reads the source only; it runs no tests.
 */

const ROOT = join(import.meta.dir, "..", "..");

/** A call, import or alias of either name; the name alone, as in this file's prose, does not match. */
const DIRECT = /\bmkdtemp(?:Sync)?\s*(?:\(|,|\}|as\b)/;

/** Test files allowed to call it directly, each with the reason. Empty today. */
const ALLOWED: Record<string, string> = {};

/** The source with comments removed, line count kept, so a comment may name the call. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** `file:line` of each direct call in `source`. */
function directCalls(file: string, source: string): string[] {
  return code(source)
    .split("\n")
    .flatMap((line, i) => (DIRECT.test(line) ? [`${file}:${i + 1}`] : []));
}

/** Tracked and untracked (not ignored) `*.test.ts` files, so a new file is checked before its first commit. */
function testFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.test.ts"], { cwd: ROOT });
  if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
  return [...new Set(out.stdout.toString().split("\0").filter(Boolean))];
}

describe("temp dir guard", () => {
  test("directCalls finds a call and skips a comment that names it", () => {
    const short = "mkdtemp";
    const name = short + "Sync";
    const src = [`// ${name}( in a comment`, `/* ${name}( */`, `const d = ${name}(join(tmpdir(), "x-"));`].join("\n");
    expect(directCalls("a.test.ts", src)).toEqual(["a.test.ts:3"]);
    expect(directCalls("b.test.ts", `import { ${name} } from "node:fs";`)).toEqual(["b.test.ts:1"]);
    expect(directCalls("c.test.ts", `import { ${name} as make, rmSync } from "node:fs";`)).toEqual(["c.test.ts:1"]);
    expect(directCalls("d.test.ts", `const { ${short}, rm } = await import("node:fs/promises");`)).toEqual(["d.test.ts:1"]);
    expect(directCalls("e.test.ts", `const d = await testTempDir(join(tmpdir(), "x-"));`)).toEqual([]);
  });

  test("no test file calls mkdtemp or mkdtempSync directly", () => {
    const files = testFiles();
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const rel of files) {
      if (rel in ALLOWED || !existsSync(join(ROOT, rel))) continue;
      offenders.push(...directCalls(rel, readFileSync(join(ROOT, rel), "utf8")));
    }
    expect(offenders).toEqual([]);
  });

  test("every allowlist entry still calls it directly", () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(directCalls(rel, readFileSync(join(ROOT, rel), "utf8")).length).toBeGreaterThan(0);
    }
  });

  test("the test preload removes the helper's dirs when the run ends", () => {
    expect(readFileSync(join(ROOT, "bunfig.toml"), "utf8")).toContain(`preload = ["./src/test/preload.ts"]`);
    const preload = code(readFileSync(join(ROOT, "src/test/preload.ts"), "utf8"));
    expect(preload).toContain(`import { removeTestTempDirs } from "./temp-dir.ts";`);
    expect(preload).toContain("afterAll(removeTestTempDirs);");
  });
});
