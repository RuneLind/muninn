/**
 * The repo-sync loop's per-repo state machine.
 *
 * One tick, per configured repo: fetch → (locked) status → commit → rebase →
 * (unlocked) push → refresh the reader cache. Driven by two triggers that share
 * this ONE code path — a 15-minute launchd `curl` and the dashboard's "Sync now"
 * button, both landing on `POST /api/sync/run`.
 *
 * **The locking contract, the deferral semantics and the non-obvious git rules
 * are stated ONCE in `src/sync/CLAUDE.md`.** Read it before changing anything in
 * here; the per-site comments below assume it and only add local detail.
 */

import path from "node:path";
import os from "node:os";
import { stat, realpath } from "node:fs/promises";
import {
  GIT_NETWORK_TIMEOUT_MS,
  gitToplevel,
  isDefaultBranch,
  listDirtyEntries,
  pathExists,
  runExclusiveQueued,
  runGit,
  type PorcelainStatusEntry,
} from "../wiki/commit.ts";
import { runWikiWriteExclusive, wikiWriteQueueKey } from "../wiki/queue.ts";
import { getWikiIndex } from "../wiki/store.ts";
import { buildReindexResponse, postCollectionUpdate } from "../wiki/reindex.ts";
import {
  blocksRebase,
  clampReason,
  decideStaging,
  describeDeferralReason,
  describeSyncState,
  isCompanionHold,
  isFreshMtimeHold,
  isTransientGitLockFailure,
  isUnmergedStatus,
  syncTone,
  type DirtyItem,
  type SyncLedgerEntry,
  type SyncState,
  type SyncTone,
} from "./decide.ts";
import { findSyncRepoCoveringToplevel, type SyncRepo } from "./config.ts";
import { getLog } from "../logging.ts";

const log = getLog("sync", "run");

/** An `index.lock` younger than this is a LIVE concurrent git op (a `git status`
 *  from a shell, an editor's git integration) — reported transient, retried next
 *  tick. Older than this and it is a crashed process's leftover, which only a
 *  human should remove. */
export const INDEX_LOCK_STALE_MS = 3 * 60 * 1000;

/** The card fields — everything derivable from a fetched repo without changing it. */
export interface RepoCard {
  name: string;
  mode: SyncRepo["mode"];
  path: string;
  /** Current branch, or null when detached. */
  branch: string | null;
  onDefaultBranch: boolean;
  /** The upstream ref the ahead/behind counts are against. */
  upstream: string | null;
  /** True when the branch has NO configured upstream and `origin/main` was used
   *  as a labelled fallback — the counts mean something slightly different and
   *  the card says so rather than implying a tracking relationship. */
  upstreamFallback: boolean;
  ahead: number | null;
  behind: number | null;
  /** Dirty entries in the repo's sync scope (the wiki subtree for a wiki repo). */
  dirtyCount: number;
  /** Standing configuration warnings about this repo, shown on the card until
   *  fixed (e.g. a wiki whose `log.md` carries no `merge=union`). Not a tick
   *  outcome — these do not change from run to run. */
  warnings: string[];
  /** Commit date of the upstream ref's tip (epoch ms) — how fresh what we can
   *  SEE of the other machine is. A mini that has not pushed in days shows
   *  stale here rather than reading as in-sync. */
  remoteCommitMs: number | null;
  /**
   * When this repo last fetched (`.git/FETCH_HEAD` mtime), which is exactly how
   * old `ahead`/`behind`/`remoteCommitMs` are.
   *
   * Load-bearing because the card's read path deliberately does NOT fetch:
   * without this, "behind 0" is indistinguishable from "behind 0 as of three
   * hours ago", and the whole point of the card is answering "do I have
   * everything from both machines". It is a separate signal from `lastRunMs`,
   * which is null after a restart even when FETCH_HEAD is minutes old.
   */
  lastFetchMs: number | null;
}

export interface RepoSyncResult extends RepoCard {
  state: SyncState;
  reason?: string;
  tone: SyncTone;
  label: string;
  dryRun: boolean;
  /** Paths committed this tick — or, in a dry run, the paths that WOULD be. */
  committed: string[];
  deferredFiles: { path: string; reason: string }[];
  denied: string[];
  rebased: boolean;
  pushed: boolean;
  /** Paths git reported as conflicting, on `state: "blocked"` / `conflict`. */
  conflicts?: string[];
  error?: string;
  /** Narration of what happened (or, in a dry run, would happen). */
  actions: string[];
  durationMs: number;
  /** Ledger echo, so the card needs no second endpoint. */
  lastRunMs: number | null;
  lastSuccessMs: number | null;
  /** Last tick that got THROUGH the local (commit) section without failing in
   *  it — the clock `syncSubsumesSweeper` reads. Rendered beside "last sync"
   *  because the two differing IS the diagnosis: ticking but never committing. */
  lastLocalSectionMs: number | null;
  consecutiveDeferrals: number;
}

export interface SyncRunReport {
  repos: RepoSyncResult[];
  warnings: string[];
  dryRun: boolean;
  startedAt: number;
  durationMs: number;
}

/** Side-effecting seams the fixture tests replace with no-ops. */
export interface SyncDeps {
  /** Refresh the reader's 5-minute page-index cache for a wiki root that just
   *  pulled — without it a pulled page stays invisible in `/wiki` for up to the
   *  full TTL. */
  refreshWikiIndex: (root: string) => Promise<void>;
  /** Best-effort huginn reindex kick. Conditional and silent by design: huginn
   *  is unreachable from the mini, so this must never colour the tick's outcome. */
  reindexCollections: (collections: string[]) => Promise<void>;
  now: () => number;
}

export function defaultSyncDeps(knowledgeApiUrl?: string): SyncDeps {
  return {
    refreshWikiIndex: async (root) => {
      await getWikiIndex({ root, refresh: true });
    },
    // The SHARED reindex assembler + poster the wiki routes use, not a third
    // hand-spelled fan-out: the private copy here used its own timeout and had no
    // 409 handling, so huginn's CAS conflict (a nightly rebuild already running —
    // the honest `already-running` state) was bucketed as a failure.
    reindexCollections: async (collections) => {
      if (!knowledgeApiUrl || collections.length === 0) return;
      const res = await buildReindexResponse(collections, (name) =>
        postCollectionUpdate(knowledgeApiUrl, name),
      );
      for (const c of res.collections) {
        // Degrade silently at INFO — v1 runs on a machine where huginn is
        // unreachable, and a search index one tick behind is not a card state.
        if (c.state === "error") {
          log.info("Sync: reindex kick for {name} failed: {error}", { name: c.name, error: c.error });
        }
      }
    },
    now: () => Date.now(),
  };
}

// ── Ledger ──────────────────────────────────────────────────────────────────
//
// In-memory, per process. Deliberately not persisted: after a restart the card
// simply reports "no sync yet in this process" and the next tick (≤15 min)
// refills it. A DB table would be a schema for something a `git status` already
// answers.

const ledger = new Map<string, SyncLedgerEntry>();

/** In-flight guard — the launchd tick and a "Sync now" click can land together. */
const inFlight = new Set<string>();

