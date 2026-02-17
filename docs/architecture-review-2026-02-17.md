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

### ~~5. DB connection can be initialized twice~~
**Status:** [x] DONE (pre-existing fix)
**File:** `src/db/client.ts:9-15`
~~No guard against double `initDb()` — first pool orphaned silently.~~
Guard already present: `initDb()` throws if `sql` is already set.

### ~~6. Voice handler missing `finally` block~~
**Status:** [x] DONE (pre-existing fix)
**File:** `src/bot/voice-handler.ts:273`
~~`setInterval` for typing indicator not cleaned up in `finally`.~~
`finally { clearInterval(typingInterval); }` already present.

### ~~7. Config not centralized~~
**Status:** [x] DONE
**Files:** `src/logging.ts`, `src/ai/knowledge-search.ts`
~~Read `process.env` directly instead of going through `src/config.ts`.~~
- `knowledge-search.ts`: already uses `configureKnowledgeSearch()` pattern (pre-existing).
- `logging.ts`: now accepts `logDir` parameter; `index.ts` passes `config.logDir` to `setupLogging()`.

### ~~8. No integer validation in config~~
**Status:** [x] DONE (pre-existing fix)
**File:** `src/config.ts:13-18`
~~`parseInt("abc")` returns `NaN`, silently used as port/interval.~~
`optionalEnvInt()` validates with `isNaN()` and throws.

### ~~9. Shutdown race condition~~
**Status:** [x] DONE (pre-existing fix)
**File:** `src/index.ts:149-150`
~~`stopScheduler()` clears intervals but in-flight ticks may still write to DB after `closeDb()`.~~
Shutdown now calls `waitForPendingTicks(10_000)` before `closeDb()`.

### ~~10. Prompt builder timing metrics wrong~~
**Status:** [x] FALSE POSITIVE
**File:** `src/ai/prompt-builder.ts:47-53`
~~`dbHistoryMs` set inside `Promise.all().then()` measures wall time, not individual query time.~~
The `.then()` fires when each individual promise resolves. Since all start at `t0` in `Promise.all()`, `performance.now() - t0` gives the actual duration of each async I/O operation. Correct for parallel async operations.

### ~~11. Task execution marks run before sending~~
**Status:** [x] DONE (pre-existing fix)
**File:** `src/scheduler/runner.ts:162-163`
~~`updateTaskLastRun()` before `api.sendMessage()` — if send fails, task won't retry.~~
Now calls `sendMessage` first, then `updateTaskLastRun`. Error handler still advances `lastRunAt` to prevent retry storms (with comment explaining why).

### ~~12. Slack thread tracking lost on restart~~
**Status:** [x] ACCEPTED — Documented limitation
**File:** `src/slack/index.ts:82`
In-memory `activeThreads` map not persisted. Has TTL (24h) and size cap (500). Impact is low: user just needs to @mention again after restart. Core conversation tracking uses persisted DB threads.

### ~~13. Unbounded Slack caches~~
**Status:** [x] DONE
**File:** `src/slack/index.ts:14-15`
- `userInfoCache`: already has 1-hour TTL (pre-existing fix).
- `channelIdCache`: now capped at 500 entries.

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

### ~~19. Duplicate `esc()`/`escapeHtml()` across dashboard pages~~
**Status:** [x] DONE
~~Defined separately in traces-page.ts, search-page.ts, logs-page.ts, knowledge-page.ts.~~
Extracted `escScript()` into `helpers.ts`. All four pages now import and use the shared function.

### 20. N+1 queries in stats
`getUsersSummary()` has correlated subqueries for each user row.

---

## Minor Issues

### ~~21. Missing `TELEGRAM_ALLOWED_USER_IDS` silently defaults to empty list~~
**Status:** [x] DONE
~~Bot starts but rejects everyone with no warning.~~
`discoverBots()` now logs a warning when a bot has a Telegram token but no allowed user IDs.

### ~~22. `config.json` parse failures are silent~~
**Status:** [x] DONE
~~Misspelled fields like `thinkingMaxTokenz` go unnoticed.~~
`discoverBots()` now validates config.json keys against known schema and warns about unknown keys.

### ~~23. Null embedding saved to DB~~
**Status:** [x] DONE
~~Memory with null embedding is unfindable via semantic search.~~
Now logs a warning when embedding is null. Memory is still saved (valuable for text search) but the warning makes the issue visible.

### ~~24. Email watcher JSON parse failure returns `[]`~~
**Status:** [x] ALREADY HANDLED
~~Indistinguishable from "no new emails".~~
`log.warn` already present on parse failure (line 34), making it distinguishable in logs. Returning `[]` is the safe fallback — prevents false positive notifications.

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
