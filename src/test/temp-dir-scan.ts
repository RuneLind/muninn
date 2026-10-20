/**
 * The scan behind `src/test/temp-dir-guard.test.ts`: test code makes temp dirs
 * through `src/test/temp-dir.ts`, never directly.
 *
 * It parses each file with the TypeScript compiler, so comments and the text
 * inside strings are never mistaken for code, and it refuses the name rather
 * than a call shape: any identifier or property name `mkdtemp`/`mkdtempSync`
 * (a call, an import, an alias, `promisify(fs.mkdtemp)`, a destructure) and any
 * string that is exactly one of those names (`fs["mkdtempSync"]`). A string or
 * template that names the shell's `mktemp` is refused too, for `Bun.$`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

const NAME = /^mkdtemp(?:Sync)?$/;
const SHELL = /\bmktemp\b/;

export interface SourceEntry {
  path: string;
  source: string;
}

function refused(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return NAME.test(node.text);
  if (ts.isStringLiteralLike(node)) return NAME.test(node.text) || SHELL.test(node.text);
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return SHELL.test(node.text);
  return false;
}

/** `path:line` of each direct use in one file, one entry per line. */
export function directUses(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const lines = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (refused(node)) lines.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...lines].sort((a, b) => a - b).map((line) => `${path}:${line}`);
}

/** Direct uses across `entries`, skipping each path in `allowed`. */
export function scanForDirectUses(entries: SourceEntry[], allowed: Record<string, string>): string[] {
  return entries.filter((e) => !Object.hasOwn(allowed, e.path)).flatMap((e) => directUses(e.path, e.source));
}

/**
 * The files the guard reads under `root`: every `*.test.ts` and every file in
 * `src/test/` (the shared test helpers), tracked or untracked but not ignored,
 * so a new file is checked before its first commit. A tracked file deleted from
 * the working tree is left out.
 */
export function listGuardedFiles(root: string): string[] {
  const out = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.test.ts", "src/test/*.ts"],
    { cwd: root },
  );
  if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
  const files = new Set(out.stdout.toString().split("\0").filter(Boolean));
  return [...files].filter((rel) => existsSync(join(root, rel))).sort();
}

export function readEntries(root: string, files: string[]): SourceEntry[] {
  return files.map((path) => ({ path, source: readFileSync(join(root, path), "utf8") }));
}
