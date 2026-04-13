/**
 * Worktree manager for benchmark runs.
 *
 * Each benchmark issue freezes a set of repos at specific baseCommits — the
 * state of each repo just before the issue was implemented. The runner uses
 * `git worktree add` to materialise these as separate working directories
 * under benchmarks/worktrees/<issue>/<repo>, so Serena and Yggdrasil can
 * point at code that doesn't have the fix in it.
 *
 * Worktrees are created lazily and reused across cells — they're cheap to
 * keep around and re-creating them on every cell would mean re-indexing
 * Serena/Yggdrasil too. cleanupWorktrees() exists for explicit teardown
 * but isn't called on the happy path.
 */

import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { getLog } from "../logging.ts";
import type { BenchmarkManifest, RepoRef } from "./types.ts";

const log = getLog("benchmarks", "worktree");

/**
 * Where worktrees live. Default: a sibling of the muninn repo so that
 * `bun test`'s recursive test-file discovery never sees them. (Bun's
 * test path filter is a substring match, so worktrees inside the muninn
 * tree get picked up by `bun test src/utils/` — see Bug 6 in known-bugs.)
 *
 * Override with $BENCHMARK_WORKTREE_ROOT if you need them elsewhere.
 */
const WORKTREE_ROOT = process.env.BENCHMARK_WORKTREE_ROOT
  ? resolve(process.env.BENCHMARK_WORKTREE_ROOT)
  : resolve(import.meta.dir, "../../../muninn-bench-worktrees");

export interface PreparedWorktree {
  repo: string;
  /** Source repo path (the manifest's repos[].path) */
  sourcePath: string;
  /** Worktree path that Serena/Yggdrasil point at */
  worktreePath: string;
  /** baseCommit SHA the worktree is checked out at */
  sha: string;
  /** True if the worktree already existed (idempotent reuse) */
  reused: boolean;
}

/**
 * Prepare worktrees for every repo in the manifest. Refuses to run if any
 * baseCommit or repo path is missing or set to "TODO" — the manifest must
 * be fully filled in before Phase 1 can use it.
 */
export async function prepareWorktrees(
  manifest: BenchmarkManifest,
): Promise<PreparedWorktree[]> {
  validateManifestForWorktrees(manifest);
  mkdirSync(WORKTREE_ROOT, { recursive: true });

  const results: PreparedWorktree[] = [];
  for (const repo of manifest.repos) {
    const sha = manifest.baseCommits[repo.name];
    if (!sha) {
      // Already validated — defensive
      throw new Error(`Manifest ${manifest.issueKey}: missing baseCommit for ${repo.name}`);
    }
    const prepared = await prepareOneWorktree(manifest.issueKey, repo, sha);
    results.push(prepared);
  }
  return results;
}

async function prepareOneWorktree(
  issueKey: string,
  repo: RepoRef,
  sha: string,
): Promise<PreparedWorktree> {
  const worktreePath = resolve(WORKTREE_ROOT, issueKey, repo.name);

  // Idempotency: if the worktree already exists at this path, check it's at
  // the right SHA and reuse it. If it exists at a different SHA, hard-reset
  // to the requested one (the user changed baseCommit in the manifest).
  if (existsSync(worktreePath)) {
    const currentSha = await gitRevParse(worktreePath, "HEAD").catch(() => null);
    if (currentSha === sha) {
      log.info("Worktree {issue}/{repo} already at {sha} — reusing", {
        botName: "benchmarks",
        issue: issueKey,
        repo: repo.name,
        sha: sha.slice(0, 12),
      });
      return { repo: repo.name, sourcePath: repo.path, worktreePath, sha, reused: true };
    }
    log.warn("Worktree {issue}/{repo} is at {current} but manifest wants {wanted} — resetting", {
      botName: "benchmarks",
      issue: issueKey,
      repo: repo.name,
      current: currentSha?.slice(0, 12) ?? "unknown",
      wanted: sha.slice(0, 12),
    });
    await runGit(worktreePath, ["reset", "--hard", sha]);
    return { repo: repo.name, sourcePath: repo.path, worktreePath, sha, reused: true };
  }

  // Fresh worktree. Use `git -C <source>` so we don't depend on cwd.
  // --detach because we don't want to create a branch — the worktree is a
  // throwaway snapshot, not a place anyone commits to.
  log.info("Creating worktree {issue}/{repo} at {sha}", {
    botName: "benchmarks",
    issue: issueKey,
    repo: repo.name,
    sha: sha.slice(0, 12),
  });

  await runGit(repo.path, ["worktree", "add", "--detach", worktreePath, sha]);

  return { repo: repo.name, sourcePath: repo.path, worktreePath, sha, reused: false };
}

/**
 * Remove all worktrees for an issue. Not called on the happy path — the
 * runner reuses worktrees across cells. Provided for explicit cleanup
 * (e.g. when a baseCommit changes and you want a clean slate).
 */
export async function cleanupWorktrees(manifest: BenchmarkManifest): Promise<void> {
  for (const repo of manifest.repos) {
    const worktreePath = resolve(WORKTREE_ROOT, manifest.issueKey, repo.name);
    if (!existsSync(worktreePath)) continue;
    log.info("Removing worktree {issue}/{repo}", {
      botName: "benchmarks",
      issue: manifest.issueKey,
      repo: repo.name,
    });
    // git -C <source> worktree remove --force <path>
    await runGit(repo.path, ["worktree", "remove", "--force", worktreePath]).catch(
      (err) => {
        log.warn("worktree remove failed for {repo}: {error}", {
          botName: "benchmarks",
          repo: repo.name,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }
}

function validateManifestForWorktrees(manifest: BenchmarkManifest): void {
  if (!manifest.repos || manifest.repos.length === 0) {
    throw new Error(
      `Manifest ${manifest.issueKey}: no repos defined — fill in repos[] before running the benchmark`,
    );
  }
  for (const repo of manifest.repos) {
    if (!repo.path || repo.path === "TODO") {
      throw new Error(
        `Manifest ${manifest.issueKey}: repos[${repo.name}].path is missing or TODO`,
      );
    }
    if (!existsSync(repo.path)) {
      throw new Error(
        `Manifest ${manifest.issueKey}: repos[${repo.name}].path does not exist on disk: ${repo.path}`,
      );
    }
    const sha = manifest.baseCommits[repo.name];
    if (!sha || sha === "TODO") {
      throw new Error(
        `Manifest ${manifest.issueKey}: baseCommits.${repo.name} is missing or TODO`,
      );
    }
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      throw new Error(
        `Manifest ${manifest.issueKey}: baseCommits.${repo.name} is not a valid git SHA: ${sha}`,
      );
    }
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} (in ${cwd}) failed (${exitCode}): ${stderr.trim() || stdout.trim()}`,
    );
  }
  return stdout.trim();
}

async function gitRevParse(cwd: string, ref: string): Promise<string> {
  return runGit(cwd, ["rev-parse", ref]);
}
