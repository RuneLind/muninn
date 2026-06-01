# Watchers Module

Background monitors that check external services at intervals and send alerts via Telegram.

## Architecture

```
Scheduler tick (every 60s)
  → getWatchersDueNow() — interval-based from DB
  → isScheduledTimeDue() — time-of-day filter (hour/minute in config)
  → runChecker() — dispatches to type-specific checker
  → dedup (lastNotifiedIds rolling window, max 400)
  → formatAlerts → sendMessage → saveMessage → updateWatcherLastRun
```

## Watcher Types

| Type | File | Data Source | Model |
|---|---|---|---|
| `email` | `email.ts` | Haiku with Gmail MCP tools | Configurable via `config.model` |
| `news` | `news.ts` | Google News RSS (no AI) | — |
| `x` | `x.ts` | Huginn x-feed collection (knowledge API) | Configurable, Sonnet recommended |

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

- Tweet IDs tracked as `tw:{tweetId}` in `lastNotifiedIds` (shared rolling window, max 400)
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

### Silent alerts and the quality-gate pattern

When `minScore` or `quietMode` suppresses a digest, `checkX` returns a single `WatcherAlert` with `silent: true` and populated `trackingIds`. The runner detects the flag (see runner.ts) and persists the IDs into `lastNotifiedIds` without sending, saving, or logging to `activityLog`. This keeps re-evaluation cost bounded — tweets that were considered and rejected won't be re-fetched next tick.

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

## Configurable prompts

All watchers support `config.prompt`. Defaults are exported (`DEFAULT_X_PROMPT`, `DEFAULT_EMAIL_PROMPT`) and shown in the dashboard Details tab (labeled "(default)" when using built-in). The dashboard Edit tab pre-fills with the effective prompt.

## Configurable model

`spawnHaiku(prompt, opts)` accepts `opts.model`. Default is Haiku. Watchers pass `config.model` through. Set via dashboard Edit tab. Important: non-Haiku models (Sonnet) need higher `timeoutMs` — Haiku default is 60s.

## Testing

Watcher tests: `runner.test.ts` — tests dedup logic, contentHash, extractProperNouns. The watcher checkers themselves are not unit-tested (they call external services). Test via manual trigger from dashboard.
