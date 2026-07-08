# Watchers Module

Background monitors that check external services at intervals and send alerts via Telegram.

## Architecture

```
Scheduler tick (every 60s)
  → getWatchersDueNow() — interval-based from DB
  → isScheduledTimeDue() — time-of-day filter (hour/minute in config)
  → runChecker() — dispatches to type-specific checker
  → dedup (lastNotifiedIds rolling window, max 600)
  → formatAlerts → sendMessage → saveMessage → updateWatcherLastRun
```

## Watcher Types

| Type | File | Data Source | Model |
|---|---|---|---|
| `email` | `email.ts` | Haiku with Gmail MCP tools | Configurable via `config.model` |
| `news` | `news.ts` | Google News RSS (no AI) | — |
| `x` | `x.ts` | Huginn x-feed collection (knowledge API) | Configurable, Sonnet recommended |
| `anthropic` | `anthropic.ts` | GitHub Atom feeds + llms.txt/blog diff | Haiku gate (Highlights) / Sonnet digest (Daily/Weekly) |
| `wiki-gardener` | `wiki-gardener.ts` | Recent summary collections (knowledge API) | Haiku cluster + bot-connector draft |

## Interest-profile personalization (gate/capture prompts)

The `x` and `anthropic` gate/capture/digest prompts carry a hardcoded BASELINE of
topics (e.g. "a senior AI engineer who lives in Claude Code…"). On top of that,
each run loads a per-user **interest profile** — a periodically-refreshed
distillation of the bot user's active goals + recent memories (`interest_profiles`
table; built by `src/profile/generator.ts` on a scheduler step gated by a
"stale > 7 days" predicate). `withInterestProfile()` (`src/profile/inject.ts`)
appends it as a clearly-delimited section that **augments, never narrows** the
baseline — the anti-filter-bubble guard: baseline topics always qualify on their
own; the profile only RAISES relevance for the user's own interests.

- **Loaded once per watcher run** (not per candidate), via
  `loadInterestProfileForBot(botName)` which resolves the bot's primary user
  through `bot_default_user`. Best-effort: no default user / no profile row / any
  DB error → returns `null`, and the prompt is **byte-identical to today**.
- Wired at: the anthropic `runGate` + `runDigest` criteria, and the X `runAlertPath`
  (highlights/digest) + `runCaptureGate` (capture) prompts.
- No config knob — personalization is automatic and silent when a profile exists.
  The profile is visible only via the DB this PR (no dashboard UI yet).

## X/Twitter Watcher — Key Lessons

### Architecture

The X watcher reads from huginn's pre-indexed `x-feed` collection via the knowledge API. It does NOT call the X API — huginn's fetcher + indexer runs separately to keep the collection fresh. The watcher just queries the collection, ranks tweets by engagement score, and sends the top-N to an LLM for digest creation.

> **Legacy note:** The codebase still contains a `fetchFromPython()` path that shells out to `x_fetcher.py` directly. This path is no longer used in production — the collection path (`config.collection: "x-feed"`) is the only active path.

### Engagement ranking

Tweets are ranked by `engagement_score` before being sent to the LLM. The score is computed by huginn's fetcher using X's open-sourced signal weights (retweets 20x, replies 13.5x, bookmarks 10x, likes 1x), normalized by sqrt(views), with boosts for long-form notes, quotes, and media. The score is stored in each tweet's markdown footer as `**Engagement Score:**`.

The watcher extracts this score via `compactTweetText()`, sorts descending, and takes the top-N (default 30, configurable via `config.topN`). This means the LLM receives a pre-ranked, filtered set rather than all recent tweets.

### Prompt size is critical

Sonnet times out at 60s with large prompts. The collection path must send **compact one-liners** (`compactTweetText`), not full markdown documents. Full docs caused 180s timeouts even with increased limits. The compact format matches what the direct fetcher produces: `@handle: text (likes, views)\n  URL: url`.

### Collection path gotchas

1. **Date filtering required**: The collection has ALL indexed tweets (800+). Without filtering to today+yesterday by filename date prefix, the watcher sends ancient tweets to the model.
2. **Timezone matters**: Huginn indexes with local dates (Europe/Oslo). Use `Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" })` — NOT `toISOString()` which gives UTC and causes off-by-one near midnight.
3. **Document ID prefix**: Huginn prepends `[2026-03-21_handle_id]` to document text. Must strip before sending to model.
4. **Batch fetches**: Huginn is a Python server — don't fire 80 concurrent requests. Batch at 20.

