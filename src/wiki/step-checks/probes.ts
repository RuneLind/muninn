/**
 * The five read-only probes behind an owner step's `<Check>` (mimir plan
 * muninn-wiki-owner-step-checks, PR 2). Each answers `ok` only when it has
 * PROVEN the fact on this machine; anything it cannot prove is `not-yet` (the
 * fact provably does not hold yet) or `unknown`. None writes: no `.env`
 * write, no fetch, pull or checkout, no DB write. Every outside read comes in
 * through {@link ProbeDeps}, so tests never touch the real machine.
 *
 * A `why` is one short sentence for the reader: it names keys, repos,
 * branches, versions and short shas, never an env value, file contents or a
 * path.
 */

import type { CheckProbe } from "../../format/check-tag.ts";
import { defaultBranch, findRepo, type GitResult, type GitRun, type RepoRoots } from "../decision-triage/git.ts";
import { envFileKeyNames } from "./env-names.ts";

export type ProbeState = "ok" | "not-yet" | "unknown";

export interface ProbeResult {
  state: ProbeState;
  why: string;
}

/** What `readEnvFile` found: the text, no file at all, or a read that failed. */
export type EnvFileRead = { text: string } | { missing: true } | { failed: true };

export interface ProbeDeps {
  git: GitRun;
  /** `DECISION_TRIAGE_REPO_ROOTS`, parsed; null when unset. */
  roots: RepoRoots | null;
  /** The `.env` muninn loaded (Bun reads it from the working directory). */
  readEnvFile: () => Promise<EnvFileRead>;
  /** Whether the running process has `key` set to a non-empty value. Never the value. */
  processHasEnv: (key: string) => boolean;
  /** Whether `schema_migrations` of this machine's database holds `version`; throws when it cannot be read. */
  hasMigration: (version: string) => Promise<boolean>;
  /** The port this muninn's dashboard serves. */
  dashboardPort: number;
  /** The checkout the running code was loaded from. */
  ownRepoDir: string;
  /** When this process started (epoch ms): a `bun --watch` reload re-executes and moves it. */
  processStartMs: number;
  /** A file's modification time (epoch ms), or null when it does not exist or cannot be read. */
  mtimeMs: (absPath: string) => Promise<number | null>;
}

/** Bounds per probe and per git call. `ls-remote` is the one network read. */
export const PROBE_BOUND_MS: Record<CheckProbe["kind"], number> = { env: 2_000, migration: 3_000, checkout: 6_500, pushed: 3_000, restart: 7_500 };
const GIT_LOCAL_MS = 2_000;
export const LS_REMOTE_MS = 5_000;
/** More dirty tracked files than this and `restart` does not date them one by one. */
const DIRTY_MAX = 200;

const ok = (why: string): ProbeResult => ({ state: "ok", why });
const notYet = (why: string): ProbeResult => ({ state: "not-yet", why });
const unknown = (why: string): ProbeResult => ({ state: "unknown", why });

const gitFailure = (res: GitResult, what: string) => (res.timedOut ? `${what} timed out` : `${what} failed`);

/** `ok` only when every state is `ok` (and there is at least one); any `not-yet` wins over `unknown`. */
export function combineStates(states: readonly ProbeState[]): ProbeState {
  if (states.includes("not-yet")) return "not-yet";
  return states.length > 0 && states.every((s) => s === "ok") ? "ok" : "unknown";
}

/** The first result with the combined state's own state, for its `why`. */
function combine(results: readonly ProbeResult[]): ProbeResult {
  const state = combineStates(results.map((r) => r.state));
  const lead = results.find((r) => r.state === state) ?? results.find((r) => r.state !== "ok");
  return { state, why: lead?.why ?? "nothing was checked" };
}

