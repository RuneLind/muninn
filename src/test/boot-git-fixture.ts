/**
 * Throwaway repos for the boot record and line tests: a bare origin, a clone
 * that pushes to it (`work`), and the checkout muninn "started" from
 * (`clone`). Test-only; every git call here is off the global and system
 * config.
 */
import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "./temp-dir.ts";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
export const shIn = (cwd: string, input: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, input, stdio: ["pipe", "pipe", "ignore"] }).toString().trim();

let n = 0;
export function commit(dir: string, subject: string): string {
  writeFileSync(path.join(dir, "f"), `${subject} ${n++}\n`);
  sh(dir, "commit", "-q", "-am", subject);
  return sh(dir, "rev-parse", "HEAD");
}

export function push(work: string, subject: string, branch = "main"): string {
  const sha = commit(work, subject);
  sh(work, "push", "-q", "origin", `HEAD:${branch}`);
  return sha;
}

/** Fast-forward `dir`'s checked-out branch from origin. */
export function pull(dir: string): void {
  sh(dir, "pull", "-q", "--ff-only");
}

export interface BootFixture {
  base: string;
  remote: string;
  work: string;
  clone: string;
}

/** A bare origin with one commit «Start here (#864)» on main, the clone that pushes to it, and the checkout muninn starts from. */
export function bootFixture(): BootFixture {
  const base = realpathSync(testTempDirSync(path.join(tmpdir(), "boot-line-")));
  const remote = path.join(base, "muninn.git");
  const work = path.join(base, "work");
  const clone = path.join(base, "muninn");
  sh(base, "init", "-q", "--bare", "-b", "main", remote);
  sh(base, "clone", "-q", remote, work);
  writeFileSync(path.join(work, "f"), "one\n");
  writeFileSync(path.join(work, "g"), "two\n");
  sh(work, "add", "f", "g");
  sh(work, "commit", "-q", "-m", "Start here (#864)");
  sh(work, "push", "-q", "-u", "origin", "HEAD:main");
  sh(base, "clone", "-q", remote, clone);
  return { base, remote, work, clone };
}

/** `count` empty commits on `dir`'s current branch after HEAD, subjects from `subject(i)`, in ONE `git fast-import`. */
export function manyCommits(dir: string, count: number, subject: (i: number) => string): void {
  const branch = sh(dir, "symbolic-ref", "HEAD");
  const parent = sh(dir, "rev-parse", "HEAD");
  let stream = "";
  for (let i = 0; i < count; i++) {
    const msg = subject(i);
    stream += `commit ${branch}\ncommitter t <t@example.invalid> ${1_700_000_000 + i} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}\n${i === 0 ? `from ${parent}\n` : ""}\n`;
  }
  shIn(dir, stream, "fast-import", "--quiet", "--force");
  sh(dir, "reset", "-q", "--hard", "HEAD");
}
