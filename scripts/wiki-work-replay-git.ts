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
  // In the script's own process group, not `detached`: a group signal the
  // script does not handle (Ctrl-\, Ctrl-Z, a supervisor's group SIGKILL)
  // then reaches git and its hooks too, which a detached git escapes (the cost
  // `runGit` documents in `src/wiki/commit.ts`). A handled signal kills the
  // tree through `killGitChildren`.
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

/** `roots` and every process below them, each SIGSTOPped as it is found so
 *  none can fork a child the walk misses. A stopped parent cannot reap an
 *  exited child either, so no pid in the tree is reused before the kill. */
function stopTree(roots: number[]): number[] {
  const tree = new Set<number>();
  for (let found = roots; found.length > 0; ) {
    for (const pid of found) {
      tree.add(pid);
      try {
        process.kill(pid, "SIGSTOP");
      } catch {
        // already exited
      }
    }
    found = [];
    for (const line of Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="]).stdout.toString().split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid && ppid && tree.has(ppid) && !tree.has(pid)) found.push(pid);
    }
  }
  return [...tree];
}

/** SIGKILL each running git child and everything below it (a hook, an lfs
 *  smudge), so nothing writes into the clone after it is removed. A process
 *  that left the tree (`setsid` and a double fork) is not reached. Returns the
 *  git children killed. */
export function killGitChildren(): Subprocess[] {
  const running = [...gitChildren];
  for (const pid of stopTree(running.map((c) => c.pid))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
  }
  return running;
}

/**
 * The script's signal handler, called with the signal's exit code (128 + n).
 * The first signal kills the git children's trees (`kill`), waits for them to
 * exit, runs `cleanup` and exits with its own code, also when `cleanup`
 * rejects. A signal that arrives while that is in flight exits at once with ITS
 * code, without waiting, so a second Ctrl-C quits a stalled removal (the clone
 * may remain).
 */
export function signalHandler(
  cleanup: () => Promise<void>,
  exit: (code: number) => void = process.exit,
  kill: () => { exited: Promise<unknown> }[] = killGitChildren,
): (code: number) => void {
  let stopping = false;
  return (code) => {
    if (stopping) return exit(code);
    stopping = true;
    const running = kill();
    void Promise.all(running.map((c) => c.exited))
      .then(cleanup)
      .then(
        () => exit(code),
        () => exit(code),
      );
  };
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
