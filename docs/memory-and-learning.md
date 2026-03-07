# Memory & Learning System

How Muninn learns from conversations — extracting memories asynchronously, storing them with vector embeddings, and retrieving them via hybrid search at prompt time.

## Overview

Every message exchange is analyzed by a fire-and-forget Claude Haiku call that decides whether the conversation contains information worth remembering. If it does, the memory is saved with a summary, tags, scope classification, and a 384-dimensional vector embedding. At prompt time, memories are retrieved using Reciprocal Rank Fusion (RRF) of full-text search and vector similarity, then injected into the system prompt.

```
User message + Assistant response
  → extractMemoryAsync()          Fire-and-forget (non-blocking)
    → runHaikuExtraction()         Shared async Haiku pattern
      → Claude Haiku               "Is this worth remembering?"
      ← { worth_remembering, summary, tags, scope }
    → generateEmbedding()          MiniLM-L6 384-dim vector
    → saveMemory()                 PostgreSQL + pgvector
```

## Extraction Pipeline

### 1. Fire-and-Forget Pattern

Memory extraction runs after the user has already received their response. It never blocks the main message path.

```typescript
// In message-processor.ts — called after Claude responds
extractMemoryAsync({ userId, botName, botDir, userMessage, assistantResponse, sourceMessageId }, config, traceCtx);
extractGoalAsync(...);      // Same pattern
extractScheduleAsync(...);  // Same pattern
```

All three extractors use the shared `runHaikuExtraction()` helper in `src/ai/haiku-extraction.ts`, which handles:
- Spawning Claude Haiku as a subprocess with `cwd: botConfig.dir`
- Parsing the JSON result with `extractJson()` (tolerant of markdown fences)
- Creating a child span in the parent request's trace
- Error handling — parse failures are logged but never crash the request

### 2. What Gets Extracted

The Haiku prompt asks for a structured JSON response:

```json
{
  "worth_remembering": true,
  "summary": "User prefers dark mode for all applications",
  "tags": ["preferences", "ui"],
  "scope": "personal"
}
```

**Worth remembering:** facts about the user, preferences, decisions, project details, important context, recurring topics, team processes, organizational knowledge.

**Not worth remembering:** greetings, thanks, simple factual lookups, small talk.

### 3. Scope Classification

Each memory is classified as one of two scopes:

| Scope | Meaning | Visible to |
|---|---|---|
| `personal` | About this specific user — their preferences, projects, schedule | Only this user |
| `shared` | General knowledge useful to anyone — company processes, team decisions | All users of the bot |

Haiku auto-classifies the scope during extraction. The prompt builder fetches both personal memories for the current user and shared memories for the bot, combining them in the system prompt.

## Embedding Generation

Embeddings are generated locally using `Xenova/all-MiniLM-L6-v2` (quantized to Q8) via the HuggingFace Transformers library. No external API calls.

- **Dimensions:** 384
- **Model size:** ~31MB (loaded once, kept in memory)
- **Pooling:** Mean pooling with L2 normalization
- **Lazy init:** Model loads on first use; concurrent callers share the same init promise
- **Graceful fallback:** If embedding generation fails (model load error, OOM), the memory is saved without an embedding — it's still findable via full-text search, just not semantic search

```typescript
// src/ai/embeddings.ts
const output = await pipe(text, { pooling: "mean", normalize: true });
return Array.from(output.data as Float32Array);  // number[384]
```

## Storage

Memories are stored in PostgreSQL with pgvector:

```sql
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  bot_name TEXT NOT NULL,
  content TEXT NOT NULL,           -- Full user+assistant exchange
  summary TEXT NOT NULL,           -- Haiku's 1-sentence summary
  tags TEXT[] DEFAULT '{}',        -- Haiku-assigned tags
  scope TEXT DEFAULT 'personal',   -- 'personal' or 'shared'
  embedding vector(384),           -- May be NULL if generation failed
  source_message_id UUID,          -- Links back to the message that created it
  search_vector tsvector,          -- Auto-populated via trigger
  created_at TIMESTAMPTZ DEFAULT now()
);
```

The `search_vector` column is populated by a PostgreSQL trigger (not `GENERATED ALWAYS AS`, because `to_tsvector` is not immutable). It indexes both `summary` and `content` for full-text search.

## Hybrid Search (RRF)

