/**
 * The rule behind `mock-isolation.test.ts`, as pure functions over strings so the
 * rule itself can be tested on fixtures and then applied to the live package.json.
 *
 * `mock.module()` applies to every file loaded AFTER it in the same `bun test`
 * process, and `bun test` orders files by a hash of the absolute path — not by
 * argv, not alphabetically — so which files it reaches differs between a laptop,
 * the mini and a GitHub runner. The only placement that removes the order from
 * the outcome is the one CLAUDE.md prescribes: a file that calls `mock.module`
 * runs in a `bun test` process of its own. "Of its own" is measured on the FILES
 * the link expands to, not on its argument count — `bun test src/watchers/` is
 * one argument and fourteen files.
 */

/** A `mock.module(` call at the start of a line — never one quoted in prose or in a regex. */
export const MOCK_MODULE_CALL = /^\s*mock\.module\(/m;

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
 * every test file under it; anything else is taken as one file. A directory
 * argument WITHOUT the slash is not a shape the chains use (asserted by the test).
 */
export function expandLink(args: string[], allTestFiles: readonly string[]): string[] {
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
