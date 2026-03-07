---
name: muninn-knowledge-system
description: >
  Deep knowledge of the Muninn AI assistant's knowledge pipeline — async Haiku calls,
  memory extraction, goal detection, schedule detection, prompt assembly, embeddings,
  token tracking, and the unified scheduler. Use when: (1) Understanding how the knowledge
  system works end-to-end, (2) Improving or debugging any Haiku pipeline (memory, goals, schedules),
  (3) Modifying prompt-builder context assembly, (4) Working with embeddings or hybrid memory search,
  (5) Adding new async extraction pipelines, (6) Debugging token tracking or dashboard stats,
  (7) Understanding the scheduler runner and task execution.
  Triggers: "knowledge system", "haiku pipeline", "memory extraction", "goal detection",
  "schedule detection", "prompt builder", "embeddings", "token tracking", "scheduler",
  "how does memory work", "how does Jarvis learn", "add a new extractor".
---

# Muninn Knowledge System

## Architecture Overview

Every user message triggers a main Claude response plus three **fire-and-forget** async Haiku pipelines that extract knowledge in the background. A unified scheduler runs independently on a 60s tick.

```
User message → bot/handler.ts
  ├── buildPrompt() → main Claude call (Sonnet) → response to Telegram
  └── [fire-and-forget, parallel]
      ├── extractMemoryAsync()   → memories table
      ├── extractGoalAsync()     → goals table
      └── extractScheduleAsync() → scheduled_tasks table

Scheduler (60s tick, independent)
  ├── Run due scheduled tasks
  ├── Goal deadline reminders (within 24h)
  └── Goal check-ins (no checkin in 3+ days)
```

## Shared Haiku Executor

**File:** `src/scheduler/executor.ts`

All async Haiku calls flow through `spawnHaiku(prompt, source, entrypoint)`:

- Spawns `claude -p <prompt> --output-format json --model claude-haiku-4-5-20251001` via `Bun.spawn`
- Sets `CLAUDE_CODE_ENTRYPOINT` env var per caller
- Parses JSON output, extracts token usage (input includes cache tokens)
- Fires `trackUsage()` → INSERT into `haiku_usage` table (fire-and-forget)
- Returns `{ result, inputTokens, outputTokens, model }`

**`callHaiku(prompt, fallback, source)`** — high-level wrapper used by scheduler. Returns `fallback` string on error.

**No timeout** on Haiku calls (unlike main executor which uses `Promise.race`).

### Source Labels

| Source | Caller | Entrypoint | Purpose |
|---|---|---|---|
| `"memory"` | `memory/extractor.ts` | `jarvis-memory` | Evaluate if conversation worth remembering |
| `"goals"` | `goals/detector.ts` | `jarvis-goals` | Detect new goals or completions |
| `"schedule"` | `scheduler/detector.ts` | `jarvis-schedule-detector` | Detect recurring schedule requests |
| `"reminder"` | `scheduler/runner.ts` | `jarvis-scheduler` | Generate reminder messages |
| `"briefing"` | `scheduler/runner.ts` | `jarvis-scheduler` | Generate daily/weekly briefings |
| `"task"` | `scheduler/runner.ts` | `jarvis-scheduler` | Execute custom task prompts |
| `"checkin"` | `scheduler/runner.ts` | `jarvis-scheduler` | Goal deadline reminders and check-ins |

## Three Extraction Pipelines

### 1. Memory Extraction (`src/memory/extractor.ts`)

**Trigger:** Every user+assistant exchange, fire-and-forget.

**Flow:**
1. Build prompt with user message + assistant response
2. `spawnHaiku(prompt, "memory", "jarvis-memory")`
3. Haiku returns `{worth_remembering: bool, summary?, tags?}`
4. If worth remembering: `generateEmbedding(summary)` → `saveMemory()` with embedding vector

**What qualifies:** User facts, preferences, decisions, project details, recurring topics.
**Not extracted:** Greetings, thanks, simple lookups, small talk.

### 2. Goal Detection (`src/goals/detector.ts`)

**Trigger:** Every user+assistant exchange, fire-and-forget.

**Flow:**
1. Fetch active goals for context (`getActiveGoals()`)
2. Build prompt including active goals list
3. `spawnHaiku(prompt, "goals", "jarvis-goals")`
4. Haiku returns `{action: "none"|"new"|"completed", title?, description?, deadline?, tags?, completedGoalTitle?}`
5. New: `saveGoal()` | Completed: fuzzy title match → `updateGoalStatus(id, "completed")`

**Completion matching:** Case-insensitive substring match in both directions.

### 3. Schedule Detection (`src/scheduler/detector.ts`)

**Trigger:** Every user+assistant exchange, fire-and-forget.

**Flow:**
1. Build prompt asking for recurring tasks (NOT one-time reminders)
2. `spawnHaiku(prompt, "schedule", "jarvis-schedule-detector")`
3. Haiku returns `{has_schedule, title, task_type, hour, minute, days, interval_ms, prompt, timezone}`
4. If detected: `saveScheduledTask()` (computes `next_run_at` timezone-aware)

**Task types:** `"reminder"` | `"briefing"` | `"custom"`

