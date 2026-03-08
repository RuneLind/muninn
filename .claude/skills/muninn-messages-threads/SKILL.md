---
description: "Conventions for message storage, platform formatting, thread management, and outbound message persistence in Muninn. Use when: (1) Saving messages to the database from any code path (watchers, scheduler, handlers), (2) Formatting messages for display on Telegram, Slack, or web, (3) Working with thread ordering or the listThreads query, (4) Adding new outbound message sources (watchers, scheduled tasks, alerts), (5) Modifying the web chat (resolveConversation, message loading, rendering), (6) Writing Haiku prompts that generate user-facing text, (7) Debugging why messages look wrong on a specific platform, (8) Debugging why thread ordering puts the wrong thread on top, (9) Working with the Jira Chrome extension research thread flow (user resolution, thread collision). Triggers: 'formatting', 'thread ordering', 'saveMessage', 'formatTelegramHtml', 'formatWebHtml', 'watcher message', 'scheduler message', 'web chat', 'platform format', 'markdown storage', 'thread activity', 'research chat', 'jira plugin', 'chrome extension', 'findThreadByName', 'forceNew'."
---

# Muninn Messages & Threads

This skill covers three interconnected conventions that prevent bugs in the multi-platform message pipeline. Breaking any one of them causes cascading issues (wrong formatting on web, inflated thread ordering, missing conversation context).

## 1. Store Markdown, Format on Send

Messages are stored as **standard markdown** in the `messages.content` column. Platform-specific formatting happens only at send/render time — never in the stored content.

### The pipeline

```
Claude output (markdown)
    │
    ├──► saveMessage({ content: markdown })     ← DB stores raw markdown
    │
    └──► Platform send:
         ├── Telegram: formatTelegramHtml(markdown)  → <b>, <i>, <code>
         ├── Web:      formatWebHtml(markdown)       → <h3>, <ul>, <strong>, <table>
         └── Slack:    formatSlackMrkdwn(markdown)    → *bold*, ~strike~, <url|text>
```

### Why this matters

If you store Telegram HTML (`<b>text</b>`) in the DB, the web chat applies `formatWebHtml()` to it — which double-encodes or misinterprets the HTML tags. The same content must render correctly on all three platforms, so the DB must hold the platform-neutral format (markdown).

### Key files

| File | Function | Purpose |
|---|---|---|
| `src/core/message-processor.ts` | `processMessage()` | Reference implementation: saves `result.result` (raw markdown), formats per platform at send |
| `src/web/web-format.ts` | `formatWebHtml()` | Markdown → rich HTML (headings, tables, lists) |
| `src/bot/telegram-format.ts` | `formatTelegramHtml()` | Markdown → Telegram HTML subset (`<b>`, `<i>`, `<code>`, `<pre>`, `<a>`) |
| `src/slack/slack-format.ts` | `formatSlackMrkdwn()` | Markdown → Slack mrkdwn (`*bold*`, `~strike~`, `<url\|text>`) |

### Common mistake: Haiku prompts

When writing prompts for Haiku (scheduled tasks, watchers, extractors), ask for **markdown** output, not Telegram HTML:

```
# Wrong — produces <b> tags that get stored in DB
"Use Telegram HTML formatting (<b>, <i> only)"

# Right — produces markdown that any platform can render
"Use markdown formatting (**bold**, *italic*)"
```

Fallback strings must also use markdown:
```typescript
// Wrong
`<b>Reminder:</b> ${title}`

// Right
`**Reminder:** ${title}`
```

### Applying format at send time

When sending via Telegram from non-core code paths (watchers, scheduler):

```typescript
import { formatTelegramHtml } from "../bot/telegram-format.ts";

const markdown = generateContent();  // returns markdown
await api.sendMessage(userId, formatTelegramHtml(markdown), { parse_mode: "HTML" });
await saveMessage({ content: markdown, ... });  // store markdown, not HTML
```

## 2. Thread Ordering

The `listThreads()` function in `src/db/threads.ts` sorts threads by most recent message activity (`MAX(created_at) DESC`).

### The NULL thread_id trap

Messages from watchers and scheduled tasks historically had no `thread_id` set. The old query used `COALESCE(thread_id, main_thread_id)` to attribute these to "main", which inflated the main thread's `last_activity` and made it permanently sort to the top — even when other threads had more recent real conversation activity.

The fix: the query now uses `AND thread_id IS NOT NULL`, excluding orphan messages from activity calculations entirely. These messages are still visible when viewing the main thread (the `getSimMessages` and `getRecentMessages` functions handle the `OR thread_id IS NULL` clause separately for display).

### Rule: always set threadId when saving messages

Every `saveMessage()` call should include `threadId` from the user's active thread:

```typescript
import { getActiveThreadId } from "../db/threads.ts";

const threadId = await getActiveThreadId(userId, botName);
await saveMessage({
  userId,
  botName,
  role: "assistant",
  content: markdown,
  source: "watcher:email",        // identifies the source
  platform: "telegram",           // always set
  threadId: threadId ?? undefined, // active thread
});
```

