---
name: slack-bolt-patterns
description: >
  Patterns and pitfalls for building Slack bots with @slack/bolt in Socket Mode.
  Covers the Assistant API, thinking indicators, event deduplication, thread management,
  and message formatting. Use when:
  (1) Building or modifying Slack bot handlers (app_mention, app.message, Assistant),
  (2) Implementing thinking/typing indicators in channels or threads,
  (3) Debugging duplicate messages or missing responses in Slack,
  (4) Working with assistant.threads.setStatus in channel threads,
  (5) Managing thread tracking and follow-up messages,
  (6) Formatting messages for Slack (mrkdwn vs HTML),
  (7) Posting, updating, or deleting bot messages.
  Triggers: "slack", "bolt", "app_mention", "setStatus", "thinking indicator",
  "slack thread", "slack channel", "slack bot", "slack assistant", "slack formatting".
---

# Slack Bolt Patterns

## Thinking Indicators

### Use `assistant.threads.setStatus` — Not Messages or Emoji

```ts
await client.assistant.threads.setStatus({
  channel_id: channel,
  thread_ts: threadTs,
  status: "tenker...",
});
```

- Works in **both** Assistant DM threads AND channel threads
- Requires **"Agent or Assistant"** enabled in Slack app settings
- Auto-clears when the bot posts a reply
- Clear manually: `status: ""`
- Supports `loading_messages: string[]` for rotating status text
- No notifications — native professional UX

### Why Not Other Approaches

| Approach | Problem |
|---|---|
| `chat.postMessage` "_Tenker..._" | Triggers push notification — useless alert |
| `chat.postMessage` + `chat.update` | Same notification issue + complex lifecycle |
| Emoji reaction | No notification but looks unprofessional |
| Ephemeral message | Cannot be updated or deleted via API |

### Channel Threads vs Assistant DMs

The Assistant handler provides `setStatus` as a utility. For channels, call the API directly:

```ts
// Assistant DM — setStatus provided by Bolt
userMessage: async ({ setStatus, say }) => {
  await setStatus("thinking...");
  await say(response); // auto-clears status
}

// Channel thread — call API directly, wrap in try-catch
app.event("app_mention", async ({ event, client }) => {
  const threadTs = event.thread_ts ?? event.ts;
  try {
    await client.assistant.threads.setStatus({
      channel_id: event.channel,
      thread_ts: threadTs,
      status: "tenker...",
    });
  } catch { /* not available if Agent/Assistant not enabled */ }
  // ... process, then post reply (auto-clears status)
});
```

## Event Handling

### Duplicate Event Problem (CRITICAL)

When a user @mentions the bot, Slack fires **both** if subscribed to both:
- `app_mention` — the @mention event
- `message.channels` — the regular message event

Both handlers process the same message → **duplicate responses**.

### Fix: Skip @mentions in `app.message()`

```ts
const authResult = await app.client.auth.test();
const botUserId = authResult.user_id;

app.message(async ({ message }) => {
  const text = "text" in message ? (message.text ?? "") : "";
  if (text.includes(`<@${botUserId}>`)) return; // handled by app_mention
  // ...
});
```

Or only subscribe to `message.im` (not `message.channels`).

### Event Flow

| User action | Event | Handler |
|---|---|---|
| DM to bot | `message.im` | `app.message()` or Assistant |
| @mention in channel | `app_mention` | `app.event("app_mention")` |
| Reply in tracked thread | `message.channels` | `app.message()` |
| Open assistant thread | `assistant_thread_started` | Assistant `threadStarted` |

## Thread Management

### Always Reply in Threads in Channels

Never post top-level messages as responses in channels.

```ts
const threadTs = event.thread_ts ?? event.ts;
await client.chat.postMessage({
  channel: event.channel,
  thread_ts: threadTs,
  text: response,
});
```

### Thread Tracking for Follow-ups Without @mention

Track threads so follow-up messages don't need re-tagging:

```ts
const activeThreads = new Map<string, number>();
const TTL = 24 * 60 * 60 * 1000;

function trackThread(channel: string, threadTs: string) {
  activeThreads.set(`${channel}:${threadTs}`, Date.now());
}

function isTracked(channel: string, threadTs: string): boolean {
  const ts = activeThreads.get(`${channel}:${threadTs}`);
  if (!ts || Date.now() - ts > TTL) return false;
  activeThreads.set(`${channel}:${threadTs}`, Date.now());
  return true;
}
```

**Caveat**: In-memory — lost on restart. Store in DB for persistence.

### Wire setStatus Through Handler

Pass `setStatus` to the AI processing layer so it can update status mid-processing:

```ts
await handleMessage({
  say: async (msg) => { await client.chat.postMessage({...}); },
  setStatus: async (status) => {
    try {
      await client.assistant.threads.setStatus({
        channel_id: channel, thread_ts: threadTs, status,
      });
    } catch {}
  },
});
```

## Message API Quick Reference

See [references/api_reference.md](references/api_reference.md) for detailed API docs.

## Formatting: mrkdwn, Not Markdown

| Format | Slack mrkdwn | Standard Markdown |
|---|---|---|
| Bold | `*bold*` | `**bold**` |
| Italic | `_italic_` | `*italic*` |
| Strike | `~strike~` | `~~strike~~` |
| Link | `<url\|text>` | `[text](url)` |
| User | `<@U12345>` | N/A |
| Channel | `<#C12345>` | N/A |

Convert Claude's Markdown output to Slack mrkdwn before posting.

## User Identity Resolution

### Scope Requirement

The `users:read` OAuth scope is required to call `users.info`. Without it, user resolution fails silently and falls back to the raw userId.

### Profile Fields

| Field | Source | Example | Notes |
|---|---|---|---|
| `real_name` | `user.profile.real_name` | "Rune Lind" | Full legal/display name |
| `display_name` | `user.profile.display_name` | "rli" | Slack handle — may be empty |
| `title` | `user.profile.title` | "Senior Consultant" | Job title — often empty |
| `name` | `user.name` | "rune.lind" | Workspace username (legacy) |

### Fallback Chain

`real_name` → `user.real_name` → `display_name` → `user.name` → userId

### `UserIdentity` Object (shared type)

```ts
// Defined in src/types.ts — used by all platforms
interface UserIdentity {
  name: string;          // Best name from fallback chain
  displayName?: string;  // Slack handle (e.g. "rli")
  title?: string;        // Job title from profile
}
```

`resolveSlackUser()` returns a `UserIdentity` (cached per userId). Call sites that only need a display string use `.name`.

### Identity Flow Into Prompt

1. `resolveSlackUser()` returns `UserIdentity` (cached)
2. Slack handler passes `userIdentity` object to `handleMessage()`
3. Handler forwards to `processMessage()` which passes it to `buildPrompt()`
4. `buildPrompt()` accepts `string | UserIdentity` — renders a multi-line block:

```
You are currently talking to: Rune Lind
- Display name: rli
- Title: Senior Consultant
```

Only lines with values are included. Telegram callers pass a plain string — backwards compatible.
