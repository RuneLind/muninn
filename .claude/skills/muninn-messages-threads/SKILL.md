---
description: "Conventions for how Muninn stores, formats and threads messages. Use whenever code saves a message from any path (handlers, watchers, scheduler), formats output for Telegram, Slack or web, writes a Haiku prompt that produces user-facing text, touches thread ordering or the web chat's message loading, or changes the Jira extension's research-thread flow — and when debugging a message that renders wrong on one platform or lands in the wrong thread."
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

`listThreads()` computes activity with `AND thread_id IS NOT NULL`, so messages without a thread never count toward a thread's `last_activity`. Attributing them to "main" would make main sort to the top permanently. These messages are still visible when viewing the main thread (the `getSimMessages` and `getRecentMessages` functions handle the `OR thread_id IS NULL` clause separately for display).

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

If `threadId` is omitted, the message gets `NULL` in the DB: it shows only in the main thread and does not affect thread ordering. Proactive rows (`watcher:`/`task:`/`goal:` sources) never enter the prompt's conversation history either way — `getRecentMessages(…, { excludeProactive: true })` drops them, and they reach the model only through the bounded alerts block.

### Where to check

- `src/watchers/runner.ts` — email/news alert persistence
- `src/scheduler/task-executor.ts` — scheduled tasks
- `src/scheduler/goal-runner.ts` — goal reminders, goal check-ins
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

`sanitizeHtml` allows a wider tag set when `isWeb` is true (headings, lists, blockquotes, tables). If `isWeb` is false (wrong conversation type), headings, lists, and tables are stripped — the page looks broken.

### Streaming messages

For real-time streaming, the client-side `formatWebHtml()` in `src/chat/views/components/web-format-client.ts` is used directly on accumulated deltas. Keep it in sync with `src/web/web-format.ts` (rules in `src/web/CLAUDE.md`).

## 4. Research Thread Creation (Jira Chrome Extension)

The `/api/research/chat` endpoint (`src/dashboard/routes/research-routes.ts`) creates threads for Jira tasks sent from the Chrome extension. It has specific safeguards to prevent two past bugs: wrong user selection and silent thread reuse.

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
| `src/dashboard/routes/research-routes.ts` | `/api/research/chat` handler — user resolution, thread collision, pending message |
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
