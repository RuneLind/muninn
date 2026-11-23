/**
 * Real git for the `pushed=` probe's tests: off the runner's global and system
 * config (a runner's git-lfs filter would answer every row `unknown`).
 */
import { realGit, type GitRun } from "../wiki/decision-triage/git.ts";

export const hermeticGit: GitRun = (cwd, args, opts) => realGit(cwd, args, { ...opts, env: { ...opts?.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });

/**
 * `base` (default {@link hermeticGit}), except `ls-remote --get-url origin` answers `url`: the
 * probe reads only a network origin, and the fixtures' origins are local bares.
 * Every other call, the live `ls-remote --heads` included, reaches the real repo.
 */
export const networkOrigin =
  (url = "https://example.invalid/skills.git", base: GitRun = hermeticGit): GitRun =>
  async (cwd, args, opts) =>
    args.join(" ") === "ls-remote --get-url origin" ? { ok: true, stdout: `${url}\n`, exitCode: 0 } : base(cwd, args, opts);
