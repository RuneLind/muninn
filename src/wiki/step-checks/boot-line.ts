/**
 * The boot line (mimir plan «Drain the owner-step queue», P1): the boot record
 * and what has moved in its checkout since, read when asked. It says what the
 * process started from and what moved; it never says «live» or «up to date».
 *
 * Origin names the default branch (`checkoutCompare`'s live `ls-remote
 * --symref`), never the local `origin/HEAD` or a guessed `main`; unread, the
 * line gives the start facts and «not compared: origin not read». Then the
 * first row that fits: the checkout is on another branch or detached; its
 * default branch does not hold the start commit; it holds first-parent commits
 * after it (a PR is a subject ending in `(#N)`, muninn lands squash commits);
 * or it is where it started. Beside every row but the first: tracked files
 * differing from HEAD now, and origin being ahead.
 *
 * What it cannot see: code read from disk after start (the rows are the signal
 * for that), and an edit `git status` hides (assume-unchanged, skip-worktree).
 */

import type { GitRun } from "../decision-triage/git.ts";
import type { ProbeSlots } from "./answer.ts";
import { prOfSubject, parseStatusV2, STATUS_ARGS, type BootRecord } from "./boot-record.ts";
import { CHECKOUT_GIT_ENV, checkoutCompare, GIT_LOCAL_MS, type ProbeResult } from "./probes.ts";

export type BootLineRow = "start-unknown" | "not-compared" | "unreadable" | "elsewhere" | "moved-off" | "newer" | "same";

export interface BootLine {
  row: BootLineRow;
  text: string;
  /** Origin's default branch, when origin was read. */
  defaultBranch: string | null;
  /** The record the line was read against. */
  record: BootRecord;
  readAt: number;
}

/** First-parent commits read after the start commit; past it the line says «more than». */
export const NEWER_MAX = 500;
/** PR numbers named on the line; the rest are counted. */
const PRS_SHOWN = 8;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pad = (n: number) => String(n).padStart(2, "0");

/** «14.11 20:58», local time. */
export function formatStartTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `git` with {@link CHECKOUT_GIT_ENV} on every call, each call holding one of `slots`. */
export function bootLineGit(raw: GitRun, slots: ProbeSlots): GitRun {
  return (cwd, args, opts) => slots.run(() => raw(cwd, args, { ...opts, env: { ...opts?.env, ...CHECKOUT_GIT_ENV } }));
}

