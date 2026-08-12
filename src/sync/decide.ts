/**
 * The repo-sync loop's PURE decision layer — what to stage, what to hold back,
 * and what the dashboard card should say. No git, no filesystem, no clock read
 * (`now` is always a parameter), so every rule below is unit-testable in
 * isolation from the state machine that executes it.
 *
 * Three rules live here and each exists because of a specific way a naive
 * version loses data or lies:
 *
 *  - **Quiet period.** A file modified in the last ~5 minutes is being edited
 *    RIGHT NOW on this machine. Committing and pushing it mid-sentence is how
 *    the other machine ends up rebasing onto half a thought. So modified and
 *    untracked files must sit still for `SYNC_QUIET_MS` before they are staged.
 *  - **Deletions don't get an mtime test, but they do get a companion test.** A
 *    deleted file has no mtime to age, so waiting on one would defer it forever.
 *    But `git status` reports an ordinary unstaged `mv` as `D old` + `?? new`
 *    (verified against real git — an unstaged rename is never paired), so
 *    staging deletions while the quiet filter still holds the new half would
 *    push a bare page deletion and the other machine would pull a 404. Hence:
 *    deletions stage freely, EXCEPT in a tick where anything was quiet-filtered.
 *  - **Rename pairs move as a unit.** A staged `git mv` IS paired (`R  new\0old`),
 *    so the pair is judged by the NEW half's mtime and both halves defer together.
 *    A COPY record (`C`) is paired by git too but is NOT a rename: the source
 *    still exists on disk, so only the new path is staged and `origPath` is
 *    ignored — treating it as a rename would stage a deletion of a file nobody
 *    removed.
 *
 * The denylist runs BEFORE the quiet filter: a denied path is not "held back",
 * it is not ours at all, and it must not make the tick look quiet-filtered.
 *
 * **The denylist applies to UNTRACKED entries ONLY.** A tracked file is already
 * the repo's own decision to version it (a committed `.obsidian/workspace.json`
 * is routine in an Obsidian vault), and dropping a tracked path from staging
 * cannot make it clean — it stays dirty, and tracked dirt is exactly what makes
 * `git rebase` refuse, so the entry would wedge the repo on every tick forever.
 * Denying can only ever help for a path git is not tracking yet.
 */

/** How long a file must sit unmodified before the loop will commit it. */
export const SYNC_QUIET_MS = 5 * 60 * 1000;

/** Consecutive deferrals before the card flips to a warn tone. At the ruled
 *  15-minute cadence this is an hour of a repo not converging — long enough to
 *  be a real editing session, short enough to notice before a day passes. */
export const SYNC_DEFERRAL_WARN_AFTER = 4;

/** A successful sync older than this also flips the card to warn, independent of
 *  the deferral count (a repo that has been *blocked* rather than deferring
 *  never accrues deferrals at all). */
export const SYNC_STALE_SUCCESS_MS = 2 * 60 * 60 * 1000;

/**
 * An mtime further than this AHEAD of now is not a fresh edit, it is a broken
 * clock or a restored file — so the quiet filter ages it instead of treating it
 * as fresh. Unclamped, `now - mtime < quietMs` is permanently true for a future
 * stamp: the file defers itself every tick AND (via `quietHeld`) holds every
 * deletion in the repo with it, forever. Same 48h skew allowance, for the same
 * reason, as the wiki store's `FUTURE_DATE_SKEW_MS` page-date guard.
 */
export const FUTURE_MTIME_SKEW_MS = 48 * 60 * 60 * 1000;

/** One card line's budget. A raw `git fetch` failure is five lines of stderr and
 *  the state chip is one line wide; the full text still rides `lastError`. */
export const SYNC_REASON_MAX = 160;

/**
 * Reduce any git output to ONE card-sized line: first non-blank line, whitespace
 * runs collapsed, truncated at {@link SYNC_REASON_MAX}. Applied where a reason is
 * BUILT (not where it is rendered), so every consumer — card, log line, ledger —
 * sees the same clamped string and only `lastError` carries the full text.
 */
