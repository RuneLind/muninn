/**
 * The read-only probes behind an owner step's `<Check>` (mimir plan
 * muninn-wiki-owner-step-checks, PR 2). Each answers `ok` only when it has
 * PROVEN the fact on this machine; anything it cannot prove is `not-yet` (the
 * fact provably does not hold yet) or `unknown`. None writes: no `.env`
 * write, no fetch, pull or checkout, no DB write; the git probes (`checkout`,
 * `pushed`, `restart`) run with replace refs, grafts and lazy fetch off and
 * answer a partial clone `unknown` before any object lookup
 * (`refusePartialClone`). Every outside read comes in
 * through {@link ProbeDeps}, so tests never touch the real machine.
 *
 * A `why` is one short sentence for the reader: it names keys, repos,
 * branches, versions and short shas, never an env value, file contents or a
 * path.
 */

import type { CheckProbe } from "../../format/check-tag.ts";
import { findRepo, type GitResult, type GitRun, type RepoRoots } from "../decision-triage/git.ts";
import { envFileKeyStates } from "./env-names.ts";
import { lateModules, type BootFingerprint, type DiskSnapshot } from "./boot-fingerprint.ts";

export type ProbeState = "ok" | "not-yet" | "unknown";

export interface ProbeResult {
  state: ProbeState;
  why: string;
}

/** What `readEnvFile` found: the file's raw bytes (never decoded: Bun parses bytes), no file at all, or a read that failed. */
export type EnvFileRead = { bytes: Uint8Array } | { missing: true } | { failed: true };

export interface ProbeDeps {
  git: GitRun;
  /** `DECISION_TRIAGE_REPO_ROOTS`, parsed; null when unset. */
  roots: RepoRoots | null;
  /** The `.env` muninn loaded (Bun reads it from the working directory). */
  readEnvFile: () => Promise<EnvFileRead>;
  /** Whether the running process has `key` set to a non-empty value. Never the value. */
  processHasEnv: (key: string) => boolean;
  /** Every `schema_migrations.version` of this machine's database: ONE read, shared by every `migration=` probe of a cache window; throws when it cannot be read. */
  appliedMigrations: () => Promise<ReadonlySet<string>>;
  /** What `restart=` reads about this process; absent, `restart=` is `unknown`. */
  restart?: RestartDeps;
}

/** This process's boot state and its disk, for `restart=`. */
export interface RestartDeps {
  /** The port this process's dashboard listens on; null before it listens. */
  listenPort: () => number | null;
  /** The boot fingerprint; null before it is taken. */
  boot: () => Promise<BootFingerprint> | null;
  /** The same inputs fingerprinted now. */
  disk: () => Promise<DiskSnapshot | { failed: string }>;
  /** Every module key the runtime has loaded, now (`require.cache`). */
  loadedModules: () => string[];
  /** What every browser bundle built so far read, by absolute path. */
  bundles: () => { inputs: ReadonlyMap<string, ReadonlySet<string>>; unaccounted: boolean };
  /** sha256 of one file now; null when it is absent. */
  hashNow: (file: string) => Promise<string | null | "failed">;
  /** muninn's own checkout. */
  checkout: string;
}

/** Bounds per probe and per git call. `ls-remote` is the one network read. `pushed` and `restart` each make one `ls-remote` and a few local reads (measured 0.6–1.1 s on the real skills and muninn checkouts); every bound is under `ANSWER_BOUND_MS` (8 s). */
export const PROBE_BOUND_MS: Record<CheckProbe["kind"], number> = { env: 2_000, migration: 3_000, checkout: 6_500, pushed: 7_000, restart: 7_000 };
const GIT_LOCAL_MS = 2_000;
export const LS_REMOTE_MS = 5_000;

const ok = (why: string): ProbeResult => ({ state: "ok", why });
const notYet = (why: string): ProbeResult => ({ state: "not-yet", why });
const unknown = (why: string): ProbeResult => ({ state: "unknown", why });

const gitFailure = (res: GitResult, what: string) => (res.timedOut ? `${what} timed out` : `${what} failed`);

