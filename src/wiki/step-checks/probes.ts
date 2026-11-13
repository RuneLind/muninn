/**
 * The read-only probes behind an owner step's `<Check>` (mimir plan
 * muninn-wiki-owner-step-checks, PR 2). Each answers `ok` only when it has
 * PROVEN the fact on this machine; anything it cannot prove is `not-yet` (the
 * fact provably does not hold yet) or `unknown`. `restart` has no probe yet
 * (`notProvableYet`): it always answers `unknown`. None writes: no `.env`
 * write, no fetch, pull or checkout, no DB write; the git probes (`checkout`,
 * `pushed`) run with replace refs, grafts and lazy fetch off and answer a
 * partial clone `unknown` before any object lookup (`refusePartialClone`).
 * `pushed` keeps git from running two kinds of command the config names: the
 * fsmonitor hook (switched off) and content filters (`unknown` before any
 * comparison). `checkout`'s `ls-remote` still runs what git runs to reach
 * origin: `remote.origin.uploadpack`, credential helpers, the transport.
 * `pushed` answers any `remote.origin.*` key outside its allowlist (uploadpack
 * among them) `unknown` before its `ls-remote`, which then runs only
 * credential helpers and the transport. Both read only a network origin: a
 * local one is `unknown`, since a path cannot be proven another repository;
 * both answer an operation in progress `unknown`, and a named roots entry
 * that is not the repo `unknown` rather than trying another clone.
 * Every outside read comes in through {@link ProbeDeps}, so tests never touch
 * the real machine, except both probes' `lstat` of the git-dir files an
 * operation in progress leaves, at paths git names, `pushed`'s `realpath` of each
 * worktree and git dir, its read of each linked git dir's `gitdir` file, and
 * its scratch index, a temp file outside the repo removed after use.
 *
 * A `why` is one short sentence for the reader: it names keys, repos,
 * branches, versions and short shas, never an env value, file contents or a
 * path.
 */

import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CheckProbe } from "../../format/check-tag.ts";
import { findRepo, type GitResult, type GitRun, type RepoRoots } from "../decision-triage/git.ts";
import { envFileKeyStates } from "./env-names.ts";

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
}

/**
 * Bounds per probe and per git call. `ls-remote` is the one network read.
 * `pushed`'s seven per-worktree git calls took 51–106 ms a worktree on the real
 * skills checkout and 140–406 ms on the real muninn checkout (measured
 * 2026-11-13, five runs each, the first one cold); its bound
 * stays under the answer's `ANSWER_BOUND_MS`.
 */
export const PROBE_BOUND_MS: Record<CheckProbe["kind"], number> = { env: 2_000, migration: 3_000, checkout: 6_500, pushed: 7_000, restart: 1_000 };
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

/** `git`, with {@link CHECKOUT_GIT_ENV} on every call, over any `env` the caller adds. */
const checkoutGit = (git: GitRun): GitRun => (cwd, args, opts) => git(cwd, args, { ...opts, env: opts?.env ? { ...opts.env, ...CHECKOUT_GIT_ENV } : CHECKOUT_GIT_ENV });

/** A partial clone's config: any promisor remote, or the repository extension. Matched against git's lower-cased names. */
const PARTIAL_CLONE_KEYS = "^(remote\\..*\\.promisor|extensions\\.partialclone)$";

/**
 * `unknown` for a partial clone, or when that cannot be read; null for a full
 * clone. Run before any object lookup: looking up a missing object in a
 * partial clone fetches it (measured: `cat-file -e` grew the pack directory and
 * made the tip present). `git` must already carry {@link CHECKOUT_GIT_ENV}.
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
 * ({@link refusePartialClone}), then an operation in progress (a stopped
 * `pull --rebase` leaves HEAD on origin's tip: {@link refuseInProgress}) and a
 * local origin ({@link refuseLocalOrigin}).
 */
