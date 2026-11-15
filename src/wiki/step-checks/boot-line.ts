/**
 * The boot line (mimir plan «Drain the owner-step queue», P1): the boot record
 * and what has moved in its checkout since. It says what the process started
 * from and what moved; it never says «live» or «up to date».
 *
 * The row needs no origin: it compares the checkout with the start commit on
 * the ref muninn started on, so it holds offline and on any branch. The first
 * that fits: another ref (or detached when it was not); the start commit gone,
 * or HEAD not descending from it; HEAD ahead of it; HEAD at it. Three addenda
 * are read apart and in parallel with it — tracked files against the start's
 * fingerprint, origin, and the start branch beside origin's default — so one
 * that fails or runs out of time says «… not read» and never replaces the row.
 *
 * What it cannot see: code read from disk after start (the rows are the signal
 * for that), and an edit `git status` hides (assume-unchanged, skip-worktree).
 */

import type { GitResult, GitRun } from "../decision-triage/git.ts";
import type { ProbeSlots } from "./answer.ts";
import { prOfSubject, readTracked, withCheckoutEnv, type BootRecord, type TrackedState } from "./boot-record.ts";
import { checkoutCompare, GIT_LOCAL_MS, LS_REMOTE_MS, type OriginHeadRead, type ProbeResult } from "./probes.ts";

export type BootRow = "start-unknown" | "unread" | "elsewhere" | "moved-off" | "newer" | "same";

/** What the client gets: never the checkout's path. */
export interface BootLine {
  row: BootRow;
  /** The row asks for a restart: the reader draws it in the attention colour. */
  restart: boolean;
  text: string;
  start:
    | { known: true; commit: string; ref: string | null; pr: number | null; at: number; tracked: TrackedState["state"] }
    | { known: false; reason: string; at: number };
  /** The parts that were not read («the checkout», «tracked files», «origin»). */
  unread: string[];
  readAt: number;
}

/** First-parent commits read after the start commit. */
export const NEWER_MAX = 500;
/** PR numbers named on the line; the rest are counted. */
export const PRS_SHOWN = 8;
/**
 * The whole line's bound: the longest part's chain of calls run one after
 * another, each at its own bound — origin's 5 local calls and `ls-remote` (the
 * row needs 5 local calls, tracked files 2). Time spent waiting for a slot is
 * not in it: past it a part answers «not read».
 */
export const BOOT_LINE_BOUND_MS = 5 * GIT_LOCAL_MS + LS_REMOTE_MS;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pad = (n: number) => String(n).padStart(2, "0");
const gitWhy = (res: GitResult, what: string) => (res.timedOut ? `${what} timed out` : `${what} failed`);

/** «14.11 20:58», local time; «14.11.2025 20:58» in another year than `now`'s. */
export function formatStartTime(ms: number, now: number): string {
  const d = new Date(ms);
  const year = d.getFullYear() !== new Date(now).getFullYear() ? `.${d.getFullYear()}` : "";
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}${year} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `refs/heads/x` → `x`; any other ref stays whole. */
const branchName = (ref: string) => (ref.startsWith("refs/heads/") ? ref.slice(11) : ref);

const CANCELLED: GitResult = { ok: false, stdout: "", stderr: "the boot line's bound expired", timedOut: true };

/**
 * `git` with {@link withCheckoutEnv}'s switches on every call, each call holding one of `slots`.
 * Once `cancelled()` holds, a call not yet started never starts (checked before and after the
 * slot wait): the answer is already sent. A call already running ends on its own timeout.
 */
export function bootLineGit(raw: GitRun, slots: ProbeSlots, cancelled: () => boolean = () => false): GitRun {
  const git = withCheckoutEnv(raw);
  return async (cwd, args, opts) => {
    if (cancelled()) return CANCELLED;
    return slots.run(async () => (cancelled() ? CANCELLED : git(cwd, args, opts)));
  };
}

type Known = BootRecord & { known: true };
type RowAnswer = { row: "elsewhere" | "moved-off" | "newer" | "same"; text: string | null; restart: boolean } | { why: string };

