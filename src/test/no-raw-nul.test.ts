import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * No tracked text file holds a raw 0x00 byte.
 *
 * ripgrep (Claude Code's Grep tool) and ugrep treat a file with a NUL as
 * binary: a directory search drops every match from the NUL's buffer to the
 * end of the file. A raw NUL in `src/wiki/store.ts` hid `buildWikiIndex`,
 * `getWikiIndex` and `readWikiPage` from every search over `src/`. Write the
 * escape `"\u0000"` instead.
 */

const ROOT = join(import.meta.dir, "..", "..");

/** Extensions of tracked files that are binary by design. Add one here when a binary format joins the repo. */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf",
  "woff", "woff2", "ttf", "otf", "mp3", "mp4", "wav", "webm",
  "zip", "gz", "tgz", "sqlite", "db", "lockb",
]);

function isBinaryPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** 1-based line of the first 0x00 in `bytes`, or null when it holds none. */
function firstNulLine(bytes: Uint8Array): number | null {
  const at = bytes.indexOf(0);
  if (at < 0) return null;
  let line = 1;
  for (let i = 0; i < at; i++) if (bytes[i] === 10) line++;
  return line;
}

function trackedFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
  return out.stdout.toString().split("\0").filter(Boolean);
}

describe("raw NUL guard", () => {
  test("firstNulLine finds the line of the first 0x00", () => {
    expect(firstNulLine(new TextEncoder().encode("a\nb\u0000c\n"))).toBe(2);
    expect(firstNulLine(new TextEncoder().encode("a\\u0000b"))).toBeNull();
  });

  test("isBinaryPath reads the extension only", () => {
    expect(isBinaryPath("e2e/fixtures/shot.PNG")).toBe(true);
    expect(isBinaryPath("src/wiki/store.ts")).toBe(false);
    expect(isBinaryPath("Dockerfile")).toBe(false);
  });

  test("no tracked text file holds a raw 0x00 byte", () => {
    const files = trackedFiles();
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const rel of files) {
      if (isBinaryPath(rel)) continue;
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(join(ROOT, rel));
      } catch {
        continue; // deleted in the working tree, or a submodule/dir entry
      }
      const line = firstNulLine(bytes);
      if (line !== null) offenders.push(`${rel}:${line}`);
    }
    expect(offenders).toEqual([]);
  });
});
