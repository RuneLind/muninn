/**
 * The boot record (mimir plan «Drain the owner-step queue», P1): what this
 * process started from, read once at start and kept in memory. `src/index.ts`
 * calls {@link startBootRecord} before its dynamic imports and never awaits
 * it; `GET /api/wiki/boot-line` reads it through {@link bootRecord}.
 *
 * Three git reads in the checkout that holds this file (never the working
 * directory), each under the probes' local bound: `rev-parse` for the commit,
 * then one `status` for the branch and whether tracked files differ, then the
 * commit's subject. A failed or slow read, or a `status` naming another commit
 * than `rev-parse` did (a pull landed in between), gives an unknown record.
 * `realGit` adds `--no-optional-locks`; every call carries `CHECKOUT_GIT_ENV`.
 */

import { realGit, type GitResult, type GitRun } from "../decision-triage/git.ts";
import { CHECKOUT_GIT_ENV, GIT_LOCAL_MS } from "./probes.ts";

export type BootRecord =
  | {
      known: true;
      /** The checkout's toplevel: the line reads it again there. */
      dir: string;
      commit: string;
      /** Null on a detached HEAD. */
      branch: string | null;
      /** Tracked files differed from the commit at start. */
      dirty: boolean;
      /** The `(#N)` the commit's subject ends in, if any. */
      pr: number | null;
      at: number;
    }
  | { known: false; reason: string; at: number };

const PR_SUFFIX = /\(#(\d+)\)\s*$/;

/** The `(#N)` a squash commit's subject ends in, or null. */
export function prOfSubject(subject: string): number | null {
  const m = PR_SUFFIX.exec(subject);
  return m ? Number(m[1]) : null;
}

/** `git status --porcelain=v2 --branch -z` → the commit, the branch (null when detached) and whether any entry is listed. */
export function parseStatusV2(stdout: string): { oid: string | null; branch: string | null; dirty: boolean } {
  let oid: string | null = null;
  let branch: string | null = null;
  let dirty = false;
  for (const entry of stdout.split("\0")) {
    if (entry === "") continue;
    if (entry.startsWith("# branch.oid ")) oid = entry.slice(13);
    else if (entry.startsWith("# branch.head ")) {
      const head = entry.slice(14);
      branch = head === "(detached)" ? null : head;
    } else if (!entry.startsWith("#")) dirty = true;
  }
  return { oid, branch, dirty };
}

/** The status read both the record and the line use: tracked files only, fsmonitor off. */
export const STATUS_ARGS = ["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"] as const;

const why = (res: GitResult, what: string) => (res.timedOut ? `git ${what} timed out at start` : `git ${what} failed at start`);

export async function takeBootRecord(dir: string, rawGit: GitRun = realGit, now: () => number = Date.now): Promise<BootRecord> {
  const at = now();
  const git: GitRun = (cwd, args, opts) => rawGit(cwd, args, { ...opts, env: { ...opts?.env, ...CHECKOUT_GIT_ENV } });
  const unknown = (reason: string): BootRecord => ({ known: false, reason, at });
  const head = await git(dir, ["rev-parse", "--show-toplevel", "HEAD"], { timeoutMs: GIT_LOCAL_MS, maxLines: 3 });
  if (!head.ok || head.exitCode !== 0) {
    if (/not a git repository/i.test(head.stderr ?? "")) return unknown("muninn did not start from a git checkout");
    if (head.exitCode === undefined && !head.timedOut) return unknown("git could not run at start");
    return unknown(why(head, "rev-parse"));
  }
  const [top, commit] = head.stdout.split("\n");
  if (!top || !commit || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) return unknown("git rev-parse gave an answer muninn cannot read");
  const status = await git(top, STATUS_ARGS, { timeoutMs: GIT_LOCAL_MS });
  if (!status.ok || status.exitCode !== 0) return unknown(why(status, "status"));
  const parsed = parseStatusV2(status.stdout);
  if (parsed.oid !== commit) return unknown("the checkout moved while muninn started");
  const subject = await git(top, ["log", "-1", "--format=%s", commit], { timeoutMs: GIT_LOCAL_MS, maxLines: 2 });
  if (!subject.ok || subject.exitCode !== 0) return unknown(why(subject, "log"));
  return { known: true, dir: top, commit, branch: parsed.branch, dirty: parsed.dirty, pr: prOfSubject(subject.stdout.trim()), at };
}

let started: Promise<BootRecord> | null = null;

/** Starts the one read for this process (later calls return the same promise). Never throws. */
export function startBootRecord(dir: string = import.meta.dir, git: GitRun = realGit): Promise<BootRecord> {
  started ??= takeBootRecord(dir, git).catch((): BootRecord => ({ known: false, reason: "the start read failed", at: Date.now() }));
  return started;
}

/** The record {@link startBootRecord} took, or an unknown one when nothing started it (a test app, a script). */
export function bootRecord(): Promise<BootRecord> {
  return started ?? Promise.resolve({ known: false, reason: "this process took no boot record", at: Date.now() });
}
