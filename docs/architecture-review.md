# Javrvis Architecture Review

Full codebase review covering architecture, DB layer, AI/executor, bot handlers, background processing, dashboard, and code quality.

> Supersedes the previous `improvements-plan.md` (2026-02-13). Outstanding items from that review are merged into the "Merged from improvements-plan.md" section below.

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
**Files:** `src/logging.ts`
~~Read `process.env` directly instead of going through `src/config.ts`.~~
- `knowledge-search.ts`: removed (knowledge now accessed via MCP tools, not prompt injection).
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
**Status:** DEFERRED — ~11% code overlap between `executor.ts` and `scheduler/executor.ts`. Different spawn args (stream-json vs print mode), error handling, and output parsing. Extraction would save ~30 lines but add indirection.

### ~~15. Three identical fire-and-forget extraction patterns~~
**Status:** [x] DONE — Extracted `runHaikuExtraction()` helper in `src/ai/haiku-extraction.ts`. Handles fire-and-forget wrapper, tracer setup, spawnHaiku + extractJson parsing, and error handling. Each extractor keeps its own prompt, result type, and post-parse domain logic via `onResult` callback.

### 16. Voice handler duplicates message handler (~60% overlap)
**Status:** DEFERRED — See also IP-13 below. Requires careful extraction of post-response logic (memory/goal/schedule extraction, message storage, activity logging). High risk of subtle regressions.

### 17. Conditional bot filtering repeated ~15x in DB layer
**Status:** DEFERRED — Every DB function has `botName ? WHERE bot_name = ... : WHERE ...`. A query builder helper would reduce repetition but adds abstraction complexity. The pattern is mechanical and works reliably.

### ~~18. Dashboard search has 3 near-identical functions~~
**Status:** [x] DONE — Extracted `buildSearchFilters()` helper in `src/db/memories.ts`. Takes `startParamIdx`, `botName?`, `scope?` and returns `{ conditions, params, nextParamIdx }`. All three dashboard search functions now use it for shared condition building.

### ~~19. Duplicate `esc()`/`escapeHtml()` across dashboard pages~~
**Status:** [x] DONE
~~Defined separately in traces-page.ts, search-page.ts, logs-page.ts, knowledge-page.ts.~~
Extracted `escScript()` into `helpers.ts`. All four pages now import and use the shared function.

### ~~20. N+1 queries in stats~~
**Status:** [x] DONE
~~`getUsersSummary()` has correlated subqueries for each user row.~~
Rewrote `getUsersSummary()`, `getSlackAnalytics()` users query, and `tokensByDay` using CTEs with pre-aggregation and LEFT JOINs instead of correlated subqueries.

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
**Status:** ACCEPTED — Format fragility is real but no clean fix without redesigning the dedup approach. Current rolling-window `lastNotifiedIds` provides a secondary dedup layer.

### ~~26. Dashboard SSE has duplicate cleanup~~
**Status:** [x] DONE
~~Both in `onAbort` and after while loop.~~
Removed post-while-loop cleanup — already handled in `stream.onAbort()` callback which sets `alive = false` to exit the loop.

### 27. Event listeners accumulate on dashboard re-render
**Status:** FALSE POSITIVE — Server-rendered pages, not SPA. Event listeners in `<script>` tags execute once per page load. No re-rendering occurs that would accumulate listeners.

### 28. No linter configured
**Status:** DEFERRED — Linter setup (ESLint/Biome) is a separate discussion. TypeScript strict mode catches most issues.

---

## Merged from improvements-plan.md

Outstanding items carried over from the 2026-02-13 review. Completed items included for tracking.

### ~~IP-5. Prompt injection in async extractors~~
**Status:** Still outstanding
**Priority:** Low | **Effort:** 30 min | **Files:** `src/memory/extractor.ts`, `src/goals/detector.ts`, `src/scheduler/detector.ts`

User messages are interpolated directly into prompts via `.replace()`. A crafted message could influence extraction by closing the `"""` delimiters and injecting instructions.

**Fix:** Use XML-style tags with random nonces as delimiters, and add an explicit note in the prompt that content between delimiters is untrusted user input.

### ~~IP-6. Dashboard API has no authentication~~
**Status:** Still outstanding
**Priority:** Medium | **Effort:** 15 min | **Files:** `src/dashboard/routes.ts`, `src/index.ts`

All endpoints are publicly accessible. Anyone on the network can read conversation history, memories, prompt snapshots, and traces.

**Fix (choose one):**
- **Minimal:** Bind Bun.serve to `127.0.0.1` only (prevents non-local access)
- **Better:** Add a `DASHBOARD_TOKEN` env var and require `Authorization: Bearer <token>` header on all API routes via Hono middleware

### ~~IP-7. DB connection pool has no startup health check~~
**Status:** Still outstanding
**Priority:** Low | **Effort:** 5 min | **Files:** `src/db/client.ts`

`initDb()` creates the pool but never validates connectivity. If Postgres is down, the first real query fails with a less helpful error.

**Fix:** Add `await sql('SELECT 1')` after pool creation. Fail fast with a clear error message.

### ~~IP-8. Telegram and Slack handlers ~80% duplicated~~
**Status:** [x] DONE — Extracted `processMessage()` in `src/core/message-processor.ts`. Both Telegram and Slack handlers now use the shared core.

### ~~IP-9. `pad()` function duplicated~~
**Status:** Partially resolved — handlers share `processMessage()` now, but `pad()`/`fmtTokens()` still duplicated in `src/bot/voice-handler.ts` and `src/core/message-processor.ts`.

### ~~IP-10. Legacy config fields never read externally~~
**Status:** Still outstanding
**Priority:** Low | **Effort:** 5 min | **Files:** `src/config.ts:20-21`

`goalCheckIntervalMs` and `goalCheckEnabled` are only used as fallbacks within `config.ts` itself. They exist for backward compatibility from the old goal scheduler.

**Fix:** Remove the legacy fields and the `GOAL_CHECK_*` env var references. Update `.env.example` if needed.

### ~~IP-12. `formatTelegramHtml` italic regex edge case~~
**Status:** Still outstanding
**Priority:** Low | **Effort:** 10 min | **Files:** `src/bot/telegram-format.ts`

The italic pattern `(?<!\w)\*([^*]+?)\*(?!\w)` could match markdown bullet points (`* item`) since `*` at line start has no preceding `\w`. A standalone `* item` line would become `<i>item</i>`.

**Fix:** Require the opening `*` to not be followed by a space (bullets have `* space`), or convert markdown bullets to a proper list format first.

### ~~IP-13. Voice handler duplicates full message pipeline~~
**Status:** Still outstanding
**Priority:** Medium | **Effort:** 1 hr | **Files:** `src/bot/voice-handler.ts`

`voice-handler.ts` duplicates the entire `processMessage()` pipeline. Every change to the core pipeline must be manually replicated here.

**Fix:** Refactor voice handler to use `processMessage()` from `src/core/message-processor.ts`. The voice-specific parts (STT before, TTS after) can wrap the shared call.

**Depends on:** IP-8 (done).

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