/** `promise`, or `unknown` once `ms` has passed. A probe that throws is `unknown` too. */
export async function bounded(promise: Promise<ProbeResult>, ms: number, timedOut = "timed out"): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => resolve(unknown(timedOut)), ms);
  });
  try {
    return await Promise.race([promise.catch(() => unknown("the probe failed")), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

// ── env ──────────────────────────────────────────────────────────────────

export async function probeEnv(key: string, deps: ProbeDeps): Promise<ProbeResult> {
  const read = await deps.readEnvFile();
  if ("failed" in read) return unknown(".env could not be read");
  // No file: nothing was loaded from one, so the key provably is not in it.
  const names = "missing" in read ? null : envFileKeyNames(read.text);
  if (!names) return notYet(`${key} is not in .env (there is no .env here)`);
  if (names.blank.has(key)) return notYet(`${key} is in .env with an empty value`);
  if (!names.set.has(key)) return notYet(`${key} is not in .env`);
  if (!deps.processHasEnv(key)) return notYet(`${key} is set in .env, not in the running process: restart`);
  return ok(`${key} is set in .env and in the running process`);
}

// ── migration ────────────────────────────────────────────────────────────

export async function probeMigration(version: string, deps: ProbeDeps): Promise<ProbeResult> {
  let applied: boolean;
  try {
    applied = await deps.hasMigration(version);
  } catch {
    return unknown("this machine's database could not be read");
  }
  return applied ? ok(`migration ${version} is applied on this machine's database`) : notYet(`migration ${version} is not applied on this machine's database`);
}

// ── checkout ─────────────────────────────────────────────────────────────

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Whether `dir`'s HEAD contains its origin's default-branch tip as origin has
 * it NOW (`git ls-remote`), never the local `origin/<branch>` ref, which is
 * only as fresh as the last fetch.
 */
export async function checkoutCurrent(dir: string, label: string, git: GitRun): Promise<ProbeResult> {
  const branch = await defaultBranch(dir, git);
  if (!branch) return unknown(`${label} has no origin default branch here`);
  const remote = await git(dir, ["ls-remote", "origin", `refs/heads/${branch}`], { timeoutMs: LS_REMOTE_MS, maxLines: 20 });
  if (!remote.ok || remote.capped) return unknown(`${gitFailure(remote, "git ls-remote")}: origin's ${branch} is unknown`);
  const rows = remote.stdout.split("\n").map((l) => l.split("\t")).filter((r) => r[1]?.trim() === `refs/heads/${branch}`);
  const tip = rows.length === 1 ? rows[0]![0]!.trim() : "";
  if (!SHA.test(tip)) return unknown(`origin has no single ${branch} tip`);
  const short = tip.slice(0, 7);
  const have = await git(dir, ["cat-file", "-e", `${tip}^{commit}`], { timeoutMs: GIT_LOCAL_MS });
  if (have.exitCode === 1 || (have.exitCode === 128 && !have.timedOut)) return notYet(`origin's ${branch} tip ${short} is not in ${label}: pull`);
  if (!have.ok) return unknown(`${gitFailure(have, "git cat-file")} on ${label}`);
  const anc = await git(dir, ["merge-base", "--is-ancestor", tip, "HEAD"], { timeoutMs: GIT_LOCAL_MS });
  if (anc.ok && anc.exitCode === 0) return ok(`${label} contains origin's ${branch} tip ${short}`);
  if (anc.exitCode === 1) return notYet(`${label} does not contain origin's ${branch} tip ${short}: pull`);
  return unknown(`${gitFailure(anc, "git merge-base")} on ${label}`);
}

async function repoDir(name: string, deps: ProbeDeps): Promise<{ dir: string } | ProbeResult> {
  if (!deps.roots) return unknown(`DECISION_TRIAGE_REPO_ROOTS is not set, so ${name} cannot be found`);
  const found = await findRepo(name, deps.roots, deps.git);
  return "reason" in found ? unknown(`${name} not found under the repo roots: ${found.reason}`) : found;
}

export async function probeCheckout(name: string, deps: ProbeDeps): Promise<ProbeResult> {
  const found = await repoDir(name, deps);
  return "dir" in found ? checkoutCurrent(found.dir, name, deps.git) : found;
}

// ── pushed ───────────────────────────────────────────────────────────────

/** No local branch with an upstream is ahead of it, and the current branch has one. */
export async function probePushed(name: string, deps: ProbeDeps): Promise<ProbeResult> {
  const found = await repoDir(name, deps);
  if (!("dir" in found)) return found;
  const { dir } = found;
  const refs = await deps.git(dir, ["for-each-ref", "--format=%(refname:short)%09%(upstream)%09%(upstream:track)", "refs/heads"], { timeoutMs: GIT_LOCAL_MS, maxLines: 5_000 });
  if (!refs.ok || refs.capped) return unknown(`${gitFailure(refs, "git for-each-ref")} on ${name}`);
  const rows = refs.stdout.split("\n").filter(Boolean).map((l) => {
    const [branch = "", upstream = "", track = ""] = l.split("\t");
    return { branch, upstream, track };
  });
  const ahead = rows.filter((r) => r.upstream && /\bahead \d+/.test(r.track));
  if (ahead.length) {
    const names = ahead.slice(0, 3).map((r) => r.branch).join(", ");
    return notYet(`${ahead.length === 1 ? "branch" : `${ahead.length} branches`} ${names}${ahead.length > 3 ? ", …" : ""} ${ahead.length === 1 ? "has" : "have"} commits not pushed in ${name}`);
  }
  const gone = rows.find((r) => r.upstream && /\bgone\b/.test(r.track));
  if (gone) return unknown(`branch ${gone.branch}'s upstream is gone in ${name}, so whether it is pushed is unknown`);
  const head = await deps.git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"], { timeoutMs: GIT_LOCAL_MS });
  if (!head.ok) return unknown(head.exitCode === 1 ? `${name} has a detached HEAD` : `${gitFailure(head, "git symbolic-ref")} on ${name}`);
  const current = rows.find((r) => r.branch === head.stdout.trim());
  if (!current) return unknown(`${name}'s current branch is not among its branches`);
  if (!current.upstream) return unknown(`${name}'s current branch ${current.branch} has no upstream`);
  return ok(`every branch with an upstream is pushed in ${name}`);
}

// ── restart ──────────────────────────────────────────────────────────────

/** When `ref` last moved, from its reflog (whole seconds, epoch ms), or null. */
async function reflogMovedMs(dir: string, ref: string, git: GitRun): Promise<number | null> {
  const res = await git(dir, ["log", "-g", "-1", "--date=unix", "--format=%gd", ref, "--"], { timeoutMs: GIT_LOCAL_MS, maxLines: 2 });
  const m = res.ok ? /@\{(\d+)\}/.exec(res.stdout) : null;
  return m ? Number(m[1]) * 1000 : null;
}

const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * When the code on disk last changed, as late as can be proven: HEAD's and its
 * branch's reflog (git writes the reflog after the working tree), rounded up
 * to the end of its second, and the mtime of every modified tracked file.
 */
async function codeChangedMs(dir: string, deps: ProbeDeps): Promise<number | ProbeResult> {
  const head = await reflogMovedMs(dir, "HEAD", deps.git);
  if (head === null) return unknown("HEAD has no reflog here, so when the code last changed is unknown");
  let moved = head + 1000;
  const sym = await deps.git(dir, ["symbolic-ref", "--quiet", "HEAD"], { timeoutMs: GIT_LOCAL_MS });
  if (sym.ok) {
    const branch = await reflogMovedMs(dir, sym.stdout.trim(), deps.git);
    if (branch === null) return unknown("the branch has no reflog here, so when the code last changed is unknown");
    moved = Math.max(moved, branch + 1000);
  }
  const status = await deps.git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--no-renames"], { timeoutMs: GIT_LOCAL_MS });
  if (!status.ok || status.capped) return unknown(`${gitFailure(status, "git status")}, so local edits are unknown`);
  const paths = status.stdout.split("\0").filter(Boolean).map((e) => e.slice(3));
  if (paths.length > DIRTY_MAX) return unknown(`${paths.length} tracked files have local edits: too many to date`);
  for (const p of paths) {
    const at = await deps.mtimeMs(`${dir}/${p}`);
    if (at === null) return unknown("a tracked file with local edits is gone, so when the code last changed is unknown");
    moved = Math.max(moved, at);
  }
  return moved;
}

/**
 * This muninn serves `port`, the code on disk is current (the `checkout` rule
 * on the checkout it was loaded from), and it started after that code last
 * changed. A `bun --watch` reload re-executes the process, so its start time
 * moves and the lazily built client bundle is built again from disk; a change
 * the watcher does not see (a client-only file) leaves the start time behind
 * the change, which reads as `not-yet` (measured, PR body).
 */
export async function probeRestart(port: string, deps: ProbeDeps): Promise<ProbeResult> {
  if (Number(port) !== deps.dashboardPort) return unknown(`this muninn serves port ${deps.dashboardPort}, not ${port}`);
  const current = await checkoutCurrent(deps.ownRepoDir, "this muninn's checkout", deps.git);
  const changed = await codeChangedMs(deps.ownRepoDir, deps);
  if (typeof changed !== "number") return combine([changed, current]);
  const started = deps.processStartMs >= changed
    ? ok(`this muninn started ${minute(deps.processStartMs)}, after its code last changed (${minute(changed)})`)
    : notYet(`the code changed ${minute(changed)}, after this muninn started (${minute(deps.processStartMs)}): restart`);
  return combine([started, current]);
}

export const PROBES: Record<CheckProbe["kind"], (value: string, deps: ProbeDeps) => Promise<ProbeResult>> = {
  env: probeEnv,
  migration: probeMigration,
  checkout: probeCheckout,
  pushed: probePushed,
  restart: probeRestart,
};

/** One probe, inside its own bound. */
export function runProbe(probe: CheckProbe, deps: ProbeDeps): Promise<ProbeResult> {
  return bounded(PROBES[probe.kind](probe.value, deps), PROBE_BOUND_MS[probe.kind]);
}