### Dedup

- Tweet IDs tracked as `tw:{tweetId}` in `lastNotifiedIds` (shared rolling window, max 600)
- `trackingIds` on `WatcherAlert` — runner persists these alongside the alert ID
- The alert ID `x-digest-{timestamp}` is always unique (never deduped by ID), but individual tweet IDs in `trackingIds` prevent re-processing
- Collection path filters by `lastNotifiedIds` BEFORE fetching full docs (avoids wasted API calls)

### Config fields (stored in watcher JSONB config)

| Field | Default | Description |
|---|---|---|
| `collection` | `"x-feed"` | Collection name. Required for the active collection path. |
| `model` | Haiku | Model for summarization (e.g. "claude-sonnet-4-6") |
| `timeoutMs` | 300000 | Model call timeout (ms). Set 600000+ for Sonnet with large backlogs. |
| `maxDocs` | 80 | Max documents to fetch from collection per run |
| `topN` | 30 | Max tweets sent to LLM after engagement ranking |
| `prompt` | `DEFAULT_X_PROMPT` | Custom prompt (overrides default two-tier format) |
| `apiUrl` | `KNOWLEDGE_API_URL` env | Knowledge API URL |
| `windowDays` | 2 | Rolling day window (Europe/Oslo). 1 = today only, 7 = last week. |
| `dedupByTweetId` | `true` | Filter out tweets already in `lastNotifiedIds`. Set `false` on daily/weekly digests that re-rank the full window. |
| `minScore` | — | Pre-LLM gate on `rankScore` (combined_score fallback engagement_score). If set and top tweet is below, the watcher silently tracks the fetched IDs and skips the LLM call entirely — no message sent. |
| `quietMode` | `false` | Allows the LLM to reply with literal `SKIP` (any case, optional surrounding markdown/punctuation) to suppress the alert. The fetched IDs are still tracked so the same tweets aren't re-evaluated next run. |
| `captureCandidates` | `false` | Persist high-value **long-form** tweets into the `summary_candidates` inbox (Candidates → Summaries). Collection path only. Runs on the FULL fetched batch, BEFORE and independent of the `minScore`/`quietMode` silencing — a run that alerts nothing can still capture. See "Candidate capture" below. |
| `candidateMinScore` | 0.6 | Inbox capture floor — long-form tweets scored ≥ this by the capture gate are queued. Independent of the alert `minScore`. |

### Silent alerts and the quality-gate pattern

When `minScore` or `quietMode` suppresses a digest, `checkX` returns a single `WatcherAlert` with `silent: true` and populated `trackingIds`. The runner detects the flag (see runner.ts) and persists the IDs into `lastNotifiedIds` without sending, saving, or logging to `activityLog`. This keeps re-evaluation cost bounded — tweets that were considered and rejected won't be re-fetched next tick.

### Candidate capture → the Candidates → Summaries inbox (Claude Learning Center, Phase B — X → shelf)

With `captureCandidates: true` the X Highlights row feeds the SAME `summary_candidates` → `/summaries` → shelf pipeline the anthropic watcher uses, so high-value X content joins the reading shelf. The mechanics mirror the anthropic capture, with X-specific twists:

