# Watchers Module

Background monitors that check external services at intervals and send alerts to Telegram and to configured Slack channels. The runner, the eight checkers, their health records and the wiki gardener's scheduling are described in the notes below.

## Detail: `src/watchers/reference/notes.md`

Detail about one checker or one function lives in `src/watchers/reference/notes.md`, which is not loaded automatically. A `src/<module>/CLAUDE.md` cited inside `notes.md` may now mean that module's `reference/notes.md`. The counts in this section are this file's own (measured 2026-11-03).

- **Search it this way, never plain:** `rg -n -o '.{0,120}<term>.{0,120}' src/watchers/reference/notes.md`. With the Grep tool: `output_mode: content`, `-o`, the same pattern and that path. Keep the window at 120 chars or less. Lines are long: plain `rg` prints each whole line and plain Grep returns "Omitted long matching line". Do not use `grep -o` here: in a Claude Code shell it returns nothing for this pattern and exits 1, which reads as no note.
- **Before editing a file:** search its basename and the exported functions you are changing; few hits is not full coverage: `x.ts` gets 3 lines, while its section, `X/Twitter Watcher — Key Lessons`, runs to 75k chars under a heading without the basename. **To look up a topic:** find its heading in the index and search a few plain words of it, never the whole heading.
- **No hit:** zero hits on a basename means no note under that name, not no rule: `format-alerts.ts`, `config-knobs.ts` and `quiet-hours.ts` have none. Search the file's stem and exported names (`quiet-hours` 9 lines, `isQuietHours` 2, `formatAlerts` 1), then the index (`config-knobs` and `readIntKnob` have no hit either; Config fields holds its knobs), then the neighbouring module's `notes.md`, or its `CLAUDE.md` where it has none; `rg -l <term> src -g '{CLAUDE,notes}.md'` finds which.
- **Read a hit:** `Read` from the hit's line with a limit of about 30 lines, not the whole section: sections run to 75k chars, and one subsection (`Candidate capture`) to 50k. No line is over about 5,000 chars today (the longest is 2,703); one that grows past it goes through `t=$(mktemp); sed -n '<N>p' src/watchers/reference/notes.md | fold -s -w 2000 > "$t"; echo "$t"` first, with the full path because a bare `notes.md` prints a valid path to an empty file and exits 0, and the printed file takes `Read` with offset and limit or `rg -n -o '.{0,120}<term>.{0,120}' <printed path>`.

**History:** `git log --follow -- src/watchers/reference/notes.md` reaches the old file's commits.

## Rules

