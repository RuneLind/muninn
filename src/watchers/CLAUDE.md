# Watchers Module

Background monitors that check external services at intervals and send alerts via Telegram. The runner, the eight checkers, their health records and the wiki gardener's scheduling are described in the notes below.

## Detail: `src/watchers/reference/notes.md`

Detail about one checker or one function lives in `src/watchers/reference/notes.md`, which is not loaded automatically. Two ways in, each ending in `Read` with offset and limit on the line numbers you get:

- **Before editing a file:** Grep `notes.md` for the file's basename, with `output_mode: content`, `-n`, `-o` and a pattern such as `.{0,120}runner\.ts.{0,120}`.
- **To look up a topic:** find its heading in the index below and Grep for a few plain words of it, never the whole heading. Parens and brackets are regex metacharacters: 28 of this file's 44 headings match nothing verbatim (measured 2026-11-03).

**No hit** on a basename means no note under that name, not no rule: `format-alerts.ts`, `config-knobs.ts` and `quiet-hours.ts` have no hit here (measured 2026-11-03). Go to the index, then to the neighbouring module's notes: `src/gardener/CLAUDE.md`, `src/wiki/reference/notes.md`, `src/dashboard/reference/notes.md`. A module that has not moved its notes yet keeps them in its `CLAUDE.md`.

**Long lines.** Claude Code's Grep tool runs ripgrep with `--max-columns 500`, so a plain search matching a long line returns "Omitted long matching line". The `-o` pattern above returns the text around each match. Keep its window at 120 chars or less, because ripgrep counts the 500-column limit in bytes.

A line too long for `Read` goes to a scratch file first, with the file's full path. From the repo root a bare `notes.md` prints a valid path to an empty file and exits 0. Then `Read` the printed file with offset and limit:

```bash
t=$(mktemp); sed -n '<N>p' src/watchers/reference/notes.md | fold -w 2000 > "$t"; echo "$t"
```

**History:** `git log --follow -- src/watchers/reference/notes.md` reaches the old file's commits.

## Rules

- A new checker type must be wired through the `WatcherCheckers` seam (`runChecker`'s 4th arg) and given a dispatch test, or deleting its branch is invisible.
- New importers of `computeWatcherTimeoutMs` and `TICK_TIMEOUT_MS` take them from `./timeout.ts`: importing them from `runner.ts` closes an import cycle.
- Treat a fix that requires a hand-edited DB row as inert where it matters.
- `last_run_at` must never be treated as a health signal: `runner.ts` advances it on every failure to prevent retry storms, which is why it is uninformative.
- A guard that can repeat indefinitely needs a counter, a bound or a surface: one with none is the defect class the skip-forever audit went after.
- Adopt health at a seam through the recorder: `openSourceHealth(watcher.id, watcher.name)`, `mark(key, outcome, detail?)`, `return health.finish()`. These checkers early-return, so an escalation built at the bottom of the function never ships.
- Health is observability and must never break the path it observes; capture is best-effort too, and a DB error never breaks the alert path.
- A health alert's builder emits on every run past the threshold, and suppressing the repeats is the runner's id-dedup job. Never commit "we alerted" bookkeeping when the alert is built: the runner writes `last_notified_ids` only after a successful send, so an undelivered alert is simply re-emitted next run.
- A health alert's id must be stable within an episode and distinct across episodes.
- Pass a DB seam as a parameter, not a `mock.module`: a `mock.module` test here invalidates `db/*` for the whole `bun test src/watchers/` chunk.
- Keep a checker's durable per-source state in `watcher_snapshots`, NOT `lastNotifiedIds` (600-capped, shared) and NOT `config` (the dashboard's `updateWatcher` overwrites the whole blob).
- The interest profile augments, never narrows: baseline topics always qualify on their own, and the profile only raises relevance. Load it with `loadInterestProfile(watcher.userId, botName)`, keyed on the watcher's own owner and NOT `bot_default_user`, which leaks one user's interests into another's alerts.
- A mistyped config knob degrades toward fewer captures and no batch growth, never a silent widening.
- A non-Haiku model (Sonnet) needs a higher `timeoutMs`: the Haiku default is 60s.

## Traps

