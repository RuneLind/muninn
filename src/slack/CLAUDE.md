# Slack Integration — Architecture & Rules

> See also: skills `slack-bolt-patterns` and `slack-channel-listening` for deeper reference.

## File Overview

| File | Role |
|---|---|
| `index.ts` | Bolt app setup, all event handlers, thread tracking, `makePostToChannel` |
| `handler.ts` | Central message pipeline: auth → prompt → Claude → extract posts → format → send |
| `slack-format.ts` | Converts Claude markdown to Slack mrkdwn (different syntax!) |
| `relevance-filter.ts` | 3-stage gate for passive channel listening (heuristics → rate limit → Haiku) |

## Five Handler Paths

Every Slack message enters through one of five paths in `index.ts`. All five call the same `handleMessage()` from `handler.ts`, but with different parameters:

### 1. Assistant DM (`assistant.userMessage`)
- Platform: `slack_assistant`
- Triggered by: Slack's built-in Assistant sidebar DM
- `say()`: Bolt's Assistant `say` (posts in assistant thread)
- `setStatus()`: Bolt's Assistant `setStatus` (native thinking indicator)
- `postToChannel`: `makePostToChannel(app.client, tag)` — uses `app.client` (NOT destructured `client`)

### 2. @mention in channel (`app_mention`)
- Platform: `slack_channel`
- Triggered by: `@Heidrun` in a channel message
- `say()`: `client.chat.postMessage()` in thread
- `setStatus()`: `client.assistant.threads.setStatus()` (thinking bubble)
- `postToChannel`: `makePostToChannel(client, tag)` — `client` from event context
- Side effects: activates channel for passive listening, tracks thread

### 3. Thread follow-up (`app.message` with tracked thread)
- Platform: inherited from thread origin (`slack_channel` or `slack_channel_listen`)
- Triggered by: reply in a thread where bot previously responded
- No @mention needed — thread is tracked in `activeThreads` map
- `postToChannel`: `makePostToChannel(client, tag)` — `client` from event context

### 4. DM via `app.message` (channel starts with "D")
- Platform: `slack_dm`
- Triggered by: direct message NOT through Assistant sidebar
- Shows "_Tenker..._" message, then replaces with response via `chat.update()`
- `postToChannel`: `makePostToChannel(client, tag)` — `client` from event context

### 5. Passive channel listen (`app.message` in active channel)
- Platform: `slack_channel_listen`
- Triggered by: message in a channel activated by prior @mention
- Goes through `RelevanceFilter.checkRelevance()` (3-stage gate)
- Auth bypassed (anyone in channel can trigger)
- Claude gets `CHANNEL_LISTEN_CONTEXT` appended (be concise, don't be intrusive)
- `postToChannel`: `makePostToChannel(client, tag)` — `client` from event context

## Critical: `client` Scoping

The `client` (WebClient) is available differently depending on handler:

| Handler | `client` source |
|---|---|
| `assistant.userMessage` | **`app.client`** (closure) — NOT destructured from callback |
| `app_mention` | Destructured from event context: `({ event, client })` |
| `app.message` | Destructured from event context: `({ message, say, client })` |

**The Assistant handler does NOT provide `client` in its callback context.** Always use `app.client` there. This was the root cause of postToChannel failing in Assistant DMs.

## postToChannel Flow

When `postToChannel` is provided to `handleMessage()`:

1. Handler appends `SLACK_POST_CAPABILITY` to system prompt (tells Claude the XML syntax)
2. Claude responds with `<slack-post channel="#name">content</slack-post>` tags
3. `extractChannelPosts()` parses both complete and incomplete tags (two-pass regex)
4. Each post is sent via `postToChannel(channel, formatSlackMrkdwn(message))`
5. `makePostToChannel` resolves `#name` → channel ID via `resolveChannelId()` (cached)
6. Failed posts are appended as error messages to the DM response
7. The `<slack-post>` tags are stripped from the DM response text

**All five handlers pass `postToChannel`.** If any handler is missing it, Claude's `<slack-post>` directives get treated as regular text, stripped by `formatSlackMrkdwn`, and the content ends up in the DM instead of the target channel.

## Text Normalization

Before processing, handler.ts converts Slack's internal channel references:
- `<#C0ADMP9CYG7|heidrun-agent-testing>` → `#heidrun-agent-testing`
- `<#C0ADMP9CYG7>` → `#C0ADMP9CYG7` (no name available)

This matters because Claude sees `#channel-name` in the user's message and uses it in `<slack-post channel="#channel-name">`.

## Thread Tracking

In-memory `activeThreads` map with 24-hour TTL:
- Key: `"channel:threadTs"`
- Value: `{ ts: lastActivity, origin: "mention" | "channel_listen" }`
- Max 500 entries, auto-prunes expired
- **Lost on restart** (not persisted to DB)
- Origin determines: platform inheritance + auth bypass for follow-ups

## Thinking Indicators

| Path | Method | Behavior |
|---|---|---|
| Assistant DM | `setStatus("Thinking...")` | Native Slack thinking bubble |
| @mention | `assistant.threads.setStatus()` | Native Slack thinking bubble in thread |
| Thread follow-up | `assistant.threads.setStatus()` | Same as @mention |
| DM (app.message) | `chat.postMessage("_Tenker..._")` → `chat.update()` | Fake thinking message, replaced |
| Channel listen | `assistant.threads.setStatus()` | Native thinking bubble |

`assistant.threads.setStatus()` requires the Slack app to have "Agent or Assistant" enabled. Always wrap in try-catch.

## Channel Listening Pipeline

```
Message in active channel
  → Heuristic filters (length, URL-only, emoji-only)
  → Rate limiting (per-channel cooldown + global hourly cap)
  → Haiku relevance classification (with conversation context)
  → handleMessage() with platform="slack_channel_listen"
```

Channels are activated when bot is @mentioned (7-day activation TTL).

Config in `bots/<name>/config.json` under `channelListening`:
- `cooldownMs`: min time between responses per channel (default 120s)
- `maxResponsesPerHour`: global cap (default 10)
- `relevanceThreshold`: "low" | "medium" | "high" (default "medium")
- `contextMessages`: recent messages to fetch for context (default 10)
- `topicHints`: domain keywords for Haiku classification

## Formatting: Markdown → mrkdwn

Claude outputs markdown. Slack uses mrkdwn (different!):
- `**bold**` → `*bold*`
- `## heading` → `*heading*` (bold line)
- `~~strike~~` → `~strike~`
- `[text](url)` → `<url|text>`
- Code blocks and inline code preserved as-is

## Common Pitfalls

1. **Missing `postToChannel`**: If a handler doesn't pass it, channel posting silently fails
2. **Wrong `client` reference**: Assistant handler must use `app.client`, not destructured `client`
3. **`assistant.threads.setStatus` errors**: Requires "Agent or Assistant" app setting — always try-catch
4. **Channel ID resolution**: `resolveChannelId` paginates through all channels — cached after first lookup
5. **Thread tracking lost on restart**: `activeThreads` is in-memory only
6. **Auth bypass**: `slack_channel_listen` platform skips auth — intentional for passive listening
7. **Incomplete `<slack-post>` tags**: Claude may get cut off — second-pass regex handles this
