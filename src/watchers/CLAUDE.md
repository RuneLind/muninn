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
| `x` | `x.ts` | Huginn collection or direct Python fetcher | Configurable, Sonnet recommended |

## X/Twitter Watcher — Key Lessons

### Two data paths (config.collection switches)

- **Collection path** (`config.collection: "x-feed"`): Queries huginn's indexed x-feed collection via knowledge API. Fast (<100ms), no X API calls. Requires huginn running with x-feed loaded.
- **Legacy path** (no collection): Shells out to huginn's Python fetcher (`uv run x_fetcher.py`). Hits X API directly, 60s timeout.

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
| `collection` | — | Collection name (e.g. "x-feed"). Omit for legacy Python fetcher. |
| `model` | Haiku | Model for summarization (e.g. "claude-sonnet-4-6") |
| `timeoutMs` | 60000 | Model call timeout. Set 180000+ for Sonnet. |
| `maxDocs` | 80 | Max documents per digest run |
| `prompt` | `DEFAULT_X_PROMPT` | Custom prompt (overrides default two-tier format) |
| `pages` | 3 | Pages for legacy fetcher (ignored in collection mode) |
| `apiUrl` | `KNOWLEDGE_API_URL` env | Knowledge API URL |

### No fallback on model failure

If the model call fails (timeout, crash), the watcher returns `[]` — no Telegram message sent. This is intentional. The raw-text fallback was noisy and confusing. Failed tweets are NOT tracked, so they retry on the next run.

## Runner (runner.ts)

### runWatchers vs runSingleWatcher

Both share the same dedup → send → save → track flow. `runSingleWatcher` skips quiet hours, time-of-day checks, and tracing — runs immediately from the dashboard "▶ Run" button.

### Time-of-day scheduling

Watchers with `config.hour`/`config.minute` only run once per day at/after that time. Uses cached `Intl.DateTimeFormat` (Europe/Oslo). The `isScheduledTimeDue` filter runs AFTER `getWatchersDueNow` (interval-based), so both conditions must be true.

**Warning**: If `config.hour` is set but interval < 24h, the time-of-day constraint wins (runs once daily). The dashboard shows a warning banner for this case.

### Scheduler context

`startScheduler()` stores `{ api, config, botConfig }` per bot in `schedulerContexts` Map. The dashboard's trigger endpoints use `getSchedulerContext(botName)` to get these for manual runs.

## Email Watcher (email.ts)

Spawns Haiku with the bot's Gmail MCP tools. The prompt has structural parts (Gmail search, JSON format) that are hardcoded, plus a configurable evaluation criteria section (`config.prompt`). Returns individual `WatcherAlert[]` per email with Gmail message IDs for dedup.

## Configurable prompts

All watchers support `config.prompt`. Defaults are exported (`DEFAULT_X_PROMPT`, `DEFAULT_EMAIL_PROMPT`) and shown in the dashboard Details tab (labeled "(default)" when using built-in). The dashboard Edit tab pre-fills with the effective prompt.

## Configurable model

`spawnHaiku(prompt, opts)` accepts `opts.model`. Default is Haiku. Watchers pass `config.model` through. Set via dashboard Edit tab. Important: non-Haiku models (Sonnet) need higher `timeoutMs` — Haiku default is 60s.

## Testing

Watcher tests: `runner.test.ts` — tests dedup logic, contentHash, extractProperNouns. The watcher checkers themselves are not unit-tested (they call external services). Test via manual trigger from dashboard.
