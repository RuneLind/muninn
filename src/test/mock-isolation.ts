/**
 * The rule behind `mock-isolation.test.ts`, as pure functions over strings so the
 * rule itself can be tested on fixtures and then applied to the live package.json.
 *
 * `mock.module()` applies to every file loaded AFTER it in the same `bun test`
 * process, and `bun test` runs files in an order of its own — not argv order, not
 * alphabetical — that depends on the SET of files in the run: on the same GitHub
 * runner, main run #508 loaded `chat-config` before `haiku-direct` (green) and
 * #509, which added one test file and touched no chain, loaded them the other way
 * round (red); the mini ordered the same set differently again. So which files a
 * mock reaches is fixed per (machine, file set) and flips on any commit that adds
 * a test file. The only placement that removes the order from the outcome is the
 * one CLAUDE.md prescribes: a file that calls `mock.module` runs in a `bun test`
 * process of its own. "Of its own" is measured on the FILES the link expands to,
 * not on its argument count — `bun test src/watchers/` is one argument and
 * fourteen files, and `bun test` with no path at all is EVERY test file.
 */

/**
 * A `mock.module(` CALL: at the start of a line, optionally behind `await`/`void`,
 * an assignment, or a `bun:test` namespace (`bt.mock.module(`). Never one quoted
 * in prose or in a regex. The one form this cannot see is an aliased import
 * (`import { mock as m }`), which the live test asserts absent.
 */
export const MOCK_MODULE_CALL =
  /^\s*(?:await\s+|void\s+|(?:const|let|var)\s+\w+\s*=\s*)?(?:\w+\.)?mock\.module\(/m;
/** `import { mock as … } from "bun:test"` would hide a call from MOCK_MODULE_CALL. */
export const MOCK_ALIAS_IMPORT = /import\s*\{[^}]*\bmock\s+as\s+\w+[^}]*\}/;
/** The substring every call form contains — what MOCK_MODULE_CALL must agree with, file by file. */
export const MOCK_MODULE_SUBSTRING = /\bmock\.module\(/;

export interface BunTestLink {
  script: string;
  /** The link's positional arguments, flags removed. */
  args: string[];
}

/** Every `bun test <args…>` `&&`-link of every `test*` script. */
export function bunTestLinks(scripts: Record<string, string>): BunTestLink[] {
  const links: BunTestLink[] = [];
  for (const [script, cmd] of Object.entries(scripts)) {
    if (!script.startsWith("test")) continue;
    for (const raw of cmd.split("&&")) {
      const words = raw.trim().split(/\s+/);
      if (words[0] !== "bun" || words[1] !== "test") continue;
      links.push({ script, args: words.slice(2).filter((w) => !w.startsWith("-")) });
    }
  }
  return links;
}

/**
 * The test files a link runs: an argument ending in `/` is a directory and covers
 * every test file under it; anything else is taken as one file; NO positional
 * argument (`bun test --coverage`) is bun's whole-repo run — every test file. A
 * directory argument WITHOUT the slash is not a shape the chains use (asserted by
 * the test).
 */
export function expandLink(args: string[], allTestFiles: readonly string[]): string[] {
  if (args.length === 0) return [...allTestFiles];
  const files = new Set<string>();
  for (const arg of args) {
    if (arg.endsWith("/")) {
      for (const f of allTestFiles) if (f.startsWith(arg)) files.add(f);
    } else {
      files.add(arg);
    }
  }
  return [...files];
}

export interface IsolationInput {
  links: BunTestLink[];
  /** Test files (repo-relative) that call `mock.module`. */
  mockFiles: readonly string[];
  /** Every test file on disk (repo-relative). */
  allTestFiles: readonly string[];
}

/** One line per (mock file, link) pair where the link runs the mock file together with others. */
export function sharedLinkOffenders({ links, mockFiles, allTestFiles }: IsolationInput): string[] {
  const out: string[] = [];
  for (const { script, args } of links) {
    const files = expandLink(args, allTestFiles);
    if (files.length < 2) continue;
    for (const f of mockFiles) {
      if (files.includes(f)) {
        out.push(`${script}: ${f} shares a bun test process with ${files.length - 1} other file(s) (link: bun test ${args.join(" ")})`);
      }
    }
  }
  return out;
}

/** Mock files no `test*` chain runs at all — not isolated, skipped. */
export function unrunMockFiles({ links, mockFiles, allTestFiles }: IsolationInput): string[] {
  const run = new Set(links.flatMap((l) => expandLink(l.args, allTestFiles)));
  return mockFiles.filter((f) => !run.has(f));
}
