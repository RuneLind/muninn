/**
 * The boot record (mimir plan «Drain the owner-step queue», P1): what this
 * process started from, read once at start and kept in memory. `src/index.ts`
 * calls {@link startBootRecord} and never awaits it; `GET /api/wiki/boot-line`
 * reads it through {@link bootRecord}. Pure apart from git: a test takes a
 * record of any directory with {@link takeBootRecord}.
 *
 * The reads run in the checkout that holds this file, never the working
 * directory: `rev-parse` (toplevel and commit), `symbolic-ref` (the full ref,
 * so a tag named like the branch cannot pass for it), the tracked-file state
 * ({@link readTracked}) and the commit's subject for its `(#N)`. Each runs
 * under the probes' local bound with {@link CHECKOUT_GIT_ENV}; `realGit` adds
 * `--no-optional-locks`. A slow or failed read gives an unknown record that
 * says which read and why; a status naming another commit than `rev-parse`
 * did (a pull landed in between) does too.
 */

import { sha256 } from "../../utils/date-hash.ts";
import { realGit, type GitResult, type GitRun } from "../decision-triage/git.ts";
import { CHECKOUT_GIT_ENV, GIT_LOCAL_MS } from "./probes.ts";

/** The tracked files against HEAD: clean, a hash of what differed, or a difference too large to hash whole. */
export type TrackedState = { state: "clean" } | { state: "dirty"; hash: string } | { state: "too-large" };

export type BootRecord =
  | {
      known: true;
      /** The checkout's toplevel: the line reads it again there. Never sent to a client. */
      dir: string;
      commit: string;
      /** The full ref HEAD named (`refs/heads/main`); null on a detached HEAD. */
      ref: string | null;
      /** The `(#N)` the commit's subject ends in, if any. */
      pr: number | null;
      tracked: TrackedState;
      at: number;
    }
  | { known: false; reason: string; at: number };

const PR_SUFFIX = /\(#(\d+)\)\s*$/;

/** The `(#N)` a squash commit's subject ends in, or null. */
export function prOfSubject(subject: string): number | null {
  const m = PR_SUFFIX.exec(subject);
  return m ? Number(m[1]) : null;
}

/** Tracked files only, fsmonitor off: the hook the repo's config names never runs. */
export const STATUS_ARGS = ["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"] as const;
/** The worktree side's blob id is on each `index` line (`--full-index`), so `-U0` keeps the hash content-sensitive at less output. */
const DIFF_ARGS = ["-c", "core.fsmonitor=false", "diff", "HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "--full-index", "-U0"] as const;
/** Diff lines hashed; past it the state is `too-large` rather than a hash of a prefix, which could miss an edit. */
export const TRACKED_MAX_LINES = 20_000;

/**
 * `git status --porcelain=v2 --branch -z` → `branch.oid` and the entries, or
 * null on a field of no known shape. A rename or copy (`2 …`) carries its
 * original path in the NEXT field, which is skipped as a header candidate: a
 * file once named `# branch.oid …` must not move the oid.
 */
export function parseStatusV2(stdout: string): { oid: string | null; entries: string[] } | null {
  const fields = stdout.split("\0");
  let oid: string | null = null;
  const entries: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f === "") continue;
    if (f.startsWith("# ")) {
      if (f.startsWith("# branch.oid ")) oid = f.slice(13);
    } else if (f.startsWith("2 ")) {
      entries.push(`${f}\0${fields[i + 1] ?? ""}`);
      i++;
    } else if (/^[1u?!] /.test(f)) entries.push(f);
    else return null;
  }
  return { oid, entries };
}

const gitWhy = (res: GitResult, what: string) => (res.timedOut ? `${what} timed out` : res.exitCode === undefined && !res.capped ? `${what} could not run` : `${what} failed`);

/**
 * The tracked files' state against HEAD: one status, then, only when it lists
 * an entry, one diff hashed with the entries. `oid` is status's `branch.oid`.
 * A read past a bound is `too-large`, never a failure.
 */