/** `ok` only when every state is `ok` (and there is at least one); any `not-yet` wins over `unknown`. */
export function combineStates(states: readonly ProbeState[]): ProbeState {
  if (states.includes("not-yet")) return "not-yet";
  return states.length > 0 && states.every((s) => s === "ok") ? "ok" : "unknown";
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
  if ("missing" in read) return notYet(`${key} is not in .env (there is no .env here)`);
  const states = envFileKeyStates(read.bytes);
  if (states.lostTrack) return unknown(`.env line ${states.lostLine} is not a form muninn can read the way Bun does`);
  const state = states.keys.get(key);
  if (state === "unset") return notYet(`${key} is in .env with an empty value`);
  if (state !== "set") return notYet(`${key} is not in .env`);
  if (!deps.processHasEnv(key)) return notYet(`${key} is set in .env, not in the running process: restart`);
  return ok(`${key} is set in .env and in the running process`);
}

// ── migration ────────────────────────────────────────────────────────────

export async function probeMigration(version: string, deps: ProbeDeps): Promise<ProbeResult> {
  let applied: boolean;
  try {
    applied = (await deps.appliedMigrations()).has(version);
  } catch {
    return unknown("this machine's database could not be read");
  }
  return applied ? ok(`migration ${version} is applied on this machine's database`) : notYet(`migration ${version} is not applied on this machine's database`);
}

// ── checkout ─────────────────────────────────────────────────────────────

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Origin's default branch and its tip, both from ONE live `git ls-remote
 * --symref origin HEAD`: exactly one `ref: refs/heads/<b>\tHEAD` line and one
 * `<sha>\tHEAD` line. Anything else (a detached remote HEAD, a second line of
 * either shape, a garbled sha, a line of no known shape) is null. Never the
 * local `origin/HEAD`, which a fetch does not move, nor a guessed main/master.
 */
export function parseSymrefHead(stdout: string): { branch: string; tip: string } | null {
  const branches: string[] = [];
  const tips: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const ref = /^ref: refs\/heads\/([^\s]+)\tHEAD$/.exec(line);
    const sha = /^([0-9a-f]+)\tHEAD$/.exec(line);
    if (ref) branches.push(ref[1]!);
    else if (sha && SHA.test(sha[1]!)) tips.push(sha[1]!);
    else return null;
  }
  return branches.length === 1 && tips.length === 1 ? { branch: branches[0]!, tip: tips[0]! } : null;
}

/**
 * Set on every git call the checkout probe makes. Replace refs and an
 * `info/grafts` file rewrite parents, so `merge-base --is-ancestor` read a fake
 * child of origin's tip as containing it (reproduced; `--no-replace-objects`
 * alone leaves grafts on, measured on git 2.54). `GIT_NO_LAZY_FETCH` (git ≥ 2.44)
 * stops a partial clone fetching a missing object from its promisor remote;
 * older gits ignore it, which is why the probe also refuses a partial clone.
 */
export const CHECKOUT_GIT_ENV: Readonly<Record<string, string>> = { GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", GIT_NO_LAZY_FETCH: "1" };

/** `git`, with {@link CHECKOUT_GIT_ENV} on every call. */
const checkoutGit = (git: GitRun): GitRun => (cwd, args, opts) => git(cwd, args, { ...opts, env: CHECKOUT_GIT_ENV });

/** A partial clone's config: any promisor remote, or the repository extension. Matched against git's lower-cased names. */
const PARTIAL_CLONE_KEYS = "^(remote\\..*\\.promisor|extensions\\.partialclone)$";

/**
 * `unknown` for a partial clone, or when that cannot be read; null when `dir`
 * is a full clone. Run before any object lookup: looking up a missing object in
 * a partial clone fetches it (measured: `cat-file -e` grew the pack directory
 * and made the tip present). `git` must already carry {@link CHECKOUT_GIT_ENV}.
 */
async function refusePartialClone(dir: string, label: string, git: GitRun): Promise<ProbeResult | null> {
  // Exit 1 with nothing on stderr is «no such key»; a match, or anything else, proves nothing.
  const partial = await git(dir, ["config", "--get-regexp", PARTIAL_CLONE_KEYS], { timeoutMs: GIT_LOCAL_MS });
  if (partial.exitCode === 0) return unknown(`${label} is a partial clone: muninn does not look up objects it would have to fetch`);
  if (partial.exitCode !== 1 || partial.stderr?.trim()) return unknown(`${gitFailure(partial, "git config")} on ${label}`);
  return null;
}

/**
 * Whether `dir`'s HEAD contains origin's default-branch tip as origin has it
 * NOW, never the local `origin/<branch>` ref, which is only as fresh as the
 * last fetch. A partial clone is `unknown` before anything else
 * ({@link refusePartialClone}).
 */
export async function checkoutCurrent(dir: string, label: string, rawGit: GitRun): Promise<ProbeResult> {
  const git = checkoutGit(rawGit);
  const partial = await refusePartialClone(dir, label, git);
  if (partial) return partial;
  const remote = await git(dir, ["ls-remote", "--symref", "origin", "HEAD"], { timeoutMs: LS_REMOTE_MS, maxLines: 20 });
  if (!remote.ok || remote.capped) return unknown(`${gitFailure(remote, "git ls-remote")}: origin's default branch is unknown`);
  const head = parseSymrefHead(remote.stdout);
  if (!head) return unknown("origin's answer names no single default branch and tip");
  const { branch, tip } = head;
  const short = tip.slice(0, 7);
  // A full sha that is not here: exit 1 with nothing on stderr (measured). Any other failure proves nothing.
  const have = await git(dir, ["cat-file", "-e", tip], { timeoutMs: GIT_LOCAL_MS });
  if (have.exitCode === 1 && !have.stderr?.trim() && !have.timedOut) return notYet(`origin's ${branch} tip ${short} is not in ${label}: pull`);
  if (!have.ok || have.exitCode !== 0) return unknown(`${gitFailure(have, "git cat-file")} on ${label}`);
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
  // The repo lookup's git calls carry the same switches as the probe's own.
  const found = await repoDir(name, { ...deps, git: checkoutGit(deps.git) });
  return "dir" in found ? checkoutCurrent(found.dir, name, deps.git) : found;
}