- ⚠️ `[]` is what a quiet run returns and what every checker degrades to, so a return value proves nothing. A refactor deleted `case "email"`, every tick returned `[]`, run-health saw a healthy run, and tsc and the full suite stayed green. A test asserts WHICH checker a run reaches.
- ⚠️ Overrunning the run's time box is catastrophic rather than soft: `withWatcherTimeout` rejects, the runner's catch re-saves the OLD `lastNotifiedIds`, and the whole batch is re-fetched next run. The scheduler tick (600s, `TICK_TIMEOUT_MS`) is the true ceiling, not the watcher net.
- ⚠️ `lastNotifiedIds` is one rolling window of 600 ids per row, already full on the live rows, so an id stays deduped only as long as it stays in that window.
- ⚠️ The runner's content-hash dedup can swallow a different alert: alerts that share one prose skeleton fingerprint to one hash, and the first stores it. A recurring alert needs the per-type skip list in `dedupContentHash` or a per-alert exemption; `x` must stay OUT of the type list, because content-hash is the only thing catching a re-summarised identical digest.
- ⚠️ For `x` and `anthropic`, `config.timeoutMs` IS the model-call timeout. `checkEmail` has never passed it to `spawnHaiku`, so on an email row it widens the runner's net only. A configured `timeoutMs` only ever raises the net.
- ⚠️ `spawnHaiku` unconditionally spawns `claude -p` and never consults the Haiku router, so `email`, `x` and `anthropic` ignore the bot's chat connector and `HAIKU_BACKEND`. The gardener types' models run outside it, so `onUsage` and `onModelError` never fire for them, and a stamped 0 would lie.
- ⚠️ Only the email spawn has tools (`toolSurface: "gmail-read"`); every other watcher spawn is tool-less (`--tools ""`).
- ⚠️ A failing checker's errored span is the CHILD: the `scheduler_tick` root still finishes `ok`, so the `/traces` list row stays green and only the waterfall detail shows red.
- ⚠️ A run landing in quiet hours is skipped whole, and `last_run_at` still advances, unless its type is in `QUIET_HOURS_RUN_EXEMPT`: `wiki-committer` is, because its side effect is a git commit and not a user notification.
- ⚠️ A prompt key seeded into a row's config hides the code default: the Daily and Highlights alert prompts' seeded keys had to be stripped to pick up code defaults. The capture-gate prompt is code-only, since `config.prompt` reaches only the alert and digest path. A setup script skips an existing row, so its seed reaches a fresh box only.

Rules and traps about one checker stay in their section of the notes; ` [trap]` in the index below sends you there before you edit that code.

## Index

- Architecture
- Watcher Types
- Interest-profile personalization (gate/capture prompts) [trap]
- X/Twitter Watcher — Key Lessons
- Rank read (`combined_score`, metadata-preferred) [trap]
- Score-ordered document cap (`orderDocsForCap`) [trap]
- X-Article amplification signal (`x-amplification.ts`)
- Prompt size is critical [trap]
- Collection path gotchas [trap]
- Dedup
- Config fields (stored in watcher JSONB config) [trap]
- Silent alerts and the quality-gate pattern
- Candidate capture → the Candidates → Summaries inbox (Claude Learning Center, Phase B — X → shelf) [trap]
- 3-watcher pattern (daytime alerts + daily + weekly)
- No fallback on model failure
- Runner (runner.ts)
- Manual trigger via force_next_run
- Wiki-readonly skip (`MUNINN_WIKI_READONLY`) [trap]
- Time-of-day scheduling [trap]
- Truthful `/agents` connector + model (`watcherConnectorInfo`)
- Scheduler context
- Per-watcher safety-net timeout
- Concurrent-duplicate guard (`claimChecker`/`releaseChecker`) [trap]
- Email Watcher (email.ts)
- Query window + the success watermark (2026-08-14) [trap]
- Tool fence (2026-10, arch-review A1) [trap]
- Bounded retry (2026-08-13) [trap]
- Anthropic Watcher (anthropic.ts)
- Two-layer Tier-2 response guard (2026-07-27, the llms.txt wedge) [trap]
- Per-source health + escalation (`src/watchers/source-health.ts`) [trap]
- Run-level health (2026-08-14, `run-health.ts`) [trap]
- Skip-forever audit (2026-07-27) — dispositions [trap]
- 3-row digest cadence (Phase 4)
- Config fields (JSONB)
- Candidate capture → the Candidates → Summaries inbox (Claude Learning Center, Phase B)
- Wiki Gardener (wiki-gardener.ts + src/gardener/) [trap]
- Wiki Linter (wiki-linter.ts + src/wiki/lint.ts) [trap]
- Wiki Committer (wiki-committer.ts) [trap]
- Consolidation Gardener (consolidation-gardener.ts)
- Configurable prompts
- Configurable model [trap]
- Tool-call visibility for Haiku-driven checkers (`spawnHaiku` telemetry) [trap]
- Testing
