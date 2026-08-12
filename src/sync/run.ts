/**
 * The repo-sync loop's per-repo state machine.
 *
 * One tick, per configured repo: fetch → (locked) status → commit → rebase →
 * (unlocked) push → refresh the reader cache. Driven by two triggers that share
 * this ONE code path — a 15-minute launchd `curl` and the dashboard's "Sync now"
 * button, both landing on `POST /api/sync/run`.
 *
 * ── Locking (the most load-bearing paragraph in this file) ───────────────────
 *
 * Two INDEPENDENT queues already exist and this loop must join both:
 *   1. the COMMIT queue — `runExclusiveQueued`, keyed on the git toplevel
 *      (`src/wiki/commit.ts`), which every wiki write's commit tail runs on;
 *   2. the WIKI-WRITE queue — `runWikiWriteExclusive`, realpath-keyed on the
 *      wiki root (`src/wiki/queue.ts`), which spans read→CAS→write→log.md.
 *
 * Rules, in order of importance:
 *
 *  - **Network I/O never holds a lock.** The fetch runs before either lock is
 *    taken and the push after both are released. This is the measured
 *    3s-push-stall rationale recorded at `src/gardener/apply.ts:191-199`: a
 *    remote that hangs must never be able to park a page write.
 *  - **The two locks are taken in a PINNED ORDER: commit first, wiki-write
 *    second.** Consequence: a hung push (which holds only the commit queue) can
 *    park the sync, never a page write.
 *  - **Deadlock invariant:** commit-first/write-second is safe ONLY because every
 *    current writer keeps its commit tail OUTSIDE its write section (stated in
 *    `src/wiki/queue.ts` and `src/gardener/CLAUDE.md`). A future writer that
 *    commits from INSIDE the write section would take the two locks in the
 *    opposite order and deadlock against this loop. If you add one, this
 *    ordering must change with it.
 *  - The local section takes the commit lock DIRECTLY (`runExclusiveQueued`)
 *    rather than routing through `commitWikiChange`, which would release the
 *    lock around its own commit — leaving the rebase unprotected against a
 *    gardener commit tail — and dispatch an immediate push that would be
 *    non-fast-forward before the rebase ran.
 *
 * ── Why deferral is not failure ─────────────────────────────────────────────
 *
 * On most ticks during a live editing session mimir carries fresh tracked
 * modifications: the quiet-period filter deliberately leaves them uncommitted,
 * and git then refuses to rebase. That is the design working, not an error — the
 * tick ends quietly as `deferred` and the next one picks it up. (Ruled against
 * `git rebase --autostash`: a stash-pop conflict on the file being edited is
 * worse than waiting 15 minutes.) Deferral only becomes visible when it PERSISTS
 * — see `syncTone` in `decide.ts`.
 */

import path from "node:path";
import { stat } from "node:fs/promises";
import {
  GIT_NETWORK_TIMEOUT_MS,
  gitToplevel,
  listDirtyEntries,
  onDefaultBranch,
  runExclusiveQueued,
  runGit,
  type PorcelainStatusEntry,
} from "../wiki/commit.ts";
import { runWikiWriteExclusive } from "../wiki/queue.ts";
import { getWikiIndex } from "../wiki/store.ts";
import { fetchKnowledgeApi } from "../ai/knowledge-api-client.ts";
import {
  blocksRebase,
  decideStaging,
  describeSyncState,
  isUnmergedStatus,
  SYNC_QUIET_MS,
  syncTone,
  type DirtyItem,
  type SyncLedgerEntry,
  type SyncState,
  type SyncTone,
} from "./decide.ts";
import type { SyncRepo } from "./config.ts";
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
  /** The rebase-blocking subset across the WHOLE repo (untracked excluded). */
  trackedDirtyCount: number;
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
    reindexCollections: async (collections) => {
      if (!knowledgeApiUrl || collections.length === 0) return;
      for (const name of collections) {
        try {
          await fetchKnowledgeApi(
            knowledgeApiUrl,
            `/api/collections/${encodeURIComponent(name)}/update`,
            { method: "POST", timeoutMs: 5_000 },
          );
        } catch {
          // Degrade silently — v1 runs on a machine where huginn is unreachable,
          // and a search index one tick behind is not worth a card state.
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
      state: "ok",
      consecutiveDeferrals: 0,
      lastSuccessMs: null,
      lastRunMs: null,
    }
  );
}

/** Test-only: clear the ledger + in-flight set between cases. */
export function __resetSyncStateForTest(): void {
  ledger.clear();
  inFlight.clear();
}