/** «N newer PRs: #…» and the commits without a PR number; null when nothing was read. */
export function newerText(subjects: readonly string[], capped: boolean): string | null {
  // `git log` lists newest first; the line names the oldest first.
  const oldest = [...subjects].reverse();
  const prs = oldest.map(prOfSubject).filter((n): n is number => n !== null);
  const without = oldest.length - prs.length;
  const parts: string[] = [];
  if (prs.length > 0) {
    const shown = prs.slice(0, PRS_SHOWN).map((n) => `#${n}`).join(", ");
    const rest = prs.length > PRS_SHOWN ? ` and ${prs.length - PRS_SHOWN} more` : "";
    parts.push(`${plural(prs.length, "newer PR", "newer PRs")}: ${shown}${rest}`);
  }
  if (without > 0) parts.push(plural(without, "commit without a PR number", "commits without a PR number"));
  if (parts.length === 0) return null;
  return `the checkout holds ${capped ? `more than ${NEWER_MAX} newer commits, among them ` : ""}${parts.join(" and ")}: restart`;
}

const MOVED_SINCE = "the checkout has moved since start: restart";

/** The row: local reads only. */
export async function readRow(record: Known, git: GitRun): Promise<RowAnswer> {
  const dir = record.dir;
  const opts = { timeoutMs: GIT_LOCAL_MS, maxLines: 2 };
  const sym = await git(dir, ["symbolic-ref", "-q", "HEAD"], opts);
  let ref: string | null;
  if (sym.exitCode === 0) ref = sym.stdout.trim();
  else if (sym.exitCode === 1 && !sym.stderr?.trim()) ref = null;
  else return { why: gitWhy(sym, "git symbolic-ref") };
  const headRes = await git(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], opts);
  const head = headRes.exitCode === 0 ? headRes.stdout.trim() : null;
  if (ref !== record.ref) {
    const where = ref !== null ? branchName(ref) : head ? `a detached HEAD at ${head.slice(0, 8)}` : "a detached HEAD";
    return { row: "elsewhere", text: `the checkout is on ${where} now, and code loaded on first use comes from it`, restart: false };
  }
  if (!head) return { why: gitWhy(headRes, "git rev-parse") };
  if (head === record.commit) return { row: "same", text: null, restart: false };
  // `^{commit}`: a missing object exits 128 «Not a valid object name»; without it `cat-file -e` exits 1 (measured).
  const have = await git(dir, ["cat-file", "-e", `${record.commit}^{commit}`], { timeoutMs: GIT_LOCAL_MS });
  let descends = false;
  if (have.exitCode === 0) {
    const anc = await git(dir, ["merge-base", "--is-ancestor", record.commit, head], { timeoutMs: GIT_LOCAL_MS });
    if (anc.exitCode === 0) descends = true;
    else if (anc.exitCode !== 1) return { why: gitWhy(anc, "git merge-base") };
  } else if (!(have.exitCode === 128 && /not a valid object name/i.test(have.stderr ?? ""))) return { why: gitWhy(have, "git cat-file") };
  if (!descends) {
    // A shallow clone can lack the history that joins the two: then only «moved» is known.
    const shallow = await git(dir, ["rev-parse", "--is-shallow-repository"], opts);
    const notShallow = shallow.exitCode === 0 && shallow.stdout.trim() === "false";
    return { row: "moved-off", text: notShallow ? "the checkout has moved off the start commit: restart" : MOVED_SINCE, restart: true };
  }
  // `--no-show-signature`: a user's `log.showSignature` adds verify lines to stdout.
  const log = await git(dir, ["log", "--no-show-signature", "--first-parent", "--format=%s", `${record.commit}..${head}`], { timeoutMs: GIT_LOCAL_MS, maxLines: NEWER_MAX });
  if (!log.ok || (!log.capped && log.exitCode !== 0)) return { why: gitWhy(log, "git log") };
  const subjects = log.stdout.split("\n").filter((s) => s !== "");
  return { row: "newer", text: newerText(subjects, !!log.capped) ?? MOVED_SINCE, restart: true };
}

/** The tracked-files addendum: nothing when both are clean. */
export function trackedText(start: TrackedState, now: TrackedState): string | null {
  if (start.state === "clean" && now.state === "clean") return null;
  if (start.state === "dirty" && now.state === "dirty" && start.hash === now.hash) return "tracked files differ from HEAD, as they did at start";
  // Two differences past the bound cannot be told apart; any other pair that is not equal differs.
  if (start.state === "too-large" && now.state === "too-large") return "tracked files not read: the difference from HEAD is too large to compare";
  return "tracked files have changed since start";
}

/** The origin addendum: nothing when the checkout holds origin's tip. */
export function originText(result: ProbeResult, row: BootRow): string | null {
  if (result.state === "ok") return null;
  if (result.state === "unknown") return `origin not read: ${result.why}`;
  // Beside a row that is not about this branch's history, pulling is not the advice.
  return row === "moved-off" || row === "elsewhere" ? "origin has commits this checkout lacks" : "origin has commits this checkout lacks: pull";
}

