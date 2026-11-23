/** Test helper: a real git repo in a temp folder, with commits at chosen times. */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function git(cwd: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

export function write(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

/** Commit everything at an ISO time (the author's own when given); returns the sha. */
export function commitAt(cwd: string, iso: string, subject: string, authorIso = iso): string {
  const res = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "add", "-A"], { cwd, env: { PATH: process.env.PATH ?? "", HOME: cwd } });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
  const c = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", subject], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_AUTHOR_DATE: authorIso, GIT_COMMITTER_DATE: iso },
  });
  if (c.exitCode !== 0) throw new Error(c.stderr.toString());
  return git(cwd, "rev-parse", "HEAD");
}

/** A repo at `dir` whose origin is a bare clone named `<originName>.git` beside it,
 *  with `origin/main` set. */
export function repoWithOrigin(dir: string, bareParent: string, originName: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  mkdirSync(bareParent, { recursive: true });
  const bare = path.join(bareParent, `${originName}.git`);
  git(bareParent, "init", "-q", "--bare", bare);
  git(dir, "remote", "add", "origin", bare);
  return bare;
}

export function pushMain(dir: string): void {
  git(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(dir, "fetch", "-q", "origin", "main:refs/remotes/origin/main");
}

/** A real merge commit of `branch` at an ISO time, with both parents kept. */
export function mergeAt(cwd: string, iso: string, branch: string, subject: string): string {
  const res = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "merge", "-q", "--no-ff", "-m", subject, branch], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
  return git(cwd, "rev-parse", "HEAD");
}