## Prompt Builder (`src/ai/prompt-builder.ts`)

Assembles full context for the main Claude call.

**Parallel data loading (4 concurrent queries):**
1. `getRecentMessages(userId, 20)` — conversation history
2. `generateEmbedding(currentMessage)` — vector for memory search
3. `getActiveGoals(userId)`
4. `getScheduledTasksForUser(userId)`

**Then:** `searchMemoriesHybrid(query, embedding, 5)` — see Hybrid Memory Search below.

**System prompt assembly** (joined with `\n\n`):
- Base persona (Jarvis identity, tone)
- Telegram HTML formatting rules
- Goal awareness instructions + scheduled task awareness
- Top 5 relevant memories: `"- {summary} [{tags}]"`
- Active goals: `"- {title} (deadline: {date}) [{tags}]"`
- Scheduled tasks: `"- {title} ({taskType}, {schedule})"`

**Returns:** `PromptBuildResult` with prompts + timing metadata (dbHistoryMs, embeddingMs, memorySearchMs, counts).

## Embeddings (`src/ai/embeddings.ts`)

**Model:** `Xenova/all-MiniLM-L6-v2` (local, `@huggingface/transformers`, q8 quantized)
**Output:** 384-dimensional vectors

- Lazy singleton via `getExtractor()` — initialized once, cached
- `warmupEmbeddings()` called at startup to avoid cold-start on first message
- Used at **query time** (prompt builder) and **storage time** (memory extractor)

## Hybrid Memory Search (`src/db/memories.ts`)

**Function:** `searchMemoriesHybrid(query, embedding, limit)`

Combines two ranking signals via Reciprocal Rank Fusion (RRF):
- **FTS:** `plainto_tsquery('english', query)` against `search_vector` (GIN index) — top 20
- **Vector:** `embedding <=> query_embedding::vector` cosine distance (HNSW index) — top 20
- **RRF score:** `1/(60+fts_rank) + 1/(60+vec_rank)` via FULL OUTER JOIN
- Returns top `limit` memories by combined score
- Falls back to FTS-only if embedding is null

## Token Tracking

**Two separate systems unified on dashboard:**

| System | Table | What's tracked |
|---|---|---|
| Main Claude | `messages` | `input_tokens`, `output_tokens` per message |
| Async Haiku | `haiku_usage` | `source`, `model`, `input_tokens`, `output_tokens` per call |

**Dashboard stats** (`src/db/stats.ts`): `getDashboardStats()` uses CTEs to query BOTH tables, combining `totalTokens`, `tokensToday`, and `tokensByDay` chart data.

**Input tokens** = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.

## Unified Scheduler (`src/scheduler/runner.ts`)

Runs on configurable interval (default 60s). Guard `tickRunning` prevents overlap.

**Three sequential jobs per tick:**

1. **Scheduled tasks:** `getTasksDueNow()` → update `next_run_at` FIRST (prevent re-fire) → `callHaiku()` → Telegram
2. **Goal deadline reminders:** Deadline within 24h, not reminded in 12h → `callHaiku()` → Telegram
3. **Goal check-ins:** Not checked in 3+ days → `callHaiku()` → Telegram (max 1 per tick)

## Key Files

| File | Purpose |
|---|---|
| `src/scheduler/executor.ts` | Shared Haiku executor + token tracking |
| `src/memory/extractor.ts` | Memory extraction pipeline |
| `src/goals/detector.ts` | Goal detection pipeline |
| `src/scheduler/detector.ts` | Schedule detection pipeline |
| `src/scheduler/runner.ts` | Unified scheduler (tasks + reminders + check-ins) |
| `src/ai/prompt-builder.ts` | Context assembly for main Claude call |
| `src/ai/executor.ts` | Main Claude CLI executor with timeout |
| `src/ai/result-parser.ts` | Parse Claude CLI JSON output |
| `src/ai/embeddings.ts` | Local MiniLM embedding model |
| `src/db/memories.ts` | Memory CRUD + hybrid search |
| `src/db/goals.ts` | Goal CRUD |
| `src/db/scheduled-tasks.ts` | Scheduled task CRUD + next_run_at computation |
| `src/db/stats.ts` | Dashboard stats (combines both token sources) |
| `src/bot/handler.ts` | Orchestrates message flow, triggers all pipelines |

## Adding a New Extraction Pipeline

Follow the existing pattern:

1. Create `src/<domain>/detector.ts` with `extract<Domain>Async(input, config)` function
2. Build a prompt instructing Haiku what to detect, with clear JSON output schema
3. Call `spawnHaiku(prompt, "<source-label>", "jarvis-<domain>")`
4. Parse response and save to DB via `src/db/<domain>.ts`
5. Wire into `src/bot/handler.ts` as fire-and-forget alongside existing extractors
6. Add source label to dashboard stats if token visibility needed
7. If context needed in main prompt: add to `buildPrompt()` parallel queries and system prompt assembly

For detailed implementation patterns, read the existing extractors — they all follow the same structure: async wrapper with `.catch()`, prompt construction, `spawnHaiku()` call, JSON parse, conditional DB save.