export function getSyncLedgerEntry(name: string): SyncLedgerEntry {
  return (
    ledger.get(name) ?? {
      // NOT `ok`: the default is the absence of evidence, and rendered as a
      // state it rode the card payload as "in sync" while the label beside it
      // said "not synced yet". `recordLedger` never writes this value back.
      state: "unknown",
      consecutiveDeferrals: 0,
      lastSuccessMs: null,
      lastRunMs: null,
      lastLocalSectionMs: null,
    }
  );
}

/** Test-only: clear the ledger + in-flight set between cases. */
export function __resetSyncStateForTest(): void {
  ledger.clear();
  inFlight.clear();
}

/**
 * `commitPathOk` is passed by the caller rather than derived from the state:
 * the SAME state can land on any of three sides of the local section (a rebase
 * failure is `error` and failed INSIDE the commit path; a failed fetch is
 * `error` and never reached it; a failed push is `error` AFTER it, with the
 * commit already made). Only the call site knows which, and
 * `syncSubsumesSweeper` reads the difference. It means "this tick exercised the
 * commit path AND the commit path did not fail" — not merely "we got as far as
 * trying", which is what let a repo whose every commit failed renew the sweeper
 * stand-down forever, and not "the whole tick succeeded" either: a push failure
 * stamps, because the sweeper could add nothing the loop did not already commit.
 */
function recordLedger(
  name: string,
  result: RepoSyncResult,
  now: number,
  commitPathOk: boolean,
): SyncLedgerEntry {
  const prev = getSyncLedgerEntry(name);
  const entry: SyncLedgerEntry = {
    state: result.state,
    reason: result.reason,
    consecutiveDeferrals: result.state === "deferred" ? prev.consecutiveDeferrals + 1 : 0,
    lastSuccessMs:
      result.state === "ok" || result.state === "status-only" ? now : prev.lastSuccessMs,
    lastRunMs: now,
    lastLocalSectionMs: commitPathOk ? now : prev.lastLocalSectionMs,
    lastError: result.error ?? (result.state === "blocked" ? result.reason : undefined),
  };
  ledger.set(name, entry);
  return entry;
}

// ── Git reads ───────────────────────────────────────────────────────────────

/** Resolve a `.git`-relative path. NB `rev-parse --git-path` ALWAYS prints a
 *  path whether or not it exists — the question is answered by `stat`, never by
 *  the exit code. */
async function gitPath(top: string, name: string): Promise<string | null> {
  const r = await runGit(top, ["rev-parse", "--git-path", name]);
  if (r.code !== 0 || !r.stdout) return null;
  return path.isAbsolute(r.stdout) ? r.stdout : path.join(top, r.stdout);
}

/** When the repo last fetched — the mtime of `.git/FETCH_HEAD`. Null when the
 *  repo has never fetched (a local-only repo, a fresh `git init`). */
async function lastFetchMs(top: string): Promise<number | null> {
  const p = await gitPath(top, "FETCH_HEAD");
  if (!p) return null;
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

type Preflight =
  | { kind: "clear" }
  | { kind: "blocked"; reason: string }
  | { kind: "transient"; reason: string };

/**
 * Is a git operation already in progress? An in-progress rebase / merge /
 * cherry-pick means a human is mid-something and the tree must not be touched.
 * An `index.lock` is judged by AGE: a young one is a live concurrent git op
 * (transient, retry next tick), an old one is a crash leftover a human must
 * clear — auto-removing it is exactly how two git processes corrupt an index.
 */
async function preflight(top: string, now: number): Promise<Preflight> {
  for (const name of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
    const p = await gitPath(top, name);
    if (p && (await pathExists(p))) {
      return { kind: "blocked", reason: `a git operation is in progress (${name})` };
    }
  }
  const lock = await gitPath(top, "index.lock");
  if (lock && (await pathExists(lock))) {
    let ageMs = 0;
    try {
      ageMs = now - (await stat(lock)).mtimeMs;
    } catch {
      ageMs = 0;
    }
    if (ageMs > INDEX_LOCK_STALE_MS) {
      return {
        kind: "blocked",
        reason: `a stale .git/index.lock (${Math.round(ageMs / 60000)} min old) — remove it by hand`,
      };
    }
    return { kind: "transient", reason: "another git process holds .git/index.lock" };
  }
  return { kind: "clear" };
}

/** True when a rebase is actually in progress — the ONLY condition under which
 *  `git rebase --abort` is the right response. A failure BEFORE a rebase started
 *  (a network error, a refused dirty tree) leaves no rebase directory, and
 *  attempting an abort there just prints a confusing second error. */
async function rebaseInProgress(top: string): Promise<boolean> {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const p = await gitPath(top, name);
    if (p && (await pathExists(p))) return true;
  }
  return false;
}

