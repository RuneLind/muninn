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
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A `mock.module(` CALL: at the start of a line, optionally behind `await`/`void`,
 * an assignment, or a `bun:test` namespace (`bt.mock.module(`). Never one quoted
 * in prose or in a regex. The live test asserts this regex and MOCK_MODULE_SUBSTRING
 * agree on every test file, so a form the call regex cannot see is a red rather
 * than a hole — as long as the substring sees it. RESIDUAL, deferred (#526 round-3
 * verify pass): spellings NEITHER regex sees — `mock.module (`, `mock . module(`,
 * `mock["module"](` — and alias forms MOCK_ALIAS_IMPORT does not see — `export {
 * mock as m }`, `import def, { mock as m }`. None of the 386 test files uses any
 * of them (swept 2026-09-06), and the repo has no formatter that would normalize
 * them, so a future file could; a follow-up widens the substring to
 * `\bmock\s*(?:\.\s*module|\[\s*["']module["']\s*\])\s*\(` and the alias check to
 * `\bmock\s+as\s+\w+\s*[,}]`.
 */
export const MOCK_MODULE_CALL =
  /^\s*(?:await\s+|void\s+|(?:const|let|var)\s+\w+\s*=\s*)?(?:\w+\.)?mock\.module\(/m;
/** `import { …, mock as m } from …` would hide a call from MOCK_MODULE_CALL (the specifier is not checked). */
export const MOCK_ALIAS_IMPORT = /import\s*\{[^}]*\bmock\s+as\s+\w+[^}]*\}/;
/** The substring every call form contains — what MOCK_MODULE_CALL must agree with, file by file. */
export const MOCK_MODULE_SUBSTRING = /\bmock\.module\(/;

/**
 * The files `bun test` discovers under a root, as bun 1.3.10 does (measured; the
 * conformance tests in mock-isolation.test.ts spawn bun to hold it there): a
 * `.test`/`_test`/`.spec`/`_spec` suffix before a JS/TS extension, case-insensitive;
 * every directory below the root except `node_modules` and hidden ones (a hidden
 * FILE is run). `.gitignore` is not read. Symlinked directories, which bun follows,
 * are not: the tracked tree has none.
 */
export const BUN_TEST_FILE = /[._](test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i;

export function discoverTestFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!e.name.startsWith(".") && e.name !== "node_modules") out.push(...discoverTestFiles(root, p));
    } else if (e.isFile() && BUN_TEST_FILE.test(e.name)) {
      out.push(p);
    }
  }
  return rel ? out : out.sort();
}

/** Playwright's files, not bun's (playwright.config.ts: testDir `./e2e`, testMatch `**\/*.spec.ts`). */
export function isPlaywrightSpec(file: string): boolean {
  return file.startsWith("e2e/") && file.endsWith(".spec.ts");
}

/**
 * `bun test --coverage` is bun's whole-repo, single-process run: every mock in the
 * tree leaks into every other file there, and coverage cannot be collected across
 * processes. It is a developer-only script whose numbers are known to be
 * mock-contaminated; it is exempted BY NAME so the exemption is visible rather
 * than falling out of a zero-argument link the rule never saw. `scripts/count-tests.ts`
 * reads the same set, so a second single-process chain added here is excluded there too.
 */
export const SINGLE_PROCESS_SCRIPTS: ReadonlySet<string> = new Set(["test:coverage"]);

/**
 * Test files that need a process of their own for a reason other than
 * `mock.module`: a file that installs happy-dom's `GlobalWindow` puts its globals
 * (`Event`, `URL`, `fetch`, timers, ~500 keys) over Bun's for the life of the
 * process. `src/dashboard/views/wiki-boot/` is one by directory, for a second
 * reason too: `boot()` leaves module state behind (initChatOptions's dialog
 * listeners and deps), which broke 14 `wiki-chat-options.test.ts` tests run in
 * one process with it. Elsewhere, a file is one by content ({@link HAPPY_DOM_GLOBALS}).
 * The same rule as a mock file applies — alone in every link that runs it, and
 * run by some chain — so it is read through the same links.
 */
export const OWN_PROCESS_DIRS = ["src/dashboard/views/wiki-boot/"] as const;

/**
 * A static import of happy-dom's `GlobalWindow` at the start of a line, so one
 * quoted in a fixture string is not one (a private `new Window()` installs
 * nothing global). Detected: a named import (`{ GlobalWindow }`, also across
 * lines), an aliased one (`{ GlobalWindow as GW }`) and default plus named
 * (`import HappyDom, { GlobalWindow }`). NOT detected: a namespace import
 * (`import * as hd`), a dynamic `import("happy-dom")`, a re-export, a subpath
 * (`happy-dom/lib/...`), `@happy-dom/global-registrator`, and a non-test helper
 * module that imports `GlobalWindow` and is imported by a test — the source of
 * each test file is read, not its import graph.
 */
export const HAPPY_DOM_GLOBALS = /^\s*import\s*(?:[\w$]+\s*,\s*)?\{[^}]*\bGlobalWindow\b[^}]*\}\s*from\s*["']happy-dom["']/m;

/** The test files under {@link OWN_PROCESS_DIRS}, plus any whose source imports `GlobalWindow` from happy-dom. */
export function ownProcessFiles(allTestFiles: readonly string[], readSource: (file: string) => string): string[] {
  return allTestFiles.filter((f) => OWN_PROCESS_DIRS.some((d) => f.startsWith(d)) || HAPPY_DOM_GLOBALS.test(readSource(f)));
}

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
 * The test files a link runs, as bun matches its arguments (measured on 1.3.10):
 * an argument is a case-sensitive SUBSTRING of the file's root-relative path, so
 * `src/plans/` also runs `sub/src/plans/b.test.ts` and `a.test.ts` also runs
 * `a.test.tsx`; an argument starting `./` is a path, the file itself or every
 * file under that directory. NO positional argument (`bun test --coverage`) is
 * bun's whole-repo run: every test file. A file argument that matches nothing is
 * returned as itself, so callers report it as not on disk.
 */
export function expandLink(args: string[], allTestFiles: readonly string[]): string[] {
  if (args.length === 0) return [...allTestFiles];
  const files = new Set<string>();
  for (const arg of args) {
    const path = arg.startsWith("./") ? arg.slice(2).replace(/\/$/, "") : null;
    const hits = allTestFiles.filter((f) => (path === null ? f.includes(arg) : f === path || f.startsWith(`${path}/`)));
    if (hits.length === 0 && !arg.endsWith("/")) files.add(arg);
    for (const f of hits) files.add(f);
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