export async function checkoutCurrent(dir: string, label: string, rawGit: GitRun): Promise<ProbeResult> {
  const git = checkoutGit(rawGit);
  const partial = await refusePartialClone(dir, label, git);
  if (partial) return partial;
  const busy = await refuseInProgress(dir, label, git);
  if (busy) return busy;
  // `false`: checkout proves what origin's URL serves, not where a push goes, so core.sshCommand is not refused.
  const local = await refuseLocalOrigin(dir, label, false, git);
  if (local) return local;
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
  // A named entry is the only candidate: findRepo would fall through to another clone under the root dirs.
  if (deps.roots.named.has(name)) {
    const found = await findRepo(name, { dirs: [], named: deps.roots.named }, deps.git);
    return "reason" in found ? unknown(`${name}'s entry in the repo roots is not that repo: ${found.reason}`) : found;
  }
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
 * Worktrees checked for uncommitted files; past it the answer is `unknown`.
 * One worktree's seven git calls took 140–406 ms on the real muninn checkout
 * (measured 2026-11-13), run one after another inside `PROBE_BOUND_MS.pushed`.
 */
export const PUSHED_MAX_WORKTREES = 12;

/**
 * On the `pushed` probe's index reads: keeps git from running the
 * `core.fsmonitor` hook the repo's config names, and from trusting an
 * fsmonitor extension in the index. It does not stop other repo-config
 * commands: a content filter is refused before any comparison
 * ({@link refuseFilters}).
 */
const NO_FSMONITOR = ["-c", "core.fsmonitor=false"] as const;

/** What an operation in progress leaves in a worktree's git dir, and the operation's name for the `why`. */
const IN_PROGRESS: readonly (readonly [string, string])[] = [
  ["MERGE_HEAD", "merge"],
  ["REBASE_HEAD", "rebase"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase or am"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["sequencer", "cherry-pick or revert"],
  ["BISECT_LOG", "bisect"],
  ["BISECT_START", "bisect"],
];

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

const ZERO_SHA = /^0+$/;

/**
 * Every worktree's HEAD commit from `git worktree list --porcelain -z`: records
 * separated by an empty field, each opening with `worktree <path>` and holding
 * one `HEAD <sha>` (all zeros: an unborn branch, no commit) or `bare`. Null
 * when any record breaks that shape or there is none. Other attributes
 * (`branch`, `detached`, `locked`, `prunable`) are skipped.
 */
export function parseWorktreeHeads(stdout: string): string[] | null {
  const list = parseWorktreeList(stdout);
  return list ? [...new Set(list.flatMap((w) => (w.head && !ZERO_SHA.test(w.head) ? [w.head] : [])))] : null;
}

/** One record of `git worktree list --porcelain`. `head` is null for a bare one; all zeros for an unborn branch. */
export interface WorktreeRecord {
  path: string;
  head: string | null;
  branch: string | null;
  prunable: boolean;
}

/** {@link parseWorktreeHeads}'s records, each with its path, branch and `prunable` flag. */
export function parseWorktreeList(stdout: string): WorktreeRecord[] | null {
  const records: string[][] = [[]];
  for (const field of stdout.split("\0")) {
    if (field === "") {
      if (records.at(-1)!.length > 0) records.push([]);
    } else records.at(-1)!.push(field);
  }
  if (records.at(-1)!.length === 0) records.pop();
  if (records.length === 0) return null;
  const out: WorktreeRecord[] = [];
  for (const fields of records) {
    if (!fields[0]!.startsWith("worktree ")) return null;
    const head = fields.filter((f) => f.startsWith("HEAD "));
    const bare = fields.includes("bare");
    if (head.length > 1 || (head.length === 0) === !bare) return null;
    const sha = head.length === 0 ? null : head[0]!.slice(5);
    if (sha !== null && !SHA.test(sha)) return null;
    const branch = fields.find((f) => f.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length) ?? null;
    out.push({ path: fields[0]!.slice("worktree ".length), head: sha, branch, prunable: fields.some((f) => f === "prunable" || f.startsWith("prunable ")) });
  }
  return out;
}

/**
 * Which of `tips` this repo has as commits, read with `cat-file --batch-check`
 * on stdin (no lazy fetch: the caller refused a partial clone and carries
 * {@link CHECKOUT_GIT_ENV}). Otherwise the `unknown` to answer: git failed,
 * a tip names a tag or tree, or a line muninn cannot read.
 */
async function presentTips(dir: string, name: string, tips: readonly string[], git: GitRun): Promise<{ present: string[]; missing: number } | ProbeResult> {
  if (tips.length === 0) return { present: [], missing: 0 };
  const res = await git(dir, ["cat-file", "--batch-check"], { timeoutMs: GIT_LOCAL_MS, maxLines: tips.length, stdin: `${tips.join("\n")}\n` });
  const garbled = unknown(`git cat-file gave an answer muninn cannot read on ${name}`);
  if (res.capped) return garbled;
  if (!res.ok || res.exitCode !== 0) return unknown(`${gitFailure(res, "git cat-file")} on ${name}`);
  const lines = res.stdout.split("\n").filter((l) => l !== "");
  if (lines.length !== tips.length) return garbled;
  const present: string[] = [];
  let missing = 0;
  for (let i = 0; i < tips.length; i++) {
    const tip = tips[i]!;
    const m = new RegExp(`^${tip} (\\w+) \\d+$`).exec(lines[i]!);
    if (lines[i] === `${tip} missing`) missing++;
    else if (m?.[1] === "commit") present.push(tip);
    else if (m) return unknown("an origin branch points at an object that is not a commit");
    else return garbled;
  }
  return { present, missing };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * `remote.origin.*` keys that change neither where `ls-remote` reads nor where
 * a push goes: they steer fetch's local refs only (`promisor` and
 * `partialclonefilter` are refused as a partial clone first). Every other key
 * (`uploadpack`, `receivepack`, `vcs`, `proxy`, `mirror`, any future one) is
 * `unknown`: an allowlist, since a per-key list of redirects twice missed one.
 */
const ORIGIN_KEYS_ALLOWED = new Set(["url", "fetch", "prune", "prunetags", "tagopt", "skipdefaultupdate", "skipfetchall", "followremotehead", "promisor", "partialclonefilter"]);

/**
 * Origin is where a push goes and where `ls-remote` reads, on another machine:
 * exactly one `remote.origin.url`, no `remote.origin.*` key outside
 * {@link ORIGIN_KEYS_ALLOWED}, no `pushInsteadOf` prefixing that URL (by git's
 * rule: an empty prefix matches every URL), no `remote.pushDefault` or
 * `branch.<x>.pushRemote` naming another remote, the URL after `insteadOf` a
 * network URL ({@link refuseLocalOrigin}), and no `core.sshCommand` when that
 * URL is ssh. Null when that holds; a read that failed, timed out or was capped
 * is `unknown`.
 */
async function refuseSplitOrigin(dir: string, name: string, git: GitRun): Promise<ProbeResult | null> {
  // `-z`: a url base may hold a space, which the `key value` form splits at.
  const res = await git(dir, ["config", "-z", "--get-regexp", "^(remote\\.origin\\.[^.]*|remote\\.pushdefault|branch\\..*\\.pushremote|url\\..*\\.pushinsteadof|core\\.sshcommand)$"], { timeoutMs: GIT_LOCAL_MS });
  if (res.exitCode === 1 && !res.stderr?.trim() && !res.timedOut) return unknown(`${name} has no origin`);
  // realGit keeps partial stdout on a timeout: a url line read without the rest proves nothing.
  if (!res.ok || res.capped || res.exitCode !== 0) return unknown(`${gitFailure(res, "git config")} on ${name}`);
  const split = unknown(`${name}'s origin pushes to another URL than the one muninn reads`);
  const urls: string[] = [];
  const pushInsteadOf: (string | null)[] = [];
  let sshCommand = false;
  for (const entry of res.stdout.split("\0")) {
    if (entry === "") continue;
    const nl = entry.indexOf("\n");
    const key = nl === -1 ? entry : entry.slice(0, nl);
    const value = nl === -1 ? null : entry.slice(nl + 1);
    if (key.startsWith("remote.origin.")) {
      const k = key.slice("remote.origin.".length);
      if (k === "pushurl") return split;
      if (k === "push") return unknown(`${name}'s origin has a push refspec: muninn does not check where it sends commits`);
      if (!ORIGIN_KEYS_ALLOWED.has(k)) return unknown(/^[a-z]+$/.test(k) ? `${name}'s origin has a ${k} setting: muninn cannot prove where its commits go` : `${name}'s origin has a setting muninn does not know: muninn cannot prove where its commits go`);
      if (k === "url") urls.push(value ?? "");
    } else if (key === "remote.pushdefault") {
      if (value !== "origin") return unknown(`${name}'s remote.pushDefault names a remote other than origin`);
    } else if (key.startsWith("branch.")) {
      if (value !== "origin") return unknown(`a branch of ${name} pushes to a remote other than origin`);
    } else if (key === "core.sshcommand") sshCommand = true;
    else pushInsteadOf.push(value);
  }
  if (urls.length !== 1) return unknown(`${name}'s origin has ${urls.length} URLs`);
  // A valueless pushInsteadOf proves nothing either way.
  if (pushInsteadOf.some((prefix) => prefix === null || urls[0]!.startsWith(prefix))) return split;
  return refuseLocalOrigin(dir, name, sshCommand, git);
}

/**
 * Whether git reaches `url` over the network. Only `https`, `http`, `ssh` and
 * `git` URLs with a host, and scp-like `[user@]host:path` as git's
 * `url_is_local_not_ssh` (connect.c, POSIX branch) decides it: no `://`, a
 * colon before any slash. A `<transport>::` helper, `file://`, any other or
 * upper-case scheme and every path are not.
 */
function isNetworkUrl(url: string): boolean {
  if (/^(https|http|ssh|git):\/\/[^/]/.test(url)) return true;
  if (url.includes("://") || url.includes("::")) return false;
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  return colon > 0 && (slash === -1 || colon < slash);
}

/**
 * `unknown` unless origin's URL after `insteadOf` (`ls-remote --get-url`, the
 * URL fetch and push both use once {@link refuseSplitOrigin} passed) is a
 * network URL ({@link isNetworkUrl}): a local path, gitfile or bundle can be
 * this checkout's own objects under another name, which no check closes. An ssh
 * URL with `core.sshCommand` set is `unknown` too: realGit's `GIT_SSH_COMMAND`
 * overrides it for the probe, while a push honours it.
 */
async function refuseLocalOrigin(dir: string, name: string, sshCommand: boolean, git: GitRun): Promise<ProbeResult | null> {
  const res = await git(dir, ["ls-remote", "--get-url", "origin"], { timeoutMs: GIT_LOCAL_MS, maxLines: 2 });
  if (!res.ok || res.capped || res.exitCode !== 0) return unknown(`${gitFailure(res, "git ls-remote")} on ${name}`);
  const lines = res.stdout.split("\n").filter((l) => l !== "");
  if (lines.length !== 1) return unknown(`muninn cannot tell where ${name}'s origin is`);
  const url = lines[0]!;
  if (!isNetworkUrl(url)) return unknown(`${name}'s origin is not a network address: muninn cannot prove it is another repository`);
  if (sshCommand && !/^(https|http|git):\/\//.test(url)) return unknown(`${name} sets core.sshCommand: muninn's read may reach another host than a push`);
  return null;
}

/** `unknown` when the probed worktree's git dir shows a merge, rebase, cherry-pick, revert or bisect in progress. Null when none does. */
async function refuseInProgress(dir: string, name: string, git: GitRun): Promise<ProbeResult | null> {
  const res = await git(dir, ["rev-parse", ...IN_PROGRESS.flatMap(([file]) => ["--git-path", file])], { timeoutMs: GIT_LOCAL_MS });
  const paths = res.stdout.split("\n").filter((l) => l !== "");
  if (!res.ok || res.exitCode !== 0 || paths.length !== IN_PROGRESS.length) return unknown(`${gitFailure(res, "git rev-parse")} on ${name}`);
  for (let i = 0; i < paths.length; i++) {
    try {
      await lstat(path.resolve(dir, paths[i]!));
      return unknown(`${name} has a ${IN_PROGRESS[i]![1]} in progress`);
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") return unknown(`muninn could not tell whether ${name} has an operation in progress`);
    }
  }
  return null;
}

/**
 * `unknown` when the index has a submodule (its commits are another repo's) or
 * an entry `status` does not look at: assume-unchanged (a lower-case tag in
 * `ls-files -v`) or skip-worktree (`S`, so a sparse checkout too). Null when
 * neither.
 */
async function refuseHiddenEntries(dir: string, name: string, git: GitRun): Promise<ProbeResult | null> {
  const res = await git(dir, [...NO_FSMONITOR, "ls-files", "-v", "-s", "-z"], { timeoutMs: GIT_LOCAL_MS });
  // No line cap here: a capped read hit the byte cap.
  if (res.capped) return unknown(`${name} has too many tracked files for muninn to read`);
  if (!res.ok || res.exitCode !== 0) return unknown(`${gitFailure(res, "git ls-files")} on ${name}`);
  let hidden = 0;
  for (const entry of res.stdout.split("\0")) {
    if (entry === "") continue;
    const m = /^(\S) (\d{6}) [0-9a-f]+ \d\t/.exec(entry);
    if (!m) return unknown(`git ls-files gave a line muninn cannot read on ${name}`);
    if (m[2] === "160000") return unknown(`${name} has submodules: muninn does not check their commits`);
    if (/^[a-z]$/.test(m[1]!) || m[1] === "S") hidden++;
  }
  return hidden > 0 ? unknown(`${plural(hidden, "tracked file is", "tracked files are")} marked assume-unchanged or skip-worktree in ${name}, so git does not show their changes`) : null;
}

/**
 * `unknown` when any config scope git reads in `dir` (the repo's, the user's,
 * the system's) names a `filter.<x>.clean` or `.process` command, whether or
 * not an attribute uses it: comparing an attributed file runs it (git-lfs's
 * writes into the git dir). Null when none does.
 */
async function refuseFilters(dir: string, label: string, git: GitRun): Promise<ProbeResult | null> {
  const res = await git(dir, ["config", "--get-regexp", "^filter\\..*\\.(clean|process)$"], { timeoutMs: GIT_LOCAL_MS });
  if (res.exitCode === 1 && !res.stderr?.trim() && !res.timedOut) return null;
  if (res.exitCode === 0) return unknown(`git's config for ${label} names a content filter command: muninn does not run it`);
  return unknown(`${gitFailure(res, "git config")} on ${label}`);
}

/**
 * Whether a tracked file in `dir` differs from HEAD by content: `status`
 * against a fresh index (`read-tree HEAD` into a temp file outside the repo).
 * That index holds no stat data, no assume-unchanged or skip-worktree bit and
 * no fsmonitor extension, so every file is read and compared (measured: an
 * edit `core.trustctime=false` or `core.checkStat=minimal` hid from `status`
 * shows). The temp file is removed on every path.
 */
async function freshIndexDirty(dir: string, label: string, git: GitRun): Promise<boolean | ProbeResult> {
  let tmp: string;
  try {
    tmp = await mkdtemp(path.join(tmpdir(), "muninn-pushed-index-"));
  } catch {
    return unknown(`muninn could not make a scratch index for ${label}`);
  }
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    // git splits only an index it read or one asked to split: `read-tree` into a fresh file wrote no `sharedindex.*`
    // even under `core.splitIndex=true` (measured, git 2.54). The switch is a guard; an explicit `--split-index` would write one.
    const read = await git(dir, [...NO_FSMONITOR, "-c", "core.splitIndex=false", "read-tree", "HEAD"], { timeoutMs: GIT_LOCAL_MS, env });
    if (!read.ok || read.exitCode !== 0) return unknown(`${gitFailure(read, "git read-tree")} on ${label}`);
    const status = await git(dir, [...NO_FSMONITOR, "status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=none"], { timeoutMs: GIT_LOCAL_MS, env });
    // A capped status already printed a change.
    if (status.capped && status.stdout !== "") return true;
    if (!status.ok || status.exitCode !== 0) return unknown(`${gitFailure(status, "git status")} on ${label}`);
    return status.stdout !== "";
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Null when nothing tracked in worktree `wt` is modified or staged, proven by
 * content. `unknown` for an unborn HEAD, an operation in progress, a content
 * filter, a hidden index entry or a submodule; `not-yet` for a staged or
 * modified file. The caller has proven `wt.real` is that worktree
 * ({@link refuseMisplacedWorktrees}).
 */
async function worktreeUncommitted(wt: WorktreeRecord & { real: string }, probed: boolean, name: string, git: GitRun): Promise<ProbeResult | null> {
  const label = probed ? name : `another worktree of ${name}`;
  if (wt.head === null || ZERO_SHA.test(wt.head)) return unknown(`${label} has no commit yet`);
  const dir = wt.real;
  const refused = (await refuseInProgress(dir, label, git)) ?? (await refuseFilters(dir, label, git)) ?? (await refuseHiddenEntries(dir, label, git));
  if (refused) return refused;
  const branch = wt.branch && /^[\w./-]{1,100}$/.test(wt.branch) ? ` (on ${wt.branch})` : "";
  const dirty = notYet(probed ? `${name} has uncommitted changes: commit and push` : `${name} has uncommitted changes in another worktree${branch}: commit and push`);
  // The index against HEAD's tree: no stat data is read.
  const staged = await git(dir, [...NO_FSMONITOR, "diff-index", "--cached", "--quiet", "HEAD"], { timeoutMs: GIT_LOCAL_MS });
  if (staged.exitCode === 1 && !staged.timedOut) return dirty;
  if (!staged.ok || staged.exitCode !== 0) return unknown(`${gitFailure(staged, "git diff-index")} on ${label}`);
  const files = await freshIndexDirty(dir, label, git);
  if (typeof files !== "boolean") return files;
  return files ? dirty : null;
}

/** What git answers in a worktree directory, each path `realpath`'d; null for a path that does not resolve. */
interface WorktreeIdentity {
  gitDir: string | null;
  common: string | null;
  top: string | null;
}

/** `rev-parse` in `dir`: its git dir, common dir and toplevel, absolute. Otherwise the `unknown` to answer. */
async function worktreeIdentity(dir: string, label: string, git: GitRun): Promise<WorktreeIdentity | ProbeResult> {
  const res = await git(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"], { timeoutMs: GIT_LOCAL_MS, maxLines: 3 });
  const garbled = unknown(`git rev-parse gave an answer muninn cannot read on ${label}`);
  if (res.capped) return garbled;
  if (!res.ok || res.exitCode !== 0) return unknown(`${gitFailure(res, "git rev-parse")} on ${label}`);
  const lines = res.stdout.split("\n").filter((l) => l !== "");
  if (lines.length !== 3 || !lines.every((l) => path.isAbsolute(l))) return garbled;
  const [gitDir, common, top] = await Promise.all(lines.map((l) => realpath(l).catch(() => null)));
  return { gitDir: gitDir!, common: common!, top: top! };
}

/**
 * The directory a linked git dir's `gitdir` file names (`<worktree>/.git`, absolute or
 * relative to the git dir: gitrepository-layout), `realpath`'d; git lists that record
 * at this path. Null when the file is missing, unreadable or of another shape.
 */
async function recordedDir(gitDir: string): Promise<string | null> {
  try {
    const line = (await readFile(path.join(gitDir, "gitdir"), "utf8")).trimEnd();
    if (!line.endsWith("/.git")) return null;
    return await realpath(path.dirname(path.resolve(gitDir, line)));
  } catch {
    return null;
  }
}

/**
 * Null only when every record's directory D is the worktree git listed, so each
 * check reads the index and HEAD that record stands for. Every D exists and the
 * Ds are distinct; in each, `rev-parse` names (i) the probed repo's common dir
 * C and (ii) D as its toplevel; (iii) no two Ds share a git dir; (iv) the git
 * dir G (realpath'd) sits in exactly one cell:
 *
 * 1. G == C: D must be the main record, and the main record must be here. Git
 *    lists the main record from C itself, and by (iii) no other D uses C.
 * 2. dirname(G) == C/worktrees (a direct child): G's `gitdir` file must name D.
 *    Git lists every direct child of C/worktrees whose `gitdir` file it can
 *    read, at the path that file names, resolved against G as here, so G is
 *    listed at D; the Ds are distinct, so that listing is D's own record, and
 *    by (iii) no other D uses G. A direct child git does not list (its `gitdir`
 *    file gone, empty or naming another directory) fails the back-link.
 * 3. Anything else (outside C, nested deeper under C/worktrees, C/worktrees
 *    itself, C's parent): `unknown`. Git accepts such a G when it has an
 *    absolute `commondir`, but lists none, so its index and HEAD are no
 *    record's (reproduced: a copied admin dir answered `ok` over the record's
 *    staged index, and over an unpushed commit checked out at D).
 *
 * So a D that passes uses its own record's git dir, and (ii) rules out a
 * working tree moved off D. A clone at D fails (i); a symlink onto another
 * record's D fails the distinctness check. `resolved[0]` is the main record
 * when it is not bare.
 */
async function refuseMisplacedWorktrees(resolved: readonly (WorktreeRecord & { real: string | null; main: boolean })[], dir: string, name: string, git: GitRun): Promise<ProbeResult | null> {
  if (resolved.some((w) => w.prunable || !w.real)) return unknown(`a worktree of ${name} is missing its directory: muninn cannot check it`);
  const own = resolved.filter((w) => w.real === dir);
  if (own.length !== 1) return unknown(`git worktree list does not name ${name}'s own worktree once`);
  if (new Set(resolved.map((w) => w.real)).size !== resolved.length) return unknown(`two worktrees of ${name} resolve to one directory`);
  const label = (w: { real: string | null }) => (w.real === dir ? name : `another worktree of ${name}`);
  // One git call at a time, the probed worktree first.
  const answers = new Map<(typeof resolved)[number], WorktreeIdentity>();
  for (const w of [own[0]!, ...resolved.filter((r) => r !== own[0])]) {
    const id = await worktreeIdentity(w.real!, label(w), git);
    if ("state" in id) return id;
    answers.set(w, id);
  }
  const misplaced = unknown(`a worktree of ${name} is not where git recorded it`);
  const common = answers.get(own[0]!)!.common;
  if (common === null || [...answers].some(([w, a]) => a.common !== common || a.gitDir === null || a.top !== w.real)) return misplaced;
  if (new Set([...answers.values()].map((a) => a.gitDir)).size !== answers.size) return unknown(`two worktrees of ${name} share one git dir`);
  const admins = path.join(common, "worktrees");
  for (const [w, { gitDir }] of answers) {
    // Cell 1: the common dir, the main record's only. Cell 2: a direct child of worktrees/ naming D. Cell 3: neither.
    if (gitDir === common) {
      if (!w.main) return misplaced;
    } else if (w.main || path.dirname(gitDir!) !== admins || (await recordedDir(gitDir!)) !== w.real) return misplaced;
  }
  return null;
}

/**
 * `pushed="<repo>"`: no commit reachable from a local branch (`refs/heads/*`)
 * or from any worktree's HEAD is missing from the branches origin has NOW, and
 * no tracked file in ANY worktree is modified or staged, compared by content
 * ({@link worktreeUncommitted}; at most {@link PUSHED_MAX_WORKTREES}).
 *
 * Origin's tips come from one live `ls-remote --heads`, never the local
 * `refs/remotes/*`, which are only as fresh as the last fetch. Only tips
 * present here are walked (`rev-list --stdin`, so no list overflows the
 * argument length): 0 missing is `ok`, some missing with every tip present is
 * `not-yet`, some missing with a tip absent is `unknown` (the commits may sit
 * under that tip). Everything that could hide a change or a commit is
 * `unknown` before that: a partial or shallow clone, an origin that pushes
 * elsewhere than it reads, a worktree record that is not that worktree
 * ({@link refuseMisplacedWorktrees}), and per worktree an operation
 * in progress, a content filter, a submodule, an assume-unchanged or
 * skip-worktree entry. Untracked files are not counted.
 */
export async function probePushed(name: string, deps: ProbeDeps): Promise<ProbeResult> {
  const git = checkoutGit(deps.git);
  const found = await repoDir(name, { ...deps, git });
  if (!("dir" in found)) return found;
  const { dir } = found;
  const refused =
    (await refusePartialClone(dir, name, git)) ??
    (await (async () => {
      const shallow = await git(dir, ["rev-parse", "--is-shallow-repository"], { timeoutMs: GIT_LOCAL_MS });
      if (!shallow.ok || shallow.exitCode !== 0) return unknown(`${gitFailure(shallow, "git rev-parse")} on ${name}`);
      if (shallow.stdout.trim() === "true") return unknown(`${name} is a shallow clone: muninn cannot walk all of its history`);
      return shallow.stdout.trim() === "false" ? null : unknown(`git could not say whether ${name} is a shallow clone`);
    })()) ??
    (await refuseSplitOrigin(dir, name, git));
  if (refused) return refused;
  const listed = await git(dir, ["worktree", "list", "--porcelain", "-z"], { timeoutMs: GIT_LOCAL_MS });
  if (!listed.ok || listed.capped || listed.exitCode !== 0) return unknown(`${gitFailure(listed, "git worktree list")} on ${name}`);
  const records = parseWorktreeList(listed.stdout);
  if (!records) return unknown(`git worktree list gave an answer muninn cannot read on ${name}`);
  const worktreeHeads = parseWorktreeHeads(listed.stdout)!;
  // `git worktree list` names the main worktree first; a bare main has no HEAD and is skipped.
  const worktrees = records.flatMap((w, i) => (w.head !== null ? [{ ...w, main: i === 0 }] : []));
  if (worktrees.length > PUSHED_MAX_WORKTREES) return unknown(`${name} has over ${PUSHED_MAX_WORKTREES} worktrees: muninn does not check them all`);
  const resolved = await Promise.all(worktrees.map(async (w) => ({ ...w, real: await realpath(w.path).catch(() => null) })));
  const misplaced = await refuseMisplacedWorktrees(resolved, dir, name, git);
  if (misplaced) return misplaced;
  const checked = resolved as (WorktreeRecord & { real: string })[];
  const own = checked.find((w) => w.real === dir)!;
  // The probed worktree first, then the rest; the first answer that is not «clean» stands.
  for (const wt of [own, ...checked.filter((w) => w !== own)]) {
    const found = await worktreeUncommitted(wt, wt === own, name, git);
    if (found) return found;
  }
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
  const have = await presentTips(dir, name, tips, git);
  if ("state" in have) return have;
  // Every worktree's HEAD is a start, every present origin tip an end. HEAD on the command line is the probed worktree's.
  const stdin = [...worktreeHeads, ...have.present.map((t) => `^${t}`)].map((l) => `${l}\n`).join("");
  const walk = ["--branches", "HEAD", "--stdin"];
  const count = await git(dir, ["rev-list", "--count", ...walk], { timeoutMs: GIT_LOCAL_MS, stdin });
  if (!count.ok || count.exitCode !== 0 || !/^\d+$/.test(count.stdout.trim())) return unknown(`${gitFailure(count, "git rev-list")} on ${name}`);
  const n = Number(count.stdout.trim());
  const scope = worktrees.length === 1 ? "its worktree" : `any of its ${worktrees.length} worktrees`;
  if (n === 0) return ok(`every commit on ${name}'s branches and worktree HEADs is on an origin branch, and no tracked file is modified or staged in ${scope}`);
  if (have.missing > 0) return unknown(`origin has ${plural(have.missing, "branch tip", "branch tips")} ${name} does not have: fetch first`);
  // Which start reaches one of the unpushed commits: a branch's name, `HEAD`, or a worktree HEAD's sha.
  const src = await git(dir, ["log", "--no-show-signature", "--source", "--format=%S", "-n", "1", ...walk], { timeoutMs: GIT_LOCAL_MS, stdin });
  const ref = src.ok && src.exitCode === 0 ? src.stdout.trim() : "";
  const where = ref === "HEAD" ? "HEAD" : worktreeHeads.includes(ref) ? `a worktree's HEAD ${ref.slice(0, 7)}` : /^[\w./-]{1,100}$/.test(ref) ? ref : null;
  const commits = `${plural(n, "commit", "commits")} in ${name} ${n === 1 ? "is" : "are"} on no origin branch`;
  return notYet(where ? `${commits} (${n === 1 ? "on" : "one of them on"} ${where}): push` : `${commits}: push`);
}

// ── restart ──────────────────────────────────────────────────────────────

/**
 * `restart` until its probe is rebuilt from a corrected spec: the earlier one
 * could answer `ok` falsely by design (a reverted edit), and the boot
 * fingerprint that replaced it still had false-ok paths (PR #849). Spawns
 * nothing and reads nothing.
 */
export async function notProvableYet(): Promise<ProbeResult> {
  return unknown("muninn cannot prove this yet");
}

export const PROBES: Record<CheckProbe["kind"], (value: string, deps: ProbeDeps) => Promise<ProbeResult>> = {
  env: probeEnv,
  migration: probeMigration,
  checkout: probeCheckout,
  pushed: probePushed,
  restart: notProvableYet,
};

/** Whether a probe kind runs anything: `restart` answers without reading or spawning. */
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