function recordLedger(name: string, result: RepoSyncResult, now: number): SyncLedgerEntry {
  const prev = getSyncLedgerEntry(name);
  const entry: SyncLedgerEntry = {
    state: result.state,
    reason: result.reason,
    consecutiveDeferrals: result.state === "deferred" ? prev.consecutiveDeferrals + 1 : 0,
    lastSuccessMs:
      result.state === "ok" || result.state === "status-only" ? now : prev.lastSuccessMs,
    lastRunMs: now,
    lastError: result.error ?? (result.state === "blocked" ? result.reason : undefined),
  };
  ledger.set(name, entry);
  return entry;
}

// ── Git reads ───────────────────────────────────────────────────────────────

async function pathExists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

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

/** Read every card field. Assumes a fetch has already run (or deliberately has
 *  not, for the no-fetch status endpoint). */
async function readCard(repo: SyncRepo, top: string): Promise<RepoCard> {
  const branch = await currentBranch(top);
  const { ref: upstream, fallback } = await resolveUpstream(top);
  const counts = upstream
    ? await aheadBehind(top, upstream)
    : { ahead: null as number | null, behind: null as number | null };
  const scopeAbs = repo.mode === "wiki" ? repo.wikiRoot : undefined;
  const scoped = await listDirtyEntries(top, scopeAbs);
  const whole = scopeAbs ? await listDirtyEntries(top) : scoped;
  return {
    name: repo.name,
    mode: repo.mode,
    path: repo.path,
    branch,
    onDefaultBranch: await onDefaultBranch(top),
    upstream,
    upstreamFallback: fallback,
    ahead: counts.ahead,
    behind: counts.behind,
    dirtyCount: scoped.length,
    trackedDirtyCount: whole.filter((e) => blocksRebase(e.xy)).length,
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
  const base: RepoSyncResult = {
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
    trackedDirtyCount: 0,
    remoteCommitMs: null,
    lastFetchMs: null,
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
  state?: SyncState;
  reason?: string;
  conflicts?: string[];
  error?: string;
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
  if (repo.mode === "wiki") {
    const entries = await decorate(top, await listDirtyEntries(top, repo.wikiRoot));
    const decision = decideStaging(entries, now, SYNC_QUIET_MS);
    out.denied = decision.denied;
    out.deferredFiles = decision.deferred;

    if (decision.stage.length > 0) {
      if (dryRun) {
        out.committed = decision.stage;
        actions.push(`would commit ${decision.stage.length} file(s)`);
      } else {
        // Stage present paths in one batch; stage each deletion separately,
        // tolerating the exit-128 a path already staged as a deletion produces
        // (the `commitInner` rule — a batched add would abort the whole tick).
        const deletions = new Set(decision.deletions);
        const toAdd = decision.stage.filter((p) => !deletions.has(p));
        if (toAdd.length > 0) {
          const added = await runGit(top, ["add", "--", ...toAdd]);
          if (added.code !== 0) {
            out.state = "error";
            out.reason = `git add failed: ${added.stderr}`;
            out.error = added.stderr;
            return out;
          }
        }
        for (const del of decision.deletions) {
          await runGit(top, ["add", "--", del]); // exit 128 tolerated by design
        }
        const message = `[sync] ${decision.stage.length} file(s) from ${hostLabel()}`;
        const body = decision.stage.map((p) => `- ${p}`).join("\n");
        const committed = await runGit(top, [
          "commit",
          "-m",
          message,
          "-m",
          body,
          "--",
          ...decision.stage,
        ]);
        if (committed.code !== 0) {
          // "nothing to commit" is not a failure — the paths may have been
          // committed by a writer between the listing and here.
          if (/nothing to commit|no changes added/i.test(committed.stdout + committed.stderr)) {
            actions.push("nothing to commit");
          } else {
            out.state = "error";
            out.reason = `git commit failed: ${committed.stderr}`;
            out.error = committed.stderr;
            return out;
          }
        } else {
          out.committed = decision.stage;
          actions.push(`committed ${decision.stage.length} file(s)`);
        }
      }
    }
  }

  // ── Rebase ────────────────────────────────────────────────────────────────
  // Anything still dirty in the TRACKED sense makes git refuse. Count tracked
  // modifications only: untracked dirt does NOT stop a rebase (verified
  // empirically), and counting it would inflate the deferral reason with files
  // that were never in the way.
  const remaining = (await listDirtyEntries(top)).filter((e) => blocksRebase(e.xy));
  if (remaining.length > 0) {
    out.state = "deferred";
    out.reason =
      repo.mode === "wiki"
        ? `active edits (${remaining.length} file${remaining.length === 1 ? "" : "s"} < 5 min)`
        : `local edits (${remaining.map((e) => e.path).slice(0, 5).join(", ")})`;
    out.deferredFiles = [
      ...out.deferredFiles,
      ...remaining
        .filter((e) => !out.deferredFiles.some((d) => d.path === e.path))
        .map((e) => ({ path: e.path, reason: "uncommitted tracked change" })),
    ];
    actions.push(`rebase deferred — ${remaining.length} tracked file(s) uncommitted`);
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

function hostLabel(): string {
  return process.env.SYNC_HOST_LABEL || process.env.HOSTNAME || "muninn";
}

/** Take BOTH locks in the pinned order (commit first, wiki-write second). */
function withLocks<T>(repo: SyncRepo, top: string, work: () => Promise<T>): Promise<T> {
  if (repo.mode === "wiki" && repo.wikiRoot) {
    const root = repo.wikiRoot;
    return runExclusiveQueued(top, () => runWikiWriteExclusive(root, work));
  }
  // No wiki root ⇒ no page writes to serialize against; the commit queue alone
  // is the repo's lock.
  return runExclusiveQueued(top, work);
}

/** Sync ONE repo. Never throws — every failure becomes a card state. */
export async function syncRepo(
  repo: SyncRepo,
  deps: SyncDeps,
  dryRun = false,
): Promise<RepoSyncResult> {
  const startedAt = deps.now();
  const finish = (
    card: RepoCard,
    state: SyncState,
    extra: Partial<RepoSyncResult> = {},
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
      consecutiveDeferrals: 0,
      ...extra,
    };
    // A dry run REPORTS but never records — otherwise a `?dry-run=1` poll would
    // reset the deferral streak and clear the last-error the card is showing.
    const led = dryRun ? getSyncLedgerEntry(repo.name) : recordLedger(repo.name, result, now);
    result.lastRunMs = led.lastRunMs;
    result.lastSuccessMs = led.lastSuccessMs;
    result.consecutiveDeferrals = led.consecutiveDeferrals;
    result.tone = syncTone({ ...led, state, reason: result.reason }, now);
    result.label = describeSyncState(state, result.reason);
    return result;
  };

  const emptyCard: RepoCard = {
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
    trackedDirtyCount: 0,
    remoteCommitMs: null,
    lastFetchMs: null,
  };

  if (inFlight.has(repo.name)) {
    return finish(emptyCard, "running", { reason: "a sync for this repo is already in flight" });
  }
  inFlight.add(repo.name);
  try {
    const top = await gitToplevel(repo.path);
    if (!top) return finish(emptyCard, "error", { reason: `not a git repo: ${repo.path}` });

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
      return finish(card, "error", {
        reason: `git fetch failed: ${fetched.stderr || "unknown error"}`,
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
      return finish(after, local.state, {
        ...carry,
        reason: local.reason,
        ...(local.conflicts ? { conflicts: local.conflicts } : {}),
        ...(local.error ? { error: local.error } : {}),
      });
    }

    // 6. Push — OUTSIDE both locks, on the commit queue only (pushInner's
    //    dispatch posture). `plain` mode never pushes, by definition.
    let pushed = false;
    let pushState: SyncState | null = null;
    let pushReason: string | undefined;
    const postRebase = await readCard(repo, top);
    if (repo.mode === "wiki" && (postRebase.ahead ?? 0) > 0) {
      if (dryRun) {
        local.actions.push(`would push ${postRebase.ahead} commit(s)`);
      } else {
        const res = await pushWithRetry(repo, top, upstream, deps, local.actions);
        pushed = res.pushed;
        pushState = res.state;
        pushReason = res.reason;
      }
    }

    // 7. Post-sync, local: refresh the reader cache for a wiki that moved.
    if (!dryRun && local.headMoved && repo.mode === "wiki" && repo.wikiRoot) {
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
    return finish(finalCard, pushState ?? "ok", {
      ...carry,
      actions: local.actions,
      pushed,
      ...(pushReason ? { reason: pushReason } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Sync: unexpected failure for {name}: {error}", { name: repo.name, error: message });
    return finish(emptyCard, "error", { reason: message, error: message });
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
): Promise<{ pushed: boolean; state: SyncState | null; reason?: string }> {
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
    return { pushed: false, state: "error", reason: `git push failed: ${first.stderr}` };
  }

  actions.push("push rejected — the remote moved; re-fetching and re-rebasing once");
  const refetch = await runGit(top, ["fetch", "--quiet"], { timeoutMs: GIT_NETWORK_TIMEOUT_MS });
  if (refetch.code !== 0) {
    return { pushed: false, state: "retrying", reason: "remote moved; re-fetch failed" };
  }
  const again = await withLocks(repo, top, () =>
    localSection(repo, top, upstream, deps.now(), false),
  );
  actions.push(...again.actions);
  if (again.state) {
    return { pushed: false, state: again.state, reason: again.reason };
  }
  const second = await attempt();
  if (second.ok) {
    actions.push("pushed after re-rebase");
    return { pushed: true, state: null };
  }
  return {
    pushed: false,
    state: second.nff ? "retrying" : "error",
    reason: second.nff ? "remote moved again — next tick will pick it up" : `git push failed: ${second.stderr}`,
  };
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