// ── pushed ───────────────────────────────────────────────────────────────

/** `ls-remote --heads` lines read; past it the answer is `unknown`. */
export const PUSHED_MAX_HEADS = 2_000;

/**
 * The distinct tips of a live `git ls-remote --heads origin`: every line must
 * be `<sha>\trefs/heads/<name>`, or the answer is null (a garbled line proves
 * nothing). An empty answer is an empty list: origin has no branch.
 */
export function parseRemoteHeads(stdout: string): string[] | null {
  const tips = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const m = /^([0-9a-f]+)\trefs\/heads\/\S+$/.exec(line);
    if (!m || !SHA.test(m[1]!)) return null;
    tips.add(m[1]!);
  }
  return [...tips];
}

/**
 * Which of `tips` this repo has as commits, read with `cat-file --batch-check`
 * on stdin (no lazy fetch: the caller refused a partial clone and carries
 * {@link CHECKOUT_GIT_ENV}). Null when the answer is not one known line per tip.
 */
async function presentTips(dir: string, tips: readonly string[], git: GitRun): Promise<{ present: string[]; missing: number } | null> {
  if (tips.length === 0) return { present: [], missing: 0 };
  const res = await git(dir, ["cat-file", "--batch-check"], { timeoutMs: GIT_LOCAL_MS, maxLines: tips.length, stdin: `${tips.join("\n")}\n` });
  if (!res.ok || res.capped || res.exitCode !== 0) return null;
  const lines = res.stdout.split("\n").filter((l) => l !== "");
  if (lines.length !== tips.length) return null;
  const present: string[] = [];
  let missing = 0;
  for (let i = 0; i < tips.length; i++) {
    const tip = tips[i]!;
    if (lines[i] === `${tip} missing`) missing++;
    else if (new RegExp(`^${tip} commit \\d+$`).test(lines[i]!)) present.push(tip);
    else return null;
  }
  return { present, missing };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * `pushed="<repo>"`: no local commit is missing from origin as origin is NOW.
 * Local commits are everything reachable from `HEAD` (a detached one counts)
 * and from every `refs/heads/*` (a branch with no upstream counts; a branch
 * checked out in another worktree is in `refs/heads` already). Origin's tips
 * come from one live `ls-remote --heads`, never the local `refs/remotes/*`,
 * which are only as fresh as the last fetch. Only tips present here are walked
 * (`rev-list --stdin`, so no list overflows the argument length): 0 missing is
 * `ok`, some missing with every tip present is `not-yet`, some missing with a
 * tip absent is `unknown` (the commits may sit under that tip). Tracked
 * changes, staged or not, are `not-yet`; untracked files are ignored. A
 * partial or shallow clone, an unborn HEAD, no local branch: `unknown`.
 */
export async function probePushed(name: string, deps: ProbeDeps): Promise<ProbeResult> {
  const git = checkoutGit(deps.git);
  const found = await repoDir(name, { ...deps, git });
  if (!("dir" in found)) return found;
  const { dir } = found;
  const partial = await refusePartialClone(dir, name, git);
  if (partial) return partial;
  const shallow = await git(dir, ["rev-parse", "--is-shallow-repository"], { timeoutMs: GIT_LOCAL_MS });
  if (!shallow.ok || shallow.exitCode !== 0) return unknown(`${gitFailure(shallow, "git rev-parse")} on ${name}`);
  if (shallow.stdout.trim() === "true") return unknown(`${name} is a shallow clone: muninn cannot walk all of its history`);
  if (shallow.stdout.trim() !== "false") return unknown(`git could not say whether ${name} is a shallow clone`);
  const status = await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=none"], { timeoutMs: GIT_LOCAL_MS });
  // A capped status already printed a change.
  if (status.capped && status.stdout !== "") return notYet(`${name} has uncommitted changes: commit and push`);
  if (!status.ok || status.exitCode !== 0) return unknown(`${gitFailure(status, "git status")} on ${name}`);
  if (status.stdout !== "") return notYet(`${name} has uncommitted changes: commit and push`);
  const head = await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { timeoutMs: GIT_LOCAL_MS });
  if (!head.ok || head.exitCode !== 0 || !SHA.test(head.stdout.trim())) return unknown(head.exitCode === 1 && !head.timedOut ? `${name} has no commit yet` : `${gitFailure(head, "git rev-parse")} on ${name}`);
  const branch = await git(dir, ["for-each-ref", "--count=1", "--format=%(refname)", "refs/heads/"], { timeoutMs: GIT_LOCAL_MS });
  if (!branch.ok || branch.exitCode !== 0) return unknown(`${gitFailure(branch, "git for-each-ref")} on ${name}`);
  if (branch.stdout.trim() === "") return unknown(`${name} has no local branch`);
  const remote = await git(dir, ["ls-remote", "--heads", "origin"], { timeoutMs: LS_REMOTE_MS, maxLines: PUSHED_MAX_HEADS });
  if (remote.capped) return unknown(`origin has over ${PUSHED_MAX_HEADS} branches: muninn does not read them all`);
  if (!remote.ok || remote.exitCode !== 0) return unknown(`${gitFailure(remote, "git ls-remote")}: what origin has is unknown`);
  const tips = parseRemoteHeads(remote.stdout);
  if (!tips) return unknown("origin's branch list has a line muninn cannot read");
  const have = await presentTips(dir, tips, git);
  if (!have) return unknown(`git cat-file failed on ${name}`);
  const stdin = have.present.map((t) => `^${t}\n`).join("");
  const count = await git(dir, ["rev-list", "--count", "--branches", "HEAD", "--stdin"], { timeoutMs: GIT_LOCAL_MS, stdin });
  const n = Number(count.stdout.trim());
  if (!count.ok || count.exitCode !== 0 || !/^\d+$/.test(count.stdout.trim())) return unknown(`${gitFailure(count, "git rev-list")} on ${name}`);
  if (n === 0) return ok(`every commit on ${name}'s branches and HEAD is on origin, and nothing tracked is uncommitted`);
  if (have.missing > 0) return unknown(`origin has commits ${name} lacks: fetch first`);
  // Branches first, so a commit on a branch is named by it and only a detached-only one by HEAD.
  const src = await git(dir, ["log", "--no-show-signature", "--source", "--format=%S", "-n", "1", "--branches", "HEAD", "--stdin"], { timeoutMs: GIT_LOCAL_MS, stdin });
  const ref = src.ok && src.exitCode === 0 ? src.stdout.trim() : "";
  const where = ref === "HEAD" ? "a detached HEAD" : /^[\w./-]{1,100}$/.test(ref) ? ref : null;
  const commits = plural(n, "commit", "commits");
  return notYet(where ? `${commits} on ${where} in ${name} ${n === 1 ? "is" : "are"} not on origin: push` : `${commits} in ${name} ${n === 1 ? "is" : "are"} not on origin: push`);
}

