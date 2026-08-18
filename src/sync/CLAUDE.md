# Repo sync loop (`src/sync/`)

Muninn runs on two machines (laptop + Mac mini) against the same shared repos —
the mimir wiki, huginn-jarvis (a wiki NESTED inside a bigger repo), the skills
repo, muninn itself — and they converge ONLY through GitHub. Nothing synced them
automatically before this; the laptop once sat a commit behind for a week.

Three files, one job:

| File | Role |
|---|---|
| `config.ts` | `SYNC_REPOS` parsing (pure — no git spawn, no env reads). Modes, path resolution, the same-repo dedup, the plain-over-a-wiki warning. |
| `decide.ts` | The PURE decision layer: what to stage, what to hold, what the card says. No git, no fs, no clock read (`now` is a parameter). |
| `run.ts` | The per-repo state machine: fetch → (locked) status → commit → rebase → (unlocked) push → refresh the reader cache. Plus the in-memory ledger the card reads. |

Surface: `POST /api/sync/run` (the ONE code path both triggers use — a 15-minute
launchd `curl` and the `/models` **Repo sync** card) and `GET /api/sync/status`
(the card's fetch-free poll). Route contract: the `sync-routes.ts` row in
`src/dashboard/CLAUDE.md`. Config reference: the `SYNC_REPOS` row in the repo
`CLAUDE.md`.

## The locking contract (stated ONCE, here)

Every other spelling of this points at this section rather than repeating it.

Two INDEPENDENT queues already exist and this loop joins both:

1. the **COMMIT queue** — `runExclusiveQueued`, keyed on the git toplevel
   (`src/wiki/commit.ts`), which every wiki write's commit tail runs on;
2. the **WIKI-WRITE queue** — `runWikiWriteExclusive`, realpath-keyed on the wiki
   root (`src/wiki/queue.ts`), spanning read→CAS→write→log.md.

Rules, in order of importance:

- **Network I/O never holds a lock.** The fetch runs before either lock is taken
  and the push after both are released — the measured 3s-push-stall rationale
  recorded in `src/gardener/apply.ts` (the "measured: a 3s push stall blocked a
  concurrent append for 3s" sentence). A remote that hangs must never park a page
  write.
- **The locks are taken in a PINNED ORDER: commit first, wiki-write second.** So a
  hung push (which holds only the commit queue) can park the sync, never a page
  write. Multiple wiki roots — a `plain` repo CONTAINING registered wikis, see
  below — nest in SORTED order, because an arbitrary order between two repos
  sharing two wikis is a deadlock.
- **Deadlock invariant:** commit-first/write-second is safe ONLY because every
  current writer keeps its commit tail OUTSIDE its write section (stated in
  `src/wiki/queue.ts` and `src/gardener/CLAUDE.md`). A future writer that commits
  from INSIDE its write section takes the two in the opposite order and deadlocks
  against this loop. If you add one, this ordering must change with it.
- The local section takes the commit lock DIRECTLY (`runExclusiveQueued`) rather
  than routing through `commitWikiChange`, which would release the lock around its
  own commit — leaving the rebase unprotected against a gardener commit tail — and
  dispatch an immediate push that would be non-fast-forward before the rebase ran.
- **Hold duration, honestly:** the local section is status + add/commit + rebase,
  all local — tens of ms on a clean repo, seconds on a big rebase. The push, the
  fetch and the huginn reindex kick are all outside it.

## Why deferral is not failure

On most ticks during a live editing session a wiki carries fresh modifications:
the quiet-period filter deliberately leaves them uncommitted, and git then refuses
to rebase. That is the design working — the tick ends as `deferred` and the next
one picks it up. (Ruled against `git rebase --autostash`: a stash-pop conflict on
the file being edited is worse than waiting 15 minutes.) Deferral only becomes
visible when it PERSISTS — `syncTone` flips the card to warn after
`SYNC_DEFERRAL_WARN_AFTER` (4) consecutive deferrals or ~2h without a clean sync.

Two KINDS of deferral, and the difference is load-bearing:

- **Hard** (`state` set inside the local section): the tick stops, nothing is
  pushed. Only when the repo is BEHIND its upstream and rebase-blocking dirt
  remains — i.e. there is remote work we cannot integrate.
- **Soft** (`holdReason`): the commit, rebase and push all still run; the tick just
  reports `deferred` at the end. Quiet-held files live here. Reporting them `ok`
  with streak 0 meant a held page could sit uncommitted forever behind a green
  card that never escalated.

**A refused rebase does NOT block the push when we are not behind.** A rebase
exists to integrate remote work; with none to integrate, refusing to push behind it
is what wedged a nested wiki forever — huginn-jarvis normally carries tracked dirt
OUTSIDE the wiki subtree (another process owns the rest of that repo), so every
tick deferred while `ahead` grew and the wiki's own commits never left the machine.
The deferral reason is derived from the actual blocking sets
(`describeDeferralReason`) and distinguishes a quiet hold from outside-subtree dirt.

Two things the deferral REPORT must not conflate, both fixed after they shipped:

- **Only a path held on its own mtime is an "edit".** A deletion has no mtime
  and the old half of a rename was never touched — they are held BECAUSE
  something else is fresh, so they carry their own clause
  (`companionHeld`, keyed off the exported `DEFER_REASON_*` strings via
  `isFreshMtimeHold`/`isCompanionHold`). Folded into the mtime count, the card
  claimed edits to a file that had just been deleted.
- **Out-of-scope dirt is not "deferred".** It rides `deferredFiles` for
  visibility, but the loop will never commit it however long you wait, so it is
  labelled as another process's work rather than as an uncommitted change
  pending on a tick that cannot help.

## Rules that are not obvious from the code

- **The denylist applies to UNTRACKED entries only.** A tracked file is already the
  repo's decision to version it (a committed `.obsidian/workspace.json` is routine
  in an Obsidian vault), and dropping a tracked path from staging cannot make it
  clean — it stays dirty, and tracked dirt is what makes `git rebase` refuse, so
  the entry would wedge the repo on EVERY tick forever.
- **A future mtime is not fresh.** `now - mtime < quietMs` is permanently true for
  a stamp ahead of the clock, so the file would defer itself and hold every
  deletion with it forever. More than `FUTURE_MTIME_SKEW_MS` (48h) ahead ⇒ treated
  as aged — the wiki store's future-date guard rationale.
- **`C` is not `R`.** git pairs copy records too, but a copy's source still exists;
  only `R` entries stage their `origPath` as a deletion.
- **Every `git status` runs `--no-optional-locks`** (`STATUS_READONLY_ARGS` in
  `commit.ts`). A plain status opportunistically rewrites `.git/index` (measured:
  the index mtime moves), i.e. takes `index.lock` — from unlocked read paths, while
  the locked `git add` runs against the same index.
- **Only network verbs are timed, and they run in their own process group.**
  `runGit`'s `timeoutMs` implies `detached: true` so the timeout kills the GROUP:
  measured on a fixture push through a hung `GIT_SSH_COMMAND`, `proc.kill(9)` alone
  left the ssh child alive holding the connection and the inherited pipes.
- **`index.lock` contention is transient at BOTH ends of a tick** — the pre-flight
  already says so, and `isTransientGitLockFailure` keeps a mid-section add/commit
  failure consistent with it instead of raising a red card for a self-healing race.
- **A branch with no upstream is not pushed by guesswork.** Ahead/behind fall back
  to `origin/main` (labelled `upstreamFallback`), but `git push` with no upstream
  fails every tick — so the loop refuses with a `blocked` card telling you to run
  `git push -u origin <branch>` once. Pushing an explicit `HEAD:<branch>` would be
  the loop guessing which remote branch this one tracks.
- **An empty pathspec is not a narrow commit, it is the WHOLE INDEX.** When every
  path vanished mid-tick the argv ends in a bare `--`, and git then commits
  whatever ANOTHER process has staged under a `[sync] 0 file(s)` subject
  (verified against real git). Nothing left to commit ⇒ no commit is attempted.
  Same class: `commitBody([])` would pass `-m ""`, a real blank paragraph.
- **Lock roots sort on the QUEUE KEY, not the configured string.** The locks are
  realpath-keyed (`wikiWriteQueueKey`), so sorting raw spellings is an incidental
  total order that a symlinked or `/tmp` root breaks — and two repos taking two
  shared wikis in opposite orders is precisely the deadlock the sort prevents
  (`sortedLockRoots`).
- **The ledger's default state is `unknown`, not `ok`.** `unknown` is the absence
  of evidence: it renders "not synced yet" in a neutral tone, and the card's
  label, tone AND payload `state` all derive from it rather than the label alone
  saying so while the machine-readable field said "in sync".
- **The ledger is in-memory, per process, and `running` never touches it.** A dry
  run and an in-flight `running` answer both REPORT without recording: recording
  `running` zeroed the deferral streak and cleared `lastError`, so a card polled
  during a slow tick went green.
- **Sweeper subsumption requires EVIDENCE, not configuration.** `SYNC_REPOS` being
  parseable used to stand the daily `wiki-committer` down forever — including on a
  machine whose launchd job was never installed, which is the 2026-07-23 page-loss
  shape. `syncSubsumesSweeper` also requires evidence inside
  `SYNC_SUBSUME_MAX_AGE_MS` (~26h); short of that the sweeper runs AND warns.
- **The evidence is `lastLocalSectionMs`, not `lastRunMs` — "the loop ran" and "the
  loop could commit" are different claims.** `recordLedger` stamps `lastRunMs` on
  EVERY tick, and a tick that returns at a FAILED FETCH (origin unreachable for days:
  offline, VPN down, an expired deploy key) commits nothing yet used to refresh that
  clock — the same page-loss shape again, reached through "the loop runs but never
  commits". So the clock is stamped only once a tick reaches step 5, the local section,
  **AND comes out of it without failing there** — reaching it is not enough. A tick
  that gets all the way to `git commit` and dies inside it every 15 minutes (a signing
  key that expired over a reboot, a pre-commit hook that started refusing, a bad
  `user.email` — reproduced with `commit.gpgsign=true` + `gpg.program=/bin/false`)
  commits exactly as little as one that never left the fetch, and stamping it renewed
  the stand-down forever: the same shape one step later. **The rule, exactly as
  implemented: an `error`, `transient` or `blocked` outcome from BEFORE or INSIDE the
  local section stamps no evidence — but one from AFTER it (a failed push, the
  no-upstream `blocked`) DOES stamp, because the local commit path genuinely worked
  and the sweeper could add nothing the loop did not already commit — except that the
  push RETRY runs a second local section, and a failure INSIDE that one (`git commit`
  refused after a re-rebase) stamps nothing either.** A hard
  `deferred` stamps (the commit path ran, the loop chose to wait), and so does a soft
  hold, which never reaches that branch at all — it sets `holdReason`, pushes, and
  exits through the final return, which passes `commitPathOk: true` unconditionally. A
  rebase-conflict `blocked` does NOT: it fails INSIDE the section, needs a human and
  its work never leaves the machine, and it subsumes on the explicit exception below
  anyway, so withholding the stamp costs nothing and keeps the daily warn. `finish`'s
  `commitPathOk` flag defaults to FALSE so a new early return can only ever under-claim
  coverage.
  **Two residuals, accepted.** (a) A loop whose PUSH has failed for days keeps
  subsuming and the daily warn stays silent — diagnosable rather than silent overall,
  because the `/models` Repo sync card is red while its "last commit pass" is fresh,
  which says the diagnosis is the push and not the commit, and the commits themselves
  are safe on disk. (b) A repeating hard `deferred` with nothing IN-SUBTREE dirty
  stamps evidence without ever invoking `git commit`, so a broken signing key is
  undetected in that state until in-subtree dirt appears — at which point the commit
  runs, fails inside the section, and the stamping stops.
  **Evidence is the ONLY thing that subsumes, with one exception.** `subsumed =
  fresh(lastLocalSectionMs) || state === "blocked"`. `blocked` subsumes regardless of
  freshness because the sweeper is not a safe substitute there at all: it is the
  unmerged-paths / interrupted-operation refusal and the sweeper has NO pre-flight of
  its own (`listWikiSubtreeDirty` treats a `UU` entry as ordinary dirt), so routing a
  blocked tick to it would stage and commit a human's half-finished merge — and the
  conditions that produce `blocked` (a leftover `MERGE_HEAD`, a stale `index.lock`,
  conflict markers) persist across ticks until a human clears them, which is what
  makes a one-tick sample sound there and nowhere else. Every OTHER state — `error`,
  `transient`, `paused`, no-upstream, not-a-repo, a cold ledger, and a rebase conflict
  that never converges — falls through once the evidence is stale; `paused` harmlessly, since the sweeper applies the same
  off-default-branch rule to itself and no-ops (`onDefaultBranch` guard,
  `src/watchers/wiki-committer.ts`). The rejected spelling was `fresh(lastRunMs) &&
  state !== "error"`: `lastRunMs` is re-stamped every 15 minutes, so ANY tick stopping
  before the local section in a non-error state renewed the stand-down forever — and a
  single `transient` tick (a young `index.lock`) re-armed 26h of silence in the middle
  of an offline week.
  **The warn is DECOUPLED from the stand-down:** `configuredButIdle =
  !fresh(lastLocalSectionMs)`, so a loop that has not committed in ~26h always warns,
  including while `blocked` subsumes — the one thing that must never happen is a
  silent stand-down over a wiki nothing is committing. Residual, accepted: a healthy
  pass still buys ~26h of grace, so at most ONE daily sweep is skipped after the remote
  goes away; and `blocked` subsumes for as long as it lasts, but never silently.
- **A `plain`/`status-only` repo containing a registered wiki takes that wiki's
  write lock.** Its rebase rewrites the wiki's working tree, and the wiki-mode
  config error actively steers people into this shape ("… or use mode plain"). The
  parse warns loudly and records `containedWikiRoots`; `withLocks` nests them.
