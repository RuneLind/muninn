/**
 * The scratch copy behind `scripts/discuss-apply-scratch.ts`: a repository of
 * its own with no remote, whatever `src` is. A linked worktree's (or a
 * submodule's) `.git` is a `gitdir:` pointer file; a file copy kept the
 * pointer, so the copy shared the source's config, objects, HEAD and index,
 * and `git remote remove` in it removed the source's remote. So the copy is a
 * `git clone --no-hardlinks` (committed state only: uncommitted edits in `src`
 * are not in it), checked to own its git dir before any remote is removed.
 */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

type Env = Record<string, string | undefined>;

function git(env: Env | undefined, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe", env: (env ?? process.env) as Record<string, string> });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

/** Clones `src` into `dest` (which must not exist) and removes every remote of the clone; throws on any failure. */
export function scratchCopy(src: string, dest: string, env?: Env): void {
  if (!existsSync(path.join(src, ".git"))) throw new Error(`${src} is not the root of a git work tree`);
  if (existsSync(dest)) throw new Error(`${dest} exists already; name a new directory`);
  git(env, "clone", "--quiet", "--no-hardlinks", "--", src, dest);
  const common = git(env, "-C", dest, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
  const own = realpathSync(path.join(dest, ".git"));
  if (realpathSync(common) !== own) throw new Error(`the copy's git dir is ${common}, not ${own}; refusing to touch its remotes`);
  for (const remote of git(env, "-C", dest, "remote").split("\n").map((r) => r.trim()).filter(Boolean)) git(env, "-C", dest, "remote", "remove", remote);
  const remotes = git(env, "-C", dest, "remote");
  if (remotes.trim() !== "") throw new Error(`git remote still prints ${JSON.stringify(remotes)}; refusing to start (Apply would push)`);
}
