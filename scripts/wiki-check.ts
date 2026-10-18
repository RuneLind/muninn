#!/usr/bin/env bun
/**
 * The component author check (`src/wiki/lint-components.ts`) over a page or a
 * directory, with no wiki index, no database and no `.env`:
 *
 *   bun --no-env-file scripts/wiki-check.ts <absolute page or directory path>
 *
 * Prints one JSON line per finding (`{check, relPath, line, message, detail}`)
 * and nothing else. A page must be an `.mdx` file. A directory runs every `.mdx`
 * under it except under `blogs/src/`, `node_modules` and dot directories.
 * `relPath` is relative to the nearest ancestor holding `.wiki-reader.json`,
 * else to the given directory (or the page's own folder). Exits 0 whether or
 * not there are findings; 2 on a usage error or an unreadable path.
 */

import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { checkComponents } from "../src/wiki/lint-components.ts";
import type { LintFinding } from "../src/wiki/lint.ts";

const USAGE = "usage: bun --no-env-file scripts/wiki-check.ts <absolute .mdx page or directory path>";

/** The nearest directory at or above `dir` holding `.wiki-reader.json`. */
export function wikiRootFor(dir: string): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".wiki-reader.json"))) return d;
    if (path.dirname(d) === d) return null;
  }
}

/** Every `.mdx` under `dir`, sorted, outside `blogs/src/`, `node_modules` and dot directories. */
export function mdxFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        if (e.name === "src" && path.basename(d) === "blogs") continue;
        walk(p);
      } else if (e.isFile() && e.name.endsWith(".mdx")) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** The findings for an absolute `.mdx` page or directory path. Throws on an
 *  unreadable path. */
export async function wikiCheck(target: string): Promise<LintFinding[]> {
  const isDir = statSync(target).isDirectory();
  const base = isDir ? target : path.dirname(target);
  const root = wikiRootFor(base) ?? base;
  const files = isDir ? mdxFilesUnder(target) : [target];
  const out: LintFinding[] = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    out.push(...checkComponents(rel, await Bun.file(file).text()));
  }
  return out;
}

/** The exit code and the lines to print for one invocation. */
export async function runWikiCheck(args: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const target = args[0];
  if (args.length !== 1 || !target || !path.isAbsolute(target)) return { code: 2, out: [], err: [USAGE] };
  let isDir: boolean;
  try {
    isDir = statSync(target).isDirectory();
  } catch (e) {
    return { code: 2, out: [], err: [`wiki-check: cannot read ${target}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`] };
  }
  if (!isDir && !target.endsWith(".mdx")) return { code: 2, out: [], err: [`wiki-check: not an .mdx page: ${target}`, USAGE] };
  try {
    return { code: 0, out: (await wikiCheck(target)).map((f) => JSON.stringify(f)), err: [] };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { code: 2, out: [], err: [`wiki-check: cannot read ${err.path ?? target}: ${err.code ?? err.message}`] };
  }
}

if (import.meta.main) {
  const { code, out, err } = await runWikiCheck(process.argv.slice(2));
  for (const line of out) process.stdout.write(`${line}\n`);
  for (const line of err) process.stderr.write(`${line}\n`);
  process.exit(code);
}
