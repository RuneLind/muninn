# X Watcher: Migrate from direct fetcher to x-feed collection

## Current state

The X watcher (`src/watchers/x.ts`) shells out to huginn's Python fetcher on every run:

```
checkX() → Bun.spawn("uv run x_fetcher.py --pages N") → parse JSON stdout → filter by lastNotifiedIds → summarize with Sonnet → return digest
```

Problems:
- Every watcher run hits the X API (rate limit risk, 60s timeout)
- No persistence — tweets are fetched, summarized, then discarded
- Can't search past tweets ("what did @karpathy say about agents last week?")
- Duplicate fetching if multiple features need timeline data

## Target state

The x-feed collection in huginn is already indexed and updated hourly. The watcher should query this collection instead of fetching directly.

```
checkX() → GET /api/collection/x-feed/documents → filter new by lastNotifiedIds
         → GET /api/document/x-feed/{id} for each new → pass markdown to Sonnet → return digest
```

Benefits:
- No X API calls during watcher runs (collection is updated separately)
- Watcher is fast (HTTP to local huginn API, <100ms)
- Jarvis can also answer ad-hoc questions about the timeline
- Tweets persist and are searchable historically

## Implementation plan

### Step 1: Fetch document list from collection

```typescript
const API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";

// Get all document IDs from x-feed collection
const resp = await fetch(`${API_URL}/api/collection/x-feed/documents`);
const { documents } = await resp.json();
// documents = [{ id: "2026-03-21_handle_tweetid.md", url: "https://x.com/..." }, ...]
```

### Step 2: Filter to new tweets using lastNotifiedIds

Extract tweet ID from the document ID (format: `{date}_{handle}_{tweetid}.md`):

```typescript
function extractTweetId(docId: string): string {
  const match = docId.match(/_(\d+)\.md$/);
  return match ? match[1] : docId;
}

const known = new Set(watcher.lastNotifiedIds);
const newDocs = documents.filter(d => !known.has(`tw:${extractTweetId(d.id)}`));
```

### Step 3: Fetch full content for new tweets

```typescript
const tweetTexts = await Promise.all(
  newDocs.slice(0, 60).map(async (doc) => {
    const resp = await fetch(`${API_URL}/api/document/x-feed/${encodeURIComponent(doc.id)}`);
    const data = await resp.json();
    return data.text; // Full markdown with heading, body, engagement, link
  })
);
```

The markdown already contains everything Sonnet needs:
- `# @handle — Author`
- Tweet text
- Quoted tweets
- Engagement stats
- Tweet type
- Link

### Step 4: Send markdown directly to Sonnet

No need to rebuild tweet summaries — the markdown IS the summary:

```typescript
const prompt = `You are curating a user's X/Twitter timeline into a digest.

Here are ${tweetTexts.length} tweets:

${tweetTexts.join("\n\n---\n\n")}

${userPrompt}`;
```

### Step 5: Track tweet IDs

```typescript
const trackingIds = newDocs.map(d => `tw:${extractTweetId(d.id)}`);
```

Backward compatible with existing `tw:` prefix dedup.

## What changes

| File | Change |
|---|---|
| `src/watchers/x.ts` | Replace `Bun.spawn` fetcher with knowledge API calls |
| `src/watchers/x.ts` | Remove `HUGINN_PATH`, `FETCHER_SCRIPT`, `FETCHER_TIMEOUT_MS`, `XTweet` interface |
| `src/watchers/x.ts` | Simpler tweet summary (raw markdown, no JSON parsing) |

## What does NOT change

- `DEFAULT_X_PROMPT` — same digest prompt works (might need minor tweak for markdown input)
- `spawnHaiku()` with `config.model` — same summarization call
- `WatcherAlert` return format — same structure
- `lastNotifiedIds` / `trackingIds` dedup — same pattern, same `tw:` prefix
- Watcher interval / scheduling — same
- Dashboard detail view — same

## Config

Add to watcher config (via dashboard Edit tab):
```json
{
  "model": "claude-sonnet-4-6",
  "collection": "x-feed",
  "apiUrl": "http://localhost:8321"
}
```

`collection` and `apiUrl` default to `"x-feed"` and `"http://localhost:8321"` if not set.

## Transition: keep both paths

During migration, use a config flag:

```typescript
const config = watcher.config as XWatcherConfig;
const tweets = config.collection
  ? await fetchFromCollection(config)
  : await fetchFromPython(config);
```

This lets you compare digest quality before cutting over. Once stable, remove the Python path.

## Prerequisite

The huginn knowledge API server must be running with x-feed loaded, and the hourly update must be active. Both are already running.

## Build order

1. Add `fetchFromCollection()` function alongside existing `fetchFromPython()` logic
2. Wire up config flag: `collection` in config triggers new path
3. Test: set `collection: "x-feed"` on the watcher, trigger manually from dashboard
4. Compare digest quality with old path
5. Once satisfied, make collection the default and remove Python spawn code