async function currentBranch(top: string): Promise<string | null> {
  const r = await runGit(top, ["branch", "--show-current"]);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

/**
 * Does the wiki's `log.md` carry `merge=union`?
 *
 * `log.md` is append-only and wiki-GLOBAL, so both machines append to its tail
 * every day. Without the union merge driver that is a textual conflict on the
 * first rebase that crosses two appends — the loop then reports `blocked` and a
 * human has to resolve a file whose correct resolution is always "keep both".
 * mimir declares it; a wiki that does not gets a standing card warning rather
 * than a surprise conflict.
 *
 * Memoized per toplevel: this is configuration, not state, and the card polls.
 */
const mergeUnionWarnCache = new Map<string, string | null>();

async function logMergeUnionWarning(repo: SyncRepo, top: string): Promise<string | null> {
  if (repo.mode !== "wiki" || !repo.wikiRoot) return null;
  const cached = mergeUnionWarnCache.get(top);
  if (cached !== undefined) return cached;
  const canonicalWiki = await realpath(repo.wikiRoot).catch(() => repo.wikiRoot!);
  const rel = path.relative(top, path.join(canonicalWiki, "log.md"));
  const r = await runGit(top, ["check-attr", "merge", "--", rel]);
  // `check-attr` prints `<path>: merge: <value>` — `unspecified` when no rule
  // matches. A failed call tells us nothing, so it warns about nothing.
  const ok = r.code !== 0 || /:\s*merge:\s*union\s*$/.test(r.stdout.trim());
  const warning = ok
    ? null
    : `log.md has no merge=union — concurrent appends from both machines will conflict (add \`log.md merge=union\` to .gitattributes)`;
  mergeUnionWarnCache.set(top, warning);
  return warning;
}

/** The upstream ref for the current branch, falling back to `origin/main` when
 *  none is configured (labelled, so the card never implies a tracking branch
 *  that does not exist). Null when neither resolves. */
async function resolveUpstream(
  top: string,
): Promise<{ ref: string | null; fallback: boolean }> {
  const u = await runGit(top, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (u.code === 0 && u.stdout) return { ref: u.stdout, fallback: false };
  const fb = await runGit(top, ["rev-parse", "--verify", "--quiet", "origin/main"]);
  if (fb.code === 0 && fb.stdout) return { ref: "origin/main", fallback: true };
  return { ref: null, fallback: false };
}

async function aheadBehind(
  top: string,
  upstream: string,
): Promise<{ ahead: number | null; behind: number | null }> {
  const r = await runGit(top, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
  if (r.code !== 0) return { ahead: null, behind: null };
  const [left, right] = r.stdout.split(/\s+/);
  const behind = Number(left);
  const ahead = Number(right);
  return {
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
  };
}

async function refCommitMs(top: string, ref: string): Promise<number | null> {
  const r = await runGit(top, ["log", "-1", "--format=%ct", ref]);
  if (r.code !== 0 || !r.stdout) return null;
  const secs = Number(r.stdout.trim());
  return Number.isFinite(secs) ? secs * 1000 : null;
}

async function headSha(top: string): Promise<string | null> {
  const r = await runGit(top, ["rev-parse", "HEAD"]);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

/** Decorate porcelain entries with the one filesystem fact the decision layer
 *  needs: the mtime, or `null` for a path absent on disk (a deletion). Paths are
 *  REPO-relative (git emits them that way even under an absolute pathspec), so
 *  they join onto the toplevel — the wiki-relative → absolute → repo-relative
 *  translation `commitInner` performs is for callers holding wiki-relative
 *  paths, which this one never does. */
async function decorate(top: string, entries: PorcelainStatusEntry[]): Promise<DirtyItem[]> {
  const out: DirtyItem[] = [];
  for (const e of entries) {
    let mtimeMs: number | null = null;
    try {
      mtimeMs = (await stat(path.join(top, e.path))).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    out.push({ path: e.path, xy: e.xy, ...(e.origPath ? { origPath: e.origPath } : {}), mtimeMs });
  }
  return out;
}

/** The card fields for a repo we could not read at all (no toplevel, an
 *  in-flight guard, an unexpected throw). ONE spelling — it was written out
 *  twice, and a field added to only one of them is a silently wrong card. */
function emptyCard(repo: SyncRepo): RepoCard {
  return {
    name: repo.name,
    mode: repo.mode,
    path: repo.path,
    branch: null,
    onDefaultBranch: false,
    upstream: null,
    upstreamFallback: false,
    ahead: null,
    behind: null,
    dirtyCount: 0,
    warnings: [],
    remoteCommitMs: null,
    lastFetchMs: null,
  };
}

/** Read every card field. Assumes a fetch has already run (or deliberately has
 *  not, for the no-fetch status endpoint). */
async function readCard(repo: SyncRepo, top: string): Promise<RepoCard> {
  // ONE `branch --show-current` for both the display and the default-branch
  // test: `onDefaultBranch` would spawn a second one, and this runs up to three
  // times per tick plus on every card poll.
  const branch = await currentBranch(top);
  const { ref: upstream, fallback } = await resolveUpstream(top);
  const counts = upstream
    ? await aheadBehind(top, upstream)
    : { ahead: null as number | null, behind: null as number | null };
  const scopeAbs = repo.mode === "wiki" ? repo.wikiRoot : undefined;
  const scoped = await listDirtyEntries(top, scopeAbs);
  const unionWarning = await logMergeUnionWarning(repo, top);
  return {
    name: repo.name,
    mode: repo.mode,
    path: repo.path,
    branch,
    onDefaultBranch: await isDefaultBranch(top, branch),
    upstream,
    upstreamFallback: fallback,
    ahead: counts.ahead,
    behind: counts.behind,
    dirtyCount: scoped.length,
    warnings: unionWarning ? [unionWarning] : [],
    remoteCommitMs: upstream ? await refCommitMs(top, upstream) : null,
    lastFetchMs: await lastFetchMs(top),
  };
}

/**
 * The card's read-only view — NO fetch, NO locks, NO writes. Cheap enough for a
 * dashboard poll.
 *
 * Deliberately fetch-free: ahead/behind and the remote commit date are measured
 * against the last-fetched ref, and the card pairs them with the last sync time
 * so "behind 0" is never read as "up to date with the other machine" when the
 * last fetch was hours ago. A poll that fetched would spend network on every
 * open tab.
 */
export async function readRepoStatus(repo: SyncRepo, now: number): Promise<RepoSyncResult> {
  const top = await gitToplevel(repo.path);
  const led = getSyncLedgerEntry(repo.name);
  // Never synced in this process ⇒ the ledger's default `unknown`, which all
  // three fields now derive from. Rendered as "in sync" it was the card's one
  // unforgivable lie: a green row on a machine whose loop had never run at all
  // (a fresh restart, a launchd job that never fired). Deriving beats a
  // `lastRunMs === null` ternary here — the label and the payload's `state`
  // cannot disagree if only one of them is authored.
  const base: RepoSyncResult = {
    ...emptyCard(repo),
    state: led.state,
    reason: led.reason,
    tone: syncTone(led, now),
    label: describeSyncState(led.state, led.reason),
    dryRun: false,
    committed: [],
    deferredFiles: [],
    denied: [],
    rebased: false,
    pushed: false,
    actions: [],
    durationMs: 0,
    lastRunMs: led.lastRunMs,
    lastSuccessMs: led.lastSuccessMs,
    lastLocalSectionMs: led.lastLocalSectionMs,
    consecutiveDeferrals: led.consecutiveDeferrals,
    ...(led.lastError ? { error: led.lastError } : {}),
  };
  if (!top) {
    return { ...base, state: "error", reason: "not a git repo", tone: "bad", label: "error: not a git repo" };
  }
  const card = await readCard(repo, top);
  return { ...base, ...card };
}

// ── The state machine ───────────────────────────────────────────────────────

interface LocalSectionOutcome {
  committed: string[];
  deferredFiles: { path: string; reason: string }[];
  denied: string[];
  rebased: boolean;
  headMoved: boolean;
  /** A HARD stop: the tick ends here, with no push. */
  state?: SyncState;
  reason?: string;
  conflicts?: string[];
  error?: string;
  /**
   * A SOFT deferral: real work happened (commit / rebase / push all still run),
   * but something was held back, so the tick must not report `ok`. Quiet-held
   * files live here — reporting them as `ok` with streak 0 meant a new page could
   * sit uncommitted forever behind a green card that never escalated.
   */
  holdReason?: string;
  actions: string[];
}

/** Parse the conflicting paths out of a failed rebase (best-effort — the list is
 *  for the card, the blocked state does not depend on it). */
async function conflictPaths(top: string): Promise<string[]> {
  const entries = await listDirtyEntries(top);
  return entries.filter((e) => isUnmergedStatus(e.xy)).map((e) => e.path);
}

/**
 * Did this push fail because the OTHER machine pushed under us?
 *
 * There are TWO spellings, because the race can land on either side of the
 * push's ref negotiation, and both were observed against a real repo:
 *
 *  - the remote moved BEFORE we negotiated ⇒ the client refuses locally:
 *    `! [rejected] main -> main (fetch first)` / `non-fast-forward`;
 *  - the remote moved AFTER we negotiated ⇒ the SERVER refuses at ref-lock
 *    time: `remote: error: cannot lock ref 'refs/heads/main': is at <a> but
 *    expected <b>` + `! [remote rejected] main -> main (failed to update ref)`.
 *
 * Matching only the first spelling would report the second as a hard error and
 * skip the re-rebase that resolves it — the fixture test reproduces exactly that
 * second spelling.
 */
export function remoteMovedUnderUs(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("non-fast-forward") ||
    s.includes("fetch first") ||
    s.includes("[rejected]") ||
    s.includes("updates were rejected") ||
    s.includes("cannot lock ref") ||
    s.includes("failed to update ref") ||
    s.includes("stale info")
  );
}

/** How many paths ride in one `git add` argv. Bounds the pathspec against
 *  ARG_MAX on a repo where a sweep left hundreds of files dirty; also bounds the
 *  blast radius of the per-path retry below. */
const ADD_CHUNK = 200;

/**
 * Stage one tick's paths, TOLERATING a path that vanished mid-tick.
 *
 * A batched `git add` exits 128 for the WHOLE batch when one pathspec matches
 * nothing — and an editor's atomic replace (write temp → rename over) routinely
 * lands between the status listing and this call, so a whole tick was reported as
 * an error because one file blinked. On a batch failure each path is retried
 * alone: a failure whose path is now absent from disk is SKIPPED (it will be
 * picked up next tick in whatever state it settles into), anything else is still
 * a real error. A tracked path deleted from disk is not affected either way —
 * `git add` stages its deletion.
 *
 * Deletions are staged one at a time, tolerating the exit-128 a path already
 * staged as a deletion produces (the `commitInner` rule).
 */
export async function stagePaths(
  top: string,
  toAdd: string[],
  deletions: string[],
): Promise<{ ok: boolean; error?: string; skipped: string[] }> {
  const skipped: string[] = [];
  for (let i = 0; i < toAdd.length; i += ADD_CHUNK) {
    const chunk = toAdd.slice(i, i + ADD_CHUNK);
    const added = await runGit(top, ["add", "--", ...chunk]);
    if (added.code === 0) continue;
    if (isTransientGitLockFailure(added.stderr)) {
      return { ok: false, error: added.stderr, skipped };
    }
    for (const p of chunk) {
      const one = await runGit(top, ["add", "--", p]);
      if (one.code === 0) continue;
      if (!(await pathExists(path.join(top, p)))) {
        skipped.push(p);
        continue;
      }
      return { ok: false, error: one.stderr || added.stderr, skipped };
    }
  }
  for (const del of deletions) {
    await runGit(top, ["add", "--", del]); // exit 128 tolerated by design
  }
  return { ok: true, skipped };
}

/** How many staged paths the commit BODY lists before summarising the rest. A
 *  200-file sweep produced a 200-line commit message nobody reads; the paths are
 *  in the diff either way. */
const COMMIT_BODY_MAX_PATHS = 20;

function commitBody(paths: string[]): string {
  const lines = paths.slice(0, COMMIT_BODY_MAX_PATHS).map((p) => `- ${p}`);
  if (paths.length > COMMIT_BODY_MAX_PATHS) {
    lines.push(`…and ${paths.length - COMMIT_BODY_MAX_PATHS} more`);
  }
  return lines.join("\n");
}

/** Split rebase-blocking dirt into "inside the loop's scope" and "someone else's
 *  work in the same repo". Only meaningful for a `wiki` entry nested below the
 *  toplevel; for the whole-repo modes everything is in scope. */
async function partitionByScope(
  repo: SyncRepo,
  top: string,
  entries: PorcelainStatusEntry[],
): Promise<{ inScope: string[]; outside: string[] }> {
  if (repo.mode !== "wiki" || !repo.wikiRoot) {
    return { inScope: entries.map((e) => e.path), outside: [] };
  }
  const canonicalWiki = await realpath(repo.wikiRoot).catch(() => repo.wikiRoot!);
  const rel = path.relative(top, canonicalWiki);
  const prefix = rel && rel !== "." ? `${rel}/` : "";
  const inScope: string[] = [];
  const outside: string[] = [];
  for (const e of entries) {
    if (!prefix || e.path.startsWith(prefix)) inScope.push(e.path);
    else outside.push(e.path);
  }
  return { inScope, outside };
}

/**
 * Everything that must run under BOTH locks: status → path-scoped add/commit →
 * rebase onto the already-fetched ref. Short and entirely local — no network.
 */
async function localSection(
  repo: SyncRepo,
  top: string,
  upstream: string,
  now: number,
  dryRun: boolean,
): Promise<LocalSectionOutcome> {
  const actions: string[] = [];
  const out: LocalSectionOutcome = {
    committed: [],
    deferredFiles: [],
    denied: [],
    rebased: false,
    headMoved: false,
    actions,
  };

  // ── Commit (wiki mode only) ───────────────────────────────────────────────
  /** What a dry run WOULD have committed — the projection the rebase gate below
   *  must apply, since those paths would no longer be dirty by then. */
  const wouldStage = new Set<string>();
  /** Held on their OWN fresh mtime — the only paths the card may call edits. */
  let quietHeld: string[] = [];
  /** Held only BECAUSE those are fresh (deletions, rename halves). Split out
   *  because folding them into the count above claimed someone was editing a
   *  file that had just been deleted. */
  let companionHeld: string[] = [];

  if (repo.mode === "wiki") {
    const entries = await decorate(top, await listDirtyEntries(top, repo.wikiRoot));
    const decision = decideStaging(entries, now);
    out.denied = decision.denied;
    out.deferredFiles = decision.deferred;
    if (decision.quietHeld) {
      quietHeld = decision.deferred.filter((d) => isFreshMtimeHold(d.reason)).map((d) => d.path);
      companionHeld = decision.deferred.filter((d) => isCompanionHold(d.reason)).map((d) => d.path);
    }

    if (decision.stage.length > 0) {
      if (dryRun) {
        out.committed = decision.stage;
        for (const p of decision.stage) wouldStage.add(p);
        actions.push(`would commit ${decision.stage.length} file(s)`);
      } else {
        const deletions = new Set(decision.deletions);
        const staged = await stagePaths(
          top,
          decision.stage.filter((p) => !deletions.has(p)),
          decision.deletions,
        );
        if (!staged.ok) {
          // A lost index.lock is the SAME self-healing contention the pre-flight
          // reports as transient — reporting it as a hard error one step later
          // put a red card on a condition that clears itself next tick.
          const lock = isTransientGitLockFailure(staged.error ?? "");
          out.state = lock ? "transient" : "error";
          out.reason = clampReason(`git add failed: ${staged.error}`);
          out.error = staged.error;
          return out;
        }
        if (staged.skipped.length > 0) {
          actions.push(`skipped ${staged.skipped.length} path(s) that vanished mid-tick`);
        }
        const toCommit = decision.stage.filter((p) => !staged.skipped.includes(p));
        if (toCommit.length === 0) {
          // EVERY path vanished mid-tick. There is nothing to commit — and the
          // commit must not be attempted, because an empty pathspec argv ends in
          // a BARE `--`, which is no pathspec at all: git then commits whatever
          // ANOTHER process happens to have staged, under a `[sync] 0 file(s)`
          // subject (verified against real git). The `-- <paths>` guard is only
          // a guard while the list is non-empty.
          //
          // Deletions cannot be stranded here: they are a subset of
          // `decision.stage` and are never members of `skipped` (only the `add`
          // half can skip), so an empty `toCommit` implies no deletions either.
          actions.push(`nothing to commit — ${staged.skipped.length} path(s) vanished mid-tick`);
        } else {
          const message = `[sync] ${toCommit.length} file(s) from ${hostLabel()}`;
          // The pathspec keeps the commit to OUR paths (another writer may have
          // staged its own). Bounded by the same chunking rationale as the add:
          // this list is the sync's own decision, never the whole repo.
          const body = commitBody(toCommit);
          const committed = await runGit(top, [
            "commit",
            "-m",
            message,
            // An empty `-m ""` is a real (blank) message paragraph, not a no-op.
            ...(body ? ["-m", body] : []),
            "--",
            ...toCommit,
          ]);
          if (committed.code !== 0) {
            // "nothing to commit" is not a failure — the paths may have been
            // committed by a writer between the listing and here.
            if (/nothing to commit|no changes added/i.test(committed.stdout + committed.stderr)) {
              actions.push("nothing to commit");
            } else if (isTransientGitLockFailure(committed.stderr)) {
              out.state = "transient";
              out.reason = clampReason(`git commit failed: ${committed.stderr}`);
              out.error = committed.stderr;
              return out;
            } else {
              out.state = "error";
              out.reason = clampReason(`git commit failed: ${committed.stderr}`);
              out.error = committed.stderr;
              return out;
            }
          } else {
            out.committed = toCommit;
            actions.push(`committed ${toCommit.length} file(s)`);
          }
        }
      }
    }
  }

  // A quiet hold is not a failure, but it is not "in sync" either: the held page
  // is uncommitted and stays that way until it settles. Soft, so the rebase and
  // the push below still run — holding one file must never stop the repo pulling.
  if (quietHeld.length > 0 || companionHeld.length > 0) {
    out.holdReason = describeDeferralReason({
      quietHeld,
      companionHeld,
      outside: [],
      inScope: [],
    });
  }

  // ── Rebase ────────────────────────────────────────────────────────────────
  // Anything still dirty in the TRACKED sense makes git refuse. Count tracked
  // modifications only: untracked dirt does NOT stop a rebase (verified
  // empirically), and counting it would inflate the deferral reason with files
  // that were never in the way.
  //
  // The listing is WHOLE-REPO because that is what git judges, but a dry run has
  // not actually committed, so its own would-be commits must be projected out —
  // otherwise the dry run counts the very files it just said it would commit as
  // rebase-blocking and reports a deferral where the real run rebases and pushes.
  const remaining = (await listDirtyEntries(top))
    .filter((e) => blocksRebase(e.xy))
    .filter((e) => !wouldStage.has(e.path));
  if (remaining.length > 0) {
    const { inScope, outside } = await partitionByScope(repo, top, remaining);
    // Both hold sets are already accounted for above — a deletion held with a
    // fresh edit blocks the rebase too, and without this it was ALSO counted as
    // an unexplained "uncommitted tracked change".
    const held = new Set([...quietHeld, ...companionHeld]);
    const reason = describeDeferralReason({
      quietHeld,
      companionHeld,
      outside,
      inScope: inScope.filter((p) => !held.has(p)),
    });
    const outsideScope = new Set(outside);
    out.deferredFiles = [
      ...out.deferredFiles,
      ...remaining
        .filter((e) => !out.deferredFiles.some((d) => d.path === e.path))
        .map((e) => ({
          path: e.path,
          // An out-of-scope path is not "deferred" in the sense the rest of this
          // list means it — the loop will NEVER commit it, however long you wait.
          // Labelled like an in-scope hold it turned up on `ok` cards as work
          // pending on a tick that cannot do anything about it.
          reason: outsideScope.has(e.path)
            ? "outside the sync scope — another process's work, never committed by the loop"
            : "uncommitted tracked change",
        })),
    ];

    // A rebase exists to integrate REMOTE work. With nothing to integrate, a
    // refused rebase costs nothing — and refusing to push behind it is what
    // wedged a nested wiki forever: huginn-jarvis normally carries tracked dirt
    // outside the wiki subtree (another process owns the rest of that repo), so
    // every tick deferred while `ahead` grew and the wiki's own commits never
    // left the machine.
    const { behind } = await aheadBehind(top, upstream);
    if ((behind ?? 0) > 0) {
      out.state = "deferred";
      out.reason = reason;
      actions.push(`rebase deferred — ${reason}`);
      return out;
    }
    actions.push(`rebase skipped (not behind ${upstream}) — ${reason}`);
    return out;
  }

  if (dryRun) {
    actions.push(`would rebase onto ${upstream}`);
    return out;
  }

  const before = await headSha(top);
  const rebase = await runGit(top, ["rebase", upstream]);
  if (rebase.code !== 0) {
    if (await rebaseInProgress(top)) {
      const conflicts = await conflictPaths(top);
      await runGit(top, ["rebase", "--abort"]);
      out.state = "blocked";
      out.reason = `rebase conflict${conflicts.length ? ` in ${conflicts.join(", ")}` : ""}`;
      out.conflicts = conflicts;
      actions.push("rebase conflicted — aborted, tree restored");
      return out;
    }
    // No rebase directory ⇒ the rebase never started (a bad ref, a refused
    // tree). Report git verbatim rather than attempting a confusing abort.
    out.state = "error";
    out.reason = `rebase failed: ${rebase.stderr || rebase.stdout}`;
    out.error = rebase.stderr || rebase.stdout;
    return out;
  }
  const after = await headSha(top);
  out.rebased = true;
  out.headMoved = before !== after;
  actions.push(out.headMoved ? `rebased onto ${upstream}` : "already up to date");
  return out;
}

/**
 * Which machine a `[sync]` commit came from.
 *
 * `process.env.HOSTNAME` is a SHELL variable, not something the OS exports:
 * under launchd (and under a plain `bun run` on macOS) it is unset, so both
 * machines signed every commit "from muninn" — the one thing the label exists to
 * distinguish. `os.hostname()` is the syscall and always answers.
 */
function hostLabel(): string {
  return process.env.SYNC_HOST_LABEL || os.hostname() || "muninn";
}

/**
 * This repo's wiki-write lock roots, in the order they must be TAKEN.
 *
 * Sorted on the KEY the lock is actually taken with (`wikiWriteQueueKey`, a
 * realpath), not on the configured spelling. The two orders agree today only
 * incidentally: they diverge the moment one entry names a wiki through a symlink
 * or a `/tmp` path, and two repos taking two shared wikis in opposite orders is
 * exactly the deadlock the sort exists to prevent.
 */
export function sortedLockRoots(repo: SyncRepo): string[] {
  const roots = repo.mode === "wiki" && repo.wikiRoot ? [repo.wikiRoot] : repo.containedWikiRoots ?? [];
  // Dedupe on the same key: the registry dedupes wikis by NAME only, so two
  // entries can name one wiki through different spellings (symlink, /tmp vs
  // /private/tmp) — and taking the same chain key twice nests a lock inside
  // itself, which never resolves.
  const seen = new Set<string>();
  return roots
    .map((root) => ({ root, key: wikiWriteQueueKey(root) }))
    .filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((r) => r.root);
}

/**
 * Take EVERY lock this repo's local section needs, in the pinned order: the
 * commit queue first, then each affected wiki's write queue.
 *
 * A `plain`/`status-only` entry over a repo that CONTAINS a registered wiki
 * (`containedWikiRoots`) takes those wikis' write locks too: its rebase rewrites
 * their working trees, and a gardener write landing mid-rebase is the same
 * corruption a wiki-mode entry's lock exists to prevent. Multiple roots nest in
 * {@link sortedLockRoots} order — an arbitrary order across two repos sharing two
 * wikis is a deadlock, and a shared total order is the cheapest thing both sides
 * can agree on without coordination.
 */
function withLocks<T>(repo: SyncRepo, top: string, work: () => Promise<T>): Promise<T> {
  const roots = sortedLockRoots(repo);
  // No wiki root ⇒ no page writes to serialize against; the commit queue alone
  // is the repo's lock.
  const nested = roots.reduceRight<() => Promise<T>>(
    (inner, root) => () => runWikiWriteExclusive(root, inner),
    work,
  );
  return runExclusiveQueued(top, nested);
}

/** Sync ONE repo. Never throws — every failure becomes a card state. */
export async function syncRepo(
  repo: SyncRepo,
  deps: SyncDeps,
  dryRun = false,
): Promise<RepoSyncResult> {
  const startedAt = deps.now();
  /**
   * `commitPathOk` says whether this tick reached step 5 — the local (commit)
   * section — AND came out of it without failing there. Reaching it is not
   * enough: a tick that reaches the commit path and dies inside it every 15
   * minutes (a signing key that expired over a reboot, a pre-commit hook that
   * started refusing, a bad `user.email`) commits exactly as little as a tick
   * that never got there, and stamping it renewed the sweeper stand-down
   * forever — "the loop runs but never commits", one step later.
   *
   * What happens AFTER the local section does not un-say it: the final return
   * passes `true` unconditionally, so a push `error`/`transient` and the
   * no-upstream `blocked` all stamp. Deliberate — the commit is on disk and a
   * sweep could add nothing to it; a failed push is a push problem, and the card
   * says so by pairing a red state with a fresh "last commit pass".
   *
   * It defaults to FALSE so a new early return can only ever under-claim: the
   * failure mode being guarded against is a tick claiming coverage it never
   * provided.
   *
   * Same direction for the outer catch: a throw AFTER the local section (the
   * push, the cache refresh) records `commitPathOk: false` even though the loop
   * did commit. Accepted — the cost is a sweeper that may run beside a
   * committing loop, which is the same collision two machines already survive,
   * and it is strictly safer than the alternative of claiming a commit pass that
   * a `git rebase` explosion may have rolled back.
   */
  const finish = (
    card: RepoCard,
    state: SyncState,
    extra: Partial<RepoSyncResult> = {},
    commitPathOk = false,
  ): RepoSyncResult => {
    const now = deps.now();
    const result: RepoSyncResult = {
      ...card,
      state,
      tone: "ok",
      label: "",
      dryRun,
      committed: [],
      deferredFiles: [],
      denied: [],
      rebased: false,
      pushed: false,
      actions: [],
      durationMs: now - startedAt,
      lastRunMs: null,
      lastSuccessMs: null,
      lastLocalSectionMs: null,
      consecutiveDeferrals: 0,
      ...extra,
    };
    // Two outcomes REPORT without recording:
    //  - a dry run — otherwise a `?dry-run=1` poll resets the deferral streak and
    //    clears the last-error the card is showing;
    //  - `running` — it means this call did NOTHING because another tick holds
    //    the repo. Recorded, it zeroed `consecutiveDeferrals` (measured: a streak
    //    of 6 became 1) and cleared `lastError`, so a card polled during a slow
    //    tick went green and the escalation restarted from scratch.
    const observeOnly = dryRun || state === "running";
    const led = observeOnly
      ? getSyncLedgerEntry(repo.name)
      : recordLedger(repo.name, result, now, commitPathOk);
    result.lastRunMs = led.lastRunMs;
    result.lastSuccessMs = led.lastSuccessMs;
    result.lastLocalSectionMs = led.lastLocalSectionMs;
    result.consecutiveDeferrals = led.consecutiveDeferrals;
    result.tone = syncTone({ ...led, state, reason: result.reason }, now);
    result.label = describeSyncState(state, result.reason);
    return result;
  };

  const blank = emptyCard(repo);

  if (inFlight.has(repo.name)) {
    return finish(blank, "running", { reason: "a sync for this repo is already in flight" });
  }
  inFlight.add(repo.name);
  try {
    const top = await gitToplevel(repo.path);
    if (!top) return finish(blank, "error", { reason: `not a git repo: ${repo.path}` });

    // 1. Pre-flight — never touch a tree mid-operation.
    const pre = await preflight(top, deps.now());
    if (pre.kind !== "clear") {
      const card = await readCard(repo, top);
      return finish(card, pre.kind === "blocked" ? "blocked" : "transient", {
        reason: pre.reason,
        actions: ["pre-flight stopped the tick"],
      });
    }

    // 2. Fetch — NO lock held (network I/O never holds a lock).
    const fetched = await runGit(top, ["fetch", "--quiet"], {
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    });
    const fetchFailed = fetched.code !== 0;
    const card = await readCard(repo, top);
    if (fetchFailed) {
      // A failed fetch is five lines of stderr; the card's state chip is one
      // line. Clamped for display, verbatim on `lastError`.
      return finish(card, "error", {
        reason: clampReason(`git fetch failed: ${fetched.stderr || "unknown error"}`),
        error: fetched.stderr,
      });
    }

    // Unmerged paths anywhere ⇒ a human's half-finished merge. Never auto-commit
    // over one.
    const unmerged = (await listDirtyEntries(top)).filter((e) => isUnmergedStatus(e.xy));
    if (unmerged.length > 0) {
      return finish(card, "blocked", {
        reason: `unmerged paths (${unmerged.map((e) => e.path).slice(0, 5).join(", ")})`,
        conflicts: unmerged.map((e) => e.path),
      });
    }

    // 3. status-only: fetch + report, nothing else. Ever.
    if (repo.mode === "status-only") {
      return finish(card, "status-only", { actions: ["fetched; status only by configuration"] });
    }

    // 4. Branch gate — fetch-status display stays live off-default, but nothing
    //    is committed, rebased or pushed there.
    if (!card.onDefaultBranch) {
      return finish(card, "paused", {
        reason: `off default branch (${card.branch ?? "detached HEAD"})`,
        actions: ["fetched; no commit/rebase/push off the default branch"],
      });
    }
    if (!card.upstream) {
      return finish(card, "error", {
        reason: "no upstream and no origin/main to sync against",
      });
    }
    const upstream = card.upstream;

    // 5. The local section, under BOTH locks in the pinned order.
    const local = await withLocks(repo, top, () =>
      localSection(repo, top, upstream, deps.now(), dryRun),
    );
    const carry = {
      committed: local.committed,
      deferredFiles: local.deferredFiles,
      denied: local.denied,
      rebased: local.rebased,
      actions: local.actions,
    };
    if (local.state) {
      const after = await readCard(repo, top);
      // Every state the local section can END on, decided explicitly — this is
      // the branch where "reached the commit path" and "the commit path worked"
      // part company, and conflating them is what let a repo whose every commit
      // failed hold the sweeper down forever:
      //   - `deferred` — a HARD deferral: status, add/commit and the rebase gate
      //     all ran and the loop chose to wait (behind, with rebase-blocking
      //     dirt). The design working, per "Why deferral is not failure". A soft
      //     hold (quiet period, deletion-hold) does not even land here — it sets
      //     `holdReason`, pushes, and exits through the final return, which
      //     stamps for the same reason. EVIDENCE. Residual: when the only dirt is
      //     OUTSIDE the subtree, nothing is staged and `git commit` is never
      //     invoked, so a repeating hard `deferred` stamps evidence without ever
      //     proving the commit works — a broken signing key stays undetected in
      //     that state until in-subtree dirt appears. Accepted.
      //   - `blocked` — a rebase conflict, aborted. A human must clear it and
      //     the tick's work never leaves the machine. NOT evidence: `blocked`
      //     subsumes on its own explicit exception in `syncSubsumesSweeper`, so
      //     withholding the stamp costs nothing there and buys the daily warn
      //     that a wiki nobody is converging must keep getting.
      //   - `error` / `transient` — `git add` or `git commit` refused, or the
      //     rebase never started. Nothing was committed. NOT evidence.
      const commitPathOk = local.state === "deferred";
      return finish(
        after,
        local.state,
        {
          ...carry,
          reason: local.reason,
          ...(local.conflicts ? { conflicts: local.conflicts } : {}),
          ...(local.error ? { error: local.error } : {}),
        },
        commitPathOk,
      );
    }

    // 6. Push — OUTSIDE both locks, on the commit queue only (pushInner's
    //    dispatch posture). `plain` mode never pushes, by definition.
    let pushed = false;
    let pushState: SyncState | null = null;
    let pushReason: string | undefined;
    let pushError: string | undefined;
    /** HEAD moved in EITHER local section — see the retry merge below. */
    let headMoved = local.headMoved;
    const postRebase = await readCard(repo, top);
    const ahead = postRebase.ahead ?? 0;
    // A dry run made no commit, so `ahead` does not yet count the one it said it
    // would make — without projecting it the dry run silently skips the push
    // narration entirely and reports a plan the real run does not follow.
    const wouldCommit = dryRun && local.committed.length > 0 ? 1 : 0;
    if (repo.mode === "wiki" && ahead + wouldCommit > 0) {
      if (postRebase.upstreamFallback) {
        // `git push` with no argument and no upstream fails "no upstream" on
        // EVERY tick — a permanent red card for a one-line fix. Pushing an
        // explicit `HEAD:<branch>` instead would be the loop GUESSING which
        // remote branch this one tracks; the counts here are against
        // `origin/main` precisely because nothing said. So: refuse, keep the work
        // committed locally, and say what to type. `blocked` because that is the
        // one state meaning "a human, once".
        pushState = "blocked";
        pushReason =
          `${ahead} commit(s) to push but this branch has no upstream ` +
          `(counts are vs ${upstream}) — run \`git push -u origin ${postRebase.branch ?? "<branch>"}\` once`;
        local.actions.push("not pushed — no upstream configured for this branch");
      } else if (dryRun) {
        // The commits already ahead were NOT caused by the commit this dry run
        // would make; labelling them "would push N" read as N new commits.
        const parts: string[] = [];
        if (wouldCommit) parts.push("1 new commit");
        if (ahead > 0) parts.push(`${ahead} commit(s) already ahead`);
        local.actions.push(`would push ${parts.join(" + ")}`);
      } else {
        const res = await pushWithRetry(repo, top, upstream, deps, local.actions);
        pushed = res.pushed;
        pushState = res.state;
        pushReason = res.reason;
        pushError = res.error;
        // The retry runs a SECOND local section. Its results are part of this
        // tick: a page it committed belongs in the report, and — load-bearing —
        // a page it PULLED must invalidate the reader's 5-minute index cache,
        // which the first pass's `headMoved` alone cannot know about.
        if (res.local) {
          carry.committed = [...carry.committed, ...res.local.committed];
          carry.rebased = carry.rebased || res.local.rebased;
          headMoved = headMoved || res.local.headMoved;
        }
      }
    }

    // 7. Post-sync, local: refresh the reader cache for a wiki that moved.
    if (!dryRun && headMoved && repo.mode === "wiki" && repo.wikiRoot) {
      try {
        await deps.refreshWikiIndex(repo.wikiRoot);
        local.actions.push("refreshed the wiki read cache");
      } catch (err) {
        log.warn("Sync: wiki cache refresh failed for {name}: {error}", {
          name: repo.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // 8. Post-sync, search: conditional huginn kick, silent on failure.
      if (repo.collections && repo.collections.length > 0) {
        void deps.reindexCollections(repo.collections).catch(() => {});
      }
    }

    const finalCard = await readCard(repo, top);
    // A soft hold outranks `ok` but never a push outcome: "the remote moved" is
    // the more urgent thing to say, and the held file is still in `deferredFiles`.
    const finalState = pushState ?? (local.holdReason ? "deferred" : "ok");
    return finish(
      finalCard,
      finalState,
      {
        ...carry,
        actions: local.actions,
        pushed,
        ...(pushReason ?? local.holdReason ? { reason: pushReason ?? local.holdReason } : {}),
        ...(pushError ? { error: pushError } : {}),
      },
      true,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Sync: unexpected failure for {name}: {error}", { name: repo.name, error: message });
    return finish(blank, "error", { reason: clampReason(message), error: message });
  } finally {
    inFlight.delete(repo.name);
  }
}

/**
 * Push, and treat a non-fast-forward rejection as what it is: the OTHER machine
 * pushed between our fetch and our push. That is the loop working, not an error
 * — so re-fetch, re-rebase (under the locks again) and push ONCE more within the
 * tick. A second rejection is reported as `retrying: remote moved` and the next
 * tick picks it up.
 */
async function pushWithRetry(
  repo: SyncRepo,
  top: string,
  upstream: string,
  deps: SyncDeps,
  actions: string[],
): Promise<{
  pushed: boolean;
  state: SyncState | null;
  reason?: string;
  error?: string;
  /** The RETRY's local section, when one ran — the caller merges its committed
   *  paths and its `headMoved` into the tick's report. */
  local?: LocalSectionOutcome;
}> {
  const attempt = async (): Promise<{ ok: boolean; nff: boolean; stderr: string }> => {
    const r = await runExclusiveQueued(top, () =>
      runGit(top, ["push"], { timeoutMs: GIT_NETWORK_TIMEOUT_MS }),
    );
    return { ok: r.code === 0, nff: r.code !== 0 && remoteMovedUnderUs(r.stderr), stderr: r.stderr };
  };

  const first = await attempt();
  if (first.ok) {
    actions.push("pushed");
    return { pushed: true, state: null };
  }
  if (!first.nff) {
    // `error` as well as `reason`: the ledger's `lastError` is built from
    // `result.error`, so a push failure that set only `reason` never reached the
    // card's last-error line at all.
    return {
      pushed: false,
      state: "error",
      reason: clampReason(`git push failed: ${first.stderr}`),
      error: first.stderr,
    };
  }

  actions.push("push rejected — the remote moved; re-fetching and re-rebasing once");
  const refetch = await runGit(top, ["fetch", "--quiet"], { timeoutMs: GIT_NETWORK_TIMEOUT_MS });
  if (refetch.code !== 0) {
    return {
      pushed: false,
      state: "retrying",
      reason: "remote moved; re-fetch failed",
      error: refetch.stderr,
    };
  }
  const again = await withLocks(repo, top, () =>
    localSection(repo, top, upstream, deps.now(), false),
  );
  actions.push(...again.actions);
  if (again.state) {
    return { pushed: false, state: again.state, reason: again.reason, error: again.error, local: again };
  }
  const second = await attempt();
  if (second.ok) {
    actions.push("pushed after re-rebase");
    return { pushed: true, state: null, local: again };
  }
  // Narrate the second rejection too: without this the actions list ended on
  // "re-fetching and re-rebasing once" and the reader had to infer the outcome
  // from the state chip.
  actions.push(
    second.nff
      ? "second push also rejected — the remote moved again; leaving it for the next tick"
      : "second push failed",
  );
  return {
    pushed: false,
    state: second.nff ? "retrying" : "error",
    reason: second.nff
      ? "remote moved again — next tick will pick it up"
      : clampReason(`git push failed: ${second.stderr}`),
    error: second.stderr,
    local: again,
  };
}

/**
 * How recent a sync run must be for the daily `wiki-committer` sweeper to stand
 * down. Sized just over the sweeper's own 24h cadence, so a loop running every 15
 * minutes clears it by two orders of magnitude and a loop that has stopped fails
 * it within one sweeper period.
 */
export const SYNC_SUBSUME_MAX_AGE_MS = 26 * 60 * 60 * 1000;

/**
 * Does the sync loop OWN this repo — i.e. may the daily sweeper stand down?
 *
 * Configuration alone is not evidence. `SYNC_REPOS` parsing made the sweeper
 * stand down forever, so a machine whose launchd job was never installed (or
 * whose plist silently failed to load) had NOBODY committing the wiki — which is
 * exactly the 2026-07-23 huginn-jarvis page-loss shape the sweeper exists to
 * prevent. So the ledger must also show a run inside {@link SYNC_SUBSUME_MAX_AGE_MS}.
 *
 * And "the loop ran" is not the same claim as "the loop could commit". A tick
 * that returns at a FAILED FETCH — origin unreachable for days: offline, VPN
 * down, an expired deploy key — commits nothing, yet it used to refresh
 * `lastRunMs` and hold the sweeper down anyway. That is the same page-loss shape
 * again, reached through "the loop runs but never commits", so the freshness
 * clock is `lastLocalSectionMs`.
 *
 * That clock is stamped on a tick that reached the local section (status →
 * commit → rebase) AND did not FAIL inside it. Reaching it is not enough: a
 * broken signing key, a refusing pre-commit hook or a bad `user.email` produces
 * a tick that gets all the way to `git commit`, dies there, and commits exactly
 * as little as one that never left the fetch — the same shape one step later.
 *
 * The rule, exactly as implemented: an `error`, `transient` or `blocked` outcome
 * from BEFORE or INSIDE the local section stamps no evidence — but one from
 * AFTER it (a failed push, the no-upstream `blocked`) DOES stamp, because the
 * local commit path genuinely worked and the sweeper could add nothing the loop
 * did not already commit. A hard `deferred` stamps too (the commit path ran; the
 * loop chose to wait), including the case where nothing was staged because only
 * out-of-subtree dirt was dirty.
 *
 * Two residuals, accepted:
 *
 *  a) a loop whose PUSH has failed for days keeps subsuming and the daily warn
 *     stays silent. Diagnosable, not silent overall: the `/models` Repo sync card
 *     is red and its "last commit pass" is fresh — which says the problem is the
 *     push, not the commit, and the local commits are safe on disk meanwhile.
 *  b) a repeating hard `deferred` with nothing in-subtree dirty stamps evidence
 *     without ever invoking `git commit`, so a broken signing key stays
 *     undetected in that state until in-subtree dirt appears — at which point the
 *     commit runs, fails, and the stamp stops.
 *
 * So EVIDENCE is the only thing that subsumes, with exactly one exception:
 *
 *  - fresh `lastLocalSectionMs` — the loop demonstrably got through its commit
 *    path inside the window; sweeping on top of it would fight it.
 *  - `state === "blocked"` — subsumes REGARDLESS of freshness, because the
 *    sweeper is not a safe substitute there at all: `blocked` is the
 *    unmerged-paths / interrupted-operation refusal and the sweeper has no
 *    pre-flight of its own (`listWikiSubtreeDirty` treats a `UU` entry as
 *    ordinary dirt), so it would stage and commit a human's half-finished merge.
 *    A one-tick sample is sound here only because the conditions that produce
 *    `blocked` (a leftover MERGE_HEAD, a stale index.lock, conflict markers)
 *    persist across ticks until a human clears them.
 *
 * Everything else — `error`, `transient`, `paused`, no-upstream, not-a-repo, a
 * cold ledger, and a rebase conflict that never converges — falls through to the
 * sweeper once the evidence goes stale (a rebase-conflict `blocked` still
 * subsumes on the exception above, but it stamps no evidence, so it keeps
 * warning). No STATE subsumes on its own here, but a state reached after the
 * local section carries a fresh stamp with it — residual (a) above.
 * It used to be `fresh(lastRunMs) && state !== "error"`, which meant
 * ANY tick that stopped before the local section in a non-error state (a young
 * index.lock, a feature-branch checkout, a missing upstream) renewed it every 15
 * minutes forever — and, for a tick failing inside the local section, so did
 * `fresh(lastLocalSectionMs)` before the stamp was narrowed to a commit path
 * that WORKED. `state` is a one-tick SAMPLE, not a claim about the window.
 * `paused` falling through is harmless: the sweeper applies the same
 * off-default-branch rule to itself (`onDefaultBranch(top)` guard,
 * `src/watchers/wiki-committer.ts:154`) and no-ops.
 *
 * `configuredButIdle` is DECOUPLED from `subsumed`: it is simply "no commit pass
 * inside the window", so a repo that subsumes on `blocked` for a week still
 * warns once a day. Only "this repo is not ours" is silent.
 */
export async function syncSubsumesSweeper(
  top: string,
  opts: { repos?: SyncRepo[]; now?: number } = {},
): Promise<{ subsumed: boolean; configuredButIdle: boolean; name?: string }> {
  const covering = await findSyncRepoCoveringToplevel(top, opts.repos);
  if (!covering) return { subsumed: false, configuredButIdle: false };
  const now = opts.now ?? Date.now();
  const led = getSyncLedgerEntry(covering.name);
  const fresh = (at: number | null) => at !== null && now - at <= SYNC_SUBSUME_MAX_AGE_MS;
  const committedRecently = fresh(led.lastLocalSectionMs);
  const subsumed = committedRecently || led.state === "blocked";
  // Not `!subsumed`: a blocked loop stands the sweeper down AND is idle.
  return { subsumed, configuredButIdle: !committedRecently, name: covering.name };
}

/** Sync every configured repo, sequentially (they contend on disk and on the
 *  same remote host; a fan-out buys nothing at N=4). */
export async function runSync(
  repos: SyncRepo[],
  deps: SyncDeps,
  opts: { dryRun?: boolean; warnings?: string[] } = {},
): Promise<SyncRunReport> {
  const startedAt = deps.now();
  const results: RepoSyncResult[] = [];
  for (const repo of repos) {
    const r = await syncRepo(repo, deps, opts.dryRun ?? false);
    results.push(r);
    log.info("Sync {name} ({mode}): {label}{dry}", {
      name: repo.name,
      mode: repo.mode,
      label: r.label,
      dry: r.dryRun ? " [dry-run]" : "",
    });
  }
  return {
    repos: results,
    warnings: opts.warnings ?? [],
    dryRun: opts.dryRun ?? false,
    startedAt,
    durationMs: deps.now() - startedAt,
  };
}