/** What the record says about the start, before anything moved. */
export function startFacts(record: BootRecord & { known: true }, defaultBranch: string | null): string {
  let text = `started from ${record.commit.slice(0, 8)}${record.pr !== null ? ` (#${record.pr})` : ""} on ${formatStartTime(record.at)}`;
  if (record.branch === null) text += ", detached HEAD";
  else if (defaultBranch === null || record.branch !== defaultBranch) text += ` on branch ${record.branch}`;
  if (record.dirty) text += ", from a modified tree";
  return text;
}

/** «N newer PRs: #…», or commits without a PR number, or null when nothing is newer. */
function newerText(subjects: readonly string[], capped: boolean): string | null {
  const prs = subjects.map(prOfSubject).filter((n): n is number => n !== null).reverse();
  const without = subjects.length - prs.length;
  const parts: string[] = [];
  if (prs.length > 0) {
    const shown = prs.slice(0, PRS_SHOWN).map((n) => `#${n}`).join(", ");
    const rest = prs.length > PRS_SHOWN ? ` and ${prs.length - PRS_SHOWN} more` : "";
    parts.push(`${plural(prs.length, "newer PR", "newer PRs")}: ${shown}${rest}`);
  }
  if (without > 0) parts.push(plural(without, "commit without a PR number", "commits without a PR number"));
  if (parts.length === 0) return null;
  return `the checkout holds ${capped ? `more than ${NEWER_MAX} commits, among them ` : ""}${parts.join(" and ")}: restart`;
}

export interface BootLineDeps {
  /** Already carrying the env and the slots ({@link bootLineGit}). */
  git: GitRun;
  /** Defaults to `checkoutCompare`; a test injects origin's answer. */
  compare?: (dir: string, label: string, git: GitRun) => Promise<{ result: ProbeResult; head: { branch: string; tip: string } | null }>;
  now?: () => number;
}

export async function readBootLine(record: BootRecord, deps: BootLineDeps): Promise<BootLine> {
  const readAt = (deps.now ?? Date.now)();
  if (!record.known) return { row: "start-unknown", text: `start commit unknown: ${record.reason}`, defaultBranch: null, record, readAt };
  const { git } = deps;
  const dir = record.dir;
  const line = (row: BootLineRow, defaultBranch: string | null, parts: string[]): BootLine => ({ row, text: parts.join(" · "), defaultBranch, record, readAt });

  const compared = await (deps.compare ?? checkoutCompare)(dir, "the checkout", git);
  if (!compared.head) return line("not-compared", null, [startFacts(record, null), "not compared: origin not read"]);
  const def = compared.head.branch;
  const start = startFacts(record, def);
  const unreadable = () => line("unreadable", def, [start, "the checkout could not be read now"]);

  const sym = await git(dir, ["symbolic-ref", "-q", "--short", "HEAD"], { timeoutMs: GIT_LOCAL_MS, maxLines: 2 });
  let nowBranch: string | null;
  if (sym.exitCode === 0) nowBranch = sym.stdout.trim();
  else if (sym.exitCode === 1 && !sym.stderr?.trim()) nowBranch = null;
  else return unreadable();
  if (nowBranch !== def) {
    let where = nowBranch;
    if (where === null) {
      const h = await git(dir, ["rev-parse", "HEAD"], { timeoutMs: GIT_LOCAL_MS, maxLines: 2 });
      where = h.exitCode === 0 ? `a detached HEAD at ${h.stdout.trim().slice(0, 8)}` : "a detached HEAD";
    }
    return line("elsewhere", def, [start, `the checkout is on ${where} now, and code loaded on first use comes from it`]);
  }

  const extras = async (): Promise<string[] | null> => {
    const st = await git(dir, STATUS_ARGS, { timeoutMs: GIT_LOCAL_MS });
    if (!st.ok || st.exitCode !== 0) return null;
    const out: string[] = [];
    if (parseStatusV2(st.stdout).dirty) out.push(`tracked files differ from HEAD${record.dirty ? ", they differed at start too" : " since start"}`);
    if (compared.result.state === "not-yet") out.push("origin is ahead: pull");
    else if (compared.result.state === "unknown") out.push(`origin not compared: ${compared.result.why}`);
    return out;
  };

  const tip = await git(dir, ["rev-parse", "--verify", "-q", `refs/heads/${def}^{commit}`], { timeoutMs: GIT_LOCAL_MS, maxLines: 2 });
  if (tip.exitCode !== 0) return unreadable();
  const local = tip.stdout.trim();
  // A full sha that is not here exits 1 with nothing on stderr: the start commit is gone from the checkout.
  const have = await git(dir, ["cat-file", "-e", `${record.commit}^{commit}`], { timeoutMs: GIT_LOCAL_MS });
  let movedOff = have.exitCode === 1 && !have.stderr?.trim();
  if (!movedOff) {
    if (have.exitCode !== 0) return unreadable();
    const anc = await git(dir, ["merge-base", "--is-ancestor", record.commit, local], { timeoutMs: GIT_LOCAL_MS });
    if (anc.exitCode === 1) movedOff = true;
    else if (anc.exitCode !== 0) return unreadable();
  }
  if (movedOff) {
    const ex = await extras();
    if (!ex) return unreadable();
    return line("moved-off", def, [start, "the checkout has moved off the start commit: restart", ...ex]);
  }
  const log = await git(dir, ["log", "--first-parent", "--format=%s", `${record.commit}..${local}`], { timeoutMs: GIT_LOCAL_MS, maxLines: NEWER_MAX });
  if (!log.ok || (!log.capped && log.exitCode !== 0)) return unreadable();
  const subjects = log.stdout.split("\n").filter((s) => s !== "");
  const ex = await extras();
  if (!ex) return unreadable();
  const newer = newerText(subjects, !!log.capped);
  return newer ? line("newer", def, [start, newer, ...ex]) : line("same", def, [start, ...ex]);
}