// ── restart ──────────────────────────────────────────────────────────────

const RESTART_CHANGED = "the code or .env on disk changed since muninn started: restart";

/**
 * `restart="<port>"`: the muninn listening on `<port>` runs the code and
 * configuration on disk now, and that disk contains origin's default-branch
 * tip. The boot fingerprint (`boot-fingerprint.ts`) is what the process
 * loaded; the disk is fingerprinted again here and must equal it, every
 * browser bundle's sources must equal what was read when it was built, and no
 * module may have been loaded after the boot fingerprint (its bytes at load
 * time are unknown). Then `checkoutCurrent` on muninn's own checkout. Never
 * names a file, a hash or a path.
 */
export async function probeRestart(value: string, deps: ProbeDeps): Promise<ProbeResult> {
  const r = deps.restart;
  if (!r) return unknown("this muninn does not read its own boot state");
  const port = r.listenPort();
  if (port === null) return unknown("this muninn's dashboard port is not known yet");
  if (Number(value) !== port) return unknown(`this muninn listens on ${port}`);
  const bootRead = r.boot();
  if (!bootRead) return unknown("muninn has not fingerprinted what it loaded yet");
  const boot = await bootRead;
  if (!boot.proven) return unknown(boot.why);
  const disk = await r.disk();
  if ("failed" in disk) return unknown(disk.failed);
  if (disk.fingerprint !== boot.snapshot.fingerprint) return notYet(RESTART_CHANGED);
  const bundles = r.bundles();
  for (const [file, hashes] of bundles.inputs) {
    const now = disk.hashes.has(file) ? disk.hashes.get(file)! : await r.hashNow(file);
    if (now === "failed") return unknown("a browser bundle's source could not be read");
    for (const h of hashes) if (h !== now) return notYet(RESTART_CHANGED);
  }
  if (bundles.unaccounted) return unknown("muninn built a browser bundle from a file it does not fingerprint");
  if (lateModules(r.loadedModules(), boot.modules).length > 0) return unknown("muninn loaded code after its boot fingerprint, so what it runs is not proven: restart");
  const current = await checkoutCurrent(r.checkout, "muninn's checkout", deps.git);
  if (current.state === "ok") return ok(`muninn runs the code and .env on disk, and ${current.why}`);
  if (current.state === "not-yet") return notYet(`${current.why.replace(/: pull$/, "")}: pull, then restart`);
  return current;
}

export const PROBES: Record<CheckProbe["kind"], (value: string, deps: ProbeDeps) => Promise<ProbeResult>> = {
  env: probeEnv,
  migration: probeMigration,
  checkout: probeCheckout,
  pushed: probePushed,
  restart: probeRestart,
};

/**
 * One probe started: `answer` resolves inside the probe's bound (`unknown` at
 * it), `settled` once the probe's own work has ended, however long after the
 * answer that is. A git-spawning probe holds its slot until `settled`, so the
 * git processes still running after a timed-out answer are counted.
 */
export function startProbe(probe: CheckProbe, deps: ProbeDeps): { answer: Promise<ProbeResult>; settled: Promise<void> } {
  let work: Promise<ProbeResult>;
  try {
    work = PROBES[probe.kind](probe.value, deps);
  } catch (err) {
    work = Promise.reject(err);
  }
  return {
    answer: bounded(work, PROBE_BOUND_MS[probe.kind]),
    settled: work.then(
      () => undefined,
      () => undefined,
    ),
  };
}

/** One probe, inside its own bound. */
export function runProbe(probe: CheckProbe, deps: ProbeDeps): Promise<ProbeResult> {
  return startProbe(probe, deps).answer;
}