- **Placement is load-bearing.** `checkX` has two silencing paths that permanently track tweet IDs (the pre-LLM `minScore` early return and the post-LLM `quietMode` SKIP). The live X Highlights row runs `minScore/quietMode`, so most runs silence the whole batch and never re-consider those IDs. Capture therefore runs on the **full fetched batch** (all docs via `FetchResult.docs`, NOT the `topN`-sliced digest subset), **before and independent of** both silencing paths — a run that alerts nothing still captures.
- **Long-form pre-filter only** (`isLongFormTweet`): an extracted tweet *body* ≥ 800 chars (measured PRE-truncation, since x-feed docs carry ~350–450 chars of fixed scaffolding) OR the `**Type:** note` marker. A short plain tweet is its own summary — never captured. **Link-tweets are deliberately excluded** (the summarizer would only see the tweet's own text, not the linked article).
- **One extra Haiku gate** (`DEFAULT_X_CAPTURE_PROMPT`, the anthropic gate's `{n,score,why}` shape) over the long-form subset only. Candidates scored ≥ `candidateMinScore` (default 0.6) are upserted with `source: 'x'`, `title: "@handle: <first line>"`, `candidateSrc: "X (@handle)"`, and `sourceDocId` = the huginn `x-feed` doc id (the summarizer fetches `/api/document/x-feed/<id>` for content — tweet URLs aren't directly fetchable).
- **Capture-gate failure stance (decided):** on a capture Haiku error, log and proceed with the normal alert path — the run's long-form tweets are lost to the inbox this run (best-effort). We deliberately do NOT hold tweet IDs back from tracking: entangling alert dedup with capture health would re-surface already-alerted tweets. Best-effort throughout — a DB error never breaks the alert path. Dedup rides the table's `UNIQUE(source,url)` + the upstream `lastNotifiedIds` filter.

Summarizer + inbox are source-aware: `resolveContent` fetches the `x-feed` doc when `source_doc_id` is set (X system-prompt variant), the summary still lands on the shared `anthropic-summaries` shelf, and the inbox route (`GET /api/anthropic/candidates`) reads `source: ["anthropic","x"]` with a small source badge per row. `dashboard_url` stays `source=anthropic` for all rows (that param keys the shelf registry, not the candidate origin). Column added in migration `048` (`source_doc_id`, nullable), mirrored in `db/init.sql`.

### 3-watcher pattern (daytime alerts + daily + weekly)

Instead of one X watcher doing everything, run three rows with shared `collection: "x-feed"` but distinct configs. Each has its own `lastNotifiedIds` column so they don't step on each other's dedup.

| Name | Schedule | `windowDays` | `dedupByTweetId` | `minScore` | `quietMode` | Prompt |
|---|---|---|---|---|---|---|
| X Highlights | every 2h (08:00–22:00) | 1 | true | `0.85` (tune) | `true` | `DEFAULT_X_HIGHLIGHTS_PROMPT` — returns `SKIP` unless genuinely exceptional |
| X Daily Digest | interval 24h + `hour: 12, minute: 0` | 1 | false | — | false | `DEFAULT_X_PROMPT` (two-tier) |
| X Weekly Digest | interval 7d + `hour: 18, minute: 0` | 7 | false | — | false | Custom ("themes of the week" + top picks) |

Day-of-week is not a first-class scheduler concept — the weekly watcher's "day" is whichever day of the week it was first run; `isScheduledTimeDue` only gates on hour/minute within a day, and the 7-day interval then determines the next fire.

Existing X watchers keep their current behavior because all new fields are opt-in: `windowDays` defaults to 2 (today+yesterday), `dedupByTweetId` defaults to true, `minScore` and `quietMode` are unset.

### No fallback on model failure

If the model call fails (timeout, crash), the watcher returns `[]` — no Telegram message sent. This is intentional. The raw-text fallback was noisy and confusing. Failed tweets are NOT tracked, so they retry on the next run.

## Runner (runner.ts)

### Manual trigger via force_next_run

The dashboard "Run" button sets `force_next_run = true` in the DB. The next scheduler tick picks it up through the same `runWatchers` path (with tracing). Forced watchers skip `isScheduledTimeDue` and quiet hours. The flag is cleared by `updateWatcherLastRun()`.

### Time-of-day scheduling

Watchers with `config.hour`/`config.minute` only run once per day at/after that time. Uses cached `Intl.DateTimeFormat` (Europe/Oslo). The `isScheduledTimeDue` filter runs AFTER `getWatchersDueNow` (interval-based), so both conditions must be true.

**Warning**: If `config.hour` is set but interval < 24h, the time-of-day constraint wins (runs once daily). The dashboard shows a warning banner for this case.

### Scheduler context

`startScheduler()` stores `{ api, config, botConfig }` per bot in `schedulerContexts` Map. The dashboard's trigger endpoints use `getSchedulerContext(botName)` to get these for manual runs.

### Per-watcher safety-net timeout

Each watcher's `runChecker` call is wrapped in `withWatcherTimeout` so a hung checker (stuck MCP connection, wedged subprocess) can't block the scheduler tick or starve the watchers behind it. `computeWatcherTimeoutMs(watcher)` returns `max(120_000, config.timeoutMs + 30_000)` — a 2-min floor for watchers with no configured timeout, otherwise 30s of headroom ABOVE the checker's own `config.timeoutMs` so a legitimately slow Sonnet/X digest is never cut off prematurely (the net only fires when the inner model timeout is itself stuck). On timeout the existing per-watcher catch advances `last_run_at` (retry-storm prevention), and the orphaned checker promise is swallowed so it doesn't surface as an unhandledRejection.

Due watchers now run **concurrently**: `runWatchers` fans the due list out through `Promise.allSettled(dueWatchers.map(async (watcher) => …))`. This is safe because each watcher owns its own `requestId` (`agentStatus` is per-`requestId` since the Map rework, so parallel runs don't clobber each other's progress), its own `Tracer`, and its own per-watcher timeout + catch — one slow or failing watcher can't block or skip the others. `allSettled` (not `all`) because each iteration is self-contained error-wise; a rejection must never abort the batch.

Caveats of the parallel model:
- The **phase dial** (`agentStatus.set("running_watcher")` / `set("sending_telegram")`) is a coarse global indicator and races under parallelism — that's expected. The real per-watcher progress lives in the per-`requestId` waterfall. The dial is reset to `idle` **once** after the whole batch settles (not per-watcher), so an early finisher doesn't flip it to idle while siblings still run.
- Concurrency is **unbounded over the due set**, which is naturally small (watchers due in one tick after the interval + time-of-day filters — typically 1–5). DB writes serialize harmlessly on the pool; the parallelism win is in `runChecker` (Haiku/MCP/HTTP), which doesn't hold a DB connection. If a deployment ever has many watchers firing in the same tick (e.g. first tick after long downtime), add a small bounded-concurrency limiter here.

## Email Watcher (email.ts)

Spawns Haiku with the bot's Gmail MCP tools. The prompt has structural parts (Gmail search, JSON format) that are hardcoded, plus a configurable evaluation criteria section (`config.prompt`). Returns individual `WatcherAlert[]` per email with Gmail message IDs for dedup.

## Anthropic Watcher (anthropic.ts)

Two tiers over the Anthropic firehose, alert-only. The companion *indexing* half (Huginn `anthropic-knowledge`) already content-hash-diffs the same surfaces, so this watcher is Muninn-only.

- **Tier-1** polls the verified GitHub Atom feeds (`DEFAULT_ANTHROPIC_FEEDS`) via a small Atom parser (`parseRssItems` is RSS-2.0-only and returns 0 on Atom). Dedup by entry id (the GitHub URL) against `lastNotifiedIds`; the runner **skips content-hash dedup for `type='anthropic'`** (ids are stable canonical URLs).
- **Tier-2** (opt-in `config.tier2`) snapshot-and-diffs the feed-less surfaces — the `llms.txt` doc-URL set (~1753) + `anthropic.com/{news,engineering,research}` slug sets — against the `watcher_snapshots` table (one row per source). NOT `lastNotifiedIds` (600-capped, shared with Tier-1) and NOT `config` (the dashboard's `updateWatcher` overwrites the whole blob). URLs absent from the snapshot are candidates; each source's first run records the baseline silently.
- **Haiku gate** (opt-in `config.gate`): the new candidates (Tier-1 entries + Tier-2 additions) are scored 0–1 in **one** Haiku call (`DEFAULT_ANTHROPIC_GATE_PROMPT` — weights Claude Code, agents/tools/MCP, retrieval/evals, and new models highest). Only candidates ≥ `minScore` alert, each carrying a one-line "why it matters"; the rest are tracked silently (one `silent: true` alert), so they aren't re-scored next run. The gate is what makes the high-churn commit feeds safe to enable. `config.quietMode` lets the model reply with literal `SKIP` to suppress the whole batch. On a gate error the run returns `[]` and Tier-2 snapshots are **not** advanced, so the additions re-surface and retry.
- **Body excerpt fed to the gate ("alert depth", Learning Center §10).** The gate scores off **content, not just titles**: each candidate carries an optional truncated body slice (`excerpt`, hard-capped at `MAX_EXCERPT_CHARS` = 300) fed in on its own line by `formatCandidateList(cands, { withExcerpt: true })`. Per-source at the cheapest layer: **Tier-1** captures it *for free* from the Atom `<content>`/`<summary>` during `parseAtomEntries` (commit messages / release notes); **Tier-2 docs** are enriched by a small direct `.md` fetch in `enrichDocExcerpts` (the llms.txt URLs are clean-markdown `.md` per L7 — no Huginn id-resolution and no indexing-lag miss for a brand-new doc), bounded to `MAX_DOC_EXCERPT_FETCHES` (10) with a short per-fetch timeout; **Tier-2 blogs** stay title-only (HTML listings, no cheap clean body). Degrades gracefully — no body → title-only (today's behavior), and a doc-fetch error/over-cap is best-effort (logged, never breaks the run). **Gate path only** — the digest (`formatCandidateList` default, no `withExcerpt`) stays title-only so its up-to-DIGEST_MAX_TIER1-item prompt can’t balloon.

**Cold start** (empty `lastNotifiedIds`): the Tier-1 baseline is recorded as a single silent alert and every Tier-2 snapshot is baselined — run 1 fires nothing despite ~1753 docs. Steady-state runs filter candidates against `lastNotifiedIds` **before** the gate, so the gate only ever sees the delta since the last run.

### 3-row digest cadence (Phase 4)

Like the X watcher, the single Anthropic row is split into three rows that share the same sources (the GitHub feeds + Tier-2 surfaces) but differ in cadence and gate behavior. `scripts/setup-anthropic-watchers.ts` reconfigures the existing row → **Anthropic Highlights** and creates the two digest rows (idempotent — skips by name, never re-clobbers a hand-tuned Highlights config).

| Name | Schedule | mode | gate / `minScore` | `quietMode` | `model` | `lookbackDays` | Prompt |
|---|---|---|---|---|---|---|---|
| **Anthropic Highlights** | every 2h | per-item gate + capture | `gate:true`, `minScore 0.8`, `captureCandidates`, `candidateMinScore 0.5`, `autoPromoteScore 0.9` | — | Haiku | 7 | `DEFAULT_ANTHROPIC_GATE_PROMPT` (standard 0.5–1.0 scoring — so the inbox gets the middle band; alert still gates 0.8) |
| **Anthropic Daily Digest** | 24h + `hour:12` | `digest:true` | — | `true` (prompt invites `SKIP`) | Sonnet | 3 | `DEFAULT_ANTHROPIC_DAILY_PROMPT` |
| **Anthropic Weekly Digest** | 7d + `hour:18` | `digest:true` | — | `false` | Sonnet | 16 | `DEFAULT_ANTHROPIC_WEEKLY_PROMPT` |

- **Per-row snapshot windows.** `watcher_snapshots` is keyed by `(watcher_id, key)`, so each row keeps an **independent** Tier-2 baseline. A row's snapshot, advanced at the row's own cadence, *is* its window: Highlights→last-2h delta, Daily→today's additions, Weekly→the week's. (Cost: each row fetches `llms.txt` and holds its own ~1753-URL baseline when it runs — trivial; it's the mechanism, not waste. Rows rarely run in the same tick.)
- **Digest mode** (`config.digest`) rolls a window's candidates into ONE message via a single LLM call instead of per-item alerts. It **caps the Tier-1 portion at 240** (`DIGEST_MAX_TIER1` = 12 feeds × `MAX_PER_FEED` 20 — a safety rail) but **never truncates Tier-2 additions**: Tier-2 dedup is the snapshot, which `persistTier2` advances to the full set unconditionally, so an un-surfaced Tier-2 addition would be lost forever, whereas a dropped Tier-1 item re-surfaces next run via `lastNotifiedIds`. `trackingIds` = the digested set only. On an LLM error the digest returns `[]` without advancing snapshots (the window retries the next *scheduled* run — hence the widened `lookbackDays` as a retry cushion). `quietMode` lets an all-churn day reply `SKIP`.
- **Daytime window for Highlights** is the runner's quiet-hours, NOT `config.hour` — `isScheduledTimeDue` only supports a single once-per-day hour (incompatible with "every 2h"), so Highlights omits `hour` and night-suppression rides `isQuietHours` (same as X Highlights). Absent a configured quiet-hours window the row fires 24/7 every 2h (the `minScore 0.8` gate keeps that rare).
- **Gate-score calibration logging.** The gate path logs one `gate-score n=… score=… min=… surfaced=… …` line per candidate (greppable prefix `gate-score`; `score=omitted` = the model dropped it as churn). Mine the log history after a week of real output to set the final `minScore`.
- **Known structural limit:** Tier-1 is capped at `MAX_PER_FEED` (20) most-recent entries *per fetch* regardless of window, so the Weekly digest only ever sees each busy feed's last ~20 commits — older commits in the week are invisible. Acceptable because the digest is thematic ("themes + top picks"), not exhaustive.

### Config fields (JSONB)

| Field | Default | Description |
|---|---|---|
| `feeds` | `DEFAULT_ANTHROPIC_FEEDS` | Tier-1 Atom feed list (omit to track the code default) |
| `lookbackDays` | 7 | How far back to read each feed (a candidate-set bound, not the dedup key) |
| `tier2` | `false` | Enable the llms.txt + blog slug-set diff |
| `llmsTxtUrl` | `platform.claude.com/llms.txt` | Override the doc index URL |
| `blogSections` | news/engineering/research | anthropic.com listings to diff |
| `gate` | `false` | Score new candidates with Haiku (Highlights/per-item path) |
| `digest` | `false` | Roll the window's candidates into ONE digest message (Daily/Weekly path; mutually exclusive with `gate`) |
| `minScore` | 0.5 | Drop scored candidates below this 0–1 threshold (gate path) |
| `model` | Haiku (`DEFAULT_MODEL`) | Gate/digest model (digest rows use Sonnet) |
| `timeoutMs` | 90000 (code) | Model-call timeout. Set ≥150000 so it clears the runner's 120s watcher-timeout floor (the runner widens its net to `timeoutMs + 30s`). |
| `quietMode` | `false` | Allow literal `SKIP` to suppress the batch/digest |
| `hour` / `minute` | — | Time-of-day gate (Europe/Oslo) for digest rows, read by the runner's `isScheduledTimeDue` |
| `prompt` | gate/daily default | Override the gate or digest criteria |
| `captureCandidates` | `false` | Persist gated candidates into the `summary_candidates` inbox (Candidates → Summaries). Gate path only. Pair with the **standard** gate prompt (`DEFAULT_ANTHROPIC_GATE_PROMPT`) so the 0.5–0.8 middle is scored — the strict Highlights prompt only emits ≥0.8 and would leave the inbox to the alerted items. |
| `candidateMinScore` | 0.5 | Inbox capture floor — candidates scored ≥ this are queued, **independent of `minScore`** (so the relevant-but-not-urgent middle that stays silent on Telegram still lands in the inbox). |
| `candidateMinScoreByKind` | commit 0.7, release 0.8 | Per-kind capture-floor overrides keyed by URL shape (`commit` / `release` / `doc` / `blog`). Unset kinds use max(`candidateMinScore`, built-in kind default); an explicit value wins outright. Exists because Haiku scores keyword-rich GitHub churn 0.55–0.85, so one flat floor either drops good docs or keeps release stubs. Capture-only; alerts keep `minScore`. |
| `autoPromoteScore` | — (off) | Auto-summarize floor (Phase D). A captured candidate scored ≥ this is summarized **in-process** immediately — no manual click — onto the `anthropic-summaries` shelf. **Opt-in**: unset → nothing auto-promotes (the inbox just fills). Requires `captureCandidates`; deduped to rows still `new` (never re-summarizes one already summarizing/summarized). Start high (~0.9–0.95) — each one spends a real Claude call. The kick (`autoPromoteCandidate` in `src/anthropic/summarizer.ts`) resolves the summarizer bot + muninn config itself, since the watcher has neither in scope. |

State table: `watcher_snapshots(watcher_id, key, value JSONB, updated_at)` — keys `tier2:llms` and `tier2:blog:<section>`. Added in migration `046` and mirrored in `db/init.sql` (the `schema-drift.test.ts` guard requires both, identical). `seed`: `scripts/setup-anthropic-watchers.ts` reconfigures the base row → Highlights (`{tier2, gate, minScore:0.8, captureCandidates, candidateMinScore:0.5, autoPromoteScore:0.9}`, standard gate prompt) and creates the Daily/Weekly digest rows (`{tier2, digest, hour, minute, model:sonnet}`).

### Candidate capture → the Candidates → Summaries inbox (Claude Learning Center, Phase B)

The Highlights row's gate already scores + writes a "why" for every new item. With `captureCandidates: true` it also persists each candidate scored ≥ its **kind's capture floor** into **`summary_candidates`** (`src/db/summary-candidates.ts`) — a ranked, pre-annotated reading queue surfaced on `/summaries`. Two cuts on the one score: `minScore` (0.8) → Telegram alert, the capture floor → inbox.

**Shelf-capture policy (2026-07).** The inbox reuses the alert gate's score for a different question ("is a *summary of this page* worth reading?"), and Haiku scores keyword-rich GitHub churn 0.55–0.85 — so capture is source-aware, in `captureGatedCandidates` only: (1) **merge/rollup commits** (`isShelfWorthy`, title `^Merge (pull request|branch(es)|tag|…)` on a `/commit/` URL) are dropped deterministically, whatever their score — a summary of a merge diff is noise (skips log at info, since the adjacent `gate-score` line may say `surfaced=true` for the same item); (2) **per-kind floors** (`captureFloor` + `candidateKind` by URL shape): commits need ≥ 0.7, releases ≥ 0.8, docs/blog stay at `candidateMinScore`. Calibrated against real inbox rows: spec-repo churn scored 0.55–0.68 while every hand-summarized commit scored 0.7+; SDK `v0.x.y` release stubs clustered at 0.75–0.8, and the 0.8 release floor equals the seeded alert `minScore`, so **alerted ⇒ capturable** holds (a release that interrupts on Telegram always has an inbox row to summarize from). Tune per-kind via `candidateMinScoreByKind` after mining `gate-score` logs / `summary_candidates.status` — or read the **Calibration tab** on `/summaries` (display-only), which aggregates that same `summary_candidates` history into per-kind acceptance rates + a suggested `candidateMinScoreByKind` snippet (`candidateOutcomeStats` in `src/db/summary-candidates.ts`; it never writes watcher config — you hand-copy the floors). Acceptance excludes auto-`expired` and pre-051-`unknown` dismissals via the `dismissed_reason` column (migration `051`), counting only human `manual` rejections against summarized rows. Note the layering: the deterministic filter + floors are capture-only (alert logic keeps `minScore` unchanged), while the sharpened gate-prompt LOW list (merge commits, version-stub releases, follow-up corrections) intentionally shifts *scores* for both paths — the prompt is the probabilistic first line, the capture policy the deterministic backstop. Auto-promote inherits the policy for free — its dedup requires a captured row in status `new`, so a filtered candidate can never auto-summarize. So the relevant middle lands in the inbox instead of being dropped silently. Capture is best-effort (a DB error never breaks the alert path) and deduped by the table's `UNIQUE(source,url)` plus the upstream `lastNotifiedIds` filter (each item captured once; re-captures keep the max score, never resurrect a dismissed/summarized row). `status` walks new → summarizing → summarized | dismissed | error; `doc_id` links the resulting `anthropic-summaries` doc (Phase C/D). Table added in migration `047`, mirrored in `db/init.sql`.

**Hybrid curation (Phase D).** A *third* cut on the same score auto-promotes the clear headliners: with `autoPromoteScore` set (≥ ~0.9), every captured candidate at/above it is summarized **in-process right after capture** (`maybeAutoPromote` → `autoPromoteCandidate` → the shared `kickCandidateSummarize` the `/summarize` route also uses), landing on the shelf with no manual click. The mid-band (≥ `candidateMinScore`, < `autoPromoteScore`) waits in the `/summaries` inbox for a hand-pick. Auto-promote is opt-in, fire-and-forget (the slow Claude call never blocks the watcher run), and deduped to rows still `new`. The seed sets it to 0.9 on the Highlights row — but only on a fresh box, since the setup script skips reconfigure when the row already exists.

The stricter `DEFAULT_ANTHROPIC_HIGHLIGHTS_PROMPT` (≥0.8-only) remains exported as a config option for anyone who wants the original quiet-alerting calibration back — but it leaves the inbox to the alerted items only (no middle band), so it's not paired with `captureCandidates`.

## Wiki Gardener (wiki-gardener.ts + src/gardener/)

A weekly watcher that clusters recently-ingested summaries (the four
`SUMMARY_SOURCES` collections) and drafts knowledge-wiki page **proposals** into
the `wiki_proposals` table. **PR 1 is the proposal pipeline only** — no wiki
writes, no review UI (those land in PR 2). Proposals accumulate in Postgres
(inspectable via psql) and a Telegram alert (🌱) announces them.

Pipeline (`src/gardener/runner.ts` `runGardener`): harvest → cluster →
target-resolve → draft → shape-gate → persist → notify.

- **Harvest** (`harvest.ts`): list docs across the summary collections
  (`GET /api/collection/<c>/documents?include_dates=1`), filter to `date >= now −
  lookbackDays` (default 14) and drop the consumed set (`source_docs` of `applied`
  proposals), then fetch full bodies (batched 20). The listing gives only
  `{id,url,date}`; title/category/author are derived from the fetched body.
- **Cluster** (`cluster.ts`): one Haiku call (`callHaikuWithFallback`, `source:
  "wiki_gardener_cluster"`) with the interest profile injected augment-only.
  Output JSON clusters `{topicKey, kind, domain, label, docIds[], rationale}`.
  A pure skip/size/cap filter runs **before any draft call**: unknown docIds
  dropped, `docIds.length >= minClusterSize` (default 3), skip topicKeys with a
  prior `rejected` OR a live `draft`/`approved` proposal, cap at
  `maxProposalsPerRun` (default 3).
- **Target-resolve** (`target-resolve.ts`): the LOCAL wiki store
  (`getWikiIndex({root: wikiDir})`) is the oracle — `update` on a normalized
  title/alias near-match, else `create` (huginn scores are never consulted).
- **Draft** (`draft.ts`): one `executeOneShot` per cluster on the bot's connector
  (explicit `timeoutMs: 180000`, no extraDirs). Summaries are inlined as
  **untrusted** delimited data. The **shape-gate** rejects a draft unless the
  frontmatter parses with required keys, `type` matches the cluster kind, the body
  is non-empty, and `target_path` is **path-confined** (relative, `..`-free,
  inside `wikiDir` under `concepts/`/`entities/`/`life/**` matching the domain, or
  the update target's existing dir).
- **Persist + notify**: each proposal is persisted **as its drafting completes**
  (a mid-run timeout can't strand undrafted proposals). One alert with a
  **per-run-unique id** (`wiki-gardener:<proposal ids>`) — the runner's
  `lastNotifiedIds` dedup runs unconditionally, so a static id would drop every
  run after the first. `skipContentHash` is extended to cover `wiki-gardener`.

**Config** (per-bot `config.json` `gardener` block, validated at discovery):
`{ enabled?, minClusterSize?, lookbackDays?, maxProposalsPerRun? }`. Requires the
bot to have `wikiDir` set (a missing `wikiDir` warns and returns no alerts).

**Seed**: `bun scripts/setup-wiki-gardener.ts [--apply]` creates the jarvis
`wiki-gardener` row — weekly interval, `config.hour: 10` (daytime, clear of quiet
hours), `config.timeoutMs: 720000` (net headroom for 3 drafts + cluster + harvest;
a timed-out run advances last_run_at and loses the week).

Schema: `wiki_proposals` (migration `057`, mirrored in `db/init.sql`); the
`watchers.type` CHECK gains `'wiki-gardener'` (migration `056`).

## Configurable prompts

All watchers support `config.prompt`. Defaults are exported (`DEFAULT_X_PROMPT`, `DEFAULT_EMAIL_PROMPT`) and shown in the dashboard Details tab (labeled "(default)" when using built-in). The dashboard Edit tab pre-fills with the effective prompt.

## Configurable model

`spawnHaiku(prompt, opts)` accepts `opts.model`. Default is Haiku. Watchers pass `config.model` through. Set via dashboard Edit tab. Important: non-Haiku models (Sonnet) need higher `timeoutMs` — Haiku default is 60s.

## Testing

Watcher tests: `runner.test.ts` — tests dedup logic, contentHash, extractProperNouns. Checkers with mockable seams are unit-tested next to their source (`anthropic.test.ts` covers parsing, gate, digest, and the shelf-capture policy against mocked fetch/Haiku/DB; `x.test.ts` similarly). The email checker spawns Haiku with Gmail MCP and is only testable via manual trigger from the dashboard.
