/**
 * The git side of `scripts/wiki-work-replay.ts`: the commit it replays, the
 * mtimes it stamps on the clone, and the git children a signal must stop
 * before the clone is removed. Its own module so the test can drive
 * `stampMtimes` on a fixture without running the script.
 */

import { lutimes } from "node:fs/promises";
import path from "node:path";
import type { Subprocess } from "bun";

/** A failure the script explains in one stderr line instead of a stack. */
export class ReplayError extends Error {}

/** The git children still running, so a signal can stop them before the
 *  clone they write into is removed. */
export const gitChildren = new Set<Subprocess>();

export async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, "-c", "core.quotePath=false", ...args], { stdout: "pipe", stderr: "pipe" });
  gitChildren.add(proc);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err.trim()}`);
    return out;
  } finally {
    gitChildren.delete(proc);
  }
}

/** The newest first-parent commit committed at or before `atSec`. */
export async function commitAt(repo: string, atSec: number): Promise<{ sha: string; at: number }> {
  for (const line of (await git(repo, ["log", "--first-parent", "--format=%H %ct", "HEAD"])).split("\n")) {
    const [sha, t] = line.split(" ");
    if (sha && Number(t) <= atSec) return { sha, at: Number(t) };
  }
  throw new ReplayError("no commit committed at or before --at");
}

/** Every tracked file's mtime set to its last commit's committer time, clamped
 *  to `atSec`: an ancestor's committer clock can run ahead of its child's. A
 *  symlink gets its own mtime (`lutimes`), never its target's, which can lie
 *  outside the clone. */
export async function stampMtimes(repo: string, atSec: number): Promise<number> {
  const newest = new Map<string, number>();
  let t = 0;
  for (const line of (await git(repo, ["log", "--format=%x00%ct", "--name-only", "HEAD"])).split("\n")) {
    if (line.startsWith("\u0000")) t = Math.min(Number(line.slice(1)), atSec);
    else if (line && !newest.has(line)) newest.set(line, t);
  }
  let n = 0;
  for (const file of (await git(repo, ["ls-files"])).split("\n")) {
    const at = newest.get(file);
    if (!file || at === undefined) continue;
    try {
      await lutimes(path.join(repo, file), at, at);
      n++;
    } catch {
      // A file the checkout did not produce (a submodule path) keeps its time.
    }
  }
  return n;
}
