# Prompt Assembly

How Muninn assembles the full prompt from 6 context sources in parallel — persona, memories, goals, scheduled tasks, alerts, and conversation history — while keeping latency under 1 second. External knowledge (RAG) is accessed on-demand via MCP tools, not injected into every prompt.

## Overview

Every incoming message triggers a prompt build that fetches context from multiple sources in parallel, then assembles a system prompt and user prompt for Claude. The system prompt contains everything Claude needs to be contextually aware: who it is, who it's talking to, what it remembers, what the user is working toward, and what happened recently.

```
                    ┌─────────────────────────┐
                    │      System Prompt       │
                    │                          │
                    │  1. Persona (CLAUDE.md)  │
                    │  2. User identity        │
                    │  3. Tool restrictions     │
                    │  4. Memories (personal    │
                    │     + shared)             │
                    │  5. Active goals          │
                    │  6. Scheduled tasks       │
                    │  7. Recent alerts         │
                    │                          │
                    ├──────────────────────────┤
                    │      User Prompt         │
                    │                          │
                    │  Conversation history     │
                    │  + current message        │
                    └─────────────────────────┘
```

## Parallel Data Fetching

Five data sources are fetched concurrently in a single `Promise.all()`:

```typescript
const [recentMessages, queryEmbedding, activeGoals, scheduledTasks, recentAlerts] =
  await Promise.all([
    getRecentMessages(userId, 20, botName, threadId),       // DB: thread-scoped history
    generateEmbedding(currentMessage),                      // Local: MiniLM-L6 384-dim
    getActiveGoals(userId, botName),                        // DB: active goals
    getScheduledTasksForUser(userId, botName),              // DB: user's scheduled tasks
    getRecentAlerts(userId, botName, 24, 5),                // DB: last 24h watcher alerts
  ]);

// Then hybrid memory search (needs the embedding from above)
const memories = await searchMemoriesHybrid(userId, message, queryEmbedding, 5, botName);
```

External knowledge (Notion, Confluence) is NOT injected into the prompt. It is accessed on-demand via MCP tools when the AI decides a search is needed. See `docs/knowledge-search-system.md`.

The embedding generation and memory search are sequential (search needs the embedding), but everything else runs in parallel. Typical build time is 100-500ms.

## System Prompt Structure

The system prompt is assembled from parts, joined with double newlines:

### 1. Persona

The bot's `CLAUDE.md` file, loaded at startup. Contains personality, rules, response style, and domain knowledge. This is also auto-loaded by Claude CLI as project instructions, so the bot sees it twice (intentionally — belt and suspenders).

### 2. User Identity

Tells Claude who it's talking to:

```
You are currently talking to: Rune
- Display name: Rune Vatne
- Title: Senior Developer
```

For Telegram, just the username. For Slack, enriched from the Slack user profile (display name, title).

### 3. Tool Restrictions

If the current user is denied access to certain tool groups (configured in `config.json`), a prompt section instructs Claude not to use those tools. See the Multi-Bot Architecture doc for details.

### 4. Memories

Top 5 memories from hybrid search (RRF of full-text + vector), split by scope:

```
Your memories about this user:
- Prefers dark mode for all applications [preferences, ui]
- Working on the Muninn project, uses Bun [projects, tech]

Shared team knowledge:
- Sprint planning is every Monday at 10am [process, meetings]
```

### 5. Active Goals

All non-completed goals for this user:

```
User's active goals:
- Ship authentication feature (deadline: Fri, Feb 20) [work]
- Write blog post about Muninn [writing, personal]
```

### 6. Scheduled Tasks

Active scheduled tasks with their schedule formatted:

```
User's scheduled tasks:
- Morning briefing (briefing, Mon, Tue, Wed, Thu, Fri at 08:00)
- Stretch reminder (reminder, every 2h)
```

### 7. Recent Alerts

Watcher alerts sent in the last 24 hours, so Claude knows what proactive messages the user already received:

```
Recent watcher alerts sent to user (last 24h):
- [09:15] email: Fra: GitHub — Your PR was approved
- [14:30] news: TechCrunch — New AI breakthrough announced
```

## User Prompt Structure

The user prompt contains the conversation history and current message:

```
<conversation_history>
[user/rune] Can you check my calendar for tomorrow?

[assistant] You have two meetings tomorrow: ...

[user/rune] Thanks! What about Friday?
</conversation_history>

What meetings do I have on Friday?
```

The conversation history is thread-scoped — if the user has created named threads via `/topic`, only messages from the active thread are included (last 20 messages).

The current message is appended after the history. If the most recent DB message is identical to the current message (saved before prompt building), it's deduplicated from the history.

## Slack-Specific Additions

For Slack conversations, two additional sections may be appended to the system prompt:

**Channel posting capability:** Enables `<slack-post channel="#name">` directives in Claude's response:
```
## Slack Channel Posting
You can post messages directly to Slack channels using this directive...
```

**Channel context:** Recent messages from the current channel/thread, so Claude understands the conversation it's joining:
```
## Channel Context
Recent messages in the channel/thread (for context):
alice: Has anyone reviewed the new API design?
bob: I'll take a look this afternoon
```

## Prompt Snapshots

The complete system + user prompt is saved to the `prompt_snapshots` table for every request (fire-and-forget, 3-day retention). This enables debugging by showing exactly what Claude saw for any given request, accessible via the `/traces` dashboard.

## Performance Metadata

The prompt builder returns timing metadata alongside the prompt:

```typescript
interface PromptBuildResult {
  systemPrompt: string;
  userPrompt: string;
  meta: {
    dbHistoryMs: number;         // Time to fetch conversation history
    embeddingMs: number;         // Time to generate query embedding
    memorySearchMs: number;      // Time for hybrid memory search
    messagesCount: number;       // Messages in history
    memoriesCount: number;       // Memories found
    goalsCount: number;          // Active goals
    scheduledTasksCount: number; // Scheduled tasks
    alertsCount: number;         // Recent alerts
  };
}
```

This metadata is logged, stored in trace span attributes, and displayed in the dashboard.

## Key Files

| File | Purpose |
|---|---|
| `src/ai/prompt-builder.ts` | `buildPrompt()` — parallel fetch + assembly |
| `src/ai/embeddings.ts` | Local embedding generation for hybrid search |
| `src/ai/tool-restrictions.ts` | Tool restriction prompt section |
| `src/db/memories.ts` | `searchMemoriesHybrid()` — RRF search |
| `src/db/goals.ts` | `getActiveGoals()` |
| `src/db/scheduled-tasks.ts` | `getScheduledTasksForUser()` |
| `src/db/messages.ts` | `getRecentMessages()`, `getRecentAlerts()` |
| `src/db/prompt-snapshots.ts` | Prompt snapshot persistence |
| `src/scheduler/briefing-prompt.ts` | Variant for scheduled briefing generation |
