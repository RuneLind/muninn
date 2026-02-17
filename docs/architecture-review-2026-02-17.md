# Javrvis Architecture Review — 2026-02-17

Full codebase review covering architecture, DB layer, AI/executor, bot handlers, background processing, dashboard, and code quality.

**Previous review:** `docs/improvements-plan.md` (2026-02-13)

---

## Critical Issues (Fix Now)

### ~~1. Embedding model race condition~~
**Status:** [x] DONE
**File:** `src/ai/embeddings.ts:13-19`

Setting `initPromise = null` on success allows concurrent calls to re-initialize the model:
1. Call A starts init, stores promise in `initPromise`
2. Call B sees `initPromise`, awaits it
3. Call A completes, sets `initPromise = null`
4. Call C sees `initPromise = null`, starts NEW init — duplicate model load

**Fix:** Only clear `initPromise` on error, not on success.

---

### ~~2. Dashboard route path typos~~
**Status:** [x] FALSE POSITIVE — Routes verified correct. Hono uses `:param` syntax which is present in all routes.

---

### ~~3. Scheduler tick can hang forever~~
**Status:** [x] DONE
**File:** `src/scheduler/runner.ts:39-48`

If `runSchedulerTick` hangs (stuck DB, process hang), `tickRunning` stays true forever, blocking all future ticks. No timeout exists.

**Fix:** Wrap `runSchedulerTick` with a timeout. Log warning when tick is skipped due to previous tick still running.

---

### ~~4. Watcher failures have no backoff~~
**Status:** [x] DONE
**File:** `src/watchers/runner.ts:60-147`

If a checker (Gmail MCP) consistently fails, it retries every tick indefinitely with no backoff or circuit breaker. `lastRunAt` is NOT updated on failure, causing immediate retry on next tick.

**Fix:** Add exponential backoff or at minimum update `lastRunAt` on failure to prevent retry storms.

---

## Important Issues (Should Fix)

### 5. DB connection can be initialized twice
**File:** `src/db/client.ts:9-15`
No guard against double `initDb()` — first pool orphaned silently.

### 6. Voice handler missing `finally` block
**File:** `src/bot/voice-handler.ts:92`
`setInterval` for typing indicator not cleaned up in `finally` (text handler does this correctly).

### 7. Config not centralized
**Files:** `src/logging.ts`, `src/dashboard/routes.ts`, `src/ai/knowledge-search.ts`
Read `process.env` directly instead of going through `src/config.ts`.

### 8. No integer validation in config
**File:** `src/config.ts:15-30`
`parseInt("abc")` returns `NaN`, silently used as port/interval.

### 9. Shutdown race condition
**File:** `src/index.ts:145`
`stopScheduler()` clears intervals but in-flight ticks may still write to DB after `closeDb()`.

### 10. Prompt builder timing metrics wrong
**File:** `src/ai/prompt-builder.ts:47-53`
`dbHistoryMs` set inside `Promise.all().then()` measures wall time, not individual query time.

### 11. Task execution marks run before sending
**File:** `src/scheduler/runner.ts:134`
`updateTaskLastRun()` before `api.sendMessage()` — if send fails, task won't retry.

### 12. Slack thread tracking lost on restart
**File:** `src/slack/index.ts:82`
In-memory `activeThreads` map not persisted.

### 13. Unbounded Slack caches
**File:** `src/slack/index.ts:14-15`
`channelIdCache` has no TTL; `userInfoCache` has no size limit.

---

## Refactoring Opportunities

### 14. Duplicate executor timeout logic
`src/ai/executor.ts` and `src/scheduler/executor.ts` implement nearly identical timeout/spawn patterns. Extract shared `spawnWithTimeout()`.

### 15. Three identical fire-and-forget extraction patterns
`extractMemoryAsync`, `extractGoalAsync`, `extractScheduleAsync` — consolidate into shared async processor.

### 16. Voice handler duplicates message handler (~60% overlap)
Extract shared post-response utility. (See also improvements-plan.md #13)

### 17. Conditional bot filtering repeated ~15x in DB layer
Every DB function has `botName ? WHERE bot_name = ... : WHERE ...`. Use query builder helper.

### 18. Dashboard search has 3 near-identical functions
`dashboardSearchText()`, `dashboardSearchSemantic()`, `dashboardSearchHybrid()` share ~80% code.

### 19. Duplicate `esc()`/`escapeHtml()` across dashboard pages
Defined separately in traces-page.ts, search-page.ts, logs-page.ts. Consolidate into helpers.ts.

### 20. N+1 queries in stats
`getUsersSummary()` has correlated subqueries for each user row.

---

## Minor Issues

### 21. Missing `TELEGRAM_ALLOWED_USER_IDS` silently defaults to empty list
Bot starts but rejects everyone with no warning.

### 22. `config.json` parse failures are silent
Misspelled fields like `thinkingMaxTokenz` go unnoticed.

### 23. Null embedding saved to DB
Memory with null embedding is unfindable via semantic search.

### 24. Email watcher JSON parse failure returns `[]`
Indistinguishable from "no new emails".

### 25. Content dedup hash is format-dependent
If Haiku changes output format, emails get duplicated.

### 26. Dashboard SSE has duplicate cleanup
Both in `onAbort` and after while loop.

### 27. Event listeners accumulate on dashboard re-render
No cleanup of old listeners.

### 28. No linter configured
Relies on TypeScript strictness only.

---

## What's Already Great

- Strict TypeScript (strict: true, noUncheckedIndexedAccess) — zero compilation errors
- 420 passing tests, zero failures
- Centralized structured logging (LogTape) — no console.log in src/
- No SQL injection — all queries parameterized
- Proper transaction usage, comprehensive DB indexing
- Clean multi-bot isolation via cwd
- Graceful degradation patterns
- No circular dependencies
- Excellent test organization (co-located, grouped by concern)