export function startFacts(record: Known, now: number, defaultBranch: string | null): string {
  let text = `started from ${record.commit.slice(0, 8)}${record.pr !== null ? ` (#${record.pr})` : ""} on ${formatStartTime(record.at, now)}`;
  if (defaultBranch !== null && record.ref !== `refs/heads/${defaultBranch}`) {
    text += ` on ${record.ref ? branchName(record.ref) : "a detached HEAD"} (origin's default branch is ${defaultBranch})`;
  }
  return text;
}

export interface BootLineDeps {
  /** The raw runner: {@link readBootLine} adds the env, the slots and the cancel ({@link bootLineGit}). */
  git: GitRun;
  slots: ProbeSlots;
  /** Origin's default branch and tip; the route passes a cached read. Defaults to a live `ls-remote`. */
  originHead?: OriginHeadRead;
  now?: () => number;
  boundMs?: number;
  /** Test seam: the bound expires when this settles, in place of the `boundMs` timer. */
  expiry?: Promise<unknown>;
}

const TIMED_OUT = Symbol("timed out");

function publicStart(record: BootRecord): BootLine["start"] {
  if (!record.known) return record;
  return { known: true, commit: record.commit, ref: record.ref, pr: record.pr, at: record.at, tracked: record.tracked.state };
}

/** The line for `record`, every part bounded together by `boundMs`; a part still running then is named «not read». */
export async function readBootLine(record: BootRecord | Promise<BootRecord>, deps: BootLineDeps): Promise<BootLine> {
  const now = deps.now ?? Date.now;
  const readAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    const expire = () => {
      expired = true;
      resolve(TIMED_OUT);
    };
    if (deps.expiry) deps.expiry.then(expire, expire);
    else timer = setTimeout(expire, deps.boundMs ?? BOOT_LINE_BOUND_MS);
  });
  const bound = <T>(p: Promise<T>) => Promise.race([p, expiry]);
  const git = bootLineGit(deps.git, deps.slots, () => expired);
  try {
    const rec = await bound(Promise.resolve(record));
    if (rec === TIMED_OUT) {
      return { row: "start-unknown", restart: false, text: "start commit not read yet: the start record is still being read", start: { known: false, reason: "still being read", at: readAt }, unread: ["the start record"], readAt };
    }
    if (!rec.known) return { row: "start-unknown", restart: false, text: `start commit unknown: ${rec.reason}`, start: rec, unread: [], readAt };
    const failed = (what: string) => (err: unknown) => ({ why: `${what} failed: ${err instanceof Error ? err.message : String(err)}` });
    const [row, tracked, origin] = await Promise.all([
      bound(readRow(rec, git).catch(failed("the row read"))),
      bound(readTracked(rec.dir, git).catch(failed("the status read"))),
      bound(checkoutCompare(rec.dir, "the checkout", git, deps.originHead).catch((err) => ({ result: { state: "unknown", why: failed("the origin read")(err).why } as ProbeResult, head: null }))),
    ]);
    const unread: string[] = [];
    const t = now();
    const def = origin !== TIMED_OUT ? (origin.head?.branch ?? null) : null;
    const parts = [startFacts(rec, t, def)];
    let rowName: BootRow;
    let restart = false;
    if (row === TIMED_OUT || "why" in row) {
      rowName = "unread";
      unread.push("the checkout");
      parts.push(`the checkout not read: ${row === TIMED_OUT ? "timed out" : row.why}`);
    } else {
      rowName = row.row;
      restart = row.restart;
      if (row.text) parts.push(row.text);
    }
    if (tracked === TIMED_OUT || "why" in tracked) {
      unread.push("tracked files");
      parts.push(`tracked files not read: ${tracked === TIMED_OUT ? "timed out" : tracked.why}`);
    } else {
      // Both past the bound: the text says «not read», so unread names it too.
      if (rec.tracked.state === "too-large" && tracked.tracked.state === "too-large") unread.push("tracked files");
      const text = trackedText(rec.tracked, tracked.tracked);
      if (text) parts.push(text);
    }
    if (origin === TIMED_OUT) {
      unread.push("origin");
      parts.push("origin not read: timed out");
    } else {
      if (origin.result.state === "unknown") unread.push("origin");
      const text = originText(origin.result, rowName);
      if (text) parts.push(text);
    }
    return { row: rowName, restart, text: parts.join(" · "), start: publicStart(rec), unread, readAt };
  } finally {
    clearTimeout(timer);
  }
}