export function clampReason(text: string): string {
  const first = (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim().replace(/\s+/g, " ");
  return first.length <= SYNC_REASON_MAX ? first : `${first.slice(0, SYNC_REASON_MAX - 1)}…`;
}

/**
 * Is this git failure the same self-healing `index.lock` contention the
 * pre-flight already classifies as transient?
 *
 * The pre-flight only looks at the START of a tick, so a shell `git status` or an
 * editor's git integration taking the lock one step later produced a hard `error`
 * card for the identical condition. Matching on git's own wording (both spellings
 * it uses) keeps the two ends of the tick consistent.
 */
export function isTransientGitLockFailure(text: string): boolean {
  const s = text.toLowerCase();
  return s.includes("index.lock") || s.includes("another git process");
}

/** The three INDEPENDENT reasons a tick can hold back, kept apart because they
 *  need different responses from a human (wait / commit elsewhere / investigate). */
export interface DeferralCause {
  /** Paths this tick's quiet filter held (an edit in progress on THIS machine). */
  quietHeld: string[];
  /** Rebase-blocking tracked paths OUTSIDE the sync scope — another process's
   *  work in the same repo, which the loop will never commit. */
  outside: string[];
  /** Rebase-blocking tracked paths inside the scope that the quiet filter did not
   *  explain (a staged-but-uncommitted change, a failed commit). */
  inScope: string[];
}

function sample(paths: string[]): string {
  const shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${shown}, +${paths.length - 3} more` : shown;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The honest deferral reason, derived from the actual blocking sets.
 *
 * The first cut hardcoded "active edits (N files < 5 min)" for every wiki-mode
 * deferral, so a repo wedged by a tracked file OUTSIDE the wiki subtree (the
 * huginn-jarvis normal state: another process writes the rest of that repo) got a
 * card claiming someone was editing wiki pages — the one reading that sends you
 * looking in the wrong place.
 */
export function describeDeferralReason(cause: DeferralCause): string {
  const quietMinutes = Math.round(SYNC_QUIET_MS / 60_000);
  const parts: string[] = [];
  if (cause.quietHeld.length > 0) {
    parts.push(
      `holding ${plural(cause.quietHeld.length, "file", "files")} edited in the last ${quietMinutes} min (${sample(cause.quietHeld)})`,
    );
  }
  if (cause.outside.length > 0) {
    parts.push(
      `${plural(cause.outside.length, "tracked edit", "tracked edits")} outside the wiki subtree (${sample(cause.outside)})`,
    );
  }
  if (cause.inScope.length > 0) {
    parts.push(
      `${plural(cause.inScope.length, "uncommitted tracked change", "uncommitted tracked changes")} (${sample(cause.inScope)})`,
    );
  }
  return clampReason(parts.join("; "));
}

/**
 * Paths the loop never commits, applied to the repo-relative path.
 *
 * Deliberately narrow: editor scratch and Obsidian's workspace churn. It is NOT
 * a general ignore mechanism — that is `.gitignore`'s job, and a path that
 * reaches this list is one git already thinks belongs in the repo.
 */
const SYNC_DENY_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.obsidian(\/|$)/, // Obsidian workspace + plugin state
  /\.tmp$/i,
  /\.swp$/i, // vim
  /\.swo$/i,
  /~$/, // emacs/gedit backups
  /(^|\/)#[^/]*#$/, // emacs autosave
  /(^|\/)\.#[^/]*$/, // emacs lockfile
  /(^|\/)\.DS_Store$/,
  /\.orig$/i, // merge leftovers
  /\.rej$/i,
];

export function isDeniedSyncPath(relPath: string): boolean {
  return SYNC_DENY_PATTERNS.some((re) => re.test(relPath));
}

/** True for a porcelain status git has no record of — the only kind of entry the
 *  denylist may drop (see the module doc). */
export function isUntrackedStatus(xy: string): boolean {
  return xy === "??" || xy === "!!";
}

/** True for a status git PAIRED as a rename (`R`). A copy (`C`) is paired too but
 *  its `origPath` is an ordinary file that still exists — see the module doc. */
function isRenameStatus(xy: string): boolean {
  return xy[0] === "R" || xy[1] === "R";
}

/** One dirty entry, decorated with what the filesystem says about it. */
export interface DirtyItem {
  /** repo-relative path (the NEW path for a rename). */
  path: string;
  /** the 2-char porcelain `XY` field. */
  xy: string;
  /** the ORIGINAL path of a staged rename/copy, when git paired one. */
  origPath?: string;
  /** mtime of `path` in ms, or `null` when the file is absent on disk (i.e. a
   *  deletion — the same "absence on disk" test `listWikiSubtreeDirty` uses). */
  mtimeMs: number | null;
}

export interface StagingDecision {
  /** Paths to `git add -- …` / `git commit -- …` (repo-relative). */
  stage: string[];
  /** The subset of `stage` that is absent on disk — staged as deletions. */
  deletions: string[];
  /** Held back this tick, with why (rendered on the card). */
  deferred: { path: string; reason: string }[];
  /** Dropped by the denylist — never staged, never a reason to hold deletions. */
  denied: string[];
  /** True when at least one path was held by the QUIET filter (as opposed to the
   *  denylist). This is what suppresses deletions for the whole tick. */
  quietHeld: boolean;
}

/** True for a porcelain status that means "unmerged / conflicted". */
export function isUnmergedStatus(xy: string): boolean {
  return xy.includes("U") || xy === "AA" || xy === "DD";
}

/** True for a status carrying an unstaged TRACKED modification — the only dirt
 *  that makes `git rebase` refuse (verified empirically: untracked-only dirt
 *  rebases fine, an unstaged tracked modification exits 1 with
 *  "cannot rebase: You have unstaged changes"). Untracked (`??`) is excluded on
 *  purpose, and so is a purely-staged change (`M `), which `rebase` also
 *  refuses — hence the second column test covering ` M`, `MM`, ` D`, `AM`… */
export function blocksRebase(xy: string): boolean {
  if (xy === "??" || xy === "!!") return false;
  const [x, y] = [xy[0] ?? " ", xy[1] ?? " "];
  // Anything recorded in the index (X) or the worktree (Y) other than untracked
  // stops a rebase — git refuses on both "unstaged changes" and "staged changes".
  return x !== " " || y !== " ";
}

/**
 * Decide what this tick commits. See the module doc for why each rule exists.
 */
export function decideStaging(
  entries: DirtyItem[],
  now: number,
  quietMs: number = SYNC_QUIET_MS,
): StagingDecision {
  const stage: string[] = [];
  const deletions: string[] = [];
  const deferred: { path: string; reason: string }[] = [];
  const denied: string[] = [];
  let quietHeld = false;

  // Pass 1 — denylist, UNTRACKED entries only (module doc). A denied path never
  // enters the quiet accounting.
  const kept: DirtyItem[] = [];
  for (const e of entries) {
    if (isUntrackedStatus(e.xy) && isDeniedSyncPath(e.path)) {
      denied.push(e.path);
      continue;
    }
    kept.push(e);
  }

  // Pass 2 — quiet filter over modifications/untracked and rename pairs;
  // deletions are collected but not committed to yet.
  const pendingDeletions: string[] = [];
  for (const e of kept) {
    const fresh =
      e.mtimeMs !== null && now - e.mtimeMs < quietMs && e.mtimeMs - now <= FUTURE_MTIME_SKEW_MS;
    // A COPY's `origPath` is an untouched file, not half of a pair.
    const renameOrig = isRenameStatus(e.xy) ? e.origPath : undefined;

    if (renameOrig) {
      // Staged rename: judged by the NEW half, both halves move together.
      if (fresh) {
        quietHeld = true;
        deferred.push({ path: e.path, reason: "renamed <5 min ago" });
        deferred.push({ path: renameOrig, reason: "rename pair held with its new half" });
        continue;
      }
      stage.push(e.path);
      stage.push(renameOrig);
      deletions.push(renameOrig); // the origin is gone from disk
      continue;
    }

    if (e.mtimeMs === null) {
      pendingDeletions.push(e.path);
      continue;
    }

    if (fresh) {
      quietHeld = true;
      deferred.push({ path: e.path, reason: "edited <5 min ago" });
      continue;
    }
    stage.push(e.path);
  }

  // Pass 3 — deletions ride only in a tick that held nothing back.
  for (const p of pendingDeletions) {
    if (quietHeld) {
      deferred.push({ path: p, reason: "deletion held — an edit in this tick is still quiet-filtered" });
      continue;
    }
    stage.push(p);
    deletions.push(p);
  }

  return { stage, deletions, deferred, denied, quietHeld };
}

// ── Card state ───────────────────────────────────────────────────────────────

/**
 * What happened to one repo on one tick. `blocked` needs a human; `paused` and
 * `deferred` are the loop working as designed and resolve themselves.
 */
export type SyncState =
  | "ok" // committed / rebased / pushed, or nothing to do
  | "status-only" // reported, by configuration
  | "deferred" // will retry next tick, nothing wrong
  | "paused" // off the default branch
  | "transient" // a live concurrent git op — retry next tick
  | "retrying" // the remote moved and the in-tick retry did not settle it
  | "blocked" // needs a human
  | "running" // a sync for this repo is already in flight
  | "error";

/** `neutral` is NOT a healthy green: it is "nothing has happened yet in this
 *  process". A never-synced repo rendered as `ok` read as "in sync" on the card,
 *  which is the one thing the card must never say without evidence. */
export type SyncTone = "ok" | "warn" | "bad" | "neutral";

/** The per-repo ledger entry the card reads (see `run.ts`). */
export interface SyncLedgerEntry {
  state: SyncState;
  reason?: string;
  /** Consecutive ticks that ended `deferred`. Reset by any other outcome. */
  consecutiveDeferrals: number;
  /** Last tick that ended `ok` (epoch ms), or null if never in this process. */
  lastSuccessMs: number | null;
  lastRunMs: number | null;
  lastError?: string;
}

/**
 * The card's tone. Deferral is normal — but a repo that has deferred every tick
 * for an hour, or has not had a clean sync in two hours, is not converging and
 * the card must stop looking healthy. A `blocked`/`error` state is always bad.
 */
export function syncTone(entry: SyncLedgerEntry, now: number): SyncTone {
  if (entry.state === "blocked" || entry.state === "error") return "bad";
  if (entry.consecutiveDeferrals >= SYNC_DEFERRAL_WARN_AFTER) return "warn";
  if (entry.state === "paused" || entry.state === "retrying") return "warn";
  if (
    entry.lastSuccessMs !== null &&
    now - entry.lastSuccessMs > SYNC_STALE_SUCCESS_MS &&
    entry.state !== "status-only"
  ) {
    return "warn";
  }
  return "ok";
}

/** One-line human label for a state + reason, used by the card and the log. */
export function describeSyncState(state: SyncState, reason?: string): string {
  const base: Record<SyncState, string> = {
    ok: "in sync",
    "status-only": "status only",
    deferred: "deferred",
    paused: "paused",
    transient: "busy",
    retrying: "retrying",
    blocked: "blocked",
    running: "running",
    error: "error",
  };
  return reason ? `${base[state]}: ${reason}` : base[state];
}