- A new checker type must be wired through the `WatcherCheckers` seam (`runChecker`'s 4th arg) and given a dispatch test, or deleting its branch is invisible.
- New importers of `computeWatcherTimeoutMs` and `TICK_TIMEOUT_MS` take them from `./timeout.ts`. `runner.ts` re-exports only `computeWatcherTimeoutMs`, and a checker importing it there closes an import cycle; it does not export `TICK_TIMEOUT_MS` at all.
- Treat a fix that requires a hand-edited DB row as inert where it matters.
- `last_run_at` must never be treated as a health signal: `runner.ts` advances it on every failure to prevent retry storms, which is why it is uninformative.
- Give a new guard that can repeat indefinitely a counter, a bound or a surface. The skip-forever audit went through every watcher for guards with none, as a defect class; two stand as noted and latent, the `news` checker and the quiet-hours whole-run skip.
- Adopt health at a seam through the recorder: `openSourceHealth(watcher.id, watcher.name)`, `mark(key, outcome, detail?)`, `return health.finish()`. These checkers early-return, so an escalation built at the bottom of the function never ships. Mark a failure you want surfaced: every non-`ok` outcome extends the streak, and three in a row escalate. On a run that could not judge a source, call `carry(key)`: `finish()` drops any source neither marked nor carried, which is meant for a de-configured one. A dropped record loses its `consecutive` streak and `lastOkAt`, so a streak one run from escalating resets and the alert reads "never succeeded".
- Health is observability and must never break the path it observes; capture is best-effort too, and a DB error never breaks the alert path.
- A health alert's builder emits on every run past the threshold, and suppressing the repeats is the runner's id-dedup job. Never commit "we alerted" bookkeeping when the alert is built: the runner writes `last_notified_ids` only after a successful send, so an undelivered alert is simply re-emitted next run.
- A health alert's id must be stable within an episode and distinct across episodes.
- Pass a DB seam as a parameter, not a `mock.module`: a `mock.module` test here invalidates `db/*` for its whole `bun test` process.
- Keep new durable per-source state in `watcher_snapshots`, as Anthropic Tier-2 does: NOT `lastNotifiedIds` (600-capped, shared with Tier-1) and NOT `config` (the dashboard's `updateWatcher` overwrites the whole blob).
- The interest profile augments, never narrows: baseline topics always qualify on their own, and the profile only raises relevance. Load it with `loadInterestProfile(watcher.userId, botName)`, keyed on the watcher's own owner and NOT `bot_default_user`, which leaks one user's interests into another's alerts.
- A numeric knob read through `readIntKnob` (`config-knobs.ts`) with a wrong-typed or out-of-range value is warned about and falls back to its default, and never aborts the run: `captureMaxItems: "1"` runs at 3, `amplificationMinAuthors: "5"` at 3. The direction differs per knob: `captureMaxItems` absent or invalid is ON at 3, never unlimited, while `captureAmplifyMin` (its own reader, `resolveCaptureAmplifyMin`) absent or invalid is OFF, so a typo never grows the gate batch.

## Traps

- ⚠️ `[]` is what a quiet run returns and what every checker degrades to, so a return value proves nothing. A refactor deleted `case "email"`, every tick returned `[]`, run-health saw a healthy run, and tsc and the full suite stayed green. A test asserts WHICH checker a run reaches.
- ⚠️ Overrunning the run's time box is catastrophic rather than soft: `withWatcherTimeout` rejects, the runner's catch re-saves the OLD `lastNotifiedIds`, and the whole batch is re-fetched next run. The scheduler tick (600s, `TICK_TIMEOUT_MS`) is the true ceiling, not the watcher net.
- ⚠️ `lastNotifiedIds` is one rolling window of 600 ids per row, already full on the live rows, so an id stays deduped only as long as it stays in that window.
- ⚠️ The runner's content-hash dedup can swallow a different alert: alerts that share one prose skeleton fingerprint to one hash, and the first stores it. A recurring alert needs the per-type skip list in `dedupContentHash` or a per-alert exemption; `x` must stay OUT of the type list, because content-hash is the only thing catching a re-summarised identical digest.
- ⚠️ For `x` and `anthropic`, `config.timeoutMs` IS the model-call timeout. `checkEmail` has never passed it to `spawnHaiku`, so on an email row it widens the runner's net only. A configured `timeoutMs` only ever raises the net.
- ⚠️ `spawnHaiku` unconditionally spawns `claude -p` and never consults the Haiku router, so `email`, `x` and `anthropic` ignore the bot's chat connector and `HAIKU_BACKEND`. The gardener types' models run outside it, so `onUsage` and `onModelError` never fire for them, and a stamped 0 would lie.
- ⚠️ Only the email spawn has tools (`toolSurface: "gmail-read"`); every other watcher spawn is tool-less (`--tools ""`).
- ⚠️ A failing checker's errored span is the CHILD: the `scheduler_tick` root still finishes `ok`, so the `/traces` list row stays green and only the waterfall detail shows red.
- ⚠️ A run landing in quiet hours is skipped whole, and `last_run_at` still advances, unless it is forced (`force_next_run`) or its type is in `QUIET_HOURS_RUN_EXEMPT`: `wiki-committer` is, because its side effect is a git commit and not a user notification.
- ⚠️ A failed run on an hour-gated row (`config.hour` set, any checker type) still advances `last_run_at`, whichever way it ends: a checker that swallows the error reaches the runner's success tail (`finishWatcherRun`), and a throw reaches the runner's catch. `isScheduledTimeDue` then sees it inside today, so that day's run is lost. A weekly row also waits out its interval from that failure, so the week's run is gone. `force_next_run` brings it back. A process death or a failed write of `last_run_at` leaves the row due.
- ⚠️ A prompt key seeded into a row's config hides the code default: the X Daily and Highlights alert prompts' seeded keys had to be stripped to pick up code defaults. X's capture gate (`runCaptureGate`) is code-only, since there `config.prompt` reaches only the alert and digest path. Anthropic differs: its gate reads `config.prompt || DEFAULT_ANTHROPIC_GATE_PROMPT` and its capture reuses that gate's score, so the row's prompt moves capture too. A setup script skips an existing row, so its seed reaches a fresh box only.

Rules and traps about one checker stay in their section of the notes; ` [trap]` in the index below sends you there before you edit that code.

## Index

` [trap]` marks a section that records a failure or hazard; an unmarked section can still hold a rule, so search before you edit.

- Architecture
- Watcher Types
- Interest-profile personalization (gate/capture prompts) [trap]
- X/Twitter Watcher — Key Lessons
- Rank read (`combined_score`, metadata-preferred) [trap]
- Score-ordered document cap (`orderDocsForCap`) [trap]
- X-Article amplification signal (`x-amplification.ts`) [trap]
- Prompt size is critical [trap]
- Collection path gotchas [trap]
- Dedup
- Config fields (stored in watcher JSONB config) [trap]
- Silent alerts and the quality-gate pattern
- Candidate capture → the Candidates → Summaries inbox (Claude Learning Center, Phase B — X → shelf) [trap]
- 3-watcher pattern (daytime alerts + daily + weekly) [trap]
- No fallback on model failure
- Runner (runner.ts)
- Manual trigger via force_next_run
- Wiki-readonly skip (`MUNINN_WIKI_READONLY`) [trap]
- Time-of-day scheduling [trap]
- Truthful `/agents` connector + model (`watcherConnectorInfo`) [trap]
- Scheduler context
- Per-watcher safety-net timeout [trap]
- Concurrent-duplicate guard (`claimChecker`/`releaseChecker`) [trap]
- Email Watcher (email.ts)
- Query window + the success watermark (2026-08-14) [trap]
- Tool fence (2026-10, arch-review A1) [trap]
- Bounded retry (2026-08-13) [trap]
- Anthropic Watcher (anthropic.ts) [trap]
- Two-layer Tier-2 response guard (2026-07-27, the llms.txt wedge) [trap]
- Per-source health + escalation (`src/watchers/source-health.ts`) [trap]
- Run-level health (2026-08-14, `run-health.ts`) [trap]
- Skip-forever audit (2026-07-27) — dispositions [trap]
- 3-row digest cadence (Phase 4) [trap]
- Config fields (JSONB) [trap]
- Candidate capture → the Candidates → Summaries inbox (Claude Learning Center, Phase B) [trap]
- Wiki Gardener (wiki-gardener.ts + src/gardener/) [trap]
- Wiki Linter (wiki-linter.ts + src/wiki/lint.ts) [trap]
- Wiki Committer (wiki-committer.ts) [trap]
- Consolidation Gardener (consolidation-gardener.ts) [trap]
- Configurable prompts
- Configurable model
- Tool-call visibility for Haiku-driven checkers (`spawnHaiku` telemetry) [trap]
- Testing
