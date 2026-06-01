# Observability Module — Architecture & Rules

Cross-cutting runtime observability singletons. These are imported by **core, scheduler, watchers, bot, slack, and dashboard** alike, so they live in their own neutral module rather than under `dashboard/` (where they used to sit before the 2026-06 layering cleanup — having lower layers import *up* from `dashboard/` was the smell being fixed).

## File Overview

| File | Role |
|---|---|
| `activity-log.ts` | `activityLog` singleton — in-memory event ring buffer with DB write-through and pub/sub |
| `agent-status.ts` | `agentStatus` singleton — tracks the active request's progress (phase, tools, tokens) + connector label helpers |

## Activity Log (`activity-log.ts`)

- In-memory ring buffer (max 500 events) + fire-and-forget DB persistence (`saveActivity`)
- `loadFromDb()` called once after DB init (`src/index.ts`) to hydrate on startup
- `push(type, message, …)` appends + notifies subscribers; dashboard SSE `/events` subscribes
- `stats` getter / `computeStats()`: messages today, avg response time, total cost
- Producers span every platform: `core/message-processor.ts`, `core/response-handler.ts`, `core/process-error.ts`, `scheduler/*`, `watchers/runner.ts`, `bot/*`, `slack/handler.ts`

## Agent Status (`agent-status.ts`)

Tracks the lifecycle of in-flight requests (the waterfall/progress overlay source). Requests are stored in a `Map<requestId, RequestProgress>`, so concurrent work (multiple users on one bot, parallel watchers) accumulates each request's tools/phase independently instead of clobbering a shared slot.

1. `startRequest()` — creates `RequestProgress` keyed by a fresh `requestId` (returned to the caller)
2. `updatePhase(requestId, …)` / `toolStart(requestId, …)` / `toolEnd(requestId, …)` / `setConnectorLabel(requestId, …)` / `setModel(requestId, …)` — **every mutator takes the `requestId`**; an unknown id is a silent no-op (defensive against callbacks arriving after auto-clear)
3. `completeRequest(requestId, …)` — marks done, auto-clears *that request* after 30s (per-request timer)
4. `clearRequest(requestId?)` — clears one request, or (no arg) every tracked request (reset / no-active-request error path)
5. Phases: `idle`, `receiving`, `transcribing`, `building_prompt`, `calling_claude`, `saving_response`, `sending_telegram`, `sending_slack`, `synthesizing_voice`, `running_task`, `checking_goals`, `running_watcher`
6. `setConnectorInfo(requestId, …)` / `getConnectorLabel()` — connector display label (mirrored verbatim by `dashboard/views/components/traces-list.ts`)
7. `createProgressCallback(requestId, …)` — adapts a `StreamProgressCallback` into status updates for that request (used by core + scheduler)

**Read side is unchanged:** `getProgress()` / `subscribeProgress()` still surface a single `RequestProgress | null` — the *primary* (most-recently-started) live request — because the dashboard/chat waterfall is a single-pane view. This keeps the SSE contract (`sse-routes.ts`) and the UI untouched while the data layer stays correct under concurrency.

The dashboard renders this via SSE `/agent-status` (phase) and `/request-progress` (full waterfall); the UI component itself stays in `dashboard/views/components/agent-status-ui.ts`.

## Common Pitfalls

1. **Mutators are request-scoped**: `updatePhase`/`toolStart`/`toolEnd`/`setConnectorLabel`/`setModel`/`completeRequest`/`clearRequest` all take the `requestId` from `startRequest()` — passing the wrong id (or one already auto-cleared) is a silent no-op, so progress updates just vanish. Thread the id through; don't reach for a "current request".
2. **The phase-only singleton (`set`/`get`/`subscribe`) is still global**: it's a coarse "what is the bot doing right now" indicator, not per-request waterfall data, so concurrent requests *do* overwrite the phase text. That's intentional — the per-request `Map` carries the real progress.
3. **The waterfall UI is single-pane**: `getProgress()`/`subscribeProgress()` emit only the primary (most-recently-started) request. The data layer tracks all concurrent requests correctly, but the dashboard/chat overlay shows one at a time. A true multi-pane UI is a future, additive change — the data is already there.
4. **Keep these layer-neutral**: depend only on `db/`, `types.ts`, `logging.ts`, and `ai/` types — never import from `dashboard/`, `core/`, or platform handlers, or the upward-import smell returns.
