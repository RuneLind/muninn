# Javrvis Improvements Plan

Full app review performed 2026-02-13. Issues ranked by priority with effort estimates.

---

## Completed

### ~~1. `activity_log` CHECK constraint missing `slack_channel_post`~~
**Done** — `db/init.sql` updated, migration `013-activity-log-slack-type.sql` created and applied.

### ~~2. Dead code in scheduler startup~~
**Done** — Removed unused `bot` variable in `src/index.ts`.

### ~~3. Hardcoded bot name in prompt-builder logging~~
**Done** — Changed `[Jarvis]` to `[${botName}]` in `src/ai/prompt-builder.ts`.

### ~~4. No timeout on Haiku spawns~~
**Done** — Added 60s `Promise.race` + `proc.kill()` timeout to `spawnHaiku()` in `src/scheduler/executor.ts`.

### ~~Cherry-pick: UNIQUE constraint on `prompt_snapshots.trace_id`~~
**Done** — Cherry-picked `a6ee053` from `feature/observability-tracing`. Added UNIQUE index on `prompt_snapshots.trace_id`, `ON CONFLICT DO NOTHING` in `savePromptSnapshot()`, and documented no-FK design on `traces.parent_id`.

---

## Remaining — Security

### 5. Prompt injection in async extractors
**Priority:** Low | **Effort:** 30 min | **Files:** `src/memory/extractor.ts`, `src/goals/detector.ts`, `src/scheduler/detector.ts`

User messages are interpolated directly into prompts via `.replace()`:
- `memory/extractor.ts:62-64`
- `goals/detector.ts` via `buildPrompt()`
- `scheduler/detector.ts:81-84`

A crafted message could influence extraction by closing the `"""` delimiters and injecting instructions.

**Fix:** Use XML-style tags with random nonces as delimiters, and add an explicit note in the prompt that content between delimiters is untrusted user input.

---

### 6. Dashboard API has no authentication
**Priority:** Medium | **Effort:** 15 min | **Files:** `src/dashboard/routes.ts`, `src/index.ts`

All endpoints (`/api/stats`, `/api/messages/:userId`, `/api/memories`, `/api/traces`, `/api/prompts/:traceId`) are publicly accessible. Anyone on the network can read conversation history, memories, prompt snapshots, and traces.

**Fix (choose one):**
- **Minimal:** Bind Bun.serve to `127.0.0.1` only (prevents non-local access)
- **Better:** Add a `DASHBOARD_TOKEN` env var and require `Authorization: Bearer <token>` header on all API routes via Hono middleware

---

### 7. DB connection pool has no startup health check
**Priority:** Low | **Effort:** 5 min | **Files:** `src/db/client.ts`

`initDb()` creates the pool but never validates connectivity. If Postgres is down, the first real query fails with a less helpful error.

**Fix:** Add `await sql('SELECT 1')` after pool creation. Fail fast with a clear error message.

---

## Remaining — Code Quality

### 8. Telegram and Slack handlers are ~80% duplicated
**Priority:** Medium | **Effort:** 1-2 hr | **Files:** `src/bot/handler.ts`, `src/slack/handler.ts`

Both handlers share nearly identical flows:
1. Save user message
2. Build prompt
3. Call Claude
4. Save response
5. Extract memory/goal/schedule async
6. Format output
7. Send response
8. Log timing

The only differences are formatting (HTML vs mrkdwn), channel posting (Slack-specific), and platform metadata.

**Fix:** Extract a shared `processMessage()` core that takes platform-specific callbacks:
```ts
interface PlatformCallbacks {
  format: (text: string) => string;
  send: (formatted: string) => Promise<void>;
  setStatus?: (status: string) => Promise<void>;
  postProcess?: (result: ClaudeResult) => Promise<string>;
}
```

Both handlers would call `processMessage()` with their platform-specific implementations. This eliminates divergence risk and reduces maintenance burden.

