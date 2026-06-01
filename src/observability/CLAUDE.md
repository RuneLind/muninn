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

Tracks the lifecycle of a single active request (the waterfall/progress overlay source):

1. `startRequest()` — creates `RequestProgress` with a `requestId`
2. `toolStart()` / `toolEnd()` — records tool calls with timing
3. `completeRequest()` — marks done, auto-clears after 30s
4. Phases: `idle`, `receiving`, `transcribing`, `building_prompt`, `calling_claude`, `saving_response`, `sending_telegram`, `sending_slack`, `synthesizing_voice`, `running_task`, `checking_goals`, `running_watcher`
5. `setConnectorInfo()` / `getConnectorLabel()` — connector display label (mirrored verbatim by `dashboard/views/components/traces-list.ts`)
6. `createProgressCallback()` — adapts a `StreamProgressCallback` into status updates (used by core + scheduler)

The dashboard renders this via SSE `/agent-status` (phase) and `/request-progress` (full waterfall); the UI component itself stays in `dashboard/views/components/agent-status-ui.ts`.

## Common Pitfalls

1. **Agent status is global**: only one active request is tracked at a time — concurrent requests overwrite. (Known limitation; a `Map<requestId, RequestProgress>` is the documented future fix.)
2. **Keep these layer-neutral**: depend only on `db/`, `types.ts`, `logging.ts`, and `ai/` types — never import from `dashboard/`, `core/`, or platform handlers, or the upward-import smell returns.
