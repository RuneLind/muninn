# Slack Integration — Architecture & Rules

> See also: skills `slack-bolt-patterns` for deeper reference.

## File Overview

| File | Role |
|---|---|
| `index.ts` | Bolt app setup, all event handlers, thread tracking, `makePostToChannel`, context fetching |
| `handler.ts` | Central message pipeline: auth → prompt → Claude → extract posts → format → send |
| `slack-format.ts` | Converts Claude markdown to Slack mrkdwn (different syntax!) |

## Four Handler Paths

Every Slack message enters through one of four paths in `index.ts`. All four call the same `handleMessage()` from `handler.ts`, but with different parameters:

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
- Side effects: tracks thread, fetches recent channel/thread messages for context

### 3. Thread follow-up (`app.message` with tracked thread)
- Platform: `slack_channel`
- Triggered by: reply in a thread where bot previously responded
- No @mention needed — thread is tracked in `activeThreads` map
- Fetches thread messages via `conversations.replies` for context
- `postToChannel`: `makePostToChannel(client, tag)` — `client` from event context

### 4. DM via `app.message` (channel starts with "D")
- Platform: `slack_dm`
- Triggered by: direct message NOT through Assistant sidebar
- Shows "_Tenker..._" message, then replaces with response via `chat.update()`
- `postToChannel`: `makePostToChannel(client, tag)` — `client` from event context

## Channel Context at @mention

When the bot is @mentioned, it fetches recent messages for context before responding:
- If in a thread (`event.thread_ts` exists): uses `conversations.replies` to get thread messages
- If top-level: uses `conversations.history` to get recent channel messages (last 15)
- Context is passed as `recentChannelMessages` to `handleMessage()` and appended to the system prompt

**The bot does NOT passively listen to channels.** It only responds when explicitly @mentioned or in tracked threads.

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

**All four handlers pass `postToChannel`.** If any handler is missing it, Claude's `<slack-post>` directives get treated as regular text, stripped by `formatSlackMrkdwn`, and the content ends up in the DM instead of the target channel.

## Text Normalization

Before processing, handler.ts converts Slack's internal channel references:
- `<#C0ADMP9CYG7|heidrun-agent-testing>` → `#heidrun-agent-testing`
- `<#C0ADMP9CYG7>` → `#C0ADMP9CYG7` (no name available)

This matters because Claude sees `#channel-name` in the user's message and uses it in `<slack-post channel="#channel-name">`.

## Thread Tracking

In-memory `activeThreads` map with 24-hour TTL:
- Key: `"channel:threadTs"`
- Value: last activity timestamp
- Max 500 entries, auto-prunes expired
- **Lost on restart** (not persisted to DB)

## Thinking Indicators

| Path | Method | Behavior |
|---|---|---|
| Assistant DM | `setStatus("Thinking...")` | Native Slack thinking bubble |
| @mention | `assistant.threads.setStatus()` | Native Slack thinking bubble in thread |
| Thread follow-up | `assistant.threads.setStatus()` | Same as @mention |
| DM (app.message) | `chat.postMessage("_Tenker..._")` → `chat.update()` | Fake thinking message, replaced |

`assistant.threads.setStatus()` requires the Slack app to have "Agent or Assistant" enabled. Always wrap in try-catch.

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
6. **Incomplete `<slack-post>` tags**: Claude may get cut off — second-pass regex handles this
