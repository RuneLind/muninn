/**
 * The read-only probes behind an owner step's `<Check>` (mimir plan
 * muninn-wiki-owner-step-checks, PR 2). Each answers `ok` only when it has
 * PROVEN the fact on this machine; anything it cannot prove is `not-yet` (the
 * fact provably does not hold yet) or `unknown`. `pushed` and `restart` have
 * no probe yet (`notProvableYet`): they always answer `unknown`. None writes: no `.env`
 * write, no fetch, pull or checkout, no DB write; the checkout probe's git runs
 * with lazy fetch off and answers a partial clone `unknown` before any object
 * lookup (`checkoutCurrent`). Every outside read comes in
 * through {@link ProbeDeps}, so tests never touch the real machine.
 *
 * A `why` is one short sentence for the reader: it names keys, repos,
 * branches, versions and short shas, never an env value, file contents or a
 * path.
 */

import type { CheckProbe } from "../../format/check-tag.ts";
import { findRepo, type GitResult, type GitRun, type RepoRoots } from "../decision-triage/git.ts";
import { envFileKeyStates } from "./env-names.ts";

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
  /** Every `schema_migrations.version` of this machine's database: ONE read, shared by every `migration=` probe of a cache window; throws when it cannot be read. */
  appliedMigrations: () => Promise<ReadonlySet<string>>;
}

/** Bounds per probe and per git call. `ls-remote` is the one network read. */
export const PROBE_BOUND_MS: Record<CheckProbe["kind"], number> = { env: 2_000, migration: 3_000, checkout: 6_500, pushed: 1_000, restart: 1_000 };
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
  const { keys, lostTrack } = envFileKeyStates(read.text);
  if (lostTrack) return unknown(".env has a line muninn cannot read the way Bun does");
  const state = keys.get(key);
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
 * Whether `dir`'s HEAD contains origin's default-branch tip as origin has it
 * NOW, never the local `origin/<branch>` ref, which is only as fresh as the
 * last fetch. A partial clone is `unknown` before anything else: looking up a
 * missing object there fetches it (measured: `cat-file -e` grew the pack
 * directory and made the tip present).
 */
export async function checkoutCurrent(dir: string, label: string, rawGit: GitRun): Promise<ProbeResult> {
  const git = checkoutGit(rawGit);
  // Exit 1 with nothing on stderr is «no such key»; a match, or anything else, proves nothing.
  const partial = await git(dir, ["config", "--get-regexp", PARTIAL_CLONE_KEYS], { timeoutMs: GIT_LOCAL_MS });
  if (partial.exitCode === 0) return unknown(`${label} is a partial clone: muninn does not look up objects it would have to fetch`);
  if (partial.exitCode !== 1 || partial.stderr?.trim()) return unknown(`${gitFailure(partial, "git config")} on ${label}`);
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

// ── pushed, restart ──────────────────────────────────────────────────────

/**
 * `pushed` and `restart` until their probes are rebuilt from a corrected
 * spec: the earlier ones could answer `ok` falsely by design (an upstream-less
 * branch, a reverted edit). Spawns nothing and reads nothing.
 */
export async function notProvableYet(): Promise<ProbeResult> {
  return unknown("muninn cannot prove this yet");
}

export const PROBES: Record<CheckProbe["kind"], (value: string, deps: ProbeDeps) => Promise<ProbeResult>> = {
  env: probeEnv,
  migration: probeMigration,
  checkout: probeCheckout,
  pushed: notProvableYet,
  restart: notProvableYet,
};

/** Whether a probe kind runs anything: `pushed` and `restart` answer without reading or spawning. */
export const probeRuns = (kind: CheckProbe["kind"]): boolean => PROBES[kind] !== notProvableYet;

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
