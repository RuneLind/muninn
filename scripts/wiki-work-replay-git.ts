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

/**
 * The shell each git runs under, as the leader of its own session and process
 * group (`detached`): it starts a watchdog in that group, then `exec`s git with
 * stdin from /dev/null. The watchdog blocks on the script's end of the stdin
 * pipe and SIGKILLs the whole group once it closes, which happens when the
 * script exits for any reason, a SIGKILL included. Until then the watchdog keeps
 * the group alive, so a group kill reaches only processes git started, including
 * one a hook left behind with `&` (ppid 1). One that calls `setsid` leaves the
 * group and is not reached.
 */
const WATCHDOG_SHELL = 'exec 3<&0 </dev/null; { read -r _ <&3; kill -s KILL 0; } >/dev/null 2>&1 & exec 3<&-; exec "$@"';

interface GitChild {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  /** Set once the group is SIGKILLed; it is never signalled after that. */
  killed: boolean;
}

/** The git children whose group is not yet killed, so a signal can stop them
 *  before the clone they write into is removed. */
const gitChildren = new Set<GitChild>();

/** SIGKILL `c`'s process group, once. The watchdog keeps the group alive until
 *  this kill, so the group id cannot name another group. */
function killGroup(c: GitChild): void {
  if (c.killed) return;
  c.killed = true;
  try {
    process.kill(-c.proc.pid, "SIGKILL");
  } catch {
    // The group is gone: the script's stdin end closed early and the watchdog
    // killed it, or someone outside killed every member.
  }
}

/** Send `sig` to every git child's group not yet killed (SIGSTOP and SIGCONT,
 *  for job control). */
function signalGroups(sig: "SIGSTOP" | "SIGCONT"): void {
  for (const c of gitChildren) {
    if (c.killed) continue;
    try {
      process.kill(-c.proc.pid, sig);
    } catch {
      // the group is gone
    }
  }
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["/bin/sh", "-c", WATCHDOG_SHELL, "sh", "git", "-C", cwd, "-c", "core.quotePath=false", ...args], {
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const child: GitChild = { proc, killed: false };
  gitChildren.add(child);
  try {
    const out = new Response(proc.stdout).text();
    const err = new Response(proc.stderr).text();
    const code = await proc.exited;
    // What a hook left running in the group dies with git, before the output is
    // read: a child that holds git's stdout or stderr would hold the read too.
    killGroup(child);
    const [o, e] = await Promise.all([out, err]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${e.trim()}`);
    return o;
  } finally {
    killGroup(child);
    gitChildren.delete(child);
    try {
      proc.stdin.end();
    } catch {
      // already closed
    }
  }
}

/** SIGKILL each running git child's process group: git, its hooks and filters,
 *  and what they left in the group, so nothing writes into the clone after it
 *  is removed. Returns the git children killed. */
export function killGitChildren(): Subprocess[] {
  const running = [...gitChildren];
  for (const c of running) killGroup(c);
  return running.map((c) => c.proc);
}

/** SIGTSTP: stop every git child's group, then the script itself. A terminal's
 *  Ctrl-Z reaches only the script's group, and a group in another session
 *  ignores SIGTSTP, so the groups get SIGSTOP. */
export function suspend(): void {
  signalGroups("SIGSTOP");
  process.kill(process.pid, "SIGSTOP");
}

/** SIGCONT: resume the groups `suspend` stopped. */
export function resume(): void {
  signalGroups("SIGCONT");
}

/**
 * The script's signal handler, called with the signal's exit code (128 + n).
 * The first signal kills the git children's groups (`kill`), waits for them to
 * exit, runs `cleanup` and exits with its own code, also when `kill` throws or
 * `cleanup` rejects. A signal that arrives while that is in flight exits at
 * once with ITS code, without waiting, so a second Ctrl-C quits a stalled
 * removal (the clone may remain).
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
    let running: { exited: Promise<unknown> }[] = [];
    try {
      running = kill();
    } catch {
      // Remove the clone and exit all the same.
    }
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
