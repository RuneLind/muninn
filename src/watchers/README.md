# X/Twitter Watcher — Collection-based Architecture

## How it works

The X watcher produces a daily digest of your Twitter/X timeline and sends it via Telegram. It reads from huginn's pre-indexed `x-feed` collection — it does NOT call the X API directly. Huginn's fetcher + indexer runs separately (on a schedule) to keep the collection fresh.

```mermaid
flowchart TD
    subgraph Scheduler["Scheduler (every 60s)"]
        TICK[Scheduler tick] --> DUE[getWatchersDueNow from DB]
        DUE --> TIME{isScheduledTimeDue?<br/>config.hour/minute}
        TIME -->|too early / already ran today| SKIP[Skip]
        TIME -->|due| QUIET{Quiet hours?}
        QUIET -->|yes| MARKONLY[Update lastRunAt, skip send]
        QUIET -->|no| RUN
    end

    subgraph Manual["Dashboard Manual Trigger"]
        BUTTON["Run button"] --> RUNMAN[runSingleWatcher]
        RUNMAN --> RUN
    end

    RUN[runChecker watcher.type = x]

    RUN --> LIST["GET /api/collection/x-feed/documents<br/>(huginn knowledge API)"]
    LIST --> DATEFILTER["Filter: today + yesterday only<br/>(Europe/Oslo timezone)"]
    DATEFILTER --> DEDUP1["Filter out known tw:ID<br/>from lastNotifiedIds"]
    DEDUP1 --> FETCH["Fetch full docs in batches of 20<br/>GET /api/document/x-feed/{id}"]
    FETCH --> COMPACT["compactTweetText()<br/>Full markdown → one-liner<br/>+ extract engagement_score"]
    COMPACT --> RANK["Sort by engagement_score desc<br/>Take top-N (default 30)"]

    RANK --> PROMPT

    subgraph Summarize["AI Summarization"]
        PROMPT["Build prompt with ranked tweets<br/>+ DEFAULT_X_PROMPT"] --> MODEL["spawnHaiku()<br/>(model from config, e.g. Sonnet)"]
        MODEL -->|success| ALERT["Return WatcherAlert<br/>with trackingIds"]
        MODEL -->|failure| DROP["Return empty — skip digest<br/>tweets retry next run"]
    end

    subgraph Deliver["Runner Delivery"]
        ALERT --> RUNDEDUP["Dedup alerts by ID + contentHash"]
        RUNDEDUP --> SEND["formatAlerts → Telegram HTML"]
        SEND --> SAVE["saveMessage to DB<br/>(active thread)"]
        SAVE --> TRACK["Append tw:IDs + hashes<br/>to lastNotifiedIds<br/>(rolling window, max 600)"]
    end
```

## How it gets tweets from huginn

