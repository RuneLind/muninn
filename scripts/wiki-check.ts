#!/usr/bin/env bun
/**
 * The component author check (`lint-components.ts`) over a page or a directory,
 * with no wiki index, no database and no `.env`:
 *
 *   bun --no-env-file scripts/wiki-check.ts <absolute page or directory path>
 *
 * Prints one JSON line per finding (`{check, relPath, line, message, detail}`)
 * and nothing else. A directory runs every `.mdx` under it except under
 * `blogs/src/`, `node_modules` and dot directories. `relPath` is relative to the
 * nearest ancestor holding `.wiki-reader.json`, else to the given directory (or
 * the page's own folder). Exits 0 whether or not there are findings; 2 on a
 * usage error or an unreadable path.
 */

import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { checkComponents, type ComponentFinding } from "../src/wiki/lint-components.ts";

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

/** The findings for an absolute page or directory path. */
export async function wikiCheck(target: string): Promise<ComponentFinding[]> {
  const isDir = statSync(target).isDirectory();
  const base = isDir ? target : path.dirname(target);
  const root = wikiRootFor(base) ?? base;
  const files = isDir ? mdxFilesUnder(target) : [target];
  const out: ComponentFinding[] = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    out.push(...checkComponents(rel, await Bun.file(file).text()));
  }
  return out;
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target || !path.isAbsolute(target) || process.argv.length > 3) {
    process.stderr.write("usage: bun --no-env-file scripts/wiki-check.ts <absolute page or directory path>\n");
    process.exit(2);
  }
  if (!existsSync(target)) {
    process.stderr.write(`wiki-check: no such path: ${target}\n`);
    process.exit(2);
  }
  for (const f of await wikiCheck(target)) process.stdout.write(`${JSON.stringify(f)}\n`);
}