At prompt time, `searchMemoriesHybrid()` runs two parallel searches and fuses the results using Reciprocal Rank Fusion:

```
Query: "What's my preferred code editor?"
                    ┌──────────────────────────────┐
                    │     Full-Text Search (FTS)    │
                    │  plainto_tsquery('english', q)│
                    │  → ranked by ts_rank          │
                    │  → top 20 candidates          │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │  FULL OUTER JOIN on memory.id │
                    │  RRF score = 1/(60+fts_rank)  │
                    │            + 1/(60+vec_rank)  │
                    │  ORDER BY rrf_score DESC      │
                    │  LIMIT 5                      │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │    Vector Search (pgvector)   │
                    │  embedding <=> query_vector   │
                    │  → ranked by cosine distance  │
                    │  → top 20 candidates          │
                    └──────────────────────────────┘
```

**Why RRF?** Full-text search catches keyword matches ("dark mode"), while vector search catches semantic similarity ("prefers dark theme"). RRF combines both without requiring score normalization — it only uses rank positions.

**Fallback:** If embedding generation fails for the query, the search falls back to FTS-only (`searchMemories()`).

### Scope Filtering

When `botName` is provided (which it always is in practice), the query includes both:
- Personal memories for this specific user: `scope = 'personal' AND user_id = $1`
- Shared memories for the bot: `scope = 'shared'`

This means a user automatically sees team knowledge alongside their personal context.

## Goal Detection

The same fire-and-forget Haiku pattern is used for goal tracking. The goal detector analyzes each conversation for:

- **New goals:** "I need to finish the report by Friday" → creates a goal with title, description, deadline, and tags
- **Completed goals:** "I shipped the feature" → fuzzy-matches against active goals and marks them completed

The detector receives the user's active goals in the prompt so it can match completions:

```
Currently active goals:
- "Ship authentication feature" (id: abc-123)
- "Write blog post" (id: def-456)
```

Goals appear in the system prompt at every interaction, giving the AI persistent awareness of what the user is working toward.

## Schedule Detection

The third extractor detects recurring scheduled tasks:

- **Reminders:** "remind me to stretch every 2 hours" → interval-based task
- **Briefings:** "give me a morning briefing at 8am on weekdays" → cron-style task
- **Custom:** "every Friday summarize my week" → custom with AI prompt

Supports both cron-style (hour/minute/days-of-week) and interval-based (every N milliseconds) scheduling. Duplicate detection prevents the same task from being created multiple times.

## Integration with Prompt Builder

The prompt builder fetches memories in parallel with other context sources:

```typescript
const [recentMessages, queryEmbedding, activeGoals, scheduledTasks, alerts] =
  await Promise.all([
    getRecentMessages(userId, 20, botName, threadId),
    generateEmbedding(currentMessage),       // For hybrid search
    getActiveGoals(userId, botName),
    getScheduledTasksForUser(userId, botName),
    getRecentAlerts(userId, botName, 24, 5),
  ]);

// Then hybrid search (needs the embedding)
const memories = await searchMemoriesHybrid(userId, message, queryEmbedding, 5, botName);
```

Memories are formatted in the system prompt with scope separation:

```
Your memories about this user:
- Prefers dark mode for all applications [preferences, ui]
- Working on the Muninn project, uses Bun [projects, tech]

Shared team knowledge:
- Sprint planning is every Monday at 10am [process, meetings]
```

## Key Files

| File | Purpose |
|---|---|
| `src/memory/extractor.ts` | Memory extraction prompt + async invocation |
| `src/goals/detector.ts` | Goal detection prompt + new/completed handling |
| `src/scheduler/detector.ts` | Schedule detection prompt + cron/interval parsing |
| `src/ai/haiku-extraction.ts` | Shared fire-and-forget Haiku pattern |
| `src/ai/embeddings.ts` | Local MiniLM-L6 embedding generation |
| `src/db/memories.ts` | CRUD + hybrid search (RRF) + dashboard search |
| `src/db/goals.ts` | Goal CRUD + reminder/check-in queries |
| `src/db/scheduled-tasks.ts` | Task CRUD + due-now queries |
| `src/ai/prompt-builder.ts` | Fetches + formats memories/goals/tasks for prompt |
| `src/core/message-processor.ts` | Triggers all three extractors after Claude responds |