export async function readTracked(dir: string, git: GitRun): Promise<{ tracked: TrackedState; oid: string | null } | { why: string }> {
  const st = await git(dir, STATUS_ARGS, { timeoutMs: GIT_LOCAL_MS });
  if (st.capped) {
    const first = st.stdout.split("\0")[0] ?? "";
    return { tracked: { state: "too-large" }, oid: first.startsWith("# branch.oid ") ? first.slice(13) : null };
  }
  if (!st.ok || st.exitCode !== 0) return { why: gitWhy(st, "git status") };
  const parsed = parseStatusV2(st.stdout);
  if (!parsed) return { why: "git status gave an answer muninn cannot read" };
  if (parsed.entries.length === 0) return { tracked: { state: "clean" }, oid: parsed.oid };
  const diff = await git(dir, DIFF_ARGS, { timeoutMs: GIT_LOCAL_MS, maxLines: TRACKED_MAX_LINES });
  if (diff.capped) return { tracked: { state: "too-large" }, oid: parsed.oid };
  if (!diff.ok || diff.exitCode !== 0) return { why: gitWhy(diff, "git diff") };
  return { tracked: { state: "dirty", hash: sha256(`${parsed.entries.join("\n")}\0\0${diff.stdout}`) }, oid: parsed.oid };
}

/** `git`, with {@link CHECKOUT_GIT_ENV} on every call: replace refs and grafts cannot rewrite what the record reads. */
export const withCheckoutEnv = (git: GitRun): GitRun => (cwd, args, opts) => git(cwd, args, { ...opts, env: { ...opts?.env, ...CHECKOUT_GIT_ENV } });

export async function takeBootRecord(dir: string, rawGit: GitRun = realGit, now: () => number = Date.now): Promise<BootRecord> {
  const at = now();
  const git = withCheckoutEnv(rawGit);
  const unknown = (reason: string): BootRecord => ({ known: false, reason, at });
  const atStart = (why: string) => unknown(`${why} at start`);
  const head = await git(dir, ["rev-parse", "--show-toplevel", "HEAD"], { timeoutMs: GIT_LOCAL_MS, maxLines: 3 });
  if (head.capped) return atStart("git rev-parse gave more lines than it should");
  if (!head.ok || head.exitCode !== 0) {
    if (/not a git repository/i.test(head.stderr ?? "")) return unknown("muninn did not start from a git checkout");
    return atStart(gitWhy(head, "git rev-parse"));
  }
  const [top, commit] = head.stdout.split("\n");
  if (!top || !commit || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) return atStart("git rev-parse gave an answer muninn cannot read");
  const sym = await git(top, ["symbolic-ref", "-q", "HEAD"], { timeoutMs: GIT_LOCAL_MS, maxLines: 2 });
  let ref: string | null;
  if (sym.exitCode === 0) ref = sym.stdout.trim();
  else if (sym.exitCode === 1 && !sym.stderr?.trim()) ref = null;
  else return atStart(gitWhy(sym, "git symbolic-ref"));
  const tracked = await readTracked(top, git);
  if ("why" in tracked) return atStart(tracked.why);
  if (tracked.oid !== commit) return unknown("the checkout moved while muninn started");
  // `--no-show-signature`: a user's `log.showSignature` adds verify lines to stdout.
  const subject = await git(top, ["log", "--no-show-signature", "-1", "--format=%s", commit], { timeoutMs: GIT_LOCAL_MS, maxLines: 2 });
  if (!subject.ok || subject.exitCode !== 0) return atStart(gitWhy(subject, "git log"));
  return { known: true, dir: top, commit, ref, pr: prOfSubject(subject.stdout.trim()), tracked: tracked.tracked, at };
}

let started: Promise<BootRecord> | null = null;

/** Starts the one read for this process (later calls return the same promise). Never rejects. */
export function startBootRecord(dir: string = import.meta.dir, git: GitRun = realGit): Promise<BootRecord> {
  started ??= takeBootRecord(dir, git).catch((): BootRecord => ({ known: false, reason: "the start read failed", at: Date.now() }));
  return started;
}

/** The record {@link startBootRecord} took, or an unknown one when nothing started it (a test app, a script). */
export function bootRecord(): Promise<BootRecord> {
  return started ?? Promise.resolve({ known: false, reason: "this process took no boot record", at: Date.now() });
}
