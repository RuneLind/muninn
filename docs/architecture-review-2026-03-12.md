# Architecture Review — 2026-03-12

**~35K lines TypeScript | 158 files | 10 major modules | 3 AI connectors | 3 bots**

## Verdict

Well-architected for a personal assistant. A few hotspots need attention.

Module-level organization is strong — bot, AI, dashboard, scheduler, watchers, and DB are cleanly separated. Multi-bot discovery is elegant. Connector abstraction successfully unifies three different AI backends behind one interface.

The issues are **local complexity hotspots**, not systemic architectural problems.

---

## High Priority

### 1. `src/core/message-processor.ts` — God function (~400 lines) ✅ DONE

- Mixes tracing, activity logging, prompt building, AI execution, memory/goal extraction, and platform-specific formatting in one procedural pipeline
- Voice handler duplicates ~80% of the same logic
- **Fix**: Decompose into phases: `buildContext()` → `callAI()` → `extractMetadata()` → `formatResponse()` → `persistResult()`. Voice handler reuses the same pipeline.

### 2. `src/dashboard/routes.ts` — Mega-file (500+ lines, 50+ handlers) ✅ DONE

- All API routes in one file makes navigation difficult
- **Fix**: Split by domain — `messages-routes.ts`, `memories-routes.ts`, `goals-routes.ts`, `traces-routes.ts`, etc. Re-export from `routes.ts`.

### 3. `openai-compat.ts` — Largest connector (554 lines) ✅ DONE

- Contains its own agent loop, MCP tool execution, SSE stream parsing, `<think>` block state machine, and retry logic — all in one file
- **Fix**: Extract `tool-execution.ts` (MCP loop), `streaming.ts` (SSE parsing). The connector itself becomes orchestration only.

---

## Medium Priority

### 4. Tool input abbreviation duplicated in 3 places

- `stream-parser.ts`, `copilot-sdk.ts`, `openai-compat.ts` all have the same `JSON.stringify(input).slice(0, 500)` pattern
- **Fix**: Extract to `abbreviateToolInput()` utility in `tool-status.ts`

### 5. N+1 query risk in `memories.ts:getMemoriesByUser()`

- Correlated subquery per user for username lookup + tag aggregation
- Fine at current scale, would degrade with many users
- **Fix**: Convert username lookup to JOIN, tags to a single LATERAL join

### 6. BotName conditional filtering repeated ~7 times across DB modules

- Every query has `botName ? sql\`...WHERE bot_name = ${botName}\` : sql\`...\``
- **Fix**: Helper function `withBotFilter()` or query builder pattern

### 7. Fire-and-forget extraction has no error feedback

- Memory/goal/schedule extraction failures are logged but never surfaced to the user or activity feed
- **Fix**: Add optional `onError` callback; log failures to activity feed so dashboard shows them

### 8. Watcher dedup relies on Haiku's summary format

- Content hash computed from translated text — if Haiku's phrasing changes, same email triggers again
- **Fix**: Use stable email message ID as primary dedup key, content hash as secondary

---

## Low Priority

### 9. Slack client scoping is error-prone

- 4 different handler paths with subtly different `client` references
- **Fix**: Standardize to always pass `app.client` explicitly; add a guard/test

### 10. `ClaudeExecResult` vs `ClaudeResult` naming confusion

- One extends the other but the distinction isn't obvious
- **Fix**: Rename to `AiResponse` (data) and `AiResponseWithMeta` (data + cost/timing)

### 11. Hardcoded Norwegian in `tool-restrictions.ts`

- Tool restriction prompt text is entirely in Norwegian
- **Fix**: Make language configurable per bot persona

### 12. No DB transactions for multi-step operations

- Message save + activity log + trace persist are separate inserts with no atomicity
- Acceptable for single-user, would need transactions for multi-user reliability

---

## What's Working Well (don't touch)

- **Bot discovery** (`src/bots/config.ts`) — auto-discovers from folder structure
- **Connector abstraction** (`src/ai/connector.ts`) — simple type, lazy loading
- **Activity log** (`src/dashboard/activity-log.ts`) — observer pattern with ring buffer
- **Prompt builder** (`src/ai/prompt-builder.ts`) — parallel data loading, clean composition
- **Scheduler** (`src/scheduler/runner.ts`) — unified tick with overlap protection
- **Hybrid memory search** — pgvector + keyword with RRF fusion
- **Logging** — structured LogTape, daily-rotating JSONL
- **Migration system** — Flyway-style versioning, transactional
- **Serena tool proxy** — reduces 40 tools to 2