The huginn knowledge system has an `x-feed` collection that is **indexed and updated hourly** by a separate process (huginn's x fetcher + indexer). The X watcher doesn't call the X API at all — it reads from this pre-built index.

```mermaid
sequenceDiagram
    participant W as X Watcher
    participant H as Huginn API<br/>(localhost:8321)
    participant AI as Claude (Sonnet)
    participant TG as Telegram

    W->>H: GET /api/collection/x-feed/documents
    H-->>W: [{id: "2026-03-22_karpathy_123.md", url: "..."}, ...]

    Note over W: Filter by date (today + yesterday)<br/>Filter out known tweet IDs

    loop Batch of 20
        W->>H: GET /api/document/x-feed/{docId}
        H-->>W: {text: "# @handle — Author\n\nTweet...", metadata: {url}}
    end

    Note over W: compactTweetText() each doc<br/>Extract engagement_score from footer

    Note over W: Sort by engagement_score desc<br/>Take top-N (default 30)

    W->>AI: Prompt with pre-ranked tweets + digest instructions
    AI-->>W: Formatted digest (Top Picks + Also Notable)

    W->>TG: Send digest as HTML message
    Note over W: Track all tw:IDs in lastNotifiedIds
```

### Why compact text matters

Huginn stores tweets as full markdown documents (~500 bytes each). Sending 80 full documents to Sonnet caused **180s+ timeouts**. The `compactTweetText()` function strips each document down to a single line:

```
Before: "# @karpathy — Andrej Karpathy\n\nLong tweet...\n\n---\n\n- **Engagement:** 1,508 likes..."
After:  "@karpathy: Long tweet (1,508 likes, 524k views)\n  URL: https://x.com/..."
```

### Date filtering

The collection contains **all** indexed tweets (800+). Without filtering, the watcher would re-process ancient tweets. Filtering uses `Europe/Oslo` timezone to match huginn's date convention in filenames:

```
Document ID format: 2026-03-22_handle_tweetid.md
                    ^^^^^^^^^^
                    Date prefix used for filtering
```

## Scheduled run vs manual run

Both go through the **same `runWatchers` code path** — same tracing, same dedup, same delivery.

The dashboard "Run" button sets `force_next_run = true` in the DB. On the next scheduler tick (up to 60s), the watcher is picked up and run with these differences:

| Aspect | Scheduled | Manual (`force_next_run`) |
|---|---|---|
| **How it's triggered** | Interval elapsed (`interval_ms`) | `force_next_run = true` in DB |
| **Time-of-day check** | Yes — `isScheduledTimeDue()` | Skipped |
| **Quiet hours** | Yes — skips send | Skipped — always sends |
| **Tracing** | Yes | Yes (with `manualTrigger: true` attribute) |
| **Everything else** | Same | Same |

After the run completes, `updateWatcherLastRun()` clears `force_next_run = false`.

## Dedup strategy

```mermaid
flowchart LR
    subgraph "lastNotifiedIds (max 600, rolling window)"
        A["tw:12345<br/>tw:12346<br/>tw:12347<br/>..."]
        B["h:8a7f3c<br/>(content hashes)"]
        C["x-digest-1711100000<br/>(alert IDs)"]
    end

    NEW[New tweet] --> CHECK{tw:ID in<br/>lastNotifiedIds?}
    CHECK -->|yes| SKIP[Skip — already processed]
    CHECK -->|no| INCLUDE[Include in digest]
    INCLUDE --> AFTERDIGEST[After digest sent]
    AFTERDIGEST --> APPEND["Append tw:ID + alert ID<br/>+ content hash"]
```

- **Pre-fetch dedup** (collection path): tweet IDs are checked _before_ fetching full documents from huginn, avoiding wasted API calls
- **Post-digest dedup** (runner): alert ID + content hash + tracking IDs are appended to the rolling window
- **Alert ID** (`x-digest-{timestamp}`) is always unique — never actually deduped by ID itself
- **trackingIds** (`tw:{tweetId}`) are the real dedup keys — they survive across runs

## Config reference

Set via the dashboard Edit tab on the watcher, stored in the watcher's JSONB `config` column:

| Field | Default | Description |
|---|---|---|
| `collection` | `"x-feed"` | Collection name. Required — the watcher reads from huginn's indexed collection. |
| `model` | `claude-haiku-4-5` | Model for summarization. Use `"claude-sonnet-4-6"` for better quality. |
| `timeoutMs` | `300000` | Model call timeout in ms. Set `600000`+ for Sonnet with large backlogs. |
| `maxDocs` | `80` | Max documents to fetch from collection per run. |
| `topN` | `30` | Max tweets sent to LLM after engagement ranking. |
| `prompt` | `DEFAULT_X_PROMPT` | Custom digest prompt (overrides the built-in two-tier format). |
| `hour` | _(unset)_ | Hour (0-23, Europe/Oslo) to run. Makes it a daily digest. |
| `minute` | `0` | Minute within the hour to run. |
| `apiUrl` | `KNOWLEDGE_API_URL` env | Huginn knowledge API URL. |

## File map

| File | Purpose |
|---|---|
| `x.ts` | X watcher — both data paths, `compactTweetText`, prompt building, AI call |
| `runner.ts` | Generic watcher runner — scheduling, dedup, delivery, `runSingleWatcher` |
| `email.ts` | Email watcher (separate type, same runner) |
| `news.ts` | News watcher (separate type, same runner) |
| `quiet-hours.ts` | Per-user quiet hours check |
| `CLAUDE.md` | Lessons learned and architecture notes for AI assistants |