If `threadId` is omitted, the message gets `NULL` in the DB. It won't appear in non-main thread contexts (breaking conversation continuity) and won't affect thread ordering.

### Where to check

- `src/watchers/runner.ts` — email/news alert persistence
- `src/scheduler/runner.ts` — scheduled tasks, goal reminders, goal check-ins
- `src/core/message-processor.ts` — main chat messages (already correct)

## 3. Web Chat

The web chat at `/chat` has specific conventions to render messages from all platforms correctly.

### resolveConversation must match type === 'web'

In `src/chat/views/page.ts`, the `resolveConversation()` function finds or creates a conversation for the selected user+bot. It must filter by `type === 'web'`:

```javascript
// Correct — only matches web conversations
if (convs[i].userId === selectedUserId && convs[i].botName === selectedBot && convs[i].type === 'web') {

// Wrong — matches first conversation, which might be telegram_dm
if (convs[i].userId === selectedUserId && convs[i].botName === selectedBot) {
```

Why: `hydrateFromDb()` creates conversations for each `(userId, botName, platform)` tuple. If a `telegram_dm` conversation is iterated first, the web chat uses it — making `isWeb` false, skipping `formatWebHtml()`, and rendering raw markdown with the Telegram-only tag whitelist.

### Message rendering chain

When loading persisted messages from the DB:

1. **Server** (`src/chat/routes.ts`): `formatWebHtml(m.content)` is applied to assistant messages when `isWeb === true`
2. **Client** (`src/chat/views/page.ts`): `sanitizeHtml(msg.text, isWeb)` strips disallowed tags

The `sanitizeHtml` function uses two tag whitelists:
- `_tgTags`: `b, strong, i, em, u, s, del, code, pre, a, br, span`
- `_webTags`: all of `_tgTags` plus `h2, h3, h4, h5, h6, ul, ol, li, blockquote, hr, table, thead, tbody, tr, th, td, p`

If `isWeb` is false (wrong conversation type), headings, lists, and tables are stripped — the page looks broken.

### Streaming messages

For real-time streaming, the client-side `formatWebHtml()` (a JS port in `page.ts`) is used directly on accumulated deltas. A note at the top of `src/web/web-format.ts` reminds to keep both copies in sync.

## 4. Research Thread Creation (Jira Chrome Extension)

The `/api/research/chat` endpoint (`src/dashboard/routes.ts`) creates threads for Jira tasks sent from the Chrome extension. It has specific safeguards to prevent two past bugs: wrong user selection and silent thread reuse.

### User resolution

The endpoint requires an explicit `userId` when multiple users exist for a bot. It never silently falls back to a default user.

| Scenario | Behavior |
|---|---|
| `userId` provided + matches | Use that user |
| `userId` provided + no match | **400** with `{ needsUser: true, users: [...] }` |
| `userId` omitted + 1 user exists | Auto-select the only user |
| `userId` omitted + multiple users | **400** with `{ needsUser: true, users: [...] }` |
| No users at all | **400** error |

### Thread collision detection

Before creating a thread, the endpoint checks if one with the same name already exists via `findThreadByName()` (`src/db/threads.ts`). If it does:

- Without `forceNew`: returns **409** with `{ threadExists: true, existingThreadId, existingThreadName }` — the client decides whether to reuse or create new
- With `forceNew: true`: creates a new thread with a timestamp suffix (e.g., `melosys-1234-2026-03-08-1430`)

This prevents the old bug where `createThread`'s `ON CONFLICT` upsert silently reused an existing thread, causing new messages to land in an old conversation.

### Key files

| File | Purpose |
|---|---|
| `src/dashboard/routes.ts` | `/api/research/chat` handler — user resolution, thread collision, pending message |
| `src/db/threads.ts` | `findThreadByName()`, `createThread()` |
| `src/chat/pending-messages.ts` | In-memory store bridging POST → chat page (5-min TTL) |
| `src/chat/views/page.ts` | `handleDeepLink()` — consumes pending message and auto-sends |

## Quick Checklist

When adding a new outbound message source:

- [ ] Generate content as **markdown** (not Telegram HTML)
- [ ] Call `formatTelegramHtml()` (or platform equivalent) only at send time
- [ ] Save to DB with `saveMessage({ content: markdown, platform, threadId })`
- [ ] Get `threadId` from `getActiveThreadId(userId, botName)`
- [ ] Set `platform` (e.g., `"telegram"`)
- [ ] Set `source` for traceability (e.g., `"watcher:email"`, `"task:reminder"`)

When modifying web chat rendering:

- [ ] Ensure `resolveConversation` matches `type === 'web'`
- [ ] Server applies `formatWebHtml()` when `isWeb === true`
- [ ] Client `sanitizeHtml` receives correct `isWeb` flag
- [ ] Keep server-side and client-side `formatWebHtml` in sync