---

### 9. `pad()` function duplicated
**Priority:** Low | **Effort:** 5 min | **Files:** `src/bot/handler.ts:218`, `src/slack/handler.ts:260`

Both files define identical `pad()` and `fmtTokens()` helper functions.

**Fix:** Move to `src/utils/formatting.ts` and import in both handlers. (Or resolve naturally as part of #8.)

---

### 10. Legacy config fields never read externally
**Priority:** Low | **Effort:** 5 min | **Files:** `src/config.ts:20-21`

`goalCheckIntervalMs` and `goalCheckEnabled` are only used as fallbacks within `config.ts` itself. They exist for backward compatibility from the old goal scheduler.

**Fix:** Remove the legacy fields and the `GOAL_CHECK_*` env var references. Update `.env.example` if needed.

---

## Remaining — Robustness

### 11. Embedding model failure degrades silently
**Priority:** Low | **Effort:** 15 min | **Files:** `src/ai/embeddings.ts`

If the HuggingFace embedding model fails to load, `generateEmbedding()` returns `null` on every call. This silently degrades hybrid search to FTS-only with no dashboard indicator or periodic retry.

**Fix options:**
- Log a warning on each fallback to FTS-only (with rate limiting so it doesn't spam)
- Add an `embeddingsHealthy` flag to `agentStatus` so the dashboard can show it
- Retry model loading on a timer (e.g., every 5 min) after initial failure

---

### 12. `formatTelegramHtml` italic regex edge case
**Priority:** Low | **Effort:** 10 min | **Files:** `src/bot/telegram-format.ts`

The italic pattern `(?<!\w)\*([^*]+?)\*(?!\w)` could match markdown bullet points (`* item`) since `*` at line start has no preceding `\w`. The bold regex runs first which helps with `**bold**`, but a standalone `* item` line would become `<i>item</i>`.

**Fix:** Add a negative lookbehind for line start: require the opening `*` to not be followed by a space (bullets have `* space`), or convert markdown bullets to a proper list format first.

---

## What's Done Well (keep doing this)

- **Multi-bot architecture** — `bots/<name>/` auto-discovery with cwd-based CLI isolation. Zero code changes to add a bot.
- **Observability** — Tracing with span hierarchy, prompt snapshots, timing breakdowns, agent status indicators. Production-grade instrumentation.
- **Hybrid memory search** — RRF fusion of FTS + vector embeddings with graceful fallback.
- **Content-based dedup in watchers** — `contentHash()` with proper noun extraction handles cross-language Haiku summarization.
- **Fire-and-forget async extraction** — Memory, goal, and schedule extraction don't block the user response.
- **Error handling in formatters** — Fallback paths when HTML/mrkdwn parsing fails.
- **Test organization** — Co-located tests, split by concern (unit/DB/handler), clean mock infrastructure.
- **DB schema** — Proper indexes, triggers for `updated_at` and `search_vector`, appropriate pgvector usage.
- **TypeScript strictness** — `strict: true`, `noUncheckedIndexedAccess`, `noImplicitOverride`.

---

## Remaining Implementation Order

| # | Issue | Priority | Effort |
|---|---|---|---|
| 1 | Dashboard auth or localhost bind (#6) | Medium | 15 min |
| 2 | Extract shared message processing (#8) | Medium | 1-2 hr |
| 3 | Strengthen prompt injection resistance (#5) | Low | 30 min |
| 4 | DB startup health check (#7) | Low | 5 min |
| 5 | Remove legacy config fields (#10) | Low | 5 min |
| 6 | Deduplicate `pad()` / `fmtTokens()` (#9) | Low | 5 min |
| 7 | Embedding model failure visibility (#11) | Low | 15 min |
| 8 | Fix italic regex edge case (#12) | Low | 10 min |

**Total remaining effort:** ~2.5-3.5 hours, ~1.5 hr for medium priority items.
