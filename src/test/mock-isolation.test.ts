import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A test file that `mock.module()`s `src/db/client.ts` must run in a `bun test`
 * process of its own — the ONLY argument of its `&&` link, in every chain that
 * runs it.
 *
 * Why this is a test and not a comment: `bun test` runs files in ITS OWN order
 * (a path-hash order, measured — not argv order, not alphabetical), and that
 * order differs between the laptop, the mini and a GitHub runner because the
 * absolute paths differ. `mock.module` then applies to every file loaded AFTER
 * it in the same process: `src/ai/haiku-direct.test.ts` sat in the first unit
 * chunk, on macOS it happened to run after the two `setupTestDb` files and the
 * chain was green, on ubuntu it ran before them and `getDb()` answered the
 * mock — `TypeError: getDb().unsafe is not a function` in `setup-db.ts`, red on
 * main for 18 runs (2026-09-03 → 2026-09-05) while passing locally. A directory
 * argument covers the file too, so `src/ai/` in a link would re-open the hole
 * without naming the file.
 */

const ROOT = join(import.meta.dir, "..", "..");
const MOCKS_DB_CLIENT = /mock\.module\(\s*["'][^"']*\bdb\/client\.ts["']/;

function testFilesUnder(...dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    for (const rel of new Bun.Glob("**/*.test.ts").scanSync({ cwd: join(ROOT, dir) })) {
      out.push(`${dir}/${rel}`);
    }
  }
  return out.sort();
}

function filesMockingDbClient(): string[] {
  return testFilesUnder("src", "db").filter((f) =>
    MOCKS_DB_CLIENT.test(readFileSync(join(ROOT, f), "utf8")),
  );
}

/** Every `bun test <args…>` link of every `test*` script, as its argument list. */
function bunTestLinks(): Array<{ script: string; args: string[] }> {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const links: Array<{ script: string; args: string[] }> = [];
  for (const [script, cmd] of Object.entries(pkg.scripts)) {
    if (!script.startsWith("test")) continue;
    for (const raw of cmd.split("&&")) {
      const words = raw.trim().split(/\s+/);
      if (words[0] !== "bun" || words[1] !== "test") continue;
      links.push({ script, args: words.slice(2).filter((w) => !w.startsWith("-")) });
    }
  }
  return links;
}

function covers(arg: string, file: string): boolean {
  return arg === file || (arg.endsWith("/") && file.startsWith(arg));
}

test("the files that mock db/client.ts exist, so the rule below has something to pin", () => {
  expect(filesMockingDbClient()).toContain("src/ai/haiku-direct.test.ts");
  expect(filesMockingDbClient()).toContain("src/scheduler/executor.test.ts");
});

test("every file that mocks db/client.ts is ALONE in each `bun test` link that runs it", () => {
  const offenders: string[] = [];
  for (const file of filesMockingDbClient()) {
    for (const { script, args } of bunTestLinks()) {
      if (!args.some((a) => covers(a, file))) continue;
      if (args.length !== 1) {
        offenders.push(`${script}: ${file} shares a link with ${args.length - 1} other argument(s)`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("every file that mocks db/client.ts is run by at least one chain (an unlisted file is not isolated, it is skipped)", () => {
  for (const file of filesMockingDbClient()) {
    expect(bunTestLinks().some(({ args }) => args.some((a) => covers(a, file)))).toBe(true);
  }
});
